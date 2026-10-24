import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowsOut, Bell, DeviceMobile, Plus, ShieldCheck, SlidersHorizontal, SpeakerHigh, SpeakerSlash, VideoCamera } from '@phosphor-icons/react'
import './styles/product.css'
import { AlertPanel } from './components/AlertPanel'
import { CameraTile } from './components/CameraTile'
import { ConflictPanel } from './components/ConflictPanel'
import { DetectionSettings } from './components/DetectionSettings'
import { DispatchControl } from './components/DispatchControl'
import { FightPanel } from './components/FightPanel'
import { ObservationRail } from './components/ObservationRail'
import { UsbPhonePanel } from './components/UsbPhonePanel'
import { RollingNumber } from './components/ui/RollingNumber'
import { Segmented } from './components/ui/Segmented'
import { useFightDetector } from './hooks/useFightDetector'
import { useGuards } from './hooks/useGuards'
import { useIncidents } from './hooks/useIncidents'
import { useUsbPhone } from './hooks/useUsbPhone'
import { useVisionSession } from './hooks/useVisionSession'
import { alertKey } from './lib/alertKey'
import type { CameraStatus } from './lib/cameraState'
import type { DemoScenario } from './lib/demoScene'
import { useRoute, type Page } from './lib/route'
import type { ReviewEvent } from './lib/sceneEngine'
import { useSite } from './lib/site'
import { cameraIdOfEvent, MAX_EXTRA_CAMERAS, useCameras } from './lib/cameras'
import { usbHealth } from './lib/usbHealth'
import { IncidentsPage } from './pages/IncidentsPage'
import { SettingsPage, type SettingsSection } from './pages/SettingsPage'
import { SetupPage } from './pages/SetupPage'
import { ClipRecorder } from './services/ClipRecorder'
import { ReviewTonePlayer, type ReviewAudioState } from './services/ReviewTonePlayer'
import { USB_PHONE_DEVICE } from './services/UsbPhoneSource'

const CAMERA_LABELS: Record<CameraStatus, string> = {
  unsupported: 'Camera unsupported',
  idle: 'Camera ready',
  requesting: 'Opening source',
  live: 'Camera live',
  'permission-denied': 'Camera permission blocked',
  'not-found': 'No camera found',
  interrupted: 'Camera interrupted',
  error: 'Source unavailable',
}

function App() {
  // MediaPipe pose + motion rules is the only detector. The trained ensemble stays off.
  const [fightModel] = useState<'video' | 'pose'>('pose')
  const session = useVisionSession({ livePoseEnabled: fightModel === 'pose' })
  const { camera, vision, metrics } = session
  const { setConflictEnabled } = session
  const useTrainedFight = fightModel === 'video' && session.kind === 'camera'
  const fight = useFightDetector(session.videoRef, useTrainedFight && camera.status === 'live' && session.playing, session.sessionId, useTrainedFight)
  // Cameras added beside CAM-01. Each tile runs its own detector and reports its alerts here.
  const cams = useCameras()
  const [extraEvents, setExtraEvents] = useState<Readonly<Record<string, ReviewEvent[]>>>({})
  const [extraLive, setExtraLive] = useState<Readonly<Record<string, { live: boolean; usb: boolean }>>>({})
  const extraRecorders = useRef<Record<string, ClipRecorder>>({})
  const onExtraEvents = useCallback((id: string, events: ReviewEvent[]) => setExtraEvents(previous => {
    const before = previous[id] ?? []
    if (before.length === events.length && before.every((event, n) => event.id === events[n].id)) return previous
    return { ...previous, [id]: events }
  }), [])
  const onExtraRecorder = useCallback((id: string, recorder: ClipRecorder | null) => {
    if (recorder) extraRecorders.current[id] = recorder
    else delete extraRecorders.current[id]
  }, [])
  const onExtraLive = useCallback((id: string, live: boolean, usb: boolean) => setExtraLive(previous =>
    previous[id]?.live === live && previous[id]?.usb === usb ? previous : { ...previous, [id]: { live, usb } }), [])
  const extraList = Object.entries(extraEvents).filter(([id]) => cams.cameras.some(camera => camera.id === id)).flatMap(([, events]) => events)
  const scene = {
    ...session.scene,
    timestampMs: useTrainedFight ? performance.now() : session.scene.timestampMs,
    events: [...session.scene.events, ...(useTrainedFight ? fight.events : session.conflict.events), ...extraList].sort((a, b) => b.occurredAtMs - a.occurredAtMs).slice(0, 10),
  }
  useEffect(() => { setConflictEnabled(!useTrainedFight) }, [useTrainedFight, setConflictEnabled])
  const guards = useGuards()
  const usb = useUsbPhone()
  const { site, update: updateSite } = useSite()
  const { route, navigate } = useRoute('console')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const audioRef = useRef<ReviewTonePlayer | null>(null)
  const soundEnabledRef = useRef(true)
  const audioActionRef = useRef(0)
  const seenEventsRef = useRef(new Set<string>())
  // Wall-clock time each alert first appeared; added cameras run their own clocks.
  const firstSeenRef = useRef(new Map<string, number>())
  const [soundAlerts, setSoundAlerts] = useState(true)
  const [audioState, setAudioState] = useState<ReviewAudioState>('idle')
  const [soundNotice, setSoundNotice] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(new Set())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [alertsOpen, setAlertsOpen] = useState(false)
  const [clock, setClock] = useState(() => new Date())
  const [incidentFor, setIncidentFor] = useState<Readonly<Record<string, string>>>({})
  const [clipPending, setClipPending] = useState<ReadonlySet<string>>(new Set())

  const isLive = camera.status === 'live'
  const isDemo = session.kind === 'demo'
  const isClip = session.kind === 'clip'
  const activeReview = scene.events.find(event => !acknowledged.has(event.id))
  // The CAM-01 tile only shows alerts it raised itself.
  const mainAlert = activeReview && !cameraIdOfEvent(activeReview.id) ? activeReview : undefined
  const incidents = useIncidents(route.page === 'incidents' || !!activeReview)

  // First visit: walk through setup. Later visits open the live view.
  const firstRun = useRef(!site.setupDone && !window.location.hash)
  useEffect(() => { if (firstRun.current) { firstRun.current = false; navigate('setup') } }, [navigate])

  // Keeps a few seconds of the view in memory so each alert gets a clip that starts before it.
  const viewRef = useRef<{ kind: 'camera' | 'clip' | 'demo' | null; mirrored: boolean }>({ kind: null, mirrored: false })
  viewRef.current = { kind: isLive ? session.kind : null, mirrored: session.mirrored }
  const recorderRef = useRef<ClipRecorder | null>(null)
  if (!recorderRef.current && typeof document !== 'undefined') {
    recorderRef.current = new ClipRecorder({
      stage: () => session.stageRef.current,
      video: () => session.videoRef.current,
      demo: () => session.demoCanvasRef.current,
      overlay: () => session.canvasRef.current,
      view: () => viewRef.current,
    })
  }
  useEffect(() => {
    const recorder = recorderRef.current
    if (isLive) recorder?.start()
    else recorder?.stop()
  }, [isLive])
  useEffect(() => () => recorderRef.current?.stop(), [])

  const getAudio = useCallback(() => {
    if (!audioRef.current || audioRef.current.getState() === 'disposed') audioRef.current = new ReviewTonePlayer()
    return audioRef.current
  }, [])

  useEffect(() => () => {
    audioActionRef.current += 1
    audioRef.current?.dispose()
    audioRef.current = null
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    audioRef.current?.stop()
    setAlertsOpen(false)
    seenEventsRef.current = new Set([...seenEventsRef.current].filter(id => cameraIdOfEvent(id)))
    setAcknowledged(previous => new Set([...previous].filter(id => cameraIdOfEvent(id))))
    setSoundNotice(null)
  }, [session.sessionId])

  const likelihood = useTrainedFight
    ? fight.prediction ? Math.round(Math.max(fight.prediction.score, fight.prediction.scores?.temporal ?? 0, fight.prediction.scores?.visual ?? 0) * 100) : null
    : session.conflictEnabled && isLive ? Math.round((session.conflict.progress ?? 0) * 100) : null
  const likelihoodRef = useRef(likelihood)
  likelihoodRef.current = likelihood
  const cameraName = site.cameraName || 'Camera 1'
  const placeLabel = site.siteName || guards.snapshot?.location?.label || (isDemo ? 'Test scenario' : isClip ? 'Video file' : 'Your site')
  const alertCamera = isDemo ? 'Test scenario · not a real camera' : [site.siteName, cameraName].filter(Boolean).join(' · ') || session.sourceName

  /** Which camera saw an alert: CAM-01 (null) or one of the added cameras. */
  const extraFor = useCallback((event: ReviewEvent) => {
    const id = cameraIdOfEvent(event.id)
    return id ? cams.cameras.find(camera => camera.id === id) ?? null : null
  }, [cams.cameras])
  const cameraLabelFor = useCallback((event: ReviewEvent) => {
    const extra = extraFor(event)
    return extra ? extra.source.kind === 'demo' ? `${extra.name} · test scenario` : [site.siteName, extra.name].filter(Boolean).join(' · ') : alertCamera
  }, [alertCamera, extraFor, site.siteName])

  // Every new alert becomes an incident on this Mac, with a still and a 5 second clip from the camera that saw it.
  const { create: createIncident, upload: uploadIncident } = incidents
  const saveIncident = useCallback((event: ReviewEvent) => {
    const key = alertKey(event)
    const extra = extraFor(event)
    setClipPending(previous => new Set([...previous, key]))
    const created = createIncident({
      eventId: key, kind: (extra ? extra.source.kind === 'demo' : isDemo) ? 'test' : 'fight', title: event.title, detail: event.detail,
      camera: cameraLabelFor(event), occurredAt: Date.now(), likelihood: extra ? null : likelihoodRef.current,
    })
    void created.then(incident => { if (incident) setIncidentFor(previous => ({ ...previous, [key]: incident.id })) })
    const recorder = extra ? extraRecorders.current[extra.id] : recorderRef.current
    const recording = recorder?.supported
      ? recorder.record(still => { if (still) void created.then(incident => incident && uploadIncident(incident.id, 'still', still)).catch(() => undefined) })
      : Promise.resolve({ clip: null, still: null, durationMs: 0 })
    void Promise.all([created, recording])
      .then(([incident, result]) => incident && result.clip ? uploadIncident(incident.id, 'clip', result.clip, result.durationMs) : null)
      .catch(() => undefined)
      .finally(() => setClipPending(previous => { const next = new Set(previous); next.delete(key); return next }))
  }, [cameraLabelFor, createIncident, extraFor, isDemo, uploadIncident])

  useEffect(() => {
    const unseen = scene.events.filter(event => !seenEventsRef.current.has(event.id))
    unseen.forEach(event => { seenEventsRef.current.add(event.id); firstSeenRef.current.set(event.id, Date.now()) })
    if (unseen.length) setAlertsOpen(true)
    const fromExtra = unseen.filter(event => cameraIdOfEvent(event.id))
    if (camera.status === 'live') unseen.filter(event => !cameraIdOfEvent(event.id)).forEach(saveIncident)
    fromExtra.forEach(saveIncident)
    if (fromExtra.length && soundEnabledRef.current) {
      const audio = getAudio()
      ++audioActionRef.current
      void audio.play(fromExtra[0].type).then(() => setAudioState(audio.getState()))
      return
    }
    const completedReview = session.kind === 'clip' && session.clipMode === 'review' &&
      session.scanProgress.duration > 0 && session.scanProgress.currentTime >= session.scanProgress.duration
    // React can batch the final result with scan completion. That confirmed
    // event still sounds; an explicit pause/stop is not a completed scan.
    if (!unseen.length || !soundEnabledRef.current || (!session.playing && !completedReview) || camera.status !== 'live') return
    const audio = getAudio()
    const action = ++audioActionRef.current
    void audio.play(unseen[0].type).then(() => {
      if (audioActionRef.current !== action || !soundEnabledRef.current) return
      const state = audio.getState()
      setAudioState(state)
      if (state === 'blocked' || state === 'unsupported') {
        setSoundNotice(state === 'unsupported'
          ? 'Audio is unavailable in this browser. The review queue stays active.'
          : 'Sound is blocked. Open Settings, Detection, and press Test to enable it.')
      }
    })
  }, [scene.events, getAudio, session.playing, session.kind, session.clipMode, session.scanProgress, camera.status, saveIncident])

  const prepareAudio = () => {
    audioActionRef.current += 1
    audioRef.current?.stop()
    setSoundNotice(null)
    if (!soundEnabledRef.current) return
    const audio = getAudio()
    const action = audioActionRef.current
    void audio.prime().then(() => {
      if (audioActionRef.current === action && soundEnabledRef.current) setAudioState(audio.getState())
    })
  }

  const startCamera = (deviceId?: string) => {
    if ((deviceId ?? session.deviceId) === USB_PHONE_DEVICE) lastUsbStart.current = performance.now()
    prepareAudio()
    // A phone over USB shows the scene as filmed. Mirroring is only for selfie webcams.
    if ((deviceId ?? session.deviceId) === USB_PHONE_DEVICE) session.setMirrored(false)
    void session.startCamera(deviceId)
  }
  const startCameraRef = useRef(startCamera)
  startCameraRef.current = startCamera
  const startDemo = (scenario: DemoScenario = 'conflict') => {
    prepareAudio()
    session.startDemo(scenario)
  }
  const stop = () => {
    audioActionRef.current += 1
    audioRef.current?.stop()
    session.stop()
  }
  const switchToUsb = () => { session.setDeviceId(USB_PHONE_DEVICE); startCamera(USB_PHONE_DEVICE) }

  const logIncident = (event: ReviewEvent, label: string, outcome?: 'acknowledged' | 'police') => {
    const id = incidentFor[alertKey(event)]
    if (!id) return
    void incidents.log(id, label, 'Mac operator').catch(() => undefined)
    if (outcome) void incidents.update(id, { outcome }).catch(() => undefined)
  }
  const acknowledge = (id: string) => {
    audioActionRef.current += 1
    audioRef.current?.stop()
    setAcknowledged(previous => new Set([...previous, id]))
    const event = scene.events.find(item => item.id === id)
    if (event) logIncident(event, 'Acknowledged on the Mac', 'acknowledged')
  }

  const openGuardSetup = () => {
    navigate('settings', 'guards')
    window.setTimeout(() => document.getElementById('guard-name')?.focus({ preventScroll: true }), 450)
  }

  const toggleSound = (enabled: boolean) => {
    audioActionRef.current += 1
    soundEnabledRef.current = enabled
    setSoundAlerts(enabled)
    setSoundNotice(null)
    if (enabled) prepareAudio()
    else audioRef.current?.stop()
  }

  const testSound = async () => {
    const action = ++audioActionRef.current
    const audio = getAudio()
    setSoundNotice('Starting test tone…')
    const scheduled = await audio.playPreview()
    if (audioActionRef.current !== action) return
    const state = audio.getState()
    setAudioState(state)
    setSoundNotice(scheduled
      ? 'Test tone started. Check your speaker volume if you did not hear it.'
      : state === 'unsupported'
        ? 'Audio is unavailable in this browser. Try Chrome for sound alerts.'
        : "Sound could not start. Press Test again and check this site's sound permission.")
  }

  const pendingCount = scene.events.filter(event => !acknowledged.has(event.id)).length
  const linkedGuards = (guards.snapshot?.guards ?? []).filter(guard => guard.paired)
  const onShiftCount = linkedGuards.filter(guard => guard.shift === 'on_shift').length
  const usbInUse = session.kind === 'camera' && session.deviceId === USB_PHONE_DEVICE && camera.status !== 'idle'
  const usbStatus = usbHealth(usb, usbInUse)

  // Plug in and go: when the Mac links a newly plugged-in iPhone, show it straight away.
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 4_500); return () => clearTimeout(timer) }, [toast])
  const autoUsbFor = useRef<number | null>(null)
  const lastUsbStart = useRef(0)
  const linkedAt = usb.link?.linkedAt ?? null
  const phoneName = usb.link?.name ?? 'iPhone'
  useEffect(() => {
    if (!usb.auto.enabled || !linkedAt || !usb.link?.onCable || autoUsbFor.current === linkedAt) return
    autoUsbFor.current = linkedAt
    const phoneInUse = usbInUse || Object.values(extraLive).some(state => state.usb) || cams.cameras.some(item => item.source.kind === 'usb')
    // The camera already on the phone (or one starting it right now) picks it up by itself.
    if (phoneInUse || performance.now() - lastUsbStart.current < 2_000) return
    if (camera.status !== 'live' && camera.status !== 'requesting') {
      session.setDeviceId(USB_PHONE_DEVICE); startCameraRef.current(USB_PHONE_DEVICE)
      setToast(`${phoneName} connected. It is the live camera now.`)
    } else if (cams.cameras.length < MAX_EXTRA_CAMERAS) {
      cams.add({ kind: 'usb' }, phoneName)
      setToast(`${phoneName} connected. Added as a camera.`)
    } else setToast(`${phoneName} connected. Pick it as a camera source.`)
  }, [linkedAt, usb.auto.enabled, usb.link?.onCable, usbInUse, extraLive, cams, camera.status, session, phoneName])
  const clipSettingsLocked = isClip && (isLive || camera.status === 'requesting')
  const isReviewScan = isClip && session.clipMode === 'review'
  const scanComplete = isReviewScan && session.scanProgress.duration > 0 &&
    session.scanProgress.currentTime >= session.scanProgress.duration
  const canStart = (fightModel === 'video' || vision.status === 'ready') && camera.status !== 'requesting' && camera.status !== 'unsupported'
  const analysisLabel = useTrainedFight ? fight.status === 'error' ? 'Fight model unavailable' : isLive ? fight.prediction ? 'Fight analysis running' : 'Preparing video window' : 'Waiting for camera'
    : isDemo && isLive ? 'Simulated observations'
    : vision.status === 'loading' ? 'Loading local models'
      : vision.status === 'error' ? 'Analysis unavailable'
        : !isLive ? 'Waiting for camera'
          : !session.playing ? scanComplete ? 'Review complete' : 'Video paused'
            : session.stalled ? 'Analysis stalled'
              : !metrics.fps ? 'Starting analysis'
                : 'Analysis running'
  const sourceLabel = isLive && usbInUse ? usbStatus.tone === 'live' ? 'iPhone live' : 'iPhone reconnecting'
    : isLive && isDemo ? 'Test scenario'
    : isLive && isClip ? isReviewScan
      ? scanComplete ? 'Review complete' : session.playing ? 'Review running' : 'Review paused'
      : session.playing ? 'Video playing' : 'Video paused'
      : CAMERA_LABELS[camera.status]
  const sourceError = session.fileError ?? camera.message
  const watch = scene.watch
  const watchLabel = useTrainedFight
    ? fight.status === 'alert' ? 'Possible fight' : fight.status === 'observing' ? 'Checking' : fight.status === 'error' ? 'Model unavailable' : fight.prediction ? 'All clear' : 'Warming up'
    : isDemo ? 'Simulated · watching' : 'All clear'
  const eventAgeLabel = activeReview ? (() => {
    const seen = firstSeenRef.current.get(activeReview.id)
    const seconds = Math.max(0, Math.round((cameraIdOfEvent(activeReview.id) && seen ? clock.getTime() - seen : scene.timestampMs - activeReview.occurredAtMs) / 1_000))
    return seconds < 2 ? 'now' : seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`
  })() : ''
  const modelPillTone = useTrainedFight ? fight.status === 'error' ? 'is-bad' : fight.device ? 'is-good' : '' : vision.status === 'ready' ? 'is-good' : vision.status === 'error' ? 'is-bad' : ''
  const modelPillLabel = useTrainedFight
    ? fight.status === 'error' ? 'Model unavailable' : fight.device ? `Model ready · ${fight.device.toUpperCase()}` : 'Model loading'
    : vision.status === 'ready' ? `Pose model ready · ${vision.delegates?.pose ?? 'CPU'}` : vision.status === 'error' ? 'Pose model unavailable' : 'Pose model loading'
  const audioLabel = !soundAlerts ? 'Sound off'
    : audioState === 'ready' ? 'Sound ready'
      : audioState === 'blocked' ? 'Sound needs permission'
        : audioState === 'unsupported' ? 'Audio unavailable'
          : 'Sound enabled'
  const fpsValue = useTrainedFight ? (isLive ? 8 : null) : isDemo ? null : metrics.fps || null
  const activeIncident = activeReview ? incidents.incidents.find(item => item.id === incidentFor[alertKey(activeReview)]) ?? null : null
  const pageOpen = route.page !== 'console'
  const sourceKind: 'camera' | 'file' | 'demo' = isDemo ? 'demo' : isClip ? 'file' : 'camera'
  const recentEvents = useMemo(() => incidents.incidents.slice(0, 6), [incidents.incidents])

  const goPage = (page: Page) => {
    if (page === 'console') navigate('console')
    else navigate(page)
  }
  const openFile = () => fileInputRef.current?.click()
  const chooseSource = (value: 'camera' | 'file' | 'demo') => {
    if (value === 'camera') startCamera()
    else if (value === 'file') openFile()
    else startDemo()
  }

  const sourceSwitch = (idPrefix: string) => (
    <div className="source-switch">
      <Segmented label="Input source" size="sm" value={isLive || camera.status === 'requesting' ? sourceKind : null} onChange={chooseSource}
        options={[
          { value: 'camera', label: 'Camera', disabled: !canStart },
          { value: 'file', label: 'Video file', disabled: vision.status !== 'ready' },
          { value: 'demo', label: 'Test scenario' },
        ]} />
      {isDemo ? (
        <label className="inline-select"><span className="visually-hidden">Scenario</span>
          <select id={`${idPrefix}scenario-select`} aria-label="Scenario" data-testid={idPrefix ? undefined : 'demo-scenario'} value={session.scenario} onChange={event => startDemo(event.target.value as DemoScenario)}>
            <option value="conflict">Repeated striking motion</option><option value="calm">Waving · no conflict</option><option value="watched">Watched item moves</option><option value="unattended">Bag left behind</option>
          </select>
        </label>
      ) : isClip ? <span className="inline-caption">{session.sourceName}</span> : (
        <label className="inline-select"><span className="visually-hidden">Camera</span>
          <select id={`${idPrefix}camera-select`} aria-label="Camera" value={session.deviceId} disabled={camera.status === 'requesting'} onChange={event => {
            session.setDeviceId(event.target.value)
            if (isLive) startCamera(event.target.value)
          }}>
            {!session.devices.length && !(usb.linked || usbInUse) ? <option value="">Default camera</option> : null}
            {usb.linked || usbInUse ? <option value={USB_PHONE_DEVICE}>iPhone · USB cable</option> : null}
            {session.devices.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}
          </select>
        </label>
      )}
    </div>
  )

  const detection = <DetectionSettings session={session} clipLocked={clipSettingsLocked} simulated={isDemo} />

  return (
    <div className={`app-shell ${pageOpen ? 'is-page' : 'is-console'}`} data-page={route.page}>
      <a className="skip-link" href="#camera-stage">Skip to camera</a>
      <header className="topbar">
        <a className="brand" href="#/console" aria-label="NIVRA live view">
          <img src="/brand/nivra-mark.png" width="30" height="30" alt="" />
          <span>NIVRA</span>
        </a>
        <span className="topbar-site" title={placeLabel}>{site.siteName || 'Set up your site'}</span>
        <nav className="topbar-nav" aria-label="Pages">
          <Segmented label="Pages" value={route.page === 'setup' ? null : route.page} onChange={goPage}
            options={[{ value: 'console', label: 'Live' }, { value: 'incidents', label: 'Incidents' }, { value: 'settings', label: 'Settings' }]} />
        </nav>
        <div className="topbar-actions">
          <button type="button" className={`top-chip ${pendingCount ? 'has-alert' : ''}`} aria-pressed={alertsOpen} onClick={() => { if (pageOpen) { navigate('console'); setAlertsOpen(true) } else setAlertsOpen(open => !open) }}>
            <Bell size={16} weight={pendingCount ? 'fill' : 'regular'} aria-hidden="true" />Alerts{pendingCount ? <b>{pendingCount}</b> : null}
          </button>
          <button type="button" className="top-chip" onClick={() => navigate('settings', 'guards')}>
            <ShieldCheck size={16} aria-hidden="true" /><span>{onShiftCount}<span className="top-chip-sub"> on shift</span></span>
          </button>
          <label className="icon-toggle" title={audioLabel}>
            <input type="checkbox" checked={soundAlerts} onChange={event => toggleSound(event.target.checked)} data-testid="sound-alerts" />
            {soundAlerts ? <SpeakerHigh size={17} aria-hidden="true" /> : <SpeakerSlash size={17} aria-hidden="true" />}
            <span className="visually-hidden">Sound</span>
          </label>
          <span className="visually-hidden" data-testid="sound-status">{audioLabel}</span>
          <time className="topbar-clock">{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
        </div>
      </header>

      <input ref={fileInputRef} className="file-input" type="file" accept="video/*" data-testid="clip-input" aria-label="Open local video"
        onChange={event => {
          const file = event.target.files?.[0]
          if (file) { prepareAudio(); void session.openClip(file) }
          event.target.value = ''
        }} />

      <main className="console" aria-hidden={pageOpen || undefined} inert={pageOpen}>
        {soundNotice ? <p className="console-notice" role="status">{soundNotice}</p> : null}
        {toast ? <p className="toast" role="status" key={toast}><DeviceMobile size={16} aria-hidden="true" />{toast}</p> : null}
        <div className={`console-grid ${alertsOpen ? 'has-rail' : ''}`}>
          <div className="console-main">
            <div className={`camera-wall has-${Math.min(4, cams.cameras.length + 1)}`}>
            <section className="camera-module" aria-label="Vision workspace">
              <div id="camera-stage" className={`camera-stage ${isLive && activeReview && !cameraIdOfEvent(activeReview.id) ? 'is-alerting' : ''} ${isLive ? 'is-live' : ''}`} ref={session.stageRef}>
                <video
                  ref={session.videoRef}
                  className={`camera-video ${session.kind === 'camera' && session.mirrored ? 'is-mirrored' : ''} ${isClip ? 'is-clip' : ''} ${isDemo ? 'is-hidden' : ''}`}
                  autoPlay muted playsInline
                  data-testid="camera-video"
                  onEnded={() => { audioRef.current?.stop(); session.setPlaying(false) }}
                />
                <canvas ref={session.demoCanvasRef} className={`demo-canvas ${isDemo && isLive ? '' : 'is-hidden'}`} aria-hidden="true" />
                <canvas ref={session.canvasRef} className="vision-canvas" aria-hidden="true" data-testid="pose-canvas" />
                <svg className="alert-outline" aria-hidden="true"><rect x="0" y="0" width="100%" height="100%" rx="14" pathLength="1" /></svg>

                <div className="stage-top">
                  {isLive ? <span className="tile-name">{cameraName}<em>CAM-01</em></span> : <span />}
                  {isLive ? (
                    <div className={`stage-status ${mainAlert ? 'is-alert' : ''}`} data-testid="stage-status">
                      <span className="stage-status-dot" aria-hidden="true" />
                      {mainAlert ? <strong>{mainAlert.title} · {eventAgeLabel}</strong> : <>
                        <strong>{watchLabel}</strong>
                        {likelihood !== null ? <><span className="stage-meter" aria-hidden="true"><i style={{ transform: `scaleX(${likelihood / 100})` }} /></span><RollingNumber value={likelihood} suffix="%" /></> : null}
                      </>}
                    </div>
                  ) : <span />}
                  <div className="stage-top-right">
                    <span className={`status-chip ${isLive ? usbInUse && usbStatus.tone !== 'live' ? 'is-warn' : 'is-live' : ''}`} data-testid="camera-status"><span className="status-dot" aria-hidden="true" />{sourceLabel}</span>
                    {typeof document !== 'undefined' && document.fullscreenEnabled ? (
                      <button className="stage-button" type="button" aria-label="Expand camera view" onClick={() => {
                        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
                        else void session.stageRef.current?.requestFullscreen().catch(() => undefined)
                      }}><ArrowsOut size={16} /></button>
                    ) : null}
                  </div>
                </div>

                {!isLive ? (
                  <div className="camera-empty-state">
                    <span className="empty-icon" aria-hidden="true"><VideoCamera size={28} /></span>
                    <h2>{camera.status === 'requesting' ? 'Opening your source' : sourceError ? 'Camera setup needs attention' : 'A clear view starts here'}</h2>
                    <p>{sourceError ?? (useTrainedFight ? 'Keep the interaction clearly in view. The fight model checks short video windows on this Mac.' : 'Keep both people’s shoulders and hands in view. Legs can be out of frame. Analysis stays on this device.')}</p>
                    <div className="empty-actions">
                      <button className="btn btn-light" type="button" onClick={() => startCamera()} disabled={!canStart} data-testid="start-camera">
                        {camera.status === 'requesting' ? 'Opening camera…' : !useTrainedFight && vision.status === 'loading' ? 'Preparing models…' : 'Start camera'}
                      </button>
                      <button className="btn btn-ghost-dark" type="button" onClick={() => startDemo()}>Try test scenario</button>
                    </div>
                    {camera.status === 'requesting' ? <button className="link-button cancel-input" type="button" onClick={stop}>Cancel</button> : null}
                  </div>
                ) : null}

                {usbInUse && isLive && usbStatus.tone !== 'live' ? (
                  <div className={`usb-overlay is-${usbStatus.tone}`} role="status" data-testid="usb-overlay">
                    <span className="usb-overlay-icon" aria-hidden="true"><DeviceMobile size={26} /></span>
                    <strong>{usbStatus.title}</strong>
                    <p>{usbStatus.detail}</p>
                    <span className="usb-overlay-retry"><span aria-hidden="true" />Reconnects by itself</span>
                  </div>
                ) : null}

                {isLive && !isDemo && !useTrainedFight && (vision.status === 'error' || session.stalled) ? (
                  <div className="analysis-error" role="status">
                    <strong>{session.stalled ? 'Analysis stopped responding' : 'Analysis unavailable'}</strong>
                    <p>{vision.error ?? 'The video is still open. Restart the local models to continue.'}</p>
                    <button className="btn btn-light" type="button" onClick={session.retryAnalysis}>Restart analysis</button>
                  </div>
                ) : null}

                {isLive ? (
                  <div className="stage-bottom">
                    <time className="stage-clock">{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                    <span className="live-caption">{useTrainedFight ? 'Trained models' : <><RollingNumber value={metrics.poses} /> {metrics.poses === 1 ? 'person' : 'people'}</>}{fpsValue ? <> · <RollingNumber value={fpsValue} /> fps</> : null}</span>
                  </div>
                ) : null}
                {isLive && isDemo ? <div className="simulation-stamp">Scripted test</div> : null}
              </div>
            </section>
            {cams.cameras.map((extra, index) => (
              <CameraTile key={extra.id} camera={extra} index={index} power={session.detectionPower}
                alerting={!!activeReview && cameraIdOfEvent(activeReview.id) === extra.id}
                devices={session.devices} usbLinked={!!usb.linked}
                usbBusy={usbInUse || Object.entries(extraLive).some(([id, state]) => id !== extra.id && state.usb)}
                onSource={source => cams.update(extra.id, { source })} onRemove={() => cams.remove(extra.id)}
                onEvents={onExtraEvents} onRecorder={onExtraRecorder} onLive={onExtraLive} />
            ))}
            </div>

            <div className="console-bar">
              {cams.cameras.length ? <span className="bar-label">CAM-01 controls</span> : null}
              {sourceSwitch('')}
              <div className="console-bar-right">
                <label className="switch-label"><span className="switch"><input type="checkbox" checked={session.mirrored && session.kind === 'camera'} disabled={session.kind !== 'camera'} onChange={event => session.setMirrored(event.target.checked)} /><span aria-hidden="true" /></span>Mirror</label>
                {!useTrainedFight ? <label className="switch-label"><span className="switch"><input type="checkbox" checked={session.skeleton} onChange={event => session.setSkeleton(event.target.checked)} /><span aria-hidden="true" /></span>Skeleton</label> : null}
                {isLive && isClip ? <button className="btn btn-dark-quiet" type="button" disabled={vision.status !== 'ready'} onClick={() => { audioRef.current?.stop(); void session.togglePlayback() }}>{vision.status !== 'ready' ? 'Waiting for analysis…' : session.playing ? 'Pause' : scanComplete ? 'Replay' : 'Resume'}</button> : null}
                {isLive && isDemo ? <button className="btn btn-dark-quiet" type="button" onClick={() => startDemo(session.scenario)}>Replay</button> : null}
                <button className={`btn ${isLive ? 'btn-dark-quiet' : 'btn-light'}`} type="button" disabled={!isLive && !canStart} onClick={isLive ? stop : () => startCamera()} data-testid={isLive ? 'stop-camera' : 'rail-start-camera'}>{isLive ? 'Stop' : 'Start camera'}</button>
                <button type="button" className="btn btn-dark-quiet" onClick={() => cams.add()} disabled={cams.cameras.length >= MAX_EXTRA_CAMERAS} title={cams.cameras.length >= MAX_EXTRA_CAMERAS ? 'Four cameras is the limit on one Mac' : undefined}>
                  <Plus size={14} aria-hidden="true" />Add camera
                </button>
                <button type="button" className={`btn btn-dark-quiet settings-toggle ${settingsOpen ? 'is-open' : ''}`} aria-expanded={settingsOpen} aria-controls="detection-settings" onClick={() => setSettingsOpen(open => !open)}>
                  <SlidersHorizontal size={15} aria-hidden="true" /><span>Detection settings</span>
                </button>
              </div>
            </div>

            {isLive && isDemo ? (
              <div className="console-notice"><strong>Scripted scene. Tests alert rules, not model accuracy.</strong><span>{session.scenario === 'conflict' ? 'Repeated directed arm movements. A review follows after the motion is confirmed.' : session.scenario === 'calm' ? 'Two people standing and waving. The conflict detector should stay quiet.' : session.scenario === 'watched' ? 'Backpack is watched. It moves after seven seconds.' : `The person leaves. An unattended-bag alert follows after ${session.unattendedSeconds} seconds without someone nearby.`}</span></div>
            ) : null}
            {isLive && isReviewScan ? (
              <div className="console-notice" data-testid="clip-review-progress" role="status">
                <strong>{scanComplete ? 'Review complete' : 'Frame-by-frame review'} · {session.scanProgress.currentTime.toFixed(1)} / {session.scanProgress.duration.toFixed(1)} s · {session.scanProgress.analyzedFrames} samples</strong>
                <span>CPU reference scan at 40 ms video intervals. Waits for each result, so playback can be slower. Motion uses the original video timing. {session.clipSensitivity === 'instant' ? 'Instant review is on.' : session.clipSensitivity === 'early' ? 'Early review is on.' : 'Standard review is on.'}</span>
              </div>
            ) : null}

            <div className={`drawer ${settingsOpen && !pageOpen ? 'is-open' : ''}`} id="detection-settings">
              <div className="drawer-inner">{settingsOpen && !pageOpen ? detection : null}</div>
            </div>

            {session.objectAnalysisEnabled || isDemo && ['watched', 'unattended'].includes(session.scenario) ? <div className={`watch-bar ${watch?.state === 'watching' ? 'is-armed' : ''}`}>
              <span className="watch-indicator" aria-hidden="true" />
              <div><strong>{watch ? `${watch.displayName} · ${watch.state === 'watching' ? 'watching position' : watch.state === 'moved' ? 'movement detected' : 'left view'}` : 'Watch an item'}</strong><p>{watch ? 'Alerts when this item moves or is no longer visible.' : 'Select Watch item beside an object to monitor its current position.'}</p></div>
              {watch ? <>
                {watch.state !== 'watching' && scene.objects.some(item => item.trackKey === watch.trackKey) ? <button className="link-button" type="button" onClick={() => session.watch(watch.trackKey)}>Rearm</button> : null}
                <button className="link-button" type="button" onClick={session.clearWatch}>Clear watch</button>
              </> : null}
            </div> : null}

            <div className="console-lower">
              <div className="console-analysis">
                {useTrainedFight
                  ? <FightPanel state={fight} active={isLive && session.playing} onRetry={fight.retry} />
                  : <ConflictPanel snapshot={session.conflict} enabled={session.conflictEnabled} active={isLive && session.playing && !session.stalled && (isDemo || vision.status === 'ready')} simulated={isDemo} onToggle={session.setConflictEnabled} />}
              </div>
              <div className="console-side">
                <section className="diagnostics" aria-label="Analysis diagnostics">
                  <div className="diagnostic-lead">
                    <span className={`status-dot ${isLive && (useTrainedFight ? fight.prediction : !session.stalled && (isDemo || metrics.fps > 0)) ? 'is-good' : ''}`} aria-hidden="true" />
                    <div><span>Scene analysis</span><strong data-testid="model-status">{analysisLabel}</strong></div>
                    <span className={`model-pill ${modelPillTone}`} data-testid="model-pill">{modelPillLabel}</span>
                  </div>
                  <dl>
                    <div><dt>{useTrainedFight ? 'Models' : 'People'}</dt><dd>{useTrainedFight ? '3 local' : metrics.poses}</dd></div>
                    <div><dt>{useTrainedFight ? 'Window frames' : 'Nearby pairs'}</dt><dd>{useTrainedFight ? `${fight.samples} / 32` : session.conflict.diagnostics.nearbyPairs}</dd></div>
                    <div><dt>{useTrainedFight ? 'Target sample FPS' : 'Processed FPS'}</dt><dd data-testid="processed-fps">{useTrainedFight ? isLive ? '8' : '-' : isDemo ? '-' : metrics.fps || '-'}</dd></div>
                    <div><dt>Pose runtime</dt><dd data-testid="runtime-delegate">{isDemo ? 'Simulated' : vision.delegates?.pose ?? 'Loading'}</dd></div>
                    <div><dt>{useTrainedFight ? 'Fight latency' : 'Pose latency'}</dt><dd>{useTrainedFight ? fight.prediction ? `${Math.round(fight.prediction.inferenceMs)} ms` : '-' : isDemo ? 'Simulated' : metrics.poseMs ? `${Math.round(metrics.poseMs)} ms` : '-'}</dd></div>
                  </dl>
                </section>
                <section className="activity" aria-label="Recent incidents">
                  <div className="activity-head"><strong>Recent</strong><button type="button" className="link-button" onClick={() => navigate('incidents')}>All incidents</button></div>
                  {recentEvents.length ? (
                    <ol>
                      {recentEvents.map(item => (
                        <li key={item.id}><button type="button" onClick={() => navigate('incidents', item.id)}>
                          <time>{new Date(item.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                          <span>{item.title}</span>
                          <i className={item.kind === 'test' ? 'is-test' : ''} aria-hidden="true" />
                        </button></li>
                      ))}
                    </ol>
                  ) : <p className="quiet">No incidents yet. Alerts and their clips appear here.</p>}
                </section>
                <UsbPhonePanel usb={usb} inUse={usbInUse} onUse={switchToUsb} onUnlinked={() => { if (usbInUse) stop() }} />
              </div>
            </div>
            {vision.status === 'error' && !isLive ? <div className="console-notice" role="status"><span>{vision.error ?? 'The local models could not load.'}</span><button className="link-button" type="button" onClick={session.retryAnalysis}>Retry analysis</button></div> : null}
            {vision.notice && !isDemo ? <div className="console-notice" role="status" data-testid="runtime-notice">{vision.notice}</div> : null}
            {session.fileError && isLive ? <p className="console-notice" role="status">{session.fileError}</p> : null}
            <p className="console-foot">Video stays on this Mac. Each alert keeps a 5 second clip. A person decides every response.</p>
          </div>

          <ObservationRail
            scene={scene} active={isLive && session.playing && (useTrainedFight ? fight.status !== 'error' : !session.stalled && (isDemo || vision.status === 'ready'))}
            trainedFight={useTrainedFight}
            alertPanel={activeReview ? (
              <AlertPanel event={activeReview} simulated={extraFor(activeReview) ? extraFor(activeReview)!.source.kind === 'demo' : isDemo}
                where={`${placeLabel} · ${extraFor(activeReview)?.name ?? cameraName}`} camera={cameraLabelFor(activeReview)} age={eventAgeLabel}
                likelihood={extraFor(activeReview) ? null : likelihood}
                guards={guards} incident={activeIncident} clipPending={clipPending.has(alertKey(activeReview))}
                onAcknowledge={() => acknowledge(activeReview.id)} onNeedGuard={openGuardSetup}
                onGuardCalled={name => logIncident(activeReview, `Guard called: ${name}`)} onPolice={() => logIncident(activeReview, 'Police called from the Mac', 'police')}
                onOpenIncident={id => navigate('incidents', id)} />
            ) : null}
            onClose={() => setAlertsOpen(false)}
            renderEventActions={(event, reviewed) => <DispatchControl event={event} camera={cameraLabelFor(event)} guards={guards} acknowledged={reviewed} onAcknowledge={() => acknowledge(event.id)} onNeedGuard={openGuardSetup}
              onGuardCalled={name => logIncident(event, `Guard called: ${name}`)} onPolice={() => logIncident(event, 'Police called from the Mac', 'police')} />}
            simulated={isDemo} acknowledged={acknowledged} onAcknowledge={acknowledge} onWatch={session.watch}
            showObjects={session.objectAnalysisEnabled || isDemo && ['watched', 'unattended'].includes(session.scenario)}
          />
        </div>
      </main>

      <div className={`page-layer ${pageOpen ? 'is-open' : ''}`} aria-hidden={!pageOpen || undefined}>
        {route.page === 'setup' ? (
          <SetupPage site={site} onSite={updateSite} session={session} guards={guards} usb={usb} usbInUse={usbInUse} isLive={isLive}
            liveLabel={isLive ? `${sourceLabel}${fpsValue ? ` · ${fpsValue} fps` : ''}` : camera.status === 'requesting' ? 'Opening…' : sourceError ?? 'No source yet'}
            onCamera={() => startCamera()} onUsb={switchToUsb} onFile={openFile} onDemo={() => startDemo()}
            onUsbUnlinked={() => { if (usbInUse) stop() }}
            onFinish={() => { updateSite({ setupDone: true }); navigate('console') }} />
        ) : null}
        {route.page === 'incidents' ? (
          <IncidentsPage incidents={incidents} selectedId={route.section} onSelect={id => navigate('incidents', id)} onBack={() => navigate('console')} />
        ) : null}
        {route.page === 'settings' ? (
          <SettingsPage section={route.section} onSection={(section: SettingsSection) => navigate('settings', section)} site={site} onSite={updateSite}
            guards={guards} usb={usb} usbInUse={usbInUse} onUseUsb={switchToUsb} onUsbUnlinked={() => { if (usbInUse) stop() }}
            cameraPicker={<div className="camera-picker">
              <div className="camera-list" aria-label="All cameras">
                <div className="camera-row">
                  <span className={`status-dot ${isLive ? 'is-good' : ''}`} aria-hidden="true" />
                  <div><strong>{cameraName}</strong><span>CAM-01 · {isLive ? `${sourceLabel} · ${session.sourceName}` : 'Off'}</span></div>
                </div>
                {cams.cameras.map((extra, index) => (
                  <div className="camera-row" key={extra.id}>
                    <span className={`status-dot ${extraLive[extra.id]?.live ? 'is-good' : ''}`} aria-hidden="true" />
                    <div>
                      <input aria-label={`Name of CAM-${String(index + 2).padStart(2, '0')}`} value={extra.name} maxLength={60} onChange={event => cams.update(extra.id, { name: event.target.value })} />
                      <span>CAM-{String(index + 2).padStart(2, '0')} · {extraLive[extra.id]?.live ? extraLive[extra.id]?.usb ? 'iPhone live' : 'Live' : 'Off'} · pick its source on the Live view</span>
                    </div>
                    <button type="button" className="link-button" onClick={() => cams.remove(extra.id)}>Remove</button>
                  </div>
                ))}
                <button type="button" className="btn btn-quiet" onClick={() => cams.add()} disabled={cams.cameras.length >= MAX_EXTRA_CAMERAS}><Plus size={14} />Add camera</button>
              </div>
              <p className="eyebrow">CAM-01 source</p>
              {sourceSwitch('settings-')}
              <p className="quiet">{isLive ? `${sourceLabel} · ${session.sourceName}` : 'No source running. Pick one to start.'} Each camera runs its own MediaPipe detector; four cameras is the limit on one Mac.</p>
            </div>}
            detection={detection}
            sound={{ enabled: soundAlerts, label: audioLabel, notice: soundNotice, onToggle: toggleSound, onTest: () => void testSound() }}
            system={{ model: modelPillLabel, modelTone: modelPillTone, analysis: analysisLabel, facts: [
              { label: 'Source', value: isLive ? session.sourceName : 'None' },
              { label: 'Processed FPS', value: fpsValue ? String(fpsValue) : '-' },
              { label: 'Pose runtime', value: isDemo ? 'Simulated' : vision.delegates?.pose ?? 'Loading' },
              { label: 'Guards linked', value: String(linkedGuards.length) },
              { label: 'Incidents saved', value: String(incidents.incidents.length) },
            ] }}
            onRunSetup={() => { updateSite({ setupStep: 0 }); navigate('setup') }} />
        ) : null}
      </div>
    </div>
  )
}

export default App
