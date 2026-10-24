"""iPhone camera over a USB cable through macOS usbmuxd.

Adapted from NIVRA service/nivra/usb_transport.py. The installed NIVRA iPhone app
serves its latest camera JPEG on phone port 8940 and requires the 8-character
code it shows on screen. usbmuxd tunnels that port over the cable, so no Wi-Fi
or internet is needed.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import logging
import os
import plistlib
import re
import secrets
import socket
import struct
import subprocess
import tempfile
import threading
import time
from pathlib import Path

MAX_BODY = 3_200_000
PHONE_PORT = 8940
APP_BUNDLE = os.environ.get('NIVRA_IOS_BUNDLE', 'work.tanishq.nivra.ios')
# Same alphabet the phone uses for its own codes (no 0/O, 1/I).
CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
SETTINGS = Path(__file__).parent / 'usb.local.json'


class AppNotOpen(ConnectionError):
    """The phone is on the cable but NIVRA is not serving (closed, in the background, or locked)."""


class PhoneUnplugged(ConnectionError):
    """The linked phone is not on the USB cable right now."""


class VideoUnsupported(ConnectionError):
    """This NIVRA app build has no /v1/video route; use still frames."""


def _read_exact(stream, count):
    data = bytearray()
    while len(data) < count:
        chunk = stream.recv(count - len(data))
        if not chunk:
            raise OSError('USB connection closed')
        data.extend(chunk)
    return bytes(data)


def _mux(message, path='/var/run/usbmuxd'):
    stream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    stream.settimeout(4)
    try:
        stream.connect(path)
        body = plistlib.dumps({'ClientVersionString': 'NIVRA Vision Lab/1',
            'ProgName': 'NIVRA', 'kLibUSBMuxVersion': 3, **message})
        stream.sendall(struct.pack('<IIII', len(body) + 16, 1, 8, 1) + body)
        length, version, kind, tag = struct.unpack('<IIII', _read_exact(stream, 16))
        if not 16 <= length <= 1_000_000 or (version, kind, tag) != (1, 8, 1):
            raise OSError('Invalid USB response')
        return stream, plistlib.loads(_read_exact(stream, length - 16))
    except BaseException:
        stream.close()
        raise


def list_devices():
    """iPhones attached by cable. Wi-Fi-synced devices are ignored on purpose."""
    try:
        stream, response = _mux({'MessageType': 'ListDevices'})
    except (FileNotFoundError, ConnectionRefusedError):
        return []
    stream.close()
    result = []
    for device in response.get('DeviceList', []):
        properties = device.get('Properties', {})
        serial = properties.get('SerialNumber', '')
        if properties.get('ConnectionType') != 'USB' or not serial:
            continue
        result.append({'id': hashlib.sha256(serial.encode()).hexdigest()[:24],
            'muxId': device['DeviceID'], 'name': properties.get('DeviceName') or 'iPhone', 'serial': serial})
    return result


def _devicectl_id(serial):
    """devicectl wants the UDID; usbmuxd may report it without the dash. Find the matching one."""
    plain = serial.replace('-', '').upper()
    with tempfile.TemporaryDirectory(prefix='nivra-usb-') as folder:
        target = Path(folder) / 'devices.json'
        subprocess.run(['xcrun', 'devicectl', 'list', 'devices', '--json-output', str(target), '--timeout', '15'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        try:
            listing = json.loads(target.read_text())
        except (OSError, ValueError):
            return serial
    for device in listing.get('result', {}).get('devices', []):
        udid = (device.get('hardwareProperties') or device.get('properties', {}).get('hardware', {}) or {}).get('udid', '')
        if udid and udid.replace('-', '').upper() == plain:
            return device.get('identifier') or udid
    return serial


def launch_app(serial, code):
    """Open NIVRA on the phone over the cable, already in camera mode on `code`. Returns (ok, reason)."""
    url = f'nivra://usb?code={code}'
    with tempfile.TemporaryDirectory(prefix='nivra-usb-') as folder:
        target = Path(folder) / 'launch.json'
        try:
            result = subprocess.run(['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', _devicectl_id(serial),
                '--terminate-existing', '--activate', '--payload-url', url, APP_BUNDLE,
                '--json-output', str(target), '--timeout', '30'], capture_output=True, text=True, timeout=60)
        except FileNotFoundError:
            return False, 'no_xcode'
        except subprocess.TimeoutExpired:
            return False, 'launch_failed'
        details = (result.stdout + result.stderr + (target.read_text() if target.exists() else '')).lower()
    if result.returncode == 0:
        return True, ''
    if 'locked' in details or 'unlock' in details:
        return False, 'locked'
    if 'developer mode' in details:
        return False, 'developer_mode'
    if 'not installed' in details or 'no application' in details or 'unable to find' in details and 'bundle' in details:
        return False, 'not_installed'
    if 'pair' in details or 'trust' in details:
        return False, 'not_paired'
    return False, 'launch_failed'


AUTO_MESSAGES = {
    'idle': '',
    'launching': 'Opening NIVRA on the iPhone…',
    'connected': '',
    'locked': 'Unlock the iPhone. NIVRA opens by itself once it is unlocked.',
    'developer_mode': 'Turn on Developer Mode on the iPhone (Settings, Privacy and Security), then plug it in again.',
    'not_installed': 'NIVRA is not installed on this iPhone. Install it, then plug it in again.',
    'not_paired': 'Unlock the iPhone and tap Trust, then plug it in again.',
    'no_xcode': 'This Mac cannot open apps on the iPhone. Open NIVRA on the phone and type its code.',
    'launch_failed': 'Could not open NIVRA on the iPhone. Open it on the phone and type its code.',
    'needs_code': 'NIVRA opened but did not accept the Mac\'s code. Update NIVRA on the phone, or type the code it shows.',
}



def phone_get(device, code, path):
    video = isinstance(path, str) and re.fullmatch(r'/v1/video(\?after=[0-9]{1,16})?', path) is not None
    if path not in ('/v1/status', '/v1/frame') and not video:
        raise ValueError('Unsupported USB request')
    stream, response = _mux({'MessageType': 'Connect', 'DeviceID': device['muxId'],
        'PortNumber': socket.htons(PHONE_PORT)})
    try:
        if response.get('Number') != 0:
            # usbmuxd 3 = nothing listening on the phone port: the app is closed, in the background, or the phone is locked.
            raise AppNotOpen('Open NIVRA on the phone, start its camera and keep it on screen.')
        stream.sendall((f'GET {path} HTTP/1.1\r\nHost: localhost\r\n'
            f'X-Nivra-Key: {code}\r\nConnection: close\r\n\r\n').encode('ascii'))
        reply = http.client.HTTPResponse(stream)
        reply.begin()
        if reply.status in (401, 403):
            raise PermissionError('That code does not match. Check the code on the phone.')
        if reply.status == 204:
            return {}, b''
        if reply.status == 404 and video:
            raise VideoUnsupported('This NIVRA app sends still frames only.')
        if reply.status != 200:
            raise ConnectionError('Waiting for the phone camera. Keep NIVRA open on the phone.')
        length = reply.length
        if length is None or not 0 <= length <= MAX_BODY:
            raise OSError('Invalid USB frame size')
        data = reply.read(MAX_BODY + 1)
        if len(data) != length:
            raise OSError('Incomplete USB frame')
        return {key.lower(): value for key, value in reply.getheaders()}, data
    finally:
        stream.close()


class UsbPhone:
    """One linked phone at a time. The code stays in memory only.

    The link is kept by the phone's serial-derived id, not the usbmuxd DeviceID, so unplugging
    and replugging the cable resumes the same link without typing the code again.
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.device: dict | None = None
        self.code: str | None = None
        # Last outcome of a real request to the phone, for the status the Mac shows.
        self.state = 'idle'
        self.message = ''
        self.last_ok = 0.0
        self.state_since = time.time()
        self.linked_at = 0
        # Plug in and go: open NIVRA on the phone and link without typing a code.
        self.auto = self._load_auto()
        self.auto_state = 'idle'
        self.retry_after: dict[str, float] = {}

    @staticmethod
    def _load_auto():
        try:
            return json.loads(SETTINGS.read_text()).get('auto', True) is not False
        except (OSError, ValueError):
            return True

    def set_auto(self, enabled: bool):
        self.auto = bool(enabled)
        try:
            SETTINGS.write_text(json.dumps({'auto': self.auto}))
        except OSError:
            pass
        if not self.auto:
            self.auto_state = 'idle'
        # Turning it on (again) retries right away, for example after installing a newer NIVRA.
        self.retry_after.clear()
        return self.auto

    def auto_tick(self, launcher=None, sleep=time.sleep):
        """One pass of plug-in-and-go. Safe to call every second or two."""
        if not self.auto:
            return
        launcher = launcher or launch_app
        devices = list_devices()
        with self.lock:
            linked, state, since = self.device, self.state, self.state_since
        on_cable = next((item for item in devices if linked and item['id'] == linked['id']), None)
        if on_cable and state not in ('app_closed', 'wrong_code'):
            if self.auto_state not in ('connected',):
                self.auto_state = 'connected'
            return
        if on_cable and time.time() - since < 3:
            return  # give a briefly backgrounded app a moment to come back by itself
        if not devices:
            if self.auto_state != 'idle' and not linked:
                self.auto_state = 'idle'
            return
        target = on_cable or devices[0]
        if time.time() < self.retry_after.get(target['id'], 0):
            return
        code = ''.join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        self.auto_state = 'launching'
        ok, reason = launcher(target['serial'], code)
        if not ok:
            self.auto_state = reason
            self.retry_after[target['id']] = time.time() + (5 if reason == 'locked' else 45)
            return
        for _ in range(40):
            try:
                phone_get(target, code, '/v1/status')
            except PermissionError:
                break  # an older app ignored our code
            except (ConnectionError, OSError):
                sleep(0.5)
                continue
            with self.lock:
                self.device, self.code = target, code
                self.state, self.message, self.last_ok, self.state_since = 'streaming', '', time.time(), time.time()
                self.linked_at = int(time.time() * 1000)
            self.auto_state = 'connected'
            self.retry_after.pop(target['id'], None)
            return
        self.auto_state = 'needs_code'
        self.retry_after[target['id']] = time.time() + 60

    def auto_loop(self, stop: threading.Event, interval=1.5):
        while not stop.wait(interval):
            try:
                self.auto_tick()
            except Exception:  # keep the loop alive; the next pass retries
                logging.exception('USB auto-connect pass failed')

    def _note(self, state, message=''):
        with self.lock:
            if state != self.state:
                self.state_since = time.time()
            self.state, self.message = state, message
            if state == 'streaming':
                self.last_ok = time.time()

    def _current(self):
        """The linked phone with its current DeviceID, or LookupError when it is not on the cable."""
        with self.lock:
            device, code = self.device, self.code
        if device is None or code is None:
            raise LookupError('No phone linked. Connect the phone first.')
        found = next((item for item in list_devices() if item['id'] == device['id']), None)
        if found is None:
            self._note('unplugged', 'The iPhone is not on the cable. Plug it back in and unlock it.')
            raise PhoneUnplugged('The iPhone is not on the cable. Plug it back in and unlock it.')
        if found['muxId'] != device['muxId']:
            with self.lock:
                if self.device and self.device['id'] == found['id']:
                    self.device = found
        return found, code

    def _get(self, path):
        device, code = self._current()
        try:
            result = phone_get(device, code, path)
        except PermissionError as exc:
            self._note('wrong_code', str(exc)); raise
        except VideoUnsupported:
            raise
        except AppNotOpen as exc:
            self._note('app_closed', str(exc)); raise
        except (ConnectionError, OSError) as exc:
            self._note('waiting', 'Waiting for the phone camera. Keep NIVRA open on the phone.'); raise ConnectionError(str(exc)) from exc
        self._note('streaming')
        return result

    def status(self):
        devices = list_devices()
        with self.lock:
            linked = self.device
            state, message, last_ok = self.state, self.message, self.last_ok
        on_cable = bool(linked and any(item['id'] == linked['id'] for item in devices))
        if linked and not on_cable:
            state, message = 'unplugged', 'The iPhone is not on the cable. Plug it back in and unlock it.'
        elif linked and state == 'streaming' and time.time() - last_ok > 6:
            state, message = 'waiting', 'No video for a few seconds. Keep NIVRA open on the phone.'
        auto = {'enabled': self.auto, 'state': self.auto_state if self.auto else 'idle', 'message': AUTO_MESSAGES.get(self.auto_state, '') if self.auto else ''}
        result = [{'id': item['id'], 'name': item['name'], 'linked': bool(linked and linked['id'] == item['id'])} for item in devices]
        if linked and not on_cable:
            # Still linked: show it so the Mac can say the cable came out instead of forgetting the phone.
            result.append({'id': linked['id'], 'name': linked['name'], 'linked': True})
        return {'devices': result, 'auto': auto, 'link': None if not linked else {
            'id': linked['id'], 'name': linked['name'], 'onCable': on_cable, 'state': state if linked else 'idle',
            'message': message, 'lastFrameAt': int(last_ok * 1000) or None, 'linkedAt': self.linked_at or None}}

    def connect(self, device_id: str, code: str):
        code = code.upper().replace(' ', '').replace('-', '')
        if re.fullmatch(r'[A-Z0-9]{8}', code) is None:
            raise ValueError('Enter the eight-character code shown on the phone.')
        device = next((item for item in list_devices() if item['id'] == device_id), None)
        if device is None:
            raise LookupError('Phone not found. Check the cable and unlock the phone.')
        try:
            _, body = phone_get(device, code, '/v1/status')
        except AppNotOpen as exc:
            raise AppNotOpen('Open NIVRA on the phone, tap Other options, then Start camera without scanning.') from exc
        try:
            details = json.loads(body)
        except ValueError:
            details = {}
        with self.lock:
            self.device, self.code = device, code
            self.state, self.message, self.last_ok = 'streaming', '', time.time()
            self.linked_at = int(time.time() * 1000)
        return {'id': device['id'], 'name': device['name'], 'phone': details if isinstance(details, dict) else {}}

    def disconnect(self):
        with self.lock:
            self.device = self.code = None
            self.state, self.message = 'idle', ''

    def frame(self):
        return self._get('/v1/frame')

    def video(self, after: int | None):
        """H.264 packets newer than `after` (JSON from the phone). Empty when nothing new."""
        path = '/v1/video' if after is None else f'/v1/video?after={int(after)}'
        return self._get(path)[1]
