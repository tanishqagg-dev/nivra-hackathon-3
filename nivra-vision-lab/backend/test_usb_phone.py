"""USB phone link survives unplug/replug and reports clear states. No real phone needed."""
import unittest
from unittest import mock

import usb_phone as u


class FakeBus:
    def __init__(self):
        self.devices = [{'id': 'phone-a', 'muxId': 7, 'name': 'Asha iPhone', 'serial': '00008140-AAAA'}]
        self.app_open = True
        self.code = 'ABCD2345'
        self.calls = []

    def list_devices(self):
        return [dict(item) for item in self.devices]

    def phone_get(self, device, code, path):
        self.calls.append((device['muxId'], path))
        if not any(item['muxId'] == device['muxId'] for item in self.devices):
            raise ConnectionError('stale device id')
        if not self.app_open:
            raise u.AppNotOpen('Open NIVRA on the phone, start its camera and keep it on screen.')
        if code != self.code:
            raise PermissionError('That code does not match. Check the code on the phone.')
        return {}, b'{"ok":true}'


class UsbPhoneTest(unittest.TestCase):
    def setUp(self):
        self.bus = FakeBus()
        patches = [mock.patch.object(u, 'list_devices', self.bus.list_devices), mock.patch.object(u, 'phone_get', self.bus.phone_get)]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.phone = u.UsbPhone()
        self.phone.connect('phone-a', 'abcd-2345')

    def test_replug_resumes_with_the_new_device_id(self):
        self.assertEqual(self.phone.video(None), b'{"ok":true}')
        # Cable out: the link stays, the Mac is told why.
        self.bus.devices = []
        with self.assertRaises(u.PhoneUnplugged):
            self.phone.video(None)
        status = self.phone.status()
        self.assertEqual(status['link']['state'], 'unplugged')
        self.assertFalse(status['link']['onCable'])
        self.assertTrue(status['devices'][0]['linked'])
        # Cable back in: usbmuxd hands out a new DeviceID; no new code needed.
        self.bus.devices = [{'id': 'phone-a', 'muxId': 31, 'name': 'Asha iPhone', 'serial': '00008140-AAAA'}]
        self.assertEqual(self.phone.video(None), b'{"ok":true}')
        self.assertEqual(self.bus.calls[-1][0], 31)
        self.assertEqual(self.phone.status()['link']['state'], 'streaming')

    def test_app_closed_and_wrong_code_are_reported(self):
        self.bus.app_open = False
        with self.assertRaises(u.AppNotOpen):
            self.phone.frame()
        self.assertEqual(self.phone.status()['link']['state'], 'app_closed')
        self.bus.app_open = True
        self.bus.code = 'ZZZZ9999'
        with self.assertRaises(PermissionError):
            self.phone.frame()
        self.assertEqual(self.phone.status()['link']['state'], 'wrong_code')

    def test_unlink_clears_state(self):
        self.phone.disconnect()
        self.assertIsNone(self.phone.status()['link'])
        with self.assertRaises(LookupError):
            self.phone.video(None)



class AutoConnectTest(unittest.TestCase):
    def setUp(self):
        self.bus = FakeBus()
        self.bus.code = None  # the phone takes whatever code the Mac launched it with
        def phone_get(device, code, path):
            if self.bus.code is None:
                raise u.AppNotOpen('not open yet')
            if code != self.bus.code:
                raise PermissionError('wrong code')
            return {}, b'{}'
        for patch in (mock.patch.object(u, 'list_devices', self.bus.list_devices), mock.patch.object(u, 'phone_get', phone_get),
                      mock.patch.object(u, 'SETTINGS', u.Path('/nonexistent/usb.local.json'))):
            patch.start()
            self.addCleanup(patch.stop)
        self.phone = u.UsbPhone()
        self.launched = []

    def launcher(self, serial, code):
        self.launched.append((serial, code))
        self.bus.code = code
        return True, ''

    def test_plug_in_opens_the_app_and_links_without_typing(self):
        self.phone.auto_tick(launcher=self.launcher, sleep=lambda _: None)
        self.assertEqual(len(self.launched), 1)
        status = self.phone.status()
        self.assertTrue(status['devices'][0]['linked'])
        self.assertEqual(status['auto']['state'], 'connected')
        self.assertRegex(self.launched[0][1], r'^[A-HJ-NP-Z2-9]{8}$')
        # Already streaming: no second launch.
        self.phone.auto_tick(launcher=self.launcher, sleep=lambda _: None)
        self.assertEqual(len(self.launched), 1)

    def test_locked_phone_is_reported_and_retried_soon(self):
        self.phone.auto_tick(launcher=lambda serial, code: (False, 'locked'), sleep=lambda _: None)
        status = self.phone.status()
        self.assertEqual(status['auto']['state'], 'locked')
        self.assertIn('Unlock', status['auto']['message'])
        self.assertIsNone(status['link'])

    def test_old_app_that_ignores_the_code_asks_for_it(self):
        def stubborn(serial, code):
            self.bus.code = 'OLDCODE2'
            return True, ''
        self.phone.auto_tick(launcher=stubborn, sleep=lambda _: None)
        self.assertEqual(self.phone.status()['auto']['state'], 'needs_code')

    def test_auto_off_does_nothing(self):
        self.phone.auto = False
        self.phone.auto_tick(launcher=self.launcher, sleep=lambda _: None)
        self.assertEqual(self.launched, [])


if __name__ == '__main__':
    unittest.main()
