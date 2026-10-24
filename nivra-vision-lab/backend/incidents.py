"""Local incident history and bounded recordings, shared with guard phones."""
from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field, field_validator

from guards import hub, register_incident_files

STORE = Path(__file__).parent / 'incidents.local.json'
FILES = Path(__file__).parent / 'incidents.local'
CLIP_LIMIT = 12 * 1024 * 1024
STILL_LIMIT = 1536 * 1024
RETENTION_SECONDS = 7 * 24 * 60 * 60
FOLDER_LIMIT = 500 * 1024 * 1024
INCIDENT_LIMIT = 1000
MEDIA_TYPES = {'video/webm': '.webm', 'video/mp4': '.mp4', 'image/jpeg': '.jpg'}
Outcome = Literal['acknowledged', 'guard_on_scene', 'police', 'cleared', 'dismissed']
OUTCOME_LABELS = {'acknowledged': 'Acknowledged', 'guard_on_scene': 'Guard on scene',
    'police': 'Police called', 'cleared': 'Cleared', 'dismissed': 'Dismissed', None: 'Outcome reset'}


def _now_ms():
    return int(time.time() * 1000)


class Input(BaseModel):
    model_config = ConfigDict(strict=True, extra='forbid', allow_inf_nan=False)


class CreateIncident(Input):
    eventId: str = Field(min_length=1, max_length=120)
    kind: Literal['fight', 'test']
    title: str = Field(min_length=1, max_length=120)
    detail: str = Field(max_length=2000)
    camera: str = Field(min_length=1, max_length=120)
    occurredAt: float = Field(ge=0)
    likelihood: float | None = Field(ge=0, le=100)

    @field_validator('eventId', 'title', 'camera')
    @classmethod
    def not_blank(cls, value):
        if not value.strip() or any(not char.isprintable() for char in value):
            raise ValueError('Use nonempty printable text.')
        return value


class PatchIncident(Input):
    note: str | None = Field(default=None, max_length=500)
    outcome: Outcome | None = None

    @field_validator('note')
    @classmethod
    def note_is_text(cls, value):
        if value is None:
            raise ValueError('Note must be text.')
        return value


class TimelineEntry(Input):
    label: str = Field(min_length=1, max_length=240)
    by: str | None = Field(default=None, max_length=120)

    @field_validator('label')
    @classmethod
    def not_blank(cls, value):
        if not value.strip():
            raise ValueError('Enter a timeline label.')
        return value


class IncidentStore:
    def __init__(self, store: Path = STORE, files: Path = FILES, guard_hub=hub):
        self.store, self.files, self.hub = Path(store), Path(files), guard_hub
        self.lock = threading.RLock()
        self.records: dict[str, dict] = {}
        self.files.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.store.parent.mkdir(parents=True, exist_ok=True)
        try:
            for record in json.loads(self.store.read_text()).get('incidents', []):
                if (isinstance(record, dict) and re.fullmatch(r'inc_[A-Za-z0-9_-]{10}', record.get('id', ''))
                        and isinstance(record.get('eventId'), str)):
                    self.records[record['id']] = record
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        self.prune()

    def _save(self):
        # The temporary file is private before any incident data is written.
        fd, name = tempfile.mkstemp(prefix=self.store.name + '.', suffix='.local', dir=self.store.parent)
        try:
            with os.fdopen(fd, 'w') as stream:
                os.fchmod(stream.fileno(), 0o600)
                json.dump({'incidents': list(self.records.values())}, stream, allow_nan=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.store)
        finally:
            Path(name).unlink(missing_ok=True)

    def _record(self, incident_id):
        record = self.records.get(incident_id)
        if record is None:
            raise HTTPException(404, 'Incident not found.')
        return record

    def _path(self, record, kind):
        metadata = record.get(kind)
        if not metadata:
            return None
        extension = MEDIA_TYPES.get(metadata.get('type')) if kind == 'clip' else '.jpg'
        return self.files / (record['id'] + extension) if extension else None

    def _view(self, record):
        result = json.loads(json.dumps(record))
        for kind in ('clip', 'still'):
            path = self._path(record, kind)
            if path is None or not path.is_file():
                result[kind] = None
        result['guards'] = self.hub.alerts_for_event(record['eventId'])
        return result

    def _drop(self, incident_id):
        record = self.records.pop(incident_id)
        for extension in MEDIA_TYPES.values():
            (self.files / (record['id'] + extension)).unlink(missing_ok=True)

    def _prune(self):
        ordered = sorted(self.records.values(), key=lambda item: item['occurredAt'])
        for record in ordered[:max(0, len(ordered) - INCIDENT_LIMIT)]:
            self._drop(record['id'])
        cutoff = time.time() - RETENTION_SECONDS
        remaining = []
        for path in self.files.iterdir():
            if not path.is_file():
                continue
            stat = path.stat()
            if stat.st_mtime < cutoff:
                path.unlink()
            else:
                remaining.append((path, stat))
        total = sum(stat.st_size for _, stat in remaining)
        # Evict oldest clips first. If stills alone exceed the quota, evict
        # their oldest files too so the directory always stays bounded.
        for path, stat in sorted(remaining, key=lambda item: (item[0].suffix == '.jpg', item[1].st_mtime)):
            if total <= FOLDER_LIMIT:
                break
            path.unlink()
            total -= stat.st_size
        for record in self.records.values():
            for kind in ('clip', 'still'):
                path = self._path(record, kind)
                if path is None or not path.is_file():
                    record[kind] = None

    def prune(self):
        with self.lock:
            self._prune()
            if self.records or self.store.exists():
                self._save()

    def create(self, body: CreateIncident):
        with self.lock:
            existing = next((item for item in self.records.values() if item['eventId'] == body.eventId), None)
            if existing is not None:
                return self._view(existing)
            incident_id = 'inc_' + secrets.token_urlsafe(8)[:10]
            while incident_id in self.records:
                incident_id = 'inc_' + secrets.token_urlsafe(8)[:10]
            label = 'Detected' if body.likelihood is None else f'Detected ({body.likelihood:g}% likelihood)'
            record = {**body.model_dump(), 'id': incident_id, 'location': self.hub.incident_location(),
                'note': '', 'outcome': None, 'timeline': [{'at': body.occurredAt, 'label': label, 'by': None}],
                'clip': None, 'still': None}
            self.records[incident_id] = record
            self._prune()
            self._save()
            return self._view(record)

    def list(self, limit=100):
        with self.lock:
            ordered = sorted(self.records.values(), key=lambda item: item['occurredAt'], reverse=True)
            return {'incidents': [self._view(item) for item in ordered[:limit]]}

    def get(self, incident_id):
        with self.lock:
            return self._view(self._record(incident_id))

    def patch(self, incident_id, body: PatchIncident):
        with self.lock:
            record = self._record(incident_id)
            updates = body.model_dump(exclude_unset=True)
            if 'outcome' in updates and updates['outcome'] != record['outcome']:
                record['timeline'].append({'at': _now_ms(), 'label': OUTCOME_LABELS[updates['outcome']], 'by': 'Mac operator'})
                record['timeline'].sort(key=lambda item: item['at'])
            record.update(updates)
            self._save()
            return self._view(record)

    def timeline(self, incident_id, body: TimelineEntry):
        with self.lock:
            record = self._record(incident_id)
            record['timeline'].append({'at': _now_ms(), **body.model_dump()})
            record['timeline'].sort(key=lambda item: item['at'])
            self._save()
            return self._view(record)

    def upload(self, incident_id, kind, content_type, data, duration=None):
        allowed = ('video/webm', 'video/mp4') if kind == 'clip' else ('image/jpeg',)
        if content_type not in allowed:
            raise HTTPException(415, 'Unsupported recording type.')
        if len(data) > (CLIP_LIMIT if kind == 'clip' else STILL_LIMIT):
            raise HTTPException(413, 'Recording is too large.')
        if not data:
            raise HTTPException(422, 'Recording is empty.')
        with self.lock:
            record = self._record(incident_id)
            path = self.files / (incident_id + MEDIA_TYPES[content_type])
            fd, name = tempfile.mkstemp(prefix=incident_id + '.', suffix='.local', dir=self.files)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    os.fchmod(stream.fileno(), 0o600)
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(name, path)
            finally:
                Path(name).unlink(missing_ok=True)
            old_path = self._path(record, kind)
            if old_path and old_path != path:
                old_path.unlink(missing_ok=True)
            metadata = {'bytes': len(data), 'createdAt': _now_ms()}
            if kind == 'clip':
                metadata.update(type=content_type, durationMs=duration)
            record[kind] = metadata
            self._prune()
            self._save()
            return self._view(record)

    def media(self, incident_id, kind):
        with self.lock:
            record = self._record(incident_id)
            path = self._path(record, kind)
            if path is None or not path.is_file():
                raise HTTPException(404, 'Recording is not ready.')
            return path, record['clip']['type'] if kind == 'clip' else 'image/jpeg'

    def file_for_event(self, event_id, kind):
        with self.lock:
            record = next((item for item in self.records.values() if item['eventId'] == event_id), None)
            if record is None:
                return None
            try:
                return self.media(record['id'], kind)
            except HTTPException as exc:
                if exc.status_code == 404:
                    return None
                raise

    def delete(self, incident_id):
        with self.lock:
            self._record(incident_id)
            self._drop(incident_id)
            self._save()


store = IncidentStore()
register_incident_files(store.file_for_event)


@asynccontextmanager
async def lifespan(_app):
    store.prune()
    yield


class IncidentRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def validated(request):
            try:
                return await handler(request)
            except RequestValidationError as exc:
                # FastAPI's default error response echoes input, including
                # NaN/Infinity that JSONResponse cannot serialize. Keep the
                # useful field errors without echoing raw incident content.
                errors = [{key: error[key] for key in ('loc', 'msg', 'type')} for error in exc.errors()]
                raise HTTPException(422, errors) from None

        return validated


router = APIRouter(prefix='/incidents', lifespan=lifespan, route_class=IncidentRoute)


@router.post('')
def create_incident(body: CreateIncident):
    return store.create(body)


@router.get('')
def list_incidents(limit: int = Query(default=100, ge=1, le=1000)):
    return store.list(limit)


@router.get('/{incident_id}')
def get_incident(incident_id: str):
    return store.get(incident_id)


@router.patch('/{incident_id}')
def patch_incident(incident_id: str, body: PatchIncident):
    return store.patch(incident_id, body)


@router.post('/{incident_id}/timeline')
def append_timeline(incident_id: str, body: TimelineEntry):
    return store.timeline(incident_id, body)


async def _upload(incident_id, kind, request, duration=None):
    store.get(incident_id)
    content_type = request.headers.get('content-type', '').split(';', 1)[0].strip().lower()
    allowed = ('video/webm', 'video/mp4') if kind == 'clip' else ('image/jpeg',)
    if content_type not in allowed:
        raise HTTPException(415, 'Unsupported recording type.')
    limit = CLIP_LIMIT if kind == 'clip' else STILL_LIMIT
    length = request.headers.get('content-length')
    if length is not None:
        try:
            count = int(length)
            if count < 0:
                raise ValueError
        except ValueError:
            raise HTTPException(422, 'Invalid Content-Length.') from None
        if count > limit:
            raise HTTPException(413, 'Recording is too large.')
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > limit:
            raise HTTPException(413, 'Recording is too large.')
        data.extend(chunk)
    return store.upload(incident_id, kind, content_type, data, duration)


@router.put('/{incident_id}/clip')
async def upload_clip(incident_id: str, request: Request, x_duration_ms: str | None = Header(default=None)):
    duration = None
    if x_duration_ms is not None:
        if not re.fullmatch(r'[0-9]{1,16}', x_duration_ms):
            raise HTTPException(422, 'X-Duration-Ms must be a nonnegative integer.')
        duration = int(x_duration_ms)
    return await _upload(incident_id, 'clip', request, duration)


@router.put('/{incident_id}/still')
async def upload_still(incident_id: str, request: Request):
    return await _upload(incident_id, 'still', request)


@router.get('/{incident_id}/clip')
def get_clip(incident_id: str):
    path, content_type = store.media(incident_id, 'clip')
    return FileResponse(path, media_type=content_type, headers={'Cache-Control': 'no-store'})


@router.get('/{incident_id}/still')
def get_still(incident_id: str):
    path, content_type = store.media(incident_id, 'still')
    return FileResponse(path, media_type=content_type, headers={'Cache-Control': 'no-store'})


@router.delete('/{incident_id}', status_code=204)
def delete_incident(incident_id: str):
    store.delete(incident_id)
    return Response(status_code=204)
