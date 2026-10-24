import { useCallback, useEffect, useRef, useState } from 'react'
import {
  VisionWorkerClient,
  type VisionResult,
} from '../services/VisionWorkerClient'
import type { PoseQuality, VisionDelegate, VisionDelegates } from '../types/vision'

export type ModelStatus = 'loading' | 'ready' | 'error'
export type PosePolicy = 'review' | 'realtime'

type GpuFailure = 'timeout' | 'unavailable' | null
const REVIEW_RUNTIME_NOTICE = 'Review scans use the CPU reference runtime. Cameras use GPU when available.'

function runtimeNotice(policy: PosePolicy, gpuFailure: GpuFailure): string | null {
  if (policy === 'review') return REVIEW_RUNTIME_NOTICE
  if (gpuFailure === 'timeout') return 'GPU analysis stopped responding. Switched to CPU for this session.'
  if (gpuFailure === 'unavailable') return 'GPU acceleration is unavailable. Using CPU on this device.'
  return null
}

interface UseVisionWorkerOptions {
  onResult(result: VisionResult): void
}

export function useVisionWorker({ onResult }: UseVisionWorkerOptions) {
  const clientRef = useRef<VisionWorkerClient | null>(null)
  const resultCallbackRef = useRef(onResult)
  const settingsRef = useRef({ maxPoses: 4, poseConfidence: 0.5, objectConfidence: 0.35 })
  const preferredPoseDelegate = useRef<VisionDelegate>('GPU')
  const posePolicy = useRef<PosePolicy>('realtime')
  // Choosing CPU for a review must not disable GPU for the next live camera.
  const gpuFailure = useRef<GpuFailure>(null)
  const qualityRef = useRef<PoseQuality>('full')
  const [quality, setQualityState] = useState<PoseQuality>('full')
  const [restartVersion, setRestartVersion] = useState(0)
  const [status, setStatus] = useState<ModelStatus>('loading')
  const [delegates, setDelegates] = useState<VisionDelegates | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  resultCallbackRef.current = onResult

  useEffect(() => {
    let active = true
    let poseWorker: Worker | null = null
    let objectWorker: Worker | null = null
    let client: VisionWorkerClient | null = null
    let activeDelegates: VisionDelegates | null = null
    const requestedPoseDelegate = preferredPoseDelegate.current
    setStatus('loading')
    setDelegates(null)
    setError(null)

    try {
      poseWorker = new Worker(new URL('../workers/vision.worker.ts', import.meta.url), {
        type: 'module',
      })
      objectWorker = new Worker(
        new URL('../workers/vision.worker.ts', import.meta.url),
        { type: 'module' },
      )
      client = new VisionWorkerClient(poseWorker, objectWorker, {
        onReady: (nextDelegates) => {
          if (!active) return
          activeDelegates = nextDelegates
          setDelegates(nextDelegates)
          if (nextDelegates.pose === 'CPU' && requestedPoseDelegate === 'GPU') {
            gpuFailure.current = 'unavailable'
            preferredPoseDelegate.current = 'CPU'
          }
          setNotice(runtimeNotice(posePolicy.current, gpuFailure.current))
          setStatus('ready')
          setError(null)
        },
        onResult: (result) => {
          if (active) resultCallbackRef.current(result)
        },
        onError: (code, message) => {
          if (!active) return
          if (code === 'pose-timeout' && activeDelegates?.pose === 'GPU' && !gpuFailure.current) {
            gpuFailure.current = 'timeout'
            preferredPoseDelegate.current = 'CPU'
            active = false
            client?.dispose()
            if (clientRef.current === client) clientRef.current = null
            setNotice(runtimeNotice(posePolicy.current, gpuFailure.current))
            setStatus('loading')
            setDelegates(null)
            setError(null)
            setRestartVersion(version => version + 1)
            return
          }
          setStatus('error')
          setError(message)
        },
      })

      clientRef.current = client
      const wasmRoot = import.meta.env.DEV
        ? `${import.meta.env.BASE_URL}__nivra_wasm`
        : `${import.meta.env.BASE_URL}mediapipe/wasm`
      const settings = settingsRef.current
      client.init(
        `${import.meta.env.BASE_URL}models/pose_landmarker_${quality}.task`,
        `${import.meta.env.BASE_URL}models/efficientdet_lite0_float16.tflite`,
        wasmRoot,
        settings.maxPoses,
        settings.poseConfidence,
        settings.objectConfidence,
        requestedPoseDelegate,
      )
    } catch (cause) {
      poseWorker?.terminate()
      objectWorker?.terminate()
      setStatus('error')
      setError(cause instanceof Error ? cause.message : 'This browser could not start local analysis.')
    }

    return () => {
      active = false
      client?.dispose()
      if (clientRef.current === client) clientRef.current = null
    }
  }, [restartVersion, quality])

  const submitFrame = useCallback(
    (
      poseBitmap: ImageBitmap,
      objectBitmap: ImageBitmap | null,
      timestampMs: number,
    ) => {
      if (clientRef.current) return clientRef.current.submitFrame(poseBitmap, objectBitmap, timestampMs)
      poseBitmap.close()
      objectBitmap?.close()
      return false
    },
    [],
  )

  const configure = useCallback(
    (maxPoses: number, poseConfidence: number, objectConfidence: number) => {
      settingsRef.current = { maxPoses, poseConfidence, objectConfidence }
      clientRef.current?.configure(maxPoses, poseConfidence, objectConfidence)
    },
    [],
  )

  const submitObjectFrame = useCallback((bitmap: ImageBitmap, timestampMs: number) => {
    if (clientRef.current) return clientRef.current.submitObjectFrame(bitmap, timestampMs)
    bitmap.close()
    return false
  }, [])

  const resetStream = useCallback(() => clientRef.current?.resetStream(), [])
  const restart = useCallback(() => {
    clientRef.current?.dispose()
    clientRef.current = null
    setStatus('loading')
    setDelegates(null)
    setError(null)
    setRestartVersion((version) => version + 1)
  }, [])

  const setPosePolicy = useCallback((nextPolicy: PosePolicy) => {
    posePolicy.current = nextPolicy
    const nextDelegate: VisionDelegate = nextPolicy === 'review' || gpuFailure.current ? 'CPU' : 'GPU'
    setNotice(runtimeNotice(nextPolicy, gpuFailure.current))
    if (preferredPoseDelegate.current === nextDelegate) return
    preferredPoseDelegate.current = nextDelegate
    // Reject old-runtime frames in the same event, before effect cleanup runs.
    clientRef.current?.dispose()
    clientRef.current = null
    setStatus('loading')
    setDelegates(null)
    setError(null)
    setRestartVersion(version => version + 1)
  }, [])

  const setQuality = useCallback((nextQuality: PoseQuality) => {
    if (qualityRef.current === nextQuality) return
    qualityRef.current = nextQuality
    // Stop accepting old-model frames immediately, before React runs cleanup.
    clientRef.current?.dispose()
    clientRef.current = null
    setStatus('loading')
    setDelegates(null)
    setError(null)
    setQualityState(nextQuality)
    setRestartVersion(version => version + 1)
  }, [])

  const isBusy = useCallback(() => clientRef.current?.isBusy ?? false, [])
  const needsObjectFrame = useCallback(
    (timestampMs: number) => clientRef.current?.needsObjectFrame(timestampMs) ?? false,
    [],
  )

  return {
    quality,
    setQuality,
    setPosePolicy,
    status,
    delegates,
    error,
    notice,
    submitFrame,
    submitObjectFrame,
    configure,
    isBusy,
    needsObjectFrame,
    resetStream,
    restart,
  }
}
