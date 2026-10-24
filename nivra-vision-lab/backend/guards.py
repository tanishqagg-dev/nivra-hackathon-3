"""Guard phones on the same Wi-Fi as this Mac.

Two surfaces share one GuardHub:
- `owner` routes mount on the loopback inference app (reached through Vite).
- `lan_app` listens on the Wi-Fi interface and serves only the guard page and
  the guard's own alerts. It never exposes camera video, model scores or other
  guards.

Alerts start from a human on the Mac. Nothing here calls police automatically;
the guard (or the Mac operator) taps the police button, which dials and records
that a person made the call.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import socket
import subprocess
import threading
import time
from pathlib import Path

from fastapi import APIRouter, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse

GUARD_PORT = int(os.environ.get('NIVRA_GUARD_PORT', '18766'))
# Public HTTPS address that forwards /guard to this listener (Vercel → Tailscale Funnel).
# Empty means guard phones use this Mac's Wi-Fi address instead.
PUBLIC_URL = os.environ.get('NIVRA_GUARD_PUBLIC_URL', '').rstrip('/')
INVITE_SECONDS = 300
ONLINE_SECONDS = 8
STATIC = Path(__file__).parent / 'guard_static'
STORE = Path(__file__).parent / 'guards.local.json'
SHIFTS = ('on_shift', 'break', 'off')
ACTIONS = ('ack', 'decline', 'on_scene', 'clear', 'police')

# Registered by incidents.py. Keep this module independent of the owner store.
_incident_file = lambda event_id, kind: None


def register_incident_files(lookup):
    global _incident_file
    _incident_file = lookup


def _now_ms():
    return int(time.time() * 1000)


def _digest(value: str):
    return hashlib.sha256(value.encode()).hexdigest()


def _clean(value, limit=60):
    return ''.join(char for char in str(value or '') if char.isprintable()).strip()[:limit]


def _location(value):
    """Validated camera position: WGS84 degrees, optional accuracy in metres and a place name."""
    if not isinstance(value, dict):
        raise HTTPException(422, 'Send a location with latitude and longitude.')
    try:
        lat, lng = float(value.get('lat')), float(value.get('lng'))
    except (TypeError, ValueError):
        raise HTTPException(422, 'Latitude and longitude must be numbers.') from None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180) or (lat == 0 and lng == 0):
        raise HTTPException(422, 'That location is outside the map.')
    accuracy = value.get('accuracy')
    try:
        accuracy = round(float(accuracy)) if accuracy is not None else None
    except (TypeError, ValueError):
        accuracy = None
    return {'lat': round(lat, 6), 'lng': round(lng, 6), 'accuracy': accuracy if accuracy and 0 < accuracy < 100_000 else None,
        'label': _clean(value.get('label'), 80) or None, 'updatedAt': _now_ms()}


def lan_address():
    """Best private IPv4 of this Mac. Works without internet."""
    for interface in ('en0', 'en1', 'en2', 'bridge100'):
        try:
            found = subprocess.run(['ipconfig', 'getifaddr', interface], capture_output=True, text=True, timeout=2).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            continue
        if found:
            return found
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(('10.255.255.255', 1))
        found = probe.getsockname()[0]
        return None if found.startswith('127.') else found
    except OSError:
        return None
    finally:
        probe.close()


class GuardHub:
    def __init__(self, store: Path = STORE):
        self.store = store
        self.lock = threading.Lock()
        self.guards: dict[str, dict] = {}
        self.invites: dict[str, dict] = {}
        self.alerts: list[dict] = []
        self.seen: dict[str, int] = {}
        self.location: dict | None = None
        self._load()

    # Persistence keeps names, shifts and hashed phone secrets across restarts.
    def _load(self):
        try:
            data = json.loads(self.store.read_text())
            for guard in data.get('guards', []):
                if isinstance(guard, dict) and isinstance(guard.get('id'), str):
                    self.guards[guard['id']] = {'id': guard['id'], 'name': _clean(guard.get('name')) or 'Guard',
                        'shift': guard.get('shift') if guard.get('shift') in SHIFTS else 'off',
                        'secrets': [value for value in guard.get('secrets', []) if isinstance(value, str)][-3:]}
            try:
                self.location = _location(data.get('location')) if data.get('location') else None
            except HTTPException:
                self.location = None
        except (OSError, ValueError):
            pass

    def _save(self):
        payload = {'guards': list(self.guards.values()), 'location': self.location}
        temporary = self.store.with_suffix('.tmp')
        temporary.write_text(json.dumps(payload))
        os.chmod(temporary, 0o600)
        temporary.replace(self.store)

    def _public_guard(self, guard):
        last = self.seen.get(guard['id'], 0)
        return {'id': guard['id'], 'name': guard['name'], 'shift': guard['shift'], 'paired': bool(guard['secrets']),
            'online': _now_ms() - last < ONLINE_SECONDS * 1000, 'lastSeen': last or None}

    def snapshot(self):
        with self.lock:
            address = lan_address()
            return {'guards': [self._public_guard(guard) for guard in self.guards.values()],
                'alerts': list(self.alerts[:30]), 'lan': {'host': address, 'port': GUARD_PORT}, 'publicUrl': PUBLIC_URL or None, 'location': self.location}

    def add(self, name: str):
        name = _clean(name)
        if not name:
            raise HTTPException(422, 'Enter the guard name.')
        with self.lock:
            if len(self.guards) >= 30:
                raise HTTPException(409, 'Remove a guard before adding another.')
            guard = {'id': secrets.token_hex(6), 'name': name, 'shift': 'off', 'secrets': []}
            self.guards[guard['id']] = guard
            self._save()
            return self._public_guard(guard)

    def remove(self, guard_id: str):
        with self.lock:
            if self.guards.pop(guard_id, None) is None:
                raise HTTPException(404, 'Guard not found.')
            self.invites = {key: value for key, value in self.invites.items() if value['guardId'] != guard_id}
            self.alerts = [alert for alert in self.alerts if alert['guardId'] != guard_id]
            self._save()

    def invite(self, guard_id: str):
        address = None if PUBLIC_URL else lan_address()
        if not PUBLIC_URL and not address:
            raise HTTPException(409, 'Join a Wi-Fi network on this Mac, then try again.')
        token = secrets.token_urlsafe(32)
        with self.lock:
            if guard_id not in self.guards:
                raise HTTPException(404, 'Guard not found.')
            now = time.monotonic()
            self.invites = {key: value for key, value in self.invites.items() if value['expires'] > now}
            self.invites[_digest(token)] = {'guardId': guard_id, 'expires': now + INVITE_SECONDS}
        base = PUBLIC_URL or f'http://{address}:{GUARD_PORT}'
        return {'url': f'{base}/guard#pair={token}', 'expiresInSeconds': INVITE_SECONDS}

    def pair(self, token: str):
        if not isinstance(token, str) or not 30 <= len(token) <= 100:
            raise HTTPException(400, 'This pairing link is invalid. Ask for a new QR.')
        with self.lock:
            entry = self.invites.pop(_digest(token), None)
            if entry is None or entry['expires'] <= time.monotonic():
                raise HTTPException(403, 'This QR expired or was already used. Ask for a new QR.')
            guard = self.guards.get(entry['guardId'])
            if guard is None:
                raise HTTPException(403, 'This guard was removed. Ask for a new QR.')
            secret = secrets.token_urlsafe(32)
            guard['secrets'] = (guard['secrets'] + [_digest(secret)])[-3:]
            self.seen[guard['id']] = _now_ms()
            self._save()
            return secret, self._public_guard(guard)

    def authenticate(self, authorization: str | None):
        if not authorization or not authorization.startswith('Bearer '):
            raise HTTPException(401, 'Scan your guard QR to connect this phone.')
        hashed = _digest(authorization[7:].strip())
        with self.lock:
            for guard in self.guards.values():
                if any(secrets.compare_digest(hashed, value) for value in guard['secrets']):
                    self.seen[guard['id']] = _now_ms()
                    return guard
        raise HTTPException(403, 'This phone is no longer linked. Ask for a new guard QR.')

    def guard_view(self, guard):
        cutoff = _now_ms() - 30 * 60_000
        with self.lock:
            alerts = [alert for alert in self.alerts if alert['guardId'] == guard['id']
                and (alert['status'] != 'cleared' or (alert['clearedAt'] or 0) > cutoff)][:10]
            result = {'guard': self._public_guard(guard), 'alerts': [dict(alert) for alert in alerts], 'serverTime': _now_ms()}
        # The incident store joins back to this hub. Never take its lock while
        # holding the hub lock.
        for alert in result['alerts']:
            for kind in ('clip', 'still'):
                alert[kind] = _incident_file(alert['eventId'], kind) is not None
        return result

    def alerts_for_event(self, event_id):
        with self.lock:
            # Alerts contain nested location/police records; callers cannot
            # mutate the live hub through the returned view.
            return json.loads(json.dumps([alert for alert in self.alerts if alert['eventId'] == event_id]))

    def incident_location(self):
        with self.lock:
            return {key: self.location.get(key) for key in ('lat', 'lng', 'label')} if self.location else None

    def set_shift(self, guard, shift):
        if shift not in SHIFTS:
            raise HTTPException(422, 'Unknown shift state.')
        with self.lock:
            guard['shift'] = shift
            self._save()
            return self._public_guard(guard)

    def set_location(self, body: dict):
        with self.lock:
            self.location = _location(body) if body else None
            self._save()
            return self.location

    def send(self, body: dict):
        guard_id = body.get('guardId')
        with self.lock:
            guard = self.guards.get(guard_id)
            if guard is None:
                raise HTTPException(404, 'Guard not found.')
            if not guard['secrets']:
                raise HTTPException(409, f'{guard["name"]} has not linked a phone yet.')
            event_id = _clean(body.get('eventId'), 120)
            if event_id and any(alert['eventId'] == event_id and alert['guardId'] == guard_id and alert['status'] != 'cleared' for alert in self.alerts):
                raise HTTPException(409, f'Already sent to {guard["name"]}.')
            alert = {'id': secrets.token_hex(8), 'guardId': guard_id, 'guardName': guard['name'], 'eventId': event_id or None,
                'title': _clean(body.get('title'), 80) or 'Possible fight', 'detail': _clean(body.get('detail'), 240) or 'Check the scene.',
                'camera': _clean(body.get('camera'), 60) or 'Camera', 'note': _clean(body.get('note'), 160) or None,
                'sentAt': _now_ms(), 'ackAt': None, 'declinedAt': None, 'onSceneAt': None, 'clearedAt': None,
                'police': None, 'status': 'sent', 'revision': 1,
                # Where the camera is. Copied at send time so later edits do not move an open alert.
                'location': dict(self.location) if self.location else None}
            self.alerts.insert(0, alert)
            del self.alerts[50:]
            return alert

    def act(self, alert_id: str, action: str, actor: str):
        if action not in ACTIONS:
            raise HTTPException(422, 'Unknown action.')
        with self.lock:
            alert = next((item for item in self.alerts if item['id'] == alert_id), None)
            if alert is None:
                raise HTTPException(404, 'Alert not found.')
            now = _now_ms()
            if action == 'police':
                # A record that a person placed the call. It does not dial anyone.
                if not alert['police']:
                    alert['police'] = {'at': now, 'by': actor}
            elif alert['status'] == 'cleared':
                raise HTTPException(409, 'This alert is already cleared.')
            elif action == 'ack':
                alert['ackAt'] = alert['ackAt'] or now
                alert['status'] = 'acknowledged'
            elif action == 'decline':
                alert['declinedAt'] = now
                alert['status'] = 'declined'
            elif action == 'on_scene':
                alert['ackAt'] = alert['ackAt'] or now
                alert['onSceneAt'] = alert['onSceneAt'] or now
                alert['status'] = 'on_scene'
            elif action == 'clear':
                alert['ackAt'] = alert['ackAt'] or now
                alert['clearedAt'] = now
                alert['status'] = 'cleared'
            alert['revision'] += 1
            return dict(alert)

    def owned_alert(self, guard, alert_id):
        with self.lock:
            alert = next((item for item in self.alerts if item['id'] == alert_id and item['guardId'] == guard['id']), None)
            if alert is None:
                raise HTTPException(404, 'Alert not found.')
            return dict(alert)


hub = GuardHub()


async def _json(request: Request, limit=4096):
    body = await request.body()
    if len(body) > limit:
        raise HTTPException(413, 'Request is too large.')
    try:
        value = json.loads(body or b'{}')
    except ValueError:
        raise HTTPException(400, 'Invalid request.') from None
    if not isinstance(value, dict):
        raise HTTPException(400, 'Invalid request.')
    return value


# Owner routes: loopback only, reached through the Vite proxy on this Mac.
owner = APIRouter(prefix='/guards')


@owner.get('')
async def owner_state():
    return hub.snapshot()


@owner.post('')
async def owner_add(request: Request):
    return hub.add((await _json(request)).get('name'))


@owner.delete('/{guard_id}', status_code=204)
async def owner_remove(guard_id: str):
    hub.remove(guard_id)


@owner.post('/{guard_id}/invite')
async def owner_invite(guard_id: str):
    return hub.invite(guard_id)


@owner.put('/location')
async def owner_location(request: Request):
    return hub.set_location(await _json(request)) or {}


@owner.post('/alerts')
async def owner_send(request: Request):
    return hub.send(await _json(request))


@owner.post('/alerts/{alert_id}/{action}')
async def owner_act(alert_id: str, action: str):
    if action not in ('police', 'clear'):
        raise HTTPException(422, 'Unknown action.')
    return hub.act(alert_id, action, 'Mac operator')


# Guard phone surface on the Wi-Fi interface.
lan_app = FastAPI(title='NIVRA guard phones', docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)


@lan_app.middleware('http')
async def no_store(request: Request, call_next):
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    return response


@lan_app.get('/')
async def root():
    return RedirectResponse('/guard')


@lan_app.get('/guard')
@lan_app.get('/guard/')
async def guard_page():
    return FileResponse(STATIC / 'index.html')


@lan_app.get('/guard/{name}')
async def guard_asset(name: str):
    if name not in ('app.js', 'app.css', 'nivra-mark.png', 'favicon.png', 'inter.woff2', 'manrope.woff2'):
        raise HTTPException(404)
    return FileResponse(STATIC / name)


@lan_app.post('/guard/api/pair')
async def guard_pair(request: Request):
    secret, guard = hub.pair((await _json(request)).get('token'))
    return {'secret': secret, 'guard': guard}


@lan_app.get('/guard/api/state')
async def guard_state(authorization: str | None = Header(default=None)):
    return hub.guard_view(hub.authenticate(authorization))


@lan_app.post('/guard/api/shift')
async def guard_shift(request: Request, authorization: str | None = Header(default=None)):
    guard = hub.authenticate(authorization)
    return hub.set_shift(guard, (await _json(request)).get('shift'))


@lan_app.post('/guard/api/alerts/{alert_id}')
async def guard_act(alert_id: str, request: Request, authorization: str | None = Header(default=None)):
    guard = hub.authenticate(authorization)
    hub.owned_alert(guard, alert_id)
    return hub.act(alert_id, (await _json(request)).get('action'), guard['name'])


def _guard_media(alert_id, kind, authorization):
    try:
        guard = hub.authenticate(authorization)
    except HTTPException as exc:
        if exc.status_code == 403:
            raise HTTPException(401, exc.detail, headers={'WWW-Authenticate': 'Bearer'}) from None
        raise
    alert = hub.owned_alert(guard, alert_id)
    media = _incident_file(alert['eventId'], kind)
    if media is None:
        raise HTTPException(404, 'Recording is not ready.')
    path, content_type = media
    return FileResponse(path, media_type=content_type)


@lan_app.get('/guard/api/alerts/{alert_id}/clip')
async def guard_clip(alert_id: str, authorization: str | None = Header(default=None)):
    return _guard_media(alert_id, 'clip', authorization)


@lan_app.get('/guard/api/alerts/{alert_id}/still')
async def guard_still(alert_id: str, authorization: str | None = Header(default=None)):
    return _guard_media(alert_id, 'still', authorization)
