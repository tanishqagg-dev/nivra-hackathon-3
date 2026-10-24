import { USB_PHONE_DEVICE, startUsbPhoneStream } from './UsbPhoneSource'

export interface CameraSource {
  start(deviceId?: string): Promise<MediaStream>
  stop(): void
  listDevices(): Promise<MediaDeviceInfo[]>
  getStream(): MediaStream | null
}

export class BrowserCameraSource implements CameraSource {
  private stream: MediaStream | null = null
  private requestVersion = 0

  async start(deviceId?: string): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera access is not supported in this browser.')
    }

    this.stop()
    const requestVersion = this.requestVersion

    if (deviceId === USB_PHONE_DEVICE) {
      this.stream = startUsbPhoneStream()
      return this.stream
    }

    const video: MediaTrackConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 60 },
      ...(deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: { ideal: 'user' } }),
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video,
    })

    // Permission prompts cannot be cancelled. Release a late stream if Stop or
    // another camera request happened while the browser was asking permission.
    if (requestVersion !== this.requestVersion) {
      for (const track of stream.getTracks()) track.stop()
      throw new DOMException('This camera request was cancelled.', 'AbortError')
    }

    this.stream = stream
    return stream
  }

  stop(): void {
    this.requestVersion += 1
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop()
    }
    this.stream = null
  }

  async listDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return []
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((device) => device.kind === 'videoinput')
  }

  getStream(): MediaStream | null {
    return this.stream
  }
}
