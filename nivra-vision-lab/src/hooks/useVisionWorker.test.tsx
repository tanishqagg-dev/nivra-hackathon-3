import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VisionWorkerResponse } from '../types/vision'
import { useVisionWorker } from './useVisionWorker'

class FakeWorker {
  static instances: FakeWorker[] = []
  static failAt = -1
  onmessage: ((event: MessageEvent<VisionWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()

  constructor() {
    if (FakeWorker.instances.length === FakeWorker.failAt) throw new Error('Worker unavailable')
    FakeWorker.instances.push(this)
  }

  emit(message: VisionWorkerResponse) {
    this.onmessage?.({ data: message } as MessageEvent<VisionWorkerResponse>)
  }
}

describe('useVisionWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWorker.instances = []
    FakeWorker.failAt = -1
    vi.stubGlobal('Worker', FakeWorker)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('starts the local Full model with four poses and keeps Lite available', () => {
    const { result } = renderHook(() => useVisionWorker({ onResult: vi.fn() }))
    expect(result.current.quality).toBe('full')
    expect(FakeWorker.instances[0].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init', modelPath: '/models/pose_landmarker_full.task', maxPoses: 4,
    }), [])

    act(() => result.current.setQuality('full'))
    expect(FakeWorker.instances).toHaveLength(2)

    act(() => result.current.setQuality('lite'))
    expect(result.current.quality).toBe('lite')
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce()
    expect(FakeWorker.instances[1].terminate).toHaveBeenCalledOnce()
    expect(FakeWorker.instances[2].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init', modelPath: '/models/pose_landmarker_lite.task', maxPoses: 4,
    }), [])
    expect(vi.getTimerCount()).toBe(1)
  })

  it('does not accept in-flight results from a replaced model and retains settings on retry', () => {
    const onResult = vi.fn()
    const { result } = renderHook(() => useVisionWorker({ onResult }))
    act(() => {
      FakeWorker.instances[0].emit({ type: 'ready', task: 'pose', delegate: 'GPU' })
      FakeWorker.instances[1].emit({ type: 'ready', task: 'objects', delegate: 'CPU' })
      result.current.configure(6, 0.65, 0.45)
      result.current.submitFrame({ close: vi.fn() } as unknown as ImageBitmap, null, 200)
    })
    const oldHandler = FakeWorker.instances[0].onmessage
    const rejectedBitmap = { close: vi.fn() } as unknown as ImageBitmap
    act(() => {
      result.current.setQuality('lite')
      expect(result.current.submitFrame(rejectedBitmap, null, 300)).toBe(false)
      oldHandler?.(new MessageEvent<VisionWorkerResponse>('message', { data: {
        type: 'pose-result', timestampMs: 200, inferenceMs: 25, poses: [],
      } }))
    })
    expect(rejectedBitmap.close).toHaveBeenCalledOnce()
    expect(onResult).not.toHaveBeenCalled()
    expect(result.current.status).toBe('loading')
    expect(result.current.delegates).toBeNull()
    expect(FakeWorker.instances[2].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init', modelPath: '/models/pose_landmarker_lite.task',
      maxPoses: 6, poseConfidence: 0.65, objectConfidence: 0.45,
    }), [])

    act(() => result.current.restart())
    expect(FakeWorker.instances[4].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init', modelPath: '/models/pose_landmarker_lite.task',
      maxPoses: 6, poseConfidence: 0.65, objectConfidence: 0.45,
    }), [])
  })

  it('reinitializes after rapid selection changes back to the original model', () => {
    const { result } = renderHook(() => useVisionWorker({ onResult: vi.fn() }))
    act(() => {
      result.current.setQuality('lite')
      result.current.setQuality('full')
    })
    expect(result.current.quality).toBe('full')
    expect(FakeWorker.instances).toHaveLength(4)
    expect(FakeWorker.instances[2].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init', modelPath: '/models/pose_landmarker_full.task',
    }), [])
  })

  it('retries failed analysis with the operator settings retained', () => {
    const { result } = renderHook(() => useVisionWorker({ onResult: vi.fn() }))
    act(() => {
      result.current.configure(2, 0.6, 0.45)
      FakeWorker.instances[0].emit({ type: 'error', task: 'pose', code: 'inference', message: 'Analysis stopped' })
    })
    expect(result.current.status).toBe('error')

    act(() => result.current.restart())
    expect(result.current.status).toBe('loading')
    expect(result.current.error).toBeNull()
    expect(FakeWorker.instances[2].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init', maxPoses: 2, poseConfidence: 0.6, objectConfidence: 0.45,
    }), [])

    act(() => {
      FakeWorker.instances[2].emit({ type: 'ready', task: 'pose', delegate: 'CPU' })
      FakeWorker.instances[3].emit({ type: 'ready', task: 'objects', delegate: 'CPU' })
    })
    expect(result.current.status).toBe('ready')
    expect(result.current.delegates).toEqual({ pose: 'CPU', objects: 'CPU' })
  })

  it('reports construction failure and terminates the first worker if the second fails', () => {
    FakeWorker.failAt = 1
    const { result } = renderHook(() => useVisionWorker({ onResult: vi.fn() }))
    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe('Worker unavailable')
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce()
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap
    expect(result.current.submitFrame(bitmap, null, 200)).toBe(false)
    expect(bitmap.close).toHaveBeenCalledOnce()
  })

  it('terminates both workers and cancels loading timeout on unmount', () => {
    const { unmount } = renderHook(() => useVisionWorker({ onResult: vi.fn() }))
    unmount()
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce()
    expect(FakeWorker.instances[1].terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries a hung GPU once on CPU and ignores results from the terminated GPU', () => {
    const onResult = vi.fn()
    const { result } = renderHook(() => useVisionWorker({ onResult }))
    act(() => {
      FakeWorker.instances[0].emit({ type: 'ready', task: 'pose', delegate: 'GPU' })
      FakeWorker.instances[1].emit({ type: 'ready', task: 'objects', delegate: 'CPU' })
      result.current.configure(2, 0.6, 0.45)
      result.current.submitFrame({ close: vi.fn() } as unknown as ImageBitmap, null, 200)
    })
    const oldHandler = FakeWorker.instances[0].onmessage
    act(() => vi.advanceTimersByTime(5_000))
    expect(result.current.status).toBe('loading')
    expect(result.current.notice).toContain('Switched to CPU')
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce()
    expect(FakeWorker.instances[2].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init', poseDelegate: 'CPU', modelPath: '/models/pose_landmarker_full.task',
      maxPoses: 2, poseConfidence: 0.6, objectConfidence: 0.45,
    }), [])

    act(() => {
      oldHandler?.(new MessageEvent<VisionWorkerResponse>('message', { data: { type: 'pose-result', timestampMs: 200, inferenceMs: 8000, poses: [] } }))
      FakeWorker.instances[2].emit({ type: 'ready', task: 'pose', delegate: 'CPU' })
      FakeWorker.instances[3].emit({ type: 'ready', task: 'objects', delegate: 'CPU' })
    })
    expect(onResult).not.toHaveBeenCalled()
    expect(result.current.status).toBe('ready')
    act(() => {
      result.current.submitFrame({ close: vi.fn() } as unknown as ImageBitmap, null, 300)
      vi.advanceTimersByTime(15_000)
    })
    expect(result.current.status).toBe('error')
    expect(FakeWorker.instances).toHaveLength(4)
  })

  it('keeps CPU recovery active when quality is changed', () => {
    const { result } = renderHook(() => useVisionWorker({ onResult: vi.fn() }))
    act(() => {
      FakeWorker.instances[0].emit({ type: 'ready', task: 'pose', delegate: 'GPU' })
      FakeWorker.instances[1].emit({ type: 'ready', task: 'objects', delegate: 'CPU' })
      result.current.submitFrame({ close: vi.fn() } as unknown as ImageBitmap, null, 200)
      vi.advanceTimersByTime(5_000)
    })
    act(() => result.current.setQuality('lite'))
    expect(FakeWorker.instances[4].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init', poseDelegate: 'CPU', modelPath: '/models/pose_landmarker_lite.task',
    }), [])
    expect(result.current.notice).toContain('Switched to CPU')
  })

  it('uses CPU for reviews, rejects old frames immediately, and restores GPU for cameras', () => {
    const onResult = vi.fn()
    const { result } = renderHook(() => useVisionWorker({ onResult }))
    const setPosePolicy = result.current.setPosePolicy
    act(() => {
      FakeWorker.instances[0].emit({ type: 'ready', task: 'pose', delegate: 'GPU' })
      FakeWorker.instances[1].emit({ type: 'ready', task: 'objects', delegate: 'CPU' })
      result.current.configure(6, .6, .4)
      result.current.submitFrame({ close: vi.fn() } as unknown as ImageBitmap, null, 100)
    })
    const oldHandler = FakeWorker.instances[0].onmessage
    const rejectedBitmap = { close: vi.fn() } as unknown as ImageBitmap
    act(() => {
      result.current.setPosePolicy('review')
      expect(result.current.submitFrame(rejectedBitmap, null, 200)).toBe(false)
      oldHandler?.(new MessageEvent<VisionWorkerResponse>('message', { data: {
        type: 'pose-result', timestampMs: 100, inferenceMs: 25, poses: [],
      } }))
    })
    expect(rejectedBitmap.close).toHaveBeenCalledOnce()
    expect(onResult).not.toHaveBeenCalled()
    expect(result.current.status).toBe('loading')
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce()
    expect(FakeWorker.instances[2].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init', poseDelegate: 'CPU', modelPath: '/models/pose_landmarker_full.task',
      maxPoses: 6, poseConfidence: .6, objectConfidence: .4,
    }), [])
    act(() => {
      FakeWorker.instances[2].emit({ type: 'ready', task: 'pose', delegate: 'CPU' })
      FakeWorker.instances[3].emit({ type: 'ready', task: 'objects', delegate: 'CPU' })
    })
    expect(result.current.notice).toBe('Review scans use the CPU reference runtime. Cameras use GPU when available.')
    act(() => result.current.setPosePolicy('review'))
    expect(FakeWorker.instances).toHaveLength(4)

    act(() => result.current.setPosePolicy('realtime'))
    expect(FakeWorker.instances[4].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init', poseDelegate: 'GPU', maxPoses: 6, poseConfidence: .6, objectConfidence: .4,
    }), [])
    expect(result.current.setPosePolicy).toBe(setPosePolicy)
    expect(result.current.notice).toBeNull()
  })

  it('does not reload on policy labels alone after GPU was unavailable', () => {
    const { result } = renderHook(() => useVisionWorker({ onResult: vi.fn() }))
    act(() => {
      FakeWorker.instances[0].emit({ type: 'ready', task: 'pose', delegate: 'CPU' })
      FakeWorker.instances[1].emit({ type: 'ready', task: 'objects', delegate: 'CPU' })
    })
    act(() => result.current.setPosePolicy('review'))
    expect(result.current.status).toBe('ready')
    expect(result.current.notice).toContain('CPU reference runtime')
    expect(FakeWorker.instances).toHaveLength(2)
    act(() => result.current.setPosePolicy('realtime'))
    expect(result.current.status).toBe('ready')
    expect(result.current.notice).toContain('GPU acceleration is unavailable')
    expect(FakeWorker.instances).toHaveLength(2)
    act(() => result.current.restart())
    expect(FakeWorker.instances[2].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init', poseDelegate: 'CPU',
    }), [])
  })

  it('retains GPU timeout recovery across review and realtime policy changes', () => {
    const { result } = renderHook(() => useVisionWorker({ onResult: vi.fn() }))
    act(() => {
      FakeWorker.instances[0].emit({ type: 'ready', task: 'pose', delegate: 'GPU' })
      FakeWorker.instances[1].emit({ type: 'ready', task: 'objects', delegate: 'CPU' })
      result.current.submitFrame({ close: vi.fn() } as unknown as ImageBitmap, null, 100)
      vi.advanceTimersByTime(5_000)
    })
    act(() => {
      FakeWorker.instances[2].emit({ type: 'ready', task: 'pose', delegate: 'CPU' })
      FakeWorker.instances[3].emit({ type: 'ready', task: 'objects', delegate: 'CPU' })
      result.current.setPosePolicy('review')
    })
    expect(result.current.notice).toContain('CPU reference runtime')
    act(() => result.current.setPosePolicy('realtime'))
    expect(result.current.notice).toContain('Switched to CPU')
    expect(result.current.status).toBe('ready')
    expect(FakeWorker.instances).toHaveLength(4)
  })

  it('keeps review CPU policy on model changes and handles a rapid return to realtime', () => {
    const { result } = renderHook(() => useVisionWorker({ onResult: vi.fn() }))
    act(() => {
      result.current.setPosePolicy('review')
      result.current.setQuality('lite')
    })
    expect(FakeWorker.instances[2].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init', poseDelegate: 'CPU', modelPath: '/models/pose_landmarker_lite.task',
    }), [])
    act(() => {
      result.current.setPosePolicy('realtime')
      result.current.setPosePolicy('review')
      result.current.setPosePolicy('realtime')
    })
    expect(FakeWorker.instances).toHaveLength(6)
    expect(FakeWorker.instances[4].postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'init', poseDelegate: 'GPU', modelPath: '/models/pose_landmarker_lite.task',
    }), [])
  })
})
