import { useCallback, useEffect, useState } from 'react'
import { onUsbStreamStatus, type UsbStreamStatus } from '../services/UsbPhoneSource'

export type UsbDevice = { id: string; name: string; linked: boolean }
/** The backend's view of the linked phone: on the cable or not, and what the last request saw. */
/** Plug-in-and-go: the Mac opens NIVRA on a plugged-in iPhone and links it without a typed code. */
export type UsbAuto = { enabled: boolean; state: 'idle' | 'launching' | 'connected' | 'locked' | 'developer_mode' | 'not_installed' | 'not_paired' | 'no_xcode' | 'launch_failed' | 'needs_code'; message: string }
export type UsbLink = { id: string; name: string; onCable: boolean; state: 'idle' | 'streaming' | 'waiting' | 'app_closed' | 'unplugged' | 'wrong_code'; message: string; lastFrameAt: number | null; linkedAt?: number | null }

async function usbRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/fight/usb${path}`, {
    method, cache: 'no-store',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const data = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : 'Could not reach the phone. Check the cable.')
  return data as T
}

export function useUsbPhone(pollMs = 3_000) {
  const [devices, setDevices] = useState<UsbDevice[]>([])
  const [link, setLink] = useState<UsbLink | null>(null)
  const [auto, setAutoState] = useState<UsbAuto>({ enabled: true, state: 'idle', message: '' })
  const [available, setAvailable] = useState(true)
  const [stream, setStream] = useState<UsbStreamStatus | null>(null)
  useEffect(() => onUsbStreamStatus(setStream), [])

  const refresh = useCallback(async () => {
    try {
      const result = await usbRequest<{ devices: UsbDevice[]; link?: UsbLink | null; auto?: UsbAuto }>('/devices')
      setDevices(Array.isArray(result.devices) ? result.devices : [])
      setLink(result.link ?? null)
      if (result.auto) setAutoState(result.auto)
      setAvailable(true)
    } catch { setAvailable(false) }
  }, [])

  useEffect(() => {
    let stopped = false
    let timer = 0
    const loop = async () => {
      await refresh()
      // Check every second: a plugged-in phone should appear right away, and a pulled cable too.
      if (!stopped) timer = window.setTimeout(() => void loop(), Math.min(pollMs, 1_000))
    }
    void loop()
    return () => { stopped = true; clearTimeout(timer) }
  }, [pollMs, refresh])

  const connect = useCallback(async (deviceId: string, code: string) => {
    await usbRequest('/connect', 'POST', { deviceId, code })
    await refresh()
  }, [refresh])

  const disconnect = useCallback(async () => {
    await usbRequest('/connect', 'DELETE')
    await refresh()
  }, [refresh])

  const setAuto = useCallback(async (enabled: boolean) => {
    setAutoState(previous => ({ ...previous, enabled }))
    await usbRequest('/auto', 'PUT', { enabled }).catch(() => undefined)
    await refresh()
  }, [refresh])

  return { devices, available, link, stream, auto, setAuto, linked: devices.find(device => device.linked) ?? null, connect, disconnect }
}
