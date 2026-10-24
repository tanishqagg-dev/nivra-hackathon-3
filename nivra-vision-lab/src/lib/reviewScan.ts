export const REVIEW_STEP_SECONDS = 0.04
export type ClipMode = 'review' | 'realtime'
export interface ScanProgress { currentTime: number; duration: number; analyzedFrames: number }
export const EMPTY_SCAN_PROGRESS: ScanProgress = { currentTime: 0, duration: 0, analyzedFrames: 0 }

export interface ReviewResultPacket { timestampMs: number; posesFresh: boolean; objectsFresh: boolean }

export function createReviewResultLatch(timestampMs: number, includeObjects: boolean, complete: () => void) {
  let poseReceived = false
  let objectsReceived = !includeObjects
  let finished = false
  return (packet: ReviewResultPacket) => {
    if (finished || packet.timestampMs !== timestampMs) return
    poseReceived ||= packet.posesFresh
    objectsReceived ||= packet.objectsFresh
    if (poseReceived && objectsReceived) { finished = true; complete() }
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Review scan cancelled.', 'AbortError')
}

export function waitForVideoData(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return waitForMedia(video, signal, () => video.readyState >= 2 && video.videoWidth > 0, ['loadeddata', 'canplay'])
}

function waitForMedia(
  video: HTMLVideoElement, signal: AbortSignal, ready: () => boolean,
  events: string[], action?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Review scan cancelled.', 'AbortError')); return }
    const cleanup = () => {
      clearTimeout(timer)
      events.forEach(event => video.removeEventListener(event, check))
      video.removeEventListener('error', fail)
      signal.removeEventListener('abort', abort)
    }
    const check = () => { if (ready()) { cleanup(); resolve() } }
    const fail = () => { cleanup(); reject(new Error('This video frame could not be decoded. Try another MP4 or WebM file.')) }
    const abort = () => { cleanup(); reject(new DOMException('Review scan cancelled.', 'AbortError')) }
    const timer = setTimeout(fail, 10_000)
    events.forEach(event => video.addEventListener(event, check))
    video.addEventListener('error', fail)
    signal.addEventListener('abort', abort, { once: true })
    try { action?.(); check() } catch (error) { cleanup(); reject(error) }
  })
}

/** A completed seek has decoded data at the requested source position. */
export function seekVideoFrame(video: HTMLVideoElement, time: number, signal: AbortSignal): Promise<void> {
  if (Math.abs(video.currentTime - time) < 0.000001 && !video.seeking) return waitForVideoData(video, signal)
  let seekCompleted = false
  const markSeeked = () => { seekCompleted = true }
  video.addEventListener('seeked', markSeeked)
  return waitForMedia(video, signal,
    () => seekCompleted && !video.seeking && video.readyState >= 2,
    ['seeked', 'loadeddata'], () => { video.currentTime = time },
  ).finally(() => video.removeEventListener('seeked', markSeeked))
}

export function waitUntilIdle(busy: () => boolean, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => { clearTimeout(timer); reject(new DOMException('Review scan cancelled.', 'AbortError')) }
    const check = () => {
      if (signal.aborted) { abort(); return }
      if (!busy()) { signal.removeEventListener('abort', abort); resolve(); return }
      timer = setTimeout(check, 16)
    }
    signal.addEventListener('abort', abort, { once: true })
    check()
  })
}

/** Fixed source-time sampling. Never advance until the submitted frame finishes. */
export async function runReviewScan(options: {
  duration: number
  completedFrames: number
  signal: AbortSignal
  seek(time: number): Promise<void>
  analyze(time: number): Promise<void>
  progress(value: ScanProgress): void
}): Promise<void> {
  const { duration, signal } = options
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('This video has no usable duration.')
  let index = options.completedFrames
  for (; index * REVIEW_STEP_SECONDS < duration - 0.000001; index += 1) {
    throwIfAborted(signal)
    const time = index * REVIEW_STEP_SECONDS
    await options.seek(time)
    throwIfAborted(signal)
    await options.analyze(time)
    throwIfAborted(signal)
    options.progress({ currentTime: time, duration, analyzedFrames: index + 1 })
  }
  throwIfAborted(signal)
  options.progress({ currentTime: duration, duration, analyzedFrames: index })
}
