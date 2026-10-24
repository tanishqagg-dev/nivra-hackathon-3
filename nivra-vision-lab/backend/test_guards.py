import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

import guards
from guards import GuardHub


class GuardHubTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.store = Path(self.folder.name) / 'guards.local.json'
        self.hub = GuardHub(self.store)
        for patcher in (mock.patch.object(guards, 'lan_address', return_value='192.168.1.20'), mock.patch.object(guards, 'PUBLIC_URL', '')):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self.folder.cleanup)

    def linked(self, name='Ravi'):
        guard = self.hub.add(name)
        token = self.hub.invite(guard['id'])['url'].split('#pair=')[1]
        secret, _ = self.hub.pair(token)
        return guard, f'Bearer {secret}'

    def test_qr_is_single_use_and_points_at_the_wifi_address(self):
        guard = self.hub.add('Ravi')
        url = self.hub.invite(guard['id'])['url']
        self.assertTrue(url.startswith(f'http://192.168.1.20:{guards.GUARD_PORT}/guard#pair='))
        token = url.split('#pair=')[1]
        self.hub.pair(token)
        with self.assertRaises(HTTPException) as reused:
            self.hub.pair(token)
        self.assertEqual(reused.exception.status_code, 403)

    def test_public_address_is_used_for_the_qr_when_set(self):
        guard = self.hub.add('Ravi')
        with mock.patch.object(guards, 'PUBLIC_URL', 'https://nivra.aestrum.in'):
            self.assertRegex(self.hub.invite(guard['id'])['url'], r'^https://nivra\.aestrum\.in/guard#pair=[A-Za-z0-9_-]{43}$')

    def test_alert_carries_the_camera_location_at_send_time(self):
        guard, auth = self.linked()
        self.hub.set_location({'lat': 28.6139, 'lng': 77.209, 'accuracy': 18, 'label': 'Main gate'})
        alert = self.hub.send({'guardId': guard['id'], 'eventId': 'e1'})
        self.assertEqual((alert['location']['lat'], alert['location']['label']), (28.6139, 'Main gate'))
        self.hub.set_location({'lat': 1.5, 'lng': 2.5})
        seen = self.hub.guard_view(self.hub.authenticate(auth))['alerts'][0]['location']
        self.assertEqual(seen['lat'], 28.6139)
        self.assertEqual(GuardHub(self.store).location['lat'], 1.5)

    def test_invalid_location_is_rejected(self):
        for bad in ({'lat': 120, 'lng': 0}, {'lat': 'x', 'lng': 1}, {'lat': 0, 'lng': 0}):
            with self.assertRaises(HTTPException):
                self.hub.set_location(bad)

    def test_expired_qr_is_rejected(self):
        guard = self.hub.add('Ravi')
        token = self.hub.invite(guard['id'])['url'].split('#pair=')[1]
        with mock.patch.object(guards.time, 'monotonic', return_value=10**12):
            with self.assertRaises(HTTPException):
                self.hub.pair(token)

    def test_unlinked_guard_cannot_receive_alert(self):
        guard = self.hub.add('Ravi')
        with self.assertRaises(HTTPException) as error:
            self.hub.send({'guardId': guard['id'], 'title': 'Possible fight'})
        self.assertEqual(error.exception.status_code, 409)

    def test_alert_flow_and_police_record(self):
        guard, auth = self.linked()
        alert = self.hub.send({'guardId': guard['id'], 'eventId': 'e1', 'title': 'Possible fight', 'camera': 'iPhone USB'})
        record = self.hub.authenticate(auth)
        self.assertEqual([item['id'] for item in self.hub.guard_view(record)['alerts']], [alert['id']])
        self.assertEqual(self.hub.act(alert['id'], 'ack', 'Ravi')['status'], 'acknowledged')
        police = self.hub.act(alert['id'], 'police', 'Ravi')['police']
        self.assertEqual(police['by'], 'Ravi')
        # A second tap keeps the first record.
        self.assertEqual(self.hub.act(alert['id'], 'police', 'Mac operator')['police'], police)
        self.assertEqual(self.hub.act(alert['id'], 'on_scene', 'Ravi')['status'], 'on_scene')
        self.assertEqual(self.hub.act(alert['id'], 'clear', 'Ravi')['status'], 'cleared')
        with self.assertRaises(HTTPException):
            self.hub.act(alert['id'], 'ack', 'Ravi')

    def test_duplicate_send_for_same_event_is_blocked(self):
        guard, _ = self.linked()
        self.hub.send({'guardId': guard['id'], 'eventId': 'e1'})
        with self.assertRaises(HTTPException) as error:
            self.hub.send({'guardId': guard['id'], 'eventId': 'e1'})
        self.assertEqual(error.exception.status_code, 409)

    def test_guard_sees_only_own_alerts(self):
        first, first_auth = self.linked('Ravi')
        second, _ = self.linked('Asha')
        self.hub.send({'guardId': second['id'], 'title': 'Other'})
        self.assertEqual(self.hub.guard_view(self.hub.authenticate(first_auth))['alerts'], [])

    def test_removed_guard_phone_is_rejected_and_secret_is_hashed_on_disk(self):
        guard, auth = self.linked()
        self.assertNotIn(auth[7:], self.store.read_text())
        self.assertEqual(GuardHub(self.store).authenticate(auth)['id'], guard['id'])
        self.hub.remove(guard['id'])
        with self.assertRaises(HTTPException) as error:
            self.hub.authenticate(auth)
        self.assertEqual(error.exception.status_code, 403)


if __name__ == '__main__':
    unittest.main()
