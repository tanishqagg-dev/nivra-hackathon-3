import { FrameGate } from '../lib/frameGate'
import type {
  ObjectObservation,
  PoseLandmarks,
  VisionDelegates,
  VisionDelegate,
  VisionTaskKind,
  VisionWorkerRequest,
  VisionWorkerResponse,
} from '../types/vision'

const OBJECT_INTERVAL_MS = 140
const MAX_OBJECT_AGE_MS = 1_200
const MODEL_TIMEOUT_MS = 60_000
const FRAME_TIMEOUT_MS = 15_000
const GPU_FRAME_TIMEOUT_MS = 5_000

interface PendingFrame {
  timestampMs: number
  generation: number
}

export interface VisionResult {
  timestampMs: number
  inferenceMs: number
  poseInferenceMs: number
  objectInferenceMs: number
  objectTimestampMs: number | null
  objectsFresh: boolean
  posesFresh: boolean
  poses: PoseLandmarks[]
  objects: ObjectObservation[]
}

export interface VisionWorkerClientCallbacks {
  onReady(delegates: VisionDelegates): void
  onResult(result: VisionResult): void
  onError(code: string, message: string): void
}

export class VisionWorkerClient {
  private readonly poseGate = new FrameGate()
  private readonly objectGate = new FrameGate()
  private readonly delegates: Partial<VisionDelegates> = {}
  private readonly poseWorker: Worker
  private readonly objectWorker: Worker
  private readonly callbacks: VisionWorkerClientCallbacks
  private disposed = false
  private ready = false
  private configuration: { maxPoses: number; poseConfidence: number; objectConfidence: number } | null = null
  private generation = 0
  private pendingPose: PendingFrame | null = null
  private pendingObjects: PendingFrame | null = null
  private modelTimer: ReturnType<typeof setTimeout> | null = null
  private poseTimer: ReturnType<typeof setTimeout> | null = null
  private objectTimer: ReturnType<typeof setTimeout> | null = null
  private latestObjects: ObjectObservation[] = []
  private latestPoses: PoseLandmarks[] = []
  private latestPoseTimestampMs = Number.NEGATIVE_INFINITY
  private poseInferenceMs = 0
  private latestObjectTimestampMs = Number.NEGATIVE_INFINITY
  private lastPoseSubmitMs = Number.NEGATIVE_INFINITY
  private objectInferenceMs = 0
  private lastObjectSubmitMs = Number.NEGATIVE_INFINITY

  constructor(
    poseWorker: Worker,
    objectWorker: Worker,
    callbacks: VisionWorkerClientCallbacks,
  ) {
    this.poseWorker = poseWorker
    this.objectWorker = objectWorker
    this.callbacks = callbacks
    poseWorker.onmessage = (event: MessageEvent<VisionWorkerResponse>) => {
      this.handleMessage('pose', event.data)
    }
    objectWorker.onmessage = (event: MessageEvent<VisionWorkerResponse>) => {
      this.handleMessage('objects', event.data)
    }
    poseWorker.onerror = (event) => this.handleWorkerCrash('pose', event)
    objectWorker.onerror = (event) => this.handleWorkerCrash('objects', event)
    poseWorker.onmessageerror = () => this.fail('worker-message', 'The pose worker returned unreadable data. Restart analysis.')
    objectWorker.onmessageerror = () => this.fail('worker-message', 'The object worker returned unreadable data. Restart analysis.')
  }

  init(
    poseModelPath: string,
    objectModelPath: string,
    wasmRoot: string,
    maxPoses = 4,
    poseConfidence = 0.5,
    objectConfidence = 0.35,
    poseDelegate: VisionDelegate = 'GPU',
  ): void {
    if (this.disposed || this.modelTimer || this.ready) return
    this.configuration = { maxPoses, poseConfidence, objectConfidence }
    this.modelTimer = setTimeout(() => {
      this.fail('model-timeout', 'Local model loading timed out. Restart analysis to try again.')
    }, MODEL_TIMEOUT_MS)
    const shared = { wasmRoot, maxPoses, poseConfidence, objectConfidence }
    try {
      this.post(this.poseWorker, {
        type: 'init',
        task: 'pose',
        modelPath: poseModelPath,
        poseDelegate,
        ...shared,
      })
      this.post(this.objectWorker, {
        type: 'init',
        task: 'objects',
        modelPath: objectModelPath,
        ...shared,
      })
    } catch (error) {
      this.fail('worker-init', error instanceof Error ? error.message : 'Local analysis could not start.')
    }
  }

  needsObjectFrame(timestampMs: number): boolean {
    return (
      !this.disposed &&
      this.ready &&
      !this.objectGate.isBusy &&
      timestampMs - this.lastObjectSubmitMs >= OBJECT_INTERVAL_MS
    )
  }

  submitFrame(
    poseBitmap: ImageBitmap,
    objectBitmap: ImageBitmap | null,
    timestampMs: number,
  ): boolean {
    if (
      this.disposed || !this.ready ||
      !Number.isFinite(timestampMs) || timestampMs <= this.lastPoseSubmitMs ||
      !this.poseGate.tryAcquire()
    ) {
      poseBitmap.close()
      objectBitmap?.close()
      return false
    }

    this.pendingPose = { timestampMs, generation: this.generation }
    this.lastPoseSubmitMs = timestampMs
    this.poseTimer = setTimeout(() => {
      this.fail('pose-timeout', 'Pose analysis stopped responding. Restart analysis to try again.')
    }, this.delegates.pose === 'GPU' ? GPU_FRAME_TIMEOUT_MS : FRAME_TIMEOUT_MS)
    try {
      this.post(
        this.poseWorker,
        { type: 'frame', bitmap: poseBitmap, timestampMs },
        [poseBitmap],
      )
    } catch (error) {
      poseBitmap.close()
      objectBitmap?.close()
      this.fail(
        'frame-transfer',
        error instanceof Error ? error.message : 'A camera frame could not be analyzed.',
      )
      return false
    }

    if (objectBitmap) this.submitObjectFrame(objectBitmap, timestampMs)
    return true
  }

  configure(maxPoses: number, poseConfidence: number, objectConfidence: number): void {
    if (
      this.configuration?.maxPoses === maxPoses &&
      this.configuration.poseConfidence === poseConfidence &&
      this.configuration.objectConfidence === objectConfidence
    ) return
    this.configuration = { maxPoses, poseConfidence, objectConfidence }
    const message: VisionWorkerRequest = {
      type: 'configure',
      maxPoses,
      poseConfidence,
      objectConfidence,
    }
    try {
      this.post(this.poseWorker, message)
      this.post(this.objectWorker, message)
    } catch (error) {
      this.fail('model-config', error instanceof Error ? error.message : 'Analysis settings could not be applied.')
    }
  }

  resetStream(): void {
    this.generation += 1
    this.latestObjects = []
    this.latestPoses = []
    this.latestPoseTimestampMs = Number.NEGATIVE_INFINITY
    this.poseInferenceMs = 0
    this.latestObjectTimestampMs = Number.NEGATIVE_INFINITY
    this.objectInferenceMs = 0
    this.lastObjectSubmitMs = Number.NEGATIVE_INFINITY
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.ready = false
    if (this.modelTimer !== null) clearTimeout(this.modelTimer)
    if (this.poseTimer !== null) clearTimeout(this.poseTimer)
    if (this.objectTimer !== null) clearTimeout(this.objectTimer)
    for (const worker of [this.poseWorker, this.objectWorker]) {
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      // Terminating also releases models if the worker is stuck inside WASM.
      worker.terminate()
    }
    this.pendingPose = null
    this.pendingObjects = null
    this.poseGate.release()
    this.objectGate.release()
  }

  get isBusy(): boolean {
    return this.poseGate.isBusy
  }

  submitObjectFrame(bitmap: ImageBitmap, timestampMs: number): boolean {
    if (!Number.isFinite(timestampMs) || !this.needsObjectFrame(timestampMs) || !this.objectGate.tryAcquire()) {
      bitmap.close()
      return false
    }
    this.lastObjectSubmitMs = timestampMs
    this.pendingObjects = { timestampMs, generation: this.generation }
    this.objectTimer = setTimeout(() => {
      this.fail('inference-timeout', 'Object analysis stopped responding. Restart analysis to try again.')
    }, FRAME_TIMEOUT_MS)
    try {
      this.post(
        this.objectWorker,
        { type: 'frame', bitmap, timestampMs },
        [bitmap],
      )
      return true
    } catch (error) {
      bitmap.close()
      this.fail(
        'frame-transfer',
        error instanceof Error ? error.message : 'An object-analysis frame was rejected.',
      )
      return false
    }
  }

  private post(worker: Worker, message: VisionWorkerRequest, transfer?: Transferable[]): void {
    if (this.disposed && message.type !== 'dispose') return
    worker.postMessage(message, transfer ?? [])
  }

  private handleWorkerCrash(task: VisionTaskKind, event: ErrorEvent): void {
    this.fail(
      'worker-crash',
      event.message || `The local ${task} worker stopped unexpectedly.`,
    )
  }

  private fail(code: string, message: string): void {
    if (this.disposed) return
    this.dispose()
    this.callbacks.onError(code, message)
  }

  private handleMessage(source: VisionTaskKind, message: VisionWorkerResponse): void {
    if (this.disposed) return
    if (message.type === 'ready') {
      if (message.task !== source || this.ready) return
      this.delegates[message.task] = message.delegate
      if (this.delegates.pose && this.delegates.objects) {
        this.ready = true
        if (this.modelTimer !== null) clearTimeout(this.modelTimer)
        this.modelTimer = null
        this.callbacks.onReady({
          pose: this.delegates.pose,
          objects: this.delegates.objects,
        })
      }
      return
    }

    if (message.type === 'error') {
      this.fail(message.code, message.message)
      return
    }

    if (message.type === 'object-result') {
      if (source !== 'objects' || message.timestampMs !== this.pendingObjects?.timestampMs) return
      const generation = this.pendingObjects.generation
      this.pendingObjects = null
      if (this.objectTimer !== null) clearTimeout(this.objectTimer)
      this.objectTimer = null
      this.objectGate.release()
      if (generation !== this.generation) return
      this.latestObjects = message.objects
      this.latestObjectTimestampMs = message.timestampMs
      this.objectInferenceMs = message.inferenceMs
      this.callbacks.onResult({
        timestampMs: message.timestampMs,
        inferenceMs: this.poseInferenceMs,
        poseInferenceMs: this.poseInferenceMs,
        objectInferenceMs: message.inferenceMs,
        objectTimestampMs: message.timestampMs,
        posesFresh: false,
        objectsFresh: true,
        poses: message.timestampMs - this.latestPoseTimestampMs <= MAX_OBJECT_AGE_MS ? this.latestPoses : [],
        objects: message.objects,
      })
      return
    }

    if (source !== 'pose' || message.timestampMs !== this.pendingPose?.timestampMs) return
    const generation = this.pendingPose.generation
    this.pendingPose = null
    if (this.poseTimer !== null) clearTimeout(this.poseTimer)
    this.poseTimer = null
    this.poseGate.release()
    if (generation !== this.generation) return
    this.latestPoses = message.poses
    this.latestPoseTimestampMs = message.timestampMs
    this.poseInferenceMs = message.inferenceMs
    const objectsExpired = message.timestampMs - this.latestObjectTimestampMs > MAX_OBJECT_AGE_MS
    this.callbacks.onResult({
      timestampMs: message.timestampMs,
      inferenceMs: message.inferenceMs,
      poseInferenceMs: message.inferenceMs,
      objectInferenceMs: this.objectInferenceMs,
      objectTimestampMs: objectsExpired ? null : this.latestObjectTimestampMs,
      posesFresh: true,
      objectsFresh: false,
      poses: message.poses,
      objects: objectsExpired ? [] : this.latestObjects,
    })
  }
}
