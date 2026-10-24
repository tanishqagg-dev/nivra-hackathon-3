import type { useUsbPhone } from '../hooks/useUsbPhone'

type Usb = ReturnType<typeof useUsbPhone>
type Tone = 'live' | 'warn' | 'bad' | 'idle'

/** One honest line about the phone link, from the stream (when in use) or the backend's last check. */
export function usbHealth(usb: Usb, inUse: boolean): { tone: Tone; title: string; detail: string } {
  const link = usb.link
  if (!link) return { tone: 'idle', title: 'Not linked', detail: '' }
  if (!link.onCable) return { tone: 'bad', title: 'Cable unplugged', detail: 'Plug the iPhone back in and unlock it. It reconnects by itself, no new code needed.' }
  const stream = inUse ? usb.stream : null
  if (stream?.state === 'live') return { tone: 'live', title: `Live · ${stream.fps || '…'} fps over USB`, detail: stream.mode === 'stills' ? 'This app build sends still frames. Update NIVRA on the phone for smooth video.' : 'H.264 video straight from the phone camera.' }
  const state = stream && stream.state !== 'connecting' ? stream.state : link.state
  if (state === 'app_closed') return { tone: 'warn', title: 'NIVRA is closed on the phone', detail: 'Open NIVRA, start its camera and keep it on screen. iPhones pause apps in the background.' }
  if (state === 'wrong_code') return { tone: 'bad', title: 'New code needed', detail: 'NIVRA on the phone shows a new code. Type it below.' }
  if (state === 'waiting') return { tone: 'warn', title: 'Waiting for video', detail: 'The phone is connected but not sending. Keep NIVRA open on the phone.' }
  if (inUse) return { tone: 'warn', title: 'Connecting to the iPhone', detail: 'This takes a second or two.' }
  return { tone: 'live', title: 'Linked and ready', detail: 'Switch the live camera to this phone.' }
}
