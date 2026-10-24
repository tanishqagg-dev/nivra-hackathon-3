import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VisionWorkerClient } from './VisionWorkerClient'
import type { VisionWorkerResponse } from '../types/vision'

class FakeWorker {
  onmessage: ((event: MessageEvent<VisionWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()

  emit(message: VisionWorkerResponse) {
    this.onmessage?.({ data: message } as MessageEvent<VisionWorkerResponse>)
  }
}

function fakeBitmap() {
  return { close: vi.fn() } as unknown as ImageBitmap
}

function createClient(callbacks = {}, ready = true) {
  const poseWorker = new FakeWorker()
  const objectWorker = new FakeWorker()
  const handlers = {
    onReady: vi.fn(),
    onResult: vi.fn(),
    onError: vi.fn(),
    ...callbacks,
  }
  const client = new VisionWorkerClient(
    poseWorker as unknown as Worker,
    objectWorker as unknown as Worker,
    handlers,
  )
  if (ready) {
    poseWorker.emit({ type: 'ready', task: 'pose', delegate: 'GPU' })
    objectWorker.emit({ type: 'ready', task: 'objects', delegate: 'CPU' })
  }
  return {
    poseWorker,
    objectWorker,
    handlers,
    client,
  }
}

describe('VisionWorkerClient', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('initializes two local workers and waits for both delegates', () => {
    const { client, poseWorker, objectWorker, handlers } = createClient({}, false)

    client.init('/pose.task', '/objects.tflite', '/wasm', 4, 0.5, 0.35)
    poseWorker.emit({ type: 'ready', task: 'pose', delegate: 'GPU' })
    expect(handlers.onReady).not.toHaveBeenCalled()
    objectWorker.emit({ type: 'ready', task: 'objects', delegate: 'CPU' })

    expect(poseWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'init', task: 'pose', modelPath: '/pose.task' }),
      [],
    )
    expect(objectWorker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'init',
        task: 'objects',
        modelPath: '/objects.tflite',
      }),
      [],
    )
    expect(handlers.onReady).toHaveBeenCalledWith({ pose: 'GPU', objects: 'CPU' })
  })

  it('delivers object observations immediately and does not repeat them as fresh on pose frames', () => {
    const { client, poseWorker, objectWorker, handlers } = createClient()
    const poseBitmap = fakeBitmap()
    const objectBitmap = fakeBitmap()

    expect(client.submitFrame(poseBitmap, objectBitmap, 200)).toBe(true)
    poseWorker.emit({
      type: 'pose-result',
      timestampMs: 200,
      inferenceMs: 8,
      poses: [],
    })
    expect(client.isBusy).toBe(false)
    expect(handlers.onResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ objectsFresh: false, objects: [] }),
    )

    const detectedObject = {
      label: 'handbag',
      displayName: 'Handbag / purse',
      score: 0.8,
      role: 'bag' as const,
      box: { x: 0.2, y: 0.3, width: 0.1, height: 0.2 },
    }
    objectWorker.emit({
      type: 'object-result',
      timestampMs: 200,
      inferenceMs: 12,
      objects: [detectedObject],
    })
    expect(handlers.onResult).toHaveBeenLastCalledWith(expect.objectContaining({
      posesFresh: false, objectsFresh: true, objectTimestampMs: 200, objects: [detectedObject],
    }))
    expect(client.needsObjectFrame(250)).toBe(false)
    expect(client.needsObjectFrame(400)).toBe(true)

    client.submitFrame(fakeBitmap(), null, 260)
    poseWorker.emit({
      type: 'pose-result',
      timestampMs: 260,
      inferenceMs: 7,
      poses: [],
    })
    expect(handlers.onResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inferenceMs: 7,
        objectInferenceMs: 12,
        objectTimestampMs: 200,
        posesFresh: true,
        objectsFresh: false,
        objects: [detectedObject],
      }),
    )
  })

  it('keeps object analysis running while the pose worker is busy', () => {
    const { client, objectWorker, handlers } = createClient()
    client.submitFrame(fakeBitmap(), null, 200)
    expect(client.isBusy).toBe(true)
    expect(client.submitObjectFrame(fakeBitmap(), 220)).toBe(true)
    objectWorker.emit({ type: 'object-result', timestampMs: 220, inferenceMs: 20, objects: [] })
    expect(handlers.onResult).toHaveBeenLastCalledWith(expect.objectContaining({
      posesFresh: false, objectsFresh: true, objectTimestampMs: 220,
    }))
    expect(client.isBusy).toBe(true)
    expect(client.submitObjectFrame(fakeBitmap(), 400)).toBe(true)
  })

  it('drops stale skeletons from independent object updates', () => {
    const { client, poseWorker, objectWorker, handlers } = createClient()
    client.submitFrame(fakeBitmap(), null, 200)
    poseWorker.emit({ type: 'pose-result', timestampMs: 200, inferenceMs: 10, poses: [[{ x: .5, y: .5, z: 0 }]] })
    client.submitObjectFrame(fakeBitmap(), 1500)
    objectWorker.emit({ type: 'object-result', timestampMs: 1500, inferenceMs: 20, objects: [] })
    expect(handlers.onResult).toHaveBeenLastCalledWith(expect.objectContaining({
      posesFresh: false, objectsFresh: true, poses: [],
    }))
  })

  it('does not rebuild the models when configuration matches initialization', () => {
    const { client, poseWorker, objectWorker } = createClient({}, false)
    client.init('/pose.task', '/objects.tflite', '/wasm', 4, 0.5, 0.35)
    client.configure(4, 0.5, 0.35)
    expect(poseWorker.postMessage).toHaveBeenCalledTimes(1)
    expect(objectWorker.postMessage).toHaveBeenCalledTimes(1)
    client.configure(2, 0.5, 0.35)
    expect(poseWorker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'configure', maxPoses: 2 }), [])
  })

  it('drops and closes both frames while pose inference is busy', () => {
    const { client } = createClient()
    client.submitFrame(fakeBitmap(), fakeBitmap(), 1)
    const droppedPose = fakeBitmap()
    const droppedObject = fakeBitmap()

    expect(client.submitFrame(droppedPose, droppedObject, 2)).toBe(false)
    expect(droppedPose.close).toHaveBeenCalledOnce()
    expect(droppedObject.close).toHaveBeenCalledOnce()
  })

  it('terminates both workers and clears in-flight state on disposal', () => {
    const { client, poseWorker, objectWorker } = createClient()
    client.submitFrame(fakeBitmap(), fakeBitmap(), 1)
    client.dispose()

    expect(poseWorker.terminate).toHaveBeenCalledOnce()
    expect(objectWorker.terminate).toHaveBeenCalledOnce()
    expect(client.isBusy).toBe(false)
  })

  it('forwards structured worker errors and releases task backpressure', () => {
    const { client, poseWorker, handlers } = createClient()
    client.submitFrame(fakeBitmap(), fakeBitmap(), 1)
    poseWorker.emit({
      type: 'error',
      task: 'pose',
      code: 'inference',
      message: 'Frame rejected.',
    })

    expect(handlers.onError).toHaveBeenCalledWith('inference', 'Frame rejected.')
    expect(client.isBusy).toBe(false)
  })

  it('closes incoming bitmaps before models are ready or after disposal', () => {
    const { client, poseWorker } = createClient({}, false)
    const beforeReady = fakeBitmap()
    expect(client.submitFrame(beforeReady, null, 1)).toBe(false)
    expect(beforeReady.close).toHaveBeenCalledOnce()
    expect(poseWorker.postMessage).not.toHaveBeenCalled()

    client.dispose()
    const afterDispose = fakeBitmap()
    expect(client.submitFrame(afterDispose, null, 2)).toBe(false)
    expect(afterDispose.close).toHaveBeenCalledOnce()
  })

  it('discards both old results when a camera is stopped or switched', () => {
    const { client, poseWorker, objectWorker, handlers } = createClient()
    client.submitFrame(fakeBitmap(), fakeBitmap(), 200)
    client.resetStream()
    objectWorker.emit({ type: 'object-result', timestampMs: 200, inferenceMs: 20, objects: [] })
    poseWorker.emit({ type: 'pose-result', timestampMs: 200, inferenceMs: 10, poses: [] })

    expect(handlers.onResult).not.toHaveBeenCalled()
    expect(client.isBusy).toBe(false)
    expect(client.needsObjectFrame(400)).toBe(true)
    client.submitFrame(fakeBitmap(), null, 400)
    poseWorker.emit({ type: 'pose-result', timestampMs: 400, inferenceMs: 10, poses: [] })
    expect(handlers.onResult).toHaveBeenCalledWith(expect.objectContaining({
      objects: [], objectsFresh: false, objectTimestampMs: null,
    }))
  })

  it('ignores unmatched results without releasing a newer in-flight frame', () => {
    const { client, poseWorker, handlers } = createClient()
    client.submitFrame(fakeBitmap(), null, 200)
    poseWorker.emit({ type: 'pose-result', timestampMs: 100, inferenceMs: 10, poses: [] })
    expect(client.isBusy).toBe(true)
    expect(handlers.onResult).not.toHaveBeenCalled()
    poseWorker.emit({ type: 'pose-result', timestampMs: 200, inferenceMs: 10, poses: [] })
    expect(client.isBusy).toBe(false)
  })

  it('never reuses object observations older than 1.2 seconds', () => {
    const { client, poseWorker, objectWorker, handlers } = createClient()
    client.submitFrame(fakeBitmap(), fakeBitmap(), 200)
    objectWorker.emit({ type: 'object-result', timestampMs: 200, inferenceMs: 20, objects: [] })
    poseWorker.emit({ type: 'pose-result', timestampMs: 200, inferenceMs: 10, poses: [] })
    client.submitFrame(fakeBitmap(), null, 1600)
    poseWorker.emit({ type: 'pose-result', timestampMs: 1600, inferenceMs: 10, poses: [] })
    expect(handlers.onResult).toHaveBeenLastCalledWith(expect.objectContaining({
      objects: [], objectsFresh: false, objectTimestampMs: null,
    }))
  })

  it('reports a worker that hangs during initialization and terminates both workers', () => {
    const { client, poseWorker, objectWorker, handlers } = createClient({}, false)
    client.init('/pose.task', '/objects.tflite', '/wasm')
    vi.advanceTimersByTime(60_000)
    expect(handlers.onError).toHaveBeenCalledWith('model-timeout', expect.any(String))
    expect(poseWorker.terminate).toHaveBeenCalledOnce()
    expect(objectWorker.terminate).toHaveBeenCalledOnce()
    poseWorker.emit({ type: 'ready', task: 'pose', delegate: 'GPU' })
    objectWorker.emit({ type: 'ready', task: 'objects', delegate: 'CPU' })
    expect(handlers.onReady).not.toHaveBeenCalled()
  })

  it('fails once when inference hangs and leaves no timers after disposal', () => {
    const { client, handlers } = createClient()
    client.submitFrame(fakeBitmap(), fakeBitmap(), 200)
    vi.advanceTimersByTime(15_000)
    expect(handlers.onError).toHaveBeenCalledTimes(1)
    expect(handlers.onError).toHaveBeenCalledWith('pose-timeout', expect.any(String))
    expect(client.isBusy).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles a failed frame transfer and releases both workers', () => {
    const { client, poseWorker, objectWorker, handlers } = createClient()
    poseWorker.postMessage.mockImplementation(() => { throw new Error('Transfer failed') })
    const poseBitmap = fakeBitmap()
    const objectBitmap = fakeBitmap()
    expect(client.submitFrame(poseBitmap, objectBitmap, 200)).toBe(false)
    expect(handlers.onError).toHaveBeenCalledWith('frame-transfer', 'Transfer failed')
    expect(poseBitmap.close).toHaveBeenCalledOnce()
    expect(objectBitmap.close).toHaveBeenCalledOnce()
    expect(objectWorker.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
