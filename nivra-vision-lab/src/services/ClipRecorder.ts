/**
 * Keeps the last few seconds of the camera view (video plus the skeleton overlay) in memory,
 * so an alert can be saved as a short clip that starts before the alert fired.
 *
 * Frames are copied into a ring buffer as small ImageBitmaps. When an alert fires the recorder
 * keeps buffering, and plays the buffer back with a fixed delay into a MediaRecorder. The result
 * is PRE_MS before the alert plus POST_MS after it, ready about POST_MS after the alert.
 */
export const CLIP_PRE_MS = 2_500
export const CLIP_POST_MS = 2_500
const FPS = 15
const WIDTH = 640
const BUFFER_MS = CLIP_PRE_MS + 1_000

type Frame = { at: number; bitmap: ImageBitmap }
export type ClipSources = {
  stage: () => HTMLElement | null
  video: () => HTMLVideoElement | null
  demo: () => HTMLCanvasElement | null
  overlay: () => HTMLCanvasElement | null
  /** Which source is visible and how it is fitted, read on every frame. */
  view: () => { kind: 'camera' | 'clip' | 'demo' | null; mirrored: boolean }
}
export type ClipResult = { clip: Blob | null; still: Blob | null; durationMs: number }

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null
  for (const type of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return null
}

function drawFitted(context: CanvasRenderingContext2D, source: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, fit: 'cover' | 'contain', mirrored: boolean) {
  if (!sourceWidth || !sourceHeight) return
  const scale = fit === 'cover' ? Math.max(width / sourceWidth, height / sourceHeight) : Math.min(width / sourceWidth, height / sourceHeight)
  const drawWidth = sourceWidth * scale, drawHeight = sourceHeight * scale
  const x = (width - drawWidth) / 2, y = (height - drawHeight) / 2
  context.save()
  if (mirrored) { context.translate(width, 0); context.scale(-1, 1) }
  context.drawImage(source, mirrored ? width - x - drawWidth : x, y, drawWidth, drawHeight)
  context.restore()
}

export class ClipRecorder {
  private frames: Frame[] = []
  private timer = 0
  private canvas = document.createElement('canvas')
  private context = this.canvas.getContext('2d', { alpha: false })
  private busy = false
  private readonly sources: ClipSources

  constructor(sources: ClipSources) { this.sources = sources }

  get supported() { return !!this.context && typeof createImageBitmap === 'function' }

  start() {
    if (this.timer || !this.supported) return
    this.timer = window.setInterval(() => void this.capture(), 1_000 / FPS)
  }

  stop() {
    clearInterval(this.timer)
    this.timer = 0
    this.frames.forEach(frame => frame.bitmap.close())
    this.frames = []
  }

  private async capture() {
    const context = this.context
    const stage = this.sources.stage()
    const { kind, mirrored } = this.sources.view()
    if (!context || !stage || !kind) return
    const bounds = stage.getBoundingClientRect()
    if (!bounds.width || !bounds.height) return
    const width = WIDTH
    const height = Math.round(WIDTH * bounds.height / bounds.width / 2) * 2
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height }
    context.fillStyle = '#000'
    context.fillRect(0, 0, width, height)
    if (kind === 'demo') {
      const demo = this.sources.demo()
      if (demo) drawFitted(context, demo, demo.width, demo.height, width, height, 'cover', false)
    } else {
      const video = this.sources.video()
      if (!video || video.readyState < 2) return
      drawFitted(context, video, video.videoWidth, video.videoHeight, width, height, kind === 'clip' ? 'contain' : 'cover', kind === 'camera' && mirrored)
    }
    const overlay = this.sources.overlay()
    if (overlay?.width && overlay.height) context.drawImage(overlay, 0, 0, width, height)
    try {
      const bitmap = await createImageBitmap(this.canvas)
      const at = performance.now()
      this.frames.push({ at, bitmap })
      // Keep enough history for the pre-roll; older frames are released straight away.
      while (this.frames.length && this.frames[0].at < at - BUFFER_MS - (this.busy ? CLIP_POST_MS + 1_000 : 0)) this.frames.shift()!.bitmap.close()
    } catch { /* tab hidden or source not ready */ }
  }

  private snapshot(): Promise<Blob | null> {
    return new Promise(resolve => this.canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.82))
  }

  /** Saves PRE_MS before now and POST_MS after now. Resolves with the clip and a still from the alert moment. */
  async record(onStill?: (still: Blob | null) => void): Promise<ClipResult> {
    const still = await this.snapshot()
    onStill?.(still)
    const mime = pickMime()
    if (this.busy || !mime || !this.timer || typeof this.canvas.captureStream !== 'function') return { clip: null, still, durationMs: 0 }
    this.busy = true
    const alertAt = performance.now()
    const startAt = alertAt - CLIP_PRE_MS
    const endAt = alertAt + CLIP_POST_MS
    const out = document.createElement('canvas')
    out.width = this.canvas.width
    out.height = this.canvas.height
    const outContext = out.getContext('2d', { alpha: false })!
    const stream = out.captureStream(FPS)
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1_200_000 })
    const chunks: Blob[] = []
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
    const done = new Promise<void>(resolve => { recorder.onstop = () => resolve() })
    // Paint the first buffered frame before starting so the clip never opens on black.
    const first = this.frames.find(frame => frame.at >= startAt) ?? this.frames[0]
    if (first) outContext.drawImage(first.bitmap, 0, 0)
    recorder.start(500)
    const playbackStart = performance.now()
    await new Promise<void>(resolve => {
      const tick = () => {
        // Wall-clock playback of the buffer, delayed by the pre-roll.
        const sourceTime = startAt + (performance.now() - playbackStart)
        let frame: Frame | undefined
        for (const item of this.frames) { if (item.at <= sourceTime) frame = item; else break }
        if (frame && frame.at >= startAt - 200) outContext.drawImage(frame.bitmap, 0, 0)
        if (sourceTime >= endAt || !this.timer) { resolve(); return }
        window.setTimeout(tick, 1_000 / FPS / 2)
      }
      tick()
    })
    recorder.stop()
    stream.getTracks().forEach(track => track.stop())
    await done
    this.busy = false
    const clip = chunks.length ? new Blob(chunks, { type: mime.split(';')[0] }) : null
    return { clip, still, durationMs: Math.round(performance.now() - playbackStart) }
  }
}
