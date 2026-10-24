import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { cameraReducer, initialCameraState } from '../lib/cameraState'
import { ConflictEngine, EMPTY_CONFLICT, type ConflictSensitivity, type ConflictSnapshot } from '../lib/conflictEngine'
import { drawDemoScene, demoFrame, DEMO_SIZE, type DemoScenario } from '../lib/demoScene'
import { clearVisionOverlay, drawVisionOverlay } from '../lib/drawVision'
import { inferenceSize } from '../lib/inferenceSize'
import { createReviewResultLatch, EMPTY_SCAN_PROGRESS, runReviewScan, seekVideoFrame, throwIfAborted, waitForVideoData, waitUntilIdle, type ClipMode, type ScanProgress } from '../lib/reviewScan'
import { SourceClock } from '../lib/sourceClock'
import { PoseSmoother } from '../lib/poseSmoother'
import { EMPTY_SCENE, SceneEngine, type SceneSnapshot } from '../lib/sceneEngine'
import { BrowserCameraSource } from '../services/BrowserCameraSource'
import { USB_PHONE_DEVICE } from '../services/UsbPhoneSource'
import type { VisionResult } from '../services/VisionWorkerClient'
import type { PoseLandmarks } from '../types/vision'
import { useVisionWorker } from './useVisionWorker'

export type InputKind = 'camera' | 'clip' | 'demo'
const EMPTY_METRICS = { poses: 0, objects: 0, fps: 0, poseMs: 0, objectMs: 0 }

export function useVisionSession({ livePoseEnabled = true }: { livePoseEnabled?: boolean } = {}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const demoCanvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const source = useRef(new BrowserCameraSource())
  const engine = useRef(new SceneEngine())
  const conflictEngine = useRef(new ConflictEngine())
  const latestConflict = useRef<ConflictSnapshot>(EMPTY_CONFLICT)
  const generation = useRef(0)
  const playbackRequest = useRef(0)
  const recoveryResume = useRef<number | null>(null)
  const sourceClock = useRef(new SourceClock())
  const clipAbort = useRef<AbortController | null>(null)
  const reviewAbort = useRef<AbortController | null>(null)
  const reviewPending = useRef<{ accept(result: VisionResult): void } | null>(null)
  const scanPosition = useRef<ScanProgress>(EMPTY_SCAN_PROGRESS)
  const active = useRef(false)
  const inputKind = useRef<InputKind>('camera')
  const clipUrl = useRef<string | null>(null)
  const latestPoses = useRef<PoseLandmarks[]>([])
  const poseSmoother = useRef(new PoseSmoother())
  const latestScene = useRef<SceneSnapshot>(EMPTY_SCENE)
  const lastResultTime = useRef(0)
  const resultTimes = useRef<number[]>([])
  const demoStart = useRef(0)
  const appliedModelSettings = useRef({ maxPoses: 4, poseConfidence: .5, confidence: .35 })
  const [camera, dispatch] = useReducer(cameraReducer, initialCameraState)
  const [kind, setKind] = useState<InputKind>('camera')
  const [sessionId, setSessionId] = useState(0)
  const [sourceName, setSourceName] = useState('Local camera')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [scene, setScene] = useState(EMPTY_SCENE)
  const [conflict, setConflict] = useState(EMPTY_CONFLICT)
  const [conflictEnabled, setConflictEnabled] = useState(true)
  const [objectAnalysisEnabled, setObjectAnalysisEnabled] = useState(false)
  const [metrics, setMetrics] = useState(EMPTY_METRICS)
  const [mirrored, setMirrored] = useState(true)
  const [skeleton, setSkeleton] = useState(true)
  const [objectsVisible, setObjectsVisible] = useState(true)
  const [maxPoses, setMaxPoses] = useState(4)
  const [poseConfidence, setPoseConfidence] = useState(.5)
  const [confidence, setConfidence] = useState(.35)
  const [unattendedSeconds, setUnattendedSeconds] = useState(5)
  const [scenario, setScenario] = useState<DemoScenario>('conflict')
  const [playing, setPlaying] = useState(false)
  const [stalled, setStalled] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [clipMode, setClipMode] = useState<ClipMode>('review')
  const [clipSensitivity, setClipSensitivity] = useState<ConflictSensitivity>('instant')
  // Live-camera sensitivity, 0 (careful) to 1 (maximum). Kept between visits.
  const [detectionPower, setDetectionPowerState] = useState(() => {
    try { const saved = Number(localStorage.getItem('nivra.detectionPower')); return Number.isFinite(saved) && localStorage.getItem('nivra.detectionPower') !== null ? Math.min(1, Math.max(0, saved)) : 0.6 } catch { return 0.6 }
  })
  const detectionPowerRef = useRef(detectionPower)
  const setDetectionPower = useCallback((power: number) => {
    const next = Math.min(1, Math.max(0, power))
    detectionPowerRef.current = next
    setDetectionPowerState(next)
    try { localStorage.setItem('nivra.detectionPower', String(next)) } catch { /* private mode */ }
    if (inputKind.current === 'camera') conflictEngine.current.configurePower(next)
  }, [])
  const [scanProgress, setScanProgress] = useState<ScanProgress>(EMPTY_SCAN_PROGRESS)

  const analysisNow = useCallback(() => inputKind.current === 'demo'
    ? performance.now()
    : sourceClock.current.read(performance.now(), videoRef.current?.currentTime ?? 0), [])

  const publishScan = useCallback((next: ScanProgress) => {
    scanPosition.current = next
    setScanProgress(next)
  }, [])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    const video = videoRef.current
    if (!canvas || !stage) return
    const sourceSize = inputKind.current === 'demo'
      ? DEMO_SIZE
      : { width: video?.videoWidth ?? 0, height: video?.videoHeight ?? 0 }
    const bounds = stage.getBoundingClientRect()
    drawVisionOverlay(canvas, latestPoses.current, latestScene.current.objects, {
      source: sourceSize, container: bounds, mirrored: inputKind.current === 'camera' && mirrored,
      fit: inputKind.current === 'clip' ? 'contain' : 'cover',
      showSkeleton: skeleton, showObjects: objectsVisible, watch: latestScene.current.watch,
      conflict: latestConflict.current,
    })
  }, [mirrored, objectsVisible, skeleton])

  const publishScene = useCallback((next: SceneSnapshot) => {
    latestScene.current = next
    setScene(next)
  }, [])

  const publishConflict = useCallback((next: ConflictSnapshot) => {
    latestConflict.current = next
    setConflict(next)
  }, [])

  const onResult = useCallback((result: VisionResult) => {
    if (!active.current || inputKind.current === 'demo') return
    const now = performance.now()
    lastResultTime.current = now
    latestPoses.current = result.posesFresh === false ? latestPoses.current : poseSmoother.current.update(result.poses, now)
    const next = result.objectsFresh && objectAnalysisEnabled
      ? engine.current.update(result.objectTimestampMs ?? result.timestampMs, result.objects)
      : engine.current.snapshot(result.timestampMs)
    if (conflictEnabled) {
      const video = videoRef.current
      publishConflict(result.posesFresh
        ? conflictEngine.current.update(result.timestampMs, result.poses, video?.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9)
        : conflictEngine.current.snapshot(result.timestampMs))
    }
    publishScene(next)
    resultTimes.current = resultTimes.current.filter(t => now - t < 1000)
    if (result.posesFresh !== false) resultTimes.current.push(now)
    setMetrics({
      poses: Math.max(latestPoses.current.length, result.objects.filter(o => o.role === 'person').length),
      objects: next.objects.length, fps: resultTimes.current.length,
      poseMs: result.poseInferenceMs, objectMs: result.objectInferenceMs,
    })
    draw()
    reviewPending.current?.accept(result)
  }, [conflictEnabled, draw, objectAnalysisEnabled, publishConflict, publishScene])

  const vision = useVisionWorker({ onResult })
  const { resetStream, configure, restart, isBusy, needsObjectFrame, submitFrame, submitObjectFrame, setPosePolicy } = vision

  const clearScene = useCallback(() => {
    engine.current.reset()
    conflictEngine.current.reset()
    latestConflict.current = EMPTY_CONFLICT
    setConflict(EMPTY_CONFLICT)
    latestScene.current = EMPTY_SCENE
    latestPoses.current = []
    poseSmoother.current.reset()
    resultTimes.current = []
    lastResultTime.current = performance.now()
    setScene(EMPTY_SCENE)
    setMetrics(EMPTY_METRICS)
    setStalled(false)
    setSessionId(id => id + 1)
    if (canvasRef.current) clearVisionOverlay(canvasRef.current)
  }, [])

  const stop = useCallback(() => {
    generation.current += 1
    playbackRequest.current += 1
    recoveryResume.current = null
    clipAbort.current?.abort()
    reviewAbort.current?.abort()
    clipAbort.current = null
    reviewAbort.current = null
    active.current = false
    source.current.stop()
    resetStream()
    const video = videoRef.current
    if (video) {
      video.pause()
      video.playbackRate = 1
      video.srcObject = null
      video.removeAttribute('src')
      video.load()
    }
    if (clipUrl.current) URL.revokeObjectURL(clipUrl.current)
    clipUrl.current = null
    setPlaying(false)
    publishScan(EMPTY_SCAN_PROGRESS)
    clearScene()
    dispatch({ type: typeof navigator.mediaDevices?.getUserMedia === 'function' ? 'stopped' : 'unsupported' })
  }, [clearScene, publishScan, resetStream])

  const refreshDevices = useCallback(async () => {
    try { setDevices(await source.current.listDevices()) } catch { /* Camera request provides the actionable error. */ }
  }, [])

  useEffect(() => {
    void refreshDevices()
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices)
  }, [refreshDevices])

  useEffect(() => stop, [stop])

  const startCamera = useCallback(async (requestedDevice = deviceId) => {
    stop()
    const token = generation.current
    inputKind.current = 'camera'
    setPosePolicy('realtime')
    conflictEngine.current.configureSensitivity('instant')
    conflictEngine.current.configurePower(detectionPowerRef.current)
    sourceClock.current.begin('camera', performance.now())
    setKind('camera')
    setFileError(null)
    dispatch({ type: 'request' })
    try {
      const stream = await source.current.start(requestedDevice || undefined)
      if (generation.current !== token) return
      const video = videoRef.current
      if (!video) { stream.getTracks().forEach(track => track.stop()); return }
      video.srcObject = stream
      const track = stream.getVideoTracks()[0]
      track?.addEventListener('ended', () => {
        if (generation.current !== token) return
        stop()
        dispatch({ type: 'interrupted' })
      }, { once: true })
      await video.play()
      if (generation.current !== token) return
      active.current = true
      lastResultTime.current = performance.now()
      const usbPhone = requestedDevice === USB_PHONE_DEVICE
      setSourceName(usbPhone ? 'iPhone · USB cable' : track?.label || 'Local camera')
      setDeviceId(usbPhone ? USB_PHONE_DEVICE : track?.getSettings().deviceId || requestedDevice)
      setPlaying(true)
      dispatch({ type: 'started' })
      void refreshDevices()
    } catch (error) {
      if (generation.current !== token) return
      source.current.stop()
      if (videoRef.current) videoRef.current.srcObject = null
      dispatch({ type: 'failed', error })
    }
  }, [deviceId, refreshDevices, setPosePolicy, stop])

  const openClip = useCallback(async (file: File) => {
    if (vision.status !== 'ready') { setFileError('Wait for the local models to finish loading before opening a video.'); return }
    if (!file.type.startsWith('video/')) { setFileError('Choose a video file, such as MP4 or WebM.'); return }
    stop()
    const token = generation.current
    setFileError(null)
    inputKind.current = 'clip'
    setPosePolicy(clipMode)
    conflictEngine.current.configurePower(null)
    conflictEngine.current.configureSensitivity(clipSensitivity)
    sourceClock.current.begin('clip', performance.now())
    setKind('clip')
    setSourceName(file.name)
    dispatch({ type: 'request' })
    const video = videoRef.current
    if (!video) return
    clipUrl.current = URL.createObjectURL(file)
    const controller = new AbortController()
    clipAbort.current = controller
    video.src = clipUrl.current
    try {
      if (clipMode === 'review') {
        video.pause()
        video.load()
        await waitForVideoData(video, controller.signal)
      } else await video.play()
      if (generation.current !== token) return
      publishScan({ currentTime: 0, duration: video.duration, analyzedFrames: 0 })
      active.current = true
      lastResultTime.current = performance.now()
      setPlaying(true)
      dispatch({ type: 'started' })
    } catch {
      if (generation.current !== token) return
      stop()
      dispatch({ type: 'failed', error: new Error('This video format could not play. Try an MP4 (H.264) or WebM file.') })
    }
  }, [clipMode, clipSensitivity, publishScan, setPosePolicy, stop, vision.status])

  const startDemo = useCallback((nextScenario: DemoScenario = scenario) => {
    stop()
    inputKind.current = 'demo'
    conflictEngine.current.configurePower(null)
    conflictEngine.current.configureSensitivity('standard')
    setKind('demo')
    setScenario(nextScenario)
    setSourceName(({ unattended: 'Bag left behind', watched: 'Watch an item move', conflict: 'Repeated striking motion', calm: 'Waving · no conflict' })[nextScenario])
    demoStart.current = performance.now()
    active.current = true
    setPlaying(true)
    dispatch({ type: 'started' })
  }, [scenario, stop])

  useEffect(() => {
    if (kind !== 'demo' || camera.status !== 'live') return
    const tick = () => {
      const now = performance.now()
      const frame = demoFrame(now - demoStart.current, scenario)
      let next = engine.current.update(now, frame.objects)
      if (scenario === 'watched' && now - demoStart.current < 500 && !next.watch) {
        const bag = next.objects.find(item => item.role === 'bag')
        if (bag) engine.current.watchObject(bag.trackKey)
        next = engine.current.snapshot(now)
      }
      publishScene(next)
      if (conflictEnabled) publishConflict(conflictEngine.current.update(now, frame.poses, DEMO_SIZE.width / DEMO_SIZE.height))
      latestPoses.current = frame.poses
      setMetrics({ ...EMPTY_METRICS, poses: frame.poses.length, objects: next.objects.length })
      if (demoCanvasRef.current) drawDemoScene(demoCanvasRef.current, frame.objects, frame.poses)
      draw()
    }
    tick()
    const timer = window.setInterval(tick, 100)
    return () => clearInterval(timer)
  }, [camera.status, conflictEnabled, kind, scenario, draw, publishConflict, publishScene, sessionId])

  useEffect(() => {
    conflictEngine.current.reset()
    publishConflict(EMPTY_CONFLICT)
  }, [conflictEnabled, publishConflict])

  useEffect(() => {
    if (!objectAnalysisEnabled && inputKind.current !== 'demo') {
      engine.current.reset()
      publishScene(EMPTY_SCENE)
    }
  }, [objectAnalysisEnabled, publishScene])

  useEffect(() => {
    if (vision.status !== 'ready') return
    const previous = appliedModelSettings.current
    if (previous.maxPoses === maxPoses && previous.poseConfidence === poseConfidence && previous.confidence === confidence) return
    resetStream()
    configure(maxPoses, poseConfidence, confidence)
    appliedModelSettings.current = { maxPoses, poseConfidence, confidence }
    // A different pose graph must build fresh motion evidence. Keep review history.
    conflictEngine.current.resetMotion()
    publishConflict(conflictEngine.current.snapshot(analysisNow()))
  }, [analysisNow, vision.status, maxPoses, poseConfidence, confidence, configure, publishConflict, resetStream])

  useEffect(() => {
    engine.current.configure({ unattendedSeconds })
  }, [unattendedSeconds])

  useEffect(() => {
    if (vision.status === 'ready' || inputKind.current === 'demo') return
    conflictEngine.current.resetMotion()
    publishConflict(conflictEngine.current.snapshot(analysisNow()))
    latestPoses.current = []
    poseSmoother.current.reset()
    resultTimes.current = []
    setMetrics(EMPTY_METRICS)
    if (canvasRef.current) clearVisionOverlay(canvasRef.current)
  }, [analysisNow, vision.status, publishConflict])

  useEffect(() => {
    if (kind !== 'clip' || clipMode !== 'review' || camera.status !== 'live' || vision.status !== 'ready' || !playing) return
    const video = videoRef.current
    if (!video) return
    const controller = new AbortController()
    reviewAbort.current = controller
    const { signal } = controller
    const token = generation.current
    video.pause()
    void runReviewScan({
      duration: video.duration,
      completedFrames: scanPosition.current.analyzedFrames,
      signal,
      seek: time => seekVideoFrame(video, time, signal),
      analyze: async time => {
        await waitUntilIdle(isBusy, signal)
        throwIfAborted(signal)
        const dimensions = inferenceSize({ width: video.videoWidth, height: video.videoHeight }, vision.quality === 'full' ? 960 : 640)
        let bitmap: ImageBitmap | null = null
        let objectBitmap: ImageBitmap | null = null
        try {
          bitmap = await createImageBitmap(video, { resizeWidth: dimensions.width, resizeHeight: dimensions.height, resizeQuality: 'medium' })
          throwIfAborted(signal)
          const timestamp = sourceClock.current.frame(performance.now(), time)
          if (objectAnalysisEnabled && needsObjectFrame(timestamp)) objectBitmap = await createImageBitmap(bitmap)
          throwIfAborted(signal)
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              signal.removeEventListener('abort', abort)
              if (reviewPending.current === pending) reviewPending.current = null
            }
            const pending = { accept: createReviewResultLatch(timestamp, !!objectBitmap, () => { cleanup(); resolve() }) }
            const abort = () => { cleanup(); reject(new DOMException('Review scan cancelled.', 'AbortError')) }
            reviewPending.current = pending
            signal.addEventListener('abort', abort, { once: true })
            if (!submitFrame(bitmap!, objectBitmap, timestamp)) {
              cleanup()
              reject(new Error('The review frame could not be submitted. Resume or restart analysis.'))
            }
          })
        } catch (error) {
          bitmap?.close()
          objectBitmap?.close()
          throw error
        }
      },
      progress: progress => { if (!signal.aborted && generation.current === token) publishScan(progress) },
    }).then(() => {
      if (signal.aborted || generation.current !== token) return
      active.current = false
      setPlaying(false)
    }).catch(error => {
      if (signal.aborted || generation.current !== token) return
      active.current = false
      setPlaying(false)
      setFileError(error instanceof Error ? error.message : 'Review scan stopped. Try opening the video again.')
    })
    return () => {
      controller.abort()
      if (reviewAbort.current === controller) reviewAbort.current = null
    }
  }, [camera.status, clipMode, kind, playing, vision.status, vision.quality, maxPoses, poseConfidence, confidence, isBusy, needsObjectFrame, objectAnalysisEnabled, publishScan, submitFrame, sessionId])

  useEffect(() => {
    if (kind === 'demo' || camera.status !== 'live' || vision.status !== 'ready' || !playing) return
    if (kind === 'clip' && clipMode === 'review') return
    if (kind === 'camera' && !livePoseEnabled && !objectAnalysisEnabled) return
    const video = videoRef.current
    if (!video) return
    let cancelled = false
    let frameId: number | null = null
    let rafId: number | null = null
    let lastMediaTime = -1
    const schedule = () => {
      if (cancelled) return
      if (typeof video.requestVideoFrameCallback === 'function') frameId = video.requestVideoFrameCallback((_now, metadata) => void capture(metadata.mediaTime))
      else rafId = requestAnimationFrame(() => void capture(video.currentTime))
    }
    const capture = async (mediaTime: number) => {
      if (cancelled) return
      const poseAvailable = (kind !== 'camera' || livePoseEnabled) && !isBusy()
      const objectAvailable = objectAnalysisEnabled && needsObjectFrame(sourceClock.current.read(performance.now(), mediaTime))
      if (!video.paused && video.readyState >= 2 && video.videoWidth > 0 && (poseAvailable || objectAvailable) && mediaTime !== lastMediaTime) {
        lastMediaTime = mediaTime
        const timestamp = sourceClock.current.frame(performance.now(), mediaTime)
        let poseBitmap: ImageBitmap | null = null
        let objectBitmap: ImageBitmap | null = null
        try {
          const dimensions = inferenceSize(
            { width: video.videoWidth, height: video.videoHeight },
            poseAvailable && vision.quality === 'full' ? 960 : 640,
          )
          poseBitmap = await createImageBitmap(video, {
            resizeWidth: dimensions.width,
            resizeHeight: dimensions.height,
            resizeQuality: 'medium',
          })
          if (poseAvailable && objectAnalysisEnabled && needsObjectFrame(timestamp)) objectBitmap = await createImageBitmap(poseBitmap)
          if (cancelled) { poseBitmap.close(); objectBitmap?.close() }
          else if (poseAvailable) submitFrame(poseBitmap, objectBitmap, timestamp)
          else submitObjectFrame(poseBitmap, timestamp)
        } catch { poseBitmap?.close(); objectBitmap?.close() }
      }
      schedule()
    }
    schedule()
    return () => {
      cancelled = true
      if (frameId !== null) video.cancelVideoFrameCallback(frameId)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [camera.status, clipMode, kind, livePoseEnabled, objectAnalysisEnabled, playing, vision.status, vision.quality, isBusy, needsObjectFrame, submitFrame, submitObjectFrame, sessionId])

  useEffect(() => {
    if (camera.status !== 'live' || kind === 'demo' || !playing) return
    if (kind === 'camera' && !livePoseEnabled && !objectAnalysisEnabled) { setStalled(false); return }
    const timer = window.setInterval(() => {
      const stale = performance.now() - lastResultTime.current > 3_500
      setStalled(stale)
      if (stale) {
        latestPoses.current = []
        poseSmoother.current.reset()
        publishScene(engine.current.snapshot(analysisNow()))
        publishConflict(conflictEngine.current.snapshot(analysisNow()))
        if (canvasRef.current) clearVisionOverlay(canvasRef.current)
        setMetrics(old => ({ ...old, fps: 0, poses: 0, objects: 0 }))
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [analysisNow, camera.status, kind, livePoseEnabled, objectAnalysisEnabled, playing, publishConflict, publishScene])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(draw)
    observer.observe(stage)
    draw()
    return () => observer.disconnect()
  }, [draw])

  const watch = useCallback((key: string) => {
    if (engine.current.watchObject(key)) publishScene(engine.current.snapshot(analysisNow()))
  }, [analysisNow, publishScene])
  const clearWatch = useCallback(() => {
    engine.current.clearWatch()
    publishScene(engine.current.snapshot(analysisNow()))
  }, [analysisNow, publishScene])

  const togglePlayback = useCallback(async () => {
    const video = videoRef.current
    if (!video || kind !== 'clip') return
    recoveryResume.current = null
    if (vision.status !== 'ready') return
    const token = generation.current
    const action = ++playbackRequest.current
    if (!playing) {
      resetStream()
      const completed = clipMode === 'review'
        ? scanPosition.current.duration > 0 && scanPosition.current.currentTime >= scanPosition.current.duration
        : video.ended
      if (completed) {
        clearScene()
        sourceClock.current.begin('clip', performance.now())
        publishScan({ currentTime: 0, duration: video.duration, analyzedFrames: 0 })
        video.currentTime = 0
      }
      try {
        if (clipMode === 'realtime') await video.play()
        if (generation.current !== token || playbackRequest.current !== action || inputKind.current !== 'clip') return
        const now = performance.now()
        publishScene(engine.current.resume(analysisNow()))
        lastResultTime.current = now
        resultTimes.current = []
        setStalled(false)
        setFileError(null)
        active.current = true
        setPlaying(true)
      } catch {
        if (generation.current === token && playbackRequest.current === action && inputKind.current === 'clip') {
          setFileError('Playback could not resume. Open the clip again.')
        }
      }
    } else {
      active.current = false
      reviewAbort.current?.abort()
      video.pause()
      resetStream()
      publishScene(engine.current.pause(analysisNow()))
      conflictEngine.current.resetMotion()
      publishConflict(conflictEngine.current.snapshot(analysisNow()))
      setPlaying(false)
    }
  }, [analysisNow, clearScene, clipMode, kind, playing, publishConflict, publishScan, publishScene, resetStream, vision.status])

  useEffect(() => {
    const video = videoRef.current
    if (kind !== 'clip' || camera.status !== 'live' || !video) return
    if (vision.status !== 'ready' && playing) {
      recoveryResume.current = generation.current
      active.current = false
      reviewAbort.current?.abort()
      video.pause()
      resetStream()
      publishScene(engine.current.pause(analysisNow()))
      setPlaying(false)
    } else if (vision.status === 'ready' && recoveryResume.current === generation.current) {
      // Keep a short clip from finishing while the fallback models initialize.
      recoveryResume.current = null
      void togglePlayback()
    }
  }, [analysisNow, camera.status, kind, playing, vision.status, publishScene, resetStream, togglePlayback])

  const retryAnalysis = useCallback(() => {
    clearScene()
    restart()
  }, [clearScene, restart])

  return {
    videoRef, canvasRef, demoCanvasRef, stageRef, camera, kind, sessionId, sourceName,
    devices, deviceId, setDeviceId, scene, metrics, mirrored, setMirrored,
    skeleton, setSkeleton, objectsVisible, setObjectsVisible,
    maxPoses, setMaxPoses, poseConfidence, setPoseConfidence, confidence, setConfidence, unattendedSeconds, setUnattendedSeconds,
    scenario, playing, setPlaying, stalled, fileError, vision, clipMode, setClipMode, scanProgress, clipSensitivity, setClipSensitivity, detectionPower, setDetectionPower,
    conflict, conflictEnabled, setConflictEnabled, objectAnalysisEnabled, setObjectAnalysisEnabled,
    startCamera, stop, openClip, startDemo, watch, clearWatch, togglePlayback, retryAnalysis,
  }
}
