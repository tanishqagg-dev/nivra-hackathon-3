import json
import os
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import guards
import incidents
from guards import GuardHub
from incidents import CreateIncident, IncidentStore


class IncidentTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.folder = Path(folder.name)
        self.hub = GuardHub(self.folder / 'guards.local.json')
        self.store = IncidentStore(self.folder / 'incidents.local.json', self.folder / 'incidents.local', self.hub)
        for patcher in (mock.patch.object(incidents, 'store', self.store),
                        mock.patch.object(guards, 'hub', self.hub),
                        mock.patch.object(guards, '_incident_file', self.store.file_for_event),
                        mock.patch.object(guards, 'PUBLIC_URL', 'https://guard.example')):
            patcher.start()
            self.addCleanup(patcher.stop)
        app = FastAPI()
        app.include_router(incidents.router)
        self.client = self.enterContext(TestClient(app))
        self.phone = self.enterContext(TestClient(guards.lan_app))

    def body(self, event='event-1', at=1000):
        return {'eventId': event, 'kind': 'fight', 'title': 'Possible fight', 'detail': 'Review the scene',
            'camera': 'Main gate', 'occurredAt': at, 'likelihood': 82}

    def create(self, event='event-1', at=1000):
        response = self.client.post('/incidents', json=self.body(event, at))
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def linked(self, name='Ravi'):
        guard = self.hub.add(name)
        token = self.hub.invite(guard['id'])['url'].split('#pair=')[1]
        secret, _ = self.hub.pair(token)
        return guard, {'Authorization': f'Bearer {secret}'}

    def upload(self, incident_id, kind='clip', data=b'0123456789', content_type=None, **headers):
        content_type = content_type or ('video/webm' if kind == 'clip' else 'image/jpeg')
        return self.client.put(f'/incidents/{incident_id}/{kind}', content=data,
            headers={'Content-Type': content_type, **headers})

    def test_idempotent_create_and_persistence_permissions(self):
        first = self.create()
        duplicate = self.create(at=5000)
        self.assertEqual(first, duplicate)
        self.assertRegex(first['id'], r'^inc_[A-Za-z0-9_-]{10}$')
        self.assertEqual(first['note'], '')
        self.assertIsNone(first['outcome'])
        self.assertEqual(first['timeline'], [{'at': 1000, 'label': 'Detected (82% likelihood)', 'by': None}])
        self.assertEqual(self.store.store.stat().st_mode & 0o777, 0o600)
        reloaded = IncidentStore(self.store.store, self.store.files, self.hub)
        self.assertEqual(reloaded.get(first['id']), first)
        self.assertEqual(self.client.get('/incidents/missing').status_code, 404)

    def test_concurrent_create_keeps_one_incident_per_event(self):
        body = CreateIncident(**self.body())
        with ThreadPoolExecutor(max_workers=8) as workers:
            results = list(workers.map(lambda _: self.store.create(body)['id'], range(24)))
        self.assertEqual(len(set(results)), 1)
        self.assertEqual(len(self.store.list()['incidents']), 1)
        self.assertEqual(len(json.loads(self.store.store.read_text())['incidents']), 1)

    def test_list_is_newest_first_and_limited(self):
        first = self.create('first', 2000)
        last = self.create('last', 1000)
        newest = self.create('newest', 3000)
        listed = self.client.get('/incidents').json()['incidents']
        self.assertEqual([item['id'] for item in listed], [newest['id'], first['id'], last['id']])
        self.assertEqual(len(self.client.get('/incidents?limit=2').json()['incidents']), 2)
        for limit in ('0', '-1', '1001', 'wat', '1.5'):
            self.assertEqual(self.client.get('/incidents?limit=' + limit).status_code, 422)

    def test_location_is_copied_and_guard_alerts_are_a_live_join(self):
        self.hub.set_location({'lat': 28.6139, 'lng': 77.209, 'label': 'Gate'})
        first = self.create(event='e' * 120)
        self.assertEqual(first['location'], {'lat': 28.6139, 'lng': 77.209, 'label': 'Gate'})
        self.assertEqual(first['guards'], [])
        guard, _ = self.linked()
        alert = self.hub.send({'guardId': guard['id'], 'eventId': first['eventId']})
        self.hub.send({'guardId': guard['id'], 'eventId': 'unrelated'})
        self.hub.set_location({'lat': 1.5, 'lng': 2.5})
        fetched = self.client.get('/incidents/' + first['id']).json()
        self.assertEqual(fetched['location'], first['location'])
        self.assertEqual([item['id'] for item in fetched['guards']], [alert['id']])
        self.hub.act(alert['id'], 'on_scene', 'Ravi')
        self.assertEqual(self.store.get(first['id'])['guards'][0]['status'], 'on_scene')

    def test_patch_note_outcome_and_timeline(self):
        incident_id = self.create()['id']
        url = '/incidents/' + incident_id
        patched = self.client.patch(url, json={'note': 'Review complete', 'outcome': 'acknowledged'}).json()
        self.assertEqual(patched['note'], 'Review complete')
        self.assertEqual(patched['outcome'], 'acknowledged')
        self.assertEqual(patched['timeline'][-1]['label'], 'Acknowledged')
        repeated = self.client.patch(url, json={'outcome': 'acknowledged'}).json()
        self.assertEqual(repeated['timeline'], patched['timeline'])
        appended = self.client.post(url + '/timeline', json={'label': 'Guard called: Asha', 'by': 'Mac operator'}).json()
        self.assertEqual(appended['timeline'][-1]['label'], 'Guard called: Asha')
        for outcome in ('guard_on_scene', 'police', 'cleared', 'dismissed', None):
            response = self.client.patch(url, json={'outcome': outcome})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['outcome'], outcome)
        cleared_note = self.client.patch(url, json={'note': ''}).json()
        self.assertEqual(cleared_note['note'], '')
        stamps = [item['at'] for item in cleared_note['timeline']]
        self.assertEqual(stamps, sorted(stamps))
        self.assertEqual(IncidentStore(self.store.store, self.store.files, self.hub).get(incident_id), cleared_note)

    def test_input_types_lengths_and_values(self):
        invalid = ({'eventId': 'e' * 121}, {'eventId': ''}, {'eventId': 123}, {'eventId': '   '},
            {'kind': 'violence'}, {'title': 't' * 121}, {'title': ''}, {'detail': 'd' * 2001},
            {'camera': None}, {'camera': 'c' * 121}, {'occurredAt': '1000'}, {'occurredAt': -1},
            {'occurredAt': True}, {'likelihood': -1}, {'likelihood': 101}, {'likelihood': '82'},
            {'likelihood': True}, {'extra': 'unknown'})
        for change in invalid:
            with self.subTest(change=next(iter(change))):
                self.assertEqual(self.client.post('/incidents', json={**self.body(), **change}).status_code, 422)
        for raw in ('[]', '{bad json', json.dumps({**self.body(), 'likelihood': float('nan')}),
                    json.dumps({**self.body(), 'occurredAt': float('inf')})):
            self.assertEqual(self.client.post('/incidents', content=raw, headers={'Content-Type': 'application/json'}).status_code, 422)
        body = {**self.body(), 'kind': 'test', 'likelihood': None}
        self.assertEqual(self.client.post('/incidents', json=body).json()['timeline'][0]['label'], 'Detected')
        url = '/incidents/' + self.create()['id']
        for bad in ({'note': 'n' * 501}, {'note': None}, {'note': 5}, {'outcome': 'resolved'}, {'outcome': 1}, {'camera': 'x'}):
            self.assertEqual(self.client.patch(url, json=bad).status_code, 422)
        for bad in ({'label': ''}, {'label': 'l' * 241}, {'label': 5}, {'label': 'ok', 'by': 'b' * 121}):
            self.assertEqual(self.client.post(url + '/timeline', json=bad).status_code, 422)

    def test_clip_and_still_download_range_replace_and_delete(self):
        incident_id = self.create()['id']
        url = '/incidents/' + incident_id
        self.assertEqual(self.client.get(url + '/clip').status_code, 404)
        self.assertEqual(self.client.get(url + '/still').status_code, 404)
        uploaded = self.upload(incident_id, **{'X-Duration-Ms': '5000'})
        self.assertEqual(uploaded.status_code, 200)
        self.assertEqual(uploaded.json()['clip']['bytes'], 10)
        self.assertEqual(uploaded.json()['clip']['durationMs'], 5000)
        full = self.client.get(url + '/clip')
        self.assertEqual(full.content, b'0123456789')
        self.assertEqual(full.headers['content-type'], 'video/webm')
        partial = self.client.get(url + '/clip', headers={'Range': 'bytes=2-5'})
        self.assertEqual((partial.status_code, partial.content), (206, b'2345'))
        self.assertEqual(partial.headers['content-range'], 'bytes 2-5/10')
        self.assertEqual(self.client.get(url + '/clip', headers={'Range': 'bytes=100-200'}).status_code, 416)
        self.assertEqual(self.upload(incident_id, content_type='video/mp4', data=b'mp4').status_code, 200)
        self.assertFalse((self.store.files / (incident_id + '.webm')).exists())
        self.assertEqual(self.client.get(url + '/clip').headers['content-type'], 'video/mp4')
        still = self.upload(incident_id, kind='still', data=b'jpeg')
        self.assertEqual(still.json()['still']['bytes'], 4)
        self.assertEqual(self.client.get(url + '/still').content, b'jpeg')
        for path in self.store.files.iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.client.delete(url).status_code, 204)
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(self.client.delete(url).status_code, 404)
        self.assertEqual(list(self.store.files.iterdir()), [])

    def test_media_size_type_duration_and_empty_body_limits(self):
        incident_id = self.create()['id']
        for kind, limit in (('clip', incidents.CLIP_LIMIT), ('still', incidents.STILL_LIMIT)):
            with self.subTest(kind=kind):
                self.assertEqual(self.upload(incident_id, kind, data=b'x' * (limit + 1)).status_code, 413)
                self.assertEqual(self.upload(incident_id, kind, content_type='application/octet-stream').status_code, 415)
                self.assertEqual(self.upload(incident_id, kind, data=b'').status_code, 422)
                # No Content-Length: the streaming body limit must still hold.
                with mock.patch.object(incidents, 'CLIP_LIMIT' if kind == 'clip' else 'STILL_LIMIT', 4):
                    response = self.client.put(f'/incidents/{incident_id}/{kind}', content=iter([b'123', b'456']),
                        headers={'Content-Type': 'video/webm' if kind == 'clip' else 'image/jpeg'})
                    self.assertEqual(response.status_code, 413)
                    self.assertEqual(self.upload(incident_id, kind, data=b'1234').status_code, 200)
        for duration in ('-1', 'NaN', '5.5', 'abc', ''):
            self.assertEqual(self.upload(incident_id, **{'X-Duration-Ms': duration}).status_code, 422)
        self.assertEqual(self.upload(incident_id, content_type='image/jpeg').status_code, 415)
        self.assertEqual(self.upload(incident_id, 'still', content_type='video/webm').status_code, 415)
        self.assertEqual(self.upload('missing').status_code, 404)

    def test_age_retention_on_startup_and_after_upload_clears_metadata(self):
        old = self.create('old')['id']
        self.upload(old)
        self.upload(old, 'still')
        expired = time.time() - incidents.RETENTION_SECONDS - 10
        for path in self.store.files.iterdir():
            os.utime(path, (expired, expired))
        reloaded = IncidentStore(self.store.store, self.store.files, self.hub)
        self.assertIsNone(reloaded.get(old)['clip'])
        self.assertIsNone(reloaded.get(old)['still'])
        self.assertEqual(list(self.store.files.iterdir()), [])
        self.assertIsNone(json.loads(self.store.store.read_text())['incidents'][0]['clip'])
        # Repeat without a restart: the next clip upload prunes old media.
        self.upload(old)
        self.upload(old, 'still')
        for path in self.store.files.iterdir():
            os.utime(path, (expired, expired))
        fresh = self.create('fresh')['id']
        self.upload(fresh)
        self.assertIsNone(self.store.get(old)['clip'])
        self.assertIsNone(self.store.get(old)['still'])
        self.assertIsNotNone(self.store.get(fresh)['clip'])

    def test_size_retention_evicts_oldest_clips_before_stills(self):
        oldest = self.create('oldest')['id']
        newer = self.create('newer')['id']
        self.upload(oldest, data=b'12345678')
        self.upload(oldest, 'still', data=b'jpeg')
        old_path, _ = self.store.media(oldest, 'clip')
        old_time = time.time() - 60
        os.utime(old_path, (old_time, old_time))
        with mock.patch.object(incidents, 'FOLDER_LIMIT', 13):
            result = self.upload(newer, data=b'87654321')
        self.assertEqual(result.status_code, 200)
        self.assertIsNone(self.store.get(oldest)['clip'])
        self.assertIsNotNone(self.store.get(oldest)['still'])
        self.assertIsNotNone(self.store.get(newer)['clip'])
        self.assertLessEqual(sum(path.stat().st_size for path in self.store.files.iterdir()), 13)
        # Stills alone also cannot leave the directory over quota.
        with mock.patch.object(incidents, 'FOLDER_LIMIT', 2):
            self.store.prune()
        self.assertEqual(list(self.store.files.iterdir()), [])

    def test_incident_cap_drops_oldest_with_files(self):
        oldest = self.create('oldest', 1)['id']
        self.upload(oldest)
        self.upload(oldest, 'still')
        with mock.patch.object(incidents, 'INCIDENT_LIMIT', 3):
            for number in range(2, 5):
                self.create(str(number), number)
        self.assertEqual(len(self.store.list()['incidents']), 3)
        self.assertEqual(self.client.get('/incidents/' + oldest).status_code, 404)
        self.assertEqual(list(self.store.files.iterdir()), [])

    def test_guard_flags_auth_ownership_readiness_and_range(self):
        guard, auth = self.linked()
        other, other_auth = self.linked('Asha')
        alert = self.hub.send({'guardId': guard['id'], 'eventId': 'event-1'})
        incident_id = self.create()['id']
        base = '/guard/api/alerts/' + alert['id']
        state = self.phone.get('/guard/api/state', headers=auth).json()['alerts'][0]
        self.assertFalse(state['clip'])
        self.assertFalse(state['still'])
        for kind in ('clip', 'still'):
            url = base + '/' + kind
            self.assertEqual(self.phone.get(url).status_code, 401)
            self.assertEqual(self.phone.get(url, headers={'Authorization': 'Bearer wrong'}).status_code, 401)
            self.assertEqual(self.phone.get(url, headers=other_auth).status_code, 404)
            self.assertEqual(self.phone.get(url, headers=auth).status_code, 404)
        self.upload(incident_id)
        self.upload(incident_id, 'still', data=b'jpeg')
        state = self.phone.get('/guard/api/state', headers=auth).json()['alerts'][0]
        self.assertTrue(state['clip'])
        self.assertTrue(state['still'])
        clip = self.phone.get(base + '/clip', headers={**auth, 'Range': 'bytes=0-3'})
        self.assertEqual((clip.status_code, clip.content), (206, b'0123'))
        self.assertEqual(clip.headers['cache-control'], 'no-store')
        self.assertEqual(self.phone.get(base + '/still', headers=auth).content, b'jpeg')
        self.assertEqual(self.phone.get(base + '/clip', headers=other_auth).status_code, 404)
        self.assertEqual(self.phone.get('/guard/api/state', headers=other_auth).json()['alerts'], [])
        self.client.delete('/incidents/' + incident_id)
        state = self.phone.get('/guard/api/state', headers=auth).json()['alerts'][0]
        self.assertFalse(state['clip'])
        self.assertFalse(state['still'])
        self.assertEqual(self.phone.get(base + '/clip', headers=auth).status_code, 404)


if __name__ == '__main__':
    unittest.main()
