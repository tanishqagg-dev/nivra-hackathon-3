/** Virtual camera id for an iPhone streaming through the NIVRA app over USB. */
export const USB_PHONE_DEVICE = 'nivra-usb-phone'

const VIDEO_URL = '/api/fight/usb/video'
const FRAME_URL = '/api/fight/usb/frame'
const OUTPUT_FPS = 60
// Small presentation delay so frames that arrive in bursts still display at an even pace.
const PLAYBACK_DELAY_MS = 120
const MAX_QUEUE = 12
// No frame for this long while streaming means the phone stopped sending.
const SILENT_MS = 2_500

type PhoneFrame = { sequence: number; timestampMs: number; keyframe: boolean; data: string }
type PhonePacket = { version: number; generation: string; codec: string; description: string; width: number; height: number; frames: PhoneFrame[] }

/** What the phone stream is doing, for the camera tile and the USB panel. */
export type UsbStreamState = 'connecting' | 'live' | 'app_closed' | 'unplugged' | 'wrong_code' | 'unlinked' | 'waiting'
export type UsbStreamStatus = { state: UsbStreamState; message: string; fps: number; mode: 'video' | 'stills' | null; since: number }

const listeners = new Set<(status: UsbStreamStatus) => void>()
let lastStatus: UsbStreamStatus | null = null
/** Subscribe to the running phone stream. Called with the latest status straight away. */
export function onUsbStreamStatus(listener: (status: UsbStreamStatus) => void) {
  listeners.add(listener)
  if (lastStatus) listener(lastStatus)
  return () => { listeners.delete(listener) }
}
function publish(status: UsbStreamStatus | null) {
  lastStatus = status
  if (status) listeners.forEach(listener => listener(status))
}

const MESSAGES: Record<UsbStreamState, string> = {
  connecting: 'Connecting to the iPhone over USB.',
  live: '',
  app_closed: 'Open NIVRA on the phone, start its camera and keep it on screen.',
  unplugged: 'The iPhone is not on the cable. Plug it back in and unlock it.',
  wrong_code: 'The phone shows a new code. Type it in the USB phone panel.',
  unlinked: 'Link the phone with the code it shows, in Settings, Cameras.',
  waiting: 'Waiting for the phone camera. Keep NIVRA open on the phone.',
}

const bytes = (base64: string) => Uint8Array.from(atob(base64), char => char.charCodeAt(0))

async function reason(response: Response): Promise<{ state: UsbStreamState; message: string }> {
  const detail = await response.json().then(body => typeof body?.detail === 'string' ? body.detail : '').catch(() => '')
  if (response.status === 403) return { state: 'wrong_code', message: MESSAGES.wrong_code }
  if (response.status === 409) return { state: 'unlinked', message: MESSAGES.unlinked }
  if (/not on the cable/i.test(detail)) return { state: 'unplugged', message: detail }
  if (/open nivra/i.test(detail)) return { state: 'app_closed', message: detail }
  return { state: 'waiting', message: detail || MESSAGES.waiting }
}

/**
 * Turns the phone's camera into a MediaStream the rest of the app treats like a webcam.
 * Prefers the phone's H.264 stream (30-40 fps, decoded with WebCodecs and painted on a steady
 * display clock) and falls back to still JPEGs on app builds without video.
 *
 * The stream never ends on its own: if the cable comes out, the app closes or the code changes,
 * it keeps the last picture, reports why, and resumes as soon as the phone answers again.
 * Only stop() ends it.
 */
export function startUsbPhoneStream(): MediaStream {
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true })
  if (!context || typeof canvas.captureStream !== 'function') throw new Error('This browser cannot show a USB phone camera. Use Chrome or Safari.')
  const stream = canvas.captureStream(OUTPUT_FPS)
  const track = stream.getVideoTracks()[0]
  let stopped = false
  let lastFrame = 0
  let painted = 0
  let mode: 'video' | 'stills' | null = null
  let state: UsbStreamState = 'connecting'
  let message = MESSAGES.connecting
  let since = performance.now()
  let fps = 0
  const controllers = new Set<AbortController>()

  const report = (next: UsbStreamState, text = MESSAGES[next]) => {
    if (next !== state || text !== message) { state = next; message = text; since = performance.now() }
    publish({ state, message, fps, mode, since })
  }
  const fpsTimer = window.setInterval(() => {
    fps = painted
    painted = 0
    if (state === 'live' && performance.now() - lastFrame > SILENT_MS) report('waiting')
    else publish({ state, message, fps, mode, since })
  }, 1_000)

  const originalStop = track.stop.bind(track)
  track.stop = () => {
    stopped = true
    clearInterval(fpsTimer)
    controllers.forEach(controller => controller.abort())
    publish(null)
    originalStop()
  }

  // A dark first frame starts the stream right away, so the camera opens and the tile can explain what it is waiting for.
  context.fillStyle = '#0a0a0a'
  context.fillRect(0, 0, canvas.width, canvas.height)
  const keepAlive = window.setInterval(() => {
    if (stopped) { clearInterval(keepAlive); return }
    // Repaint the held picture now and then so the stream keeps producing frames while the phone is away.
    if (performance.now() - lastFrame > 500) context.drawImage(canvas, 0, 0)
  }, 500)

  const paint = (source: CanvasImageSource, width: number, height: number) => {
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
    context.drawImage(source, 0, 0, width, height)
    lastFrame = performance.now()
    painted++
    if (state !== 'live') report('live', '')
  }
  const fetchWithTimeout = async (url: string) => {
    const controller = new AbortController()
    controllers.add(controller)
    const timer = window.setTimeout(() => controller.abort(), 4_000)
    try { return await fetch(url, { cache: 'no-store', signal: controller.signal }) }
    finally { clearTimeout(timer); controllers.delete(controller) }
  }
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  // ---------- H.264 path ----------
  // Returns 'unsupported' when this app build has no video route, otherwise runs until stop().
  const runVideo = async (): Promise<'unsupported' | 'stopped'> => {
    if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') return 'unsupported'
    let decoder: VideoDecoder | null = null
    let config = ''
    let after: number | null = null
    let lastSequence = -1
    let waitingKey = true
    let baseSource = 0, baseWall = 0
    const queue: { frame: VideoFrame; due: number }[] = []

    const reset = () => {
      try { decoder?.close() } catch { /* already closed */ }
      decoder = null; waitingKey = true; lastSequence = -1; baseWall = 0
      while (queue.length) queue.shift()!.frame.close()
    }
    // Display clock: on every animation frame, show the newest frame that is due.
    const tick = () => {
      if (stopped) { reset(); return }
      const now = performance.now()
      let show: { frame: VideoFrame; due: number } | undefined
      while (queue.length && queue[0].due <= now) { show?.frame.close(); show = queue.shift() }
      if (show) { paint(show.frame, show.frame.displayWidth, show.frame.displayHeight); show.frame.close() }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)

    let failures = 0
    while (!stopped) {
      const loopStart = performance.now()
      try {
        const response = await fetchWithTimeout(after === null ? VIDEO_URL : `${VIDEO_URL}?after=${after}`)
        if (response.status === 501) { reset(); return 'unsupported' }
        if (response.status === 200) {
          failures = 0
          const packet = await response.json() as PhonePacket
          if (packet.version === 1 && Array.isArray(packet.frames) && packet.frames.length) {
            const nextConfig = `${packet.generation}:${packet.codec}:${packet.description}:${packet.width}x${packet.height}`
            // A new generation means the phone app restarted its encoder: start clean from its next keyframe.
            if (nextConfig !== config) { reset(); config = nextConfig; after = null }
            if (!decoder) {
              decoder = new VideoDecoder({
                output: frame => {
                  const timestamp = frame.timestamp / 1000
                  if (!baseWall) { baseSource = timestamp; baseWall = performance.now() + PLAYBACK_DELAY_MS }
                  let due = baseWall + (timestamp - baseSource)
                  // Re-anchor if the phone clock drifts far from ours (or after a reconnect gap).
                  if (Math.abs(due - performance.now() - PLAYBACK_DELAY_MS) > 600) { baseSource = timestamp; baseWall = performance.now() + PLAYBACK_DELAY_MS; due = baseWall }
                  if (queue.length >= MAX_QUEUE) queue.shift()!.frame.close()
                  queue.push({ frame, due })
                },
                error: () => reset(),
              })
              decoder.configure({ codec: packet.codec, description: bytes(packet.description), hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true })
            }
            for (const item of packet.frames) {
              if (item.sequence <= lastSequence) continue
              if (lastSequence >= 0 && item.sequence !== lastSequence + 1) { reset(); config = ''; break }
              lastSequence = item.sequence
              if (waitingKey && !item.keyframe) continue
              waitingKey = false
              decoder?.decode(new EncodedVideoChunk({ type: item.keyframe ? 'key' : 'delta', timestamp: Math.round(item.timestampMs * 1000), data: bytes(item.data) }))
            }
            after = packet.frames.at(-1)!.sequence
          }
        } else if (response.status !== 204 && response.status !== 429) {
          failures++
          const why = await reason(response)
          // Phone gone or app closed: the next stream starts from a fresh keyframe.
          reset(); config = ''; after = null
          if (state === 'live' || state === 'connecting' || why.state !== state) report(why.state, why.message)
        }
      } catch {
        failures++
        if (failures > 2 && state === 'live') report('waiting')
      }
      // Poll fast while streaming, back off gently while the phone is away.
      const wait = (failures ? Math.min(1_500, 250 * failures) : 25) - (performance.now() - loopStart)
      if (wait > 0) await sleep(wait)
    }
    reset()
    return 'stopped'
  }

  // ---------- JPEG fallback (app builds without /v1/video) ----------
  const runStills = async () => {
    let failures = 0
    while (!stopped) {
      const started = performance.now()
      try {
        const response = await fetchWithTimeout(FRAME_URL)
        if (response.ok) {
          failures = 0
          const bitmap = await createImageBitmap(await response.blob())
          if (stopped) { bitmap.close(); break }
          paint(bitmap, bitmap.width, bitmap.height)
          bitmap.close()
        } else if (response.status !== 429) {
          failures++
          const why = await reason(response)
          if (why.state !== state) report(why.state, why.message)
        }
      } catch { failures++ }
      const wait = (failures ? Math.min(1_500, 250 * failures) : 1000 / 15) - (performance.now() - started)
      if (wait > 0) await sleep(wait)
    }
  }

  report('connecting')
  void (async () => {
    mode = 'video'
    const result = await runVideo()
    if (result === 'unsupported' && !stopped) { mode = 'stills'; await runStills() }
  })()
  return stream
}
