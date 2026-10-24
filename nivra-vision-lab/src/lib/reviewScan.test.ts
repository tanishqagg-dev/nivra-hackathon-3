import { afterEach, describe, expect, it, vi } from 'vitest'
import { createReviewResultLatch, runReviewScan, seekVideoFrame, waitForVideoData, waitUntilIdle, type ScanProgress } from './reviewScan'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(next => { resolve = next })
  return { promise, resolve }
}

afterEach(() => vi.useRealTimers())

describe('review result completion', () => {
  it('waits for a slower matching object result after the final pose', () => {
    const complete = vi.fn()
    const accept = createReviewResultLatch(1200, true, complete)
    accept({ timestampMs: 1200, posesFresh: true, objectsFresh: false })
    expect(complete).not.toHaveBeenCalled()
    accept({ timestampMs: 1200, posesFresh: false, objectsFresh: true })
    expect(complete).toHaveBeenCalledOnce()
  })

  it('waits for a slower pose when objects finish first', () => {
    const complete = vi.fn()
    const accept = createReviewResultLatch(1200, true, complete)
    accept({ timestampMs: 1200, posesFresh: false, objectsFresh: true })
    expect(complete).not.toHaveBeenCalled()
    accept({ timestampMs: 1200, posesFresh: true, objectsFresh: false })
    expect(complete).toHaveBeenCalledOnce()
  })

  it('does not wait for an object task that was not submitted', () => {
    const complete = vi.fn()
    const accept = createReviewResultLatch(1200, false, complete)
    accept({ timestampMs: 1200, posesFresh: true, objectsFresh: false })
    accept({ timestampMs: 1200, posesFresh: true, objectsFresh: false })
    expect(complete).toHaveBeenCalledOnce()
  })

  it('ignores another source frame and cached observations', () => {
    const complete = vi.fn()
    const accept = createReviewResultLatch(1200, true, complete)
    accept({ timestampMs: 1100, posesFresh: true, objectsFresh: true })
    accept({ timestampMs: 1200, posesFresh: false, objectsFresh: false })
    expect(complete).not.toHaveBeenCalled()
  })
})

describe('fixed-step review scan', () => {
  it('waits for each matching inference before advancing and completes only after the final result', async () => {
    const controller = new AbortController()
    const frames = [deferred(), deferred(), deferred()]
    const seek = vi.fn(async (_time: number) => {})
    const analyze = vi.fn((time: number) => frames[Math.round(time / 0.04)].promise)
    const progress = vi.fn()
    const running = runReviewScan({ duration: 0.12, completedFrames: 0, signal: controller.signal, seek, analyze, progress })
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1))
    expect(seek).toHaveBeenCalledTimes(1)
    expect(progress).not.toHaveBeenCalled()
    frames[0].resolve()
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2))
    expect(progress).toHaveBeenLastCalledWith({ currentTime: 0, duration: 0.12, analyzedFrames: 1 })
    frames[1].resolve()
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(3))
    expect(progress).not.toHaveBeenCalledWith(expect.objectContaining({ currentTime: 0.12 }))
    frames[2].resolve()
    await running
    expect(seek.mock.calls.map(call => call[0])).toEqual([0, 0.04, 0.08])
    expect(progress).toHaveBeenLastCalledWith({ currentTime: 0.12, duration: 0.12, analyzedFrames: 3 })
  })

  it('resumes at the first unfinished position after abort during inference', async () => {
    const controller = new AbortController()
    const pending = deferred()
    let last: ScanProgress = { currentTime: 0, duration: 0.12, analyzedFrames: 0 }
    const first = runReviewScan({
      duration: 0.12, completedFrames: 0, signal: controller.signal,
      seek: async () => {}, analyze: async time => { if (time === 0.04) await pending.promise },
      progress: value => { last = value },
    })
    const rejection = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(last.analyzedFrames).toBe(1))
    controller.abort()
    pending.resolve()
    await rejection
    expect(last.analyzedFrames).toBe(1)
    const resumedTimes: number[] = []
    await runReviewScan({
      duration: 0.12, completedFrames: last.analyzedFrames, signal: new AbortController().signal,
      seek: async () => {}, analyze: async time => { resumedTimes.push(time) }, progress: value => { last = value },
    })
    expect(resumedTimes).toEqual([0.04, 0.08])
    expect(last.analyzedFrames).toBe(3)
  })

  it('does not analyze or publish after cancellation during a seek', async () => {
    const controller = new AbortController()
    const seeking = deferred()
    const analyze = vi.fn(async () => {})
    const progress = vi.fn()
    const running = runReviewScan({ duration: 1, completedFrames: 0, signal: controller.signal, seek: () => seeking.promise, analyze, progress })
    const rejection = expect(running).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    seeking.resolve()
    await rejection
    expect(analyze).not.toHaveBeenCalled()
    expect(progress).not.toHaveBeenCalled()
  })

  it('rejects unknown duration instead of scanning forever', async () => {
    await expect(runReviewScan({ duration: Infinity, completedFrames: 0, signal: new AbortController().signal,
      seek: async () => {}, analyze: async () => {}, progress: () => {},
    })).rejects.toThrow('duration')
  })
})

describe('decoded-frame waits', () => {
  function videoFixture() {
    const video = document.createElement('video')
    Object.defineProperty(video, 'readyState', { configurable: true, value: 2 })
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 640 })
    return video
  }

  it('requires seek completion, not merely a changed currentTime', async () => {
    const video = videoFixture()
    const done = vi.fn()
    const waiting = seekVideoFrame(video, 0.04, new AbortController().signal).then(done)
    await Promise.resolve()
    expect(done).not.toHaveBeenCalled()
    video.dispatchEvent(new Event('seeked'))
    await waiting
    expect(done).toHaveBeenCalledOnce()
  })

  it('uses the decoded first frame without waiting for a no-op seek event', async () => {
    await expect(seekVideoFrame(videoFixture(), 0, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('cancels a seek and clears its timeout and listeners', async () => {
    vi.useFakeTimers()
    const video = videoFixture()
    const remove = vi.spyOn(video, 'removeEventListener')
    const controller = new AbortController()
    const waiting = seekVideoFrame(video, 0.04, controller.signal)
    const rejection = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('seeked', expect.any(Function))
  })

  it('reports a decode timeout rather than leaving an unresolved scan', async () => {
    vi.useFakeTimers()
    const waiting = seekVideoFrame(videoFixture(), 0.04, new AbortController().signal)
    const rejection = expect(waiting).rejects.toThrow('decoded')
    await vi.advanceTimersByTimeAsync(10_000)
    await rejection
  })

  it('cancels an initial video load before pixels become available', async () => {
    const controller = new AbortController()
    const waiting = waitForVideoData(document.createElement('video'), controller.signal)
    const rejection = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
  })

  it('waits out a previous cancelled worker request and cancels its own wait', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const waiting = waitUntilIdle(() => true, controller.signal)
    const rejection = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })
})
