import { useEffect, useMemo, useRef } from 'react'
import { ArrowsOut, Play, Stop, X } from '@phosphor-icons/react'
import { useVisionSession } from '../hooks/useVisionSession'
import { extraEventPrefix, type CameraSource, type ExtraCamera } from '../lib/cameras'
import type { ReviewEvent } from '../lib/sceneEngine'
import { ClipRecorder } from '../services/ClipRecorder'
import { USB_PHONE_DEVICE } from '../services/UsbPhoneSource'
import { RollingNumber } from './ui/RollingNumber'

type Props = {
  camera: ExtraCamera
  index: number
  power: number
  alerting: boolean
  devices: MediaDeviceInfo[]
  usbLinked: boolean
  usbBusy: boolean
  onSource(source: CameraSource): void
  onRemove(): void
  onEvents(cameraId: string, events: ReviewEvent[]): void
  onRecorder(cameraId: string, recorder: ClipRecorder | null): void
  onLive(cameraId: string, live: boolean, usesUsb: boolean): void
}

const sourceValue = (source: CameraSource) => source.kind === 'camera' ? `camera:${source.deviceId}` : source.kind

/**
 * An added camera: its own source, MediaPipe pose detector, conflict rules and 5 second clip buffer.
 * Alerts go up to the shared alert panel and incident log.
 */
export function CameraTile({ camera, index, power, alerting, devices, usbLinked, usbBusy, onSource, onRemove, onEvents, onRecorder, onLive }: Props) {
  const session = useVisionSession({ livePoseEnabled: true })
  const fileRef = useRef<HTMLInputElement>(null)
  const live = session.camera.status === 'live'
  const usesUsb = session.kind === 'camera' && session.deviceId === USB_PHONE_DEVICE && session.camera.status !== 'idle'
  const { setDetectionPower, setConflictEnabled } = session

  useEffect(() => { setConflictEnabled(true) }, [setConflictEnabled])
  // Video files in an added camera play in real time, like a live feed.
  const { setClipMode } = session
  useEffect(() => { setClipMode('realtime') }, [setClipMode])
  useEffect(() => { setDetectionPower(power) }, [power, setDetectionPower])

  // Start the saved source once on mount (camera permission is already granted by then).
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    const source = camera.source
    if (source.kind === 'demo') session.startDemo('conflict')
    else if (source.kind === 'usb' && usbLinked) { session.setMirrored(false); void session.startCamera(USB_PHONE_DEVICE) }
    else if (source.kind === 'camera') void session.startCamera(source.deviceId || undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A tile set to the iPhone starts as soon as the phone links (plug in and go).
  const wasLinked = useRef(usbLinked)
  useEffect(() => {
    const became = usbLinked && !wasLinked.current
    wasLinked.current = usbLinked
    if (became && camera.source.kind === 'usb' && session.camera.status !== 'live' && session.camera.status !== 'requesting') {
      session.setMirrored(false); session.setDeviceId(USB_PHONE_DEVICE); void session.startCamera(USB_PHONE_DEVICE)
    }
  }, [usbLinked, camera.source.kind, session])

  // Alerts from this camera, with ids no other camera can produce.
  const events = useMemo(() => session.conflict.events.map(event => ({
    ...event, id: `${extraEventPrefix(camera.id)}${session.sessionId}:${event.id}`, objectName: camera.name,
  })), [session.conflict.events, session.sessionId, camera.id, camera.name])
  useEffect(() => { onEvents(camera.id, events) }, [camera.id, events, onEvents])
  useEffect(() => () => onEvents(camera.id, []), [camera.id, onEvents])
  useEffect(() => { onLive(camera.id, live, usesUsb) }, [camera.id, live, usesUsb, onLive])
  useEffect(() => () => onLive(camera.id, false, false), [camera.id, onLive])

  // Each camera keeps its own few seconds of video for alert clips.
  const view = useRef<{ kind: 'camera' | 'clip' | 'demo' | null; mirrored: boolean }>({ kind: null, mirrored: false })
  view.current = { kind: live ? session.kind : null, mirrored: session.mirrored }
  const recorder = useMemo(() => new ClipRecorder({
    stage: () => session.stageRef.current, video: () => session.videoRef.current, demo: () => session.demoCanvasRef.current,
    overlay: () => session.canvasRef.current, view: () => view.current,
  }), [session.stageRef, session.videoRef, session.demoCanvasRef, session.canvasRef])
  useEffect(() => { onRecorder(camera.id, recorder); return () => { recorder.stop(); onRecorder(camera.id, null) } }, [camera.id, recorder, onRecorder])
  useEffect(() => { if (live) recorder.start(); else recorder.stop() }, [live, recorder])

  const choose = (value: string) => {
    if (value === 'file') { fileRef.current?.click(); return }
    const source: CameraSource = value === 'usb' ? { kind: 'usb' } : value === 'demo' ? { kind: 'demo' } : value.startsWith('camera:') ? { kind: 'camera', deviceId: value.slice(7) } : { kind: 'none' }
    onSource(source)
    if (source.kind === 'none') { session.stop(); return }
    if (source.kind === 'demo') session.startDemo('conflict')
    else if (source.kind === 'usb') { session.setMirrored(false); session.setDeviceId(USB_PHONE_DEVICE); void session.startCamera(USB_PHONE_DEVICE) }
    else { session.setMirrored(true); session.setDeviceId(source.deviceId); void session.startCamera(source.deviceId || undefined) }
  }
  const restart = () => choose(sourceValue(camera.source))
  const status = live ? session.kind === 'demo' ? 'Test scenario' : session.kind === 'clip' ? 'Video file' : usesUsb ? 'iPhone live' : 'Live'
    : session.camera.status === 'requesting' ? 'Opening…' : session.camera.message ? 'Needs attention' : 'Off'
  const likelihood = live ? Math.round((session.conflict.progress ?? 0) * 100) : null
  const label = `CAM-${String(index + 2).padStart(2, '0')}`

  return (
    <section className="camera-tile" aria-label={`${camera.name}, ${label}`} data-testid="camera-tile">
      <div className={`camera-stage is-tile ${alerting && live ? 'is-alerting' : ''} ${live ? 'is-live' : ''}`} ref={session.stageRef}>
        <video ref={session.videoRef} className={`camera-video ${session.kind === 'camera' && session.mirrored ? 'is-mirrored' : ''} ${session.kind === 'clip' ? 'is-clip' : ''} ${session.kind === 'demo' ? 'is-hidden' : ''}`}
          autoPlay muted playsInline onEnded={() => session.setPlaying(false)} />
        <canvas ref={session.demoCanvasRef} className={`demo-canvas ${session.kind === 'demo' && live ? '' : 'is-hidden'}`} aria-hidden="true" />
        <canvas ref={session.canvasRef} className="vision-canvas" aria-hidden="true" />
        <svg className="alert-outline" aria-hidden="true"><rect x="0" y="0" width="100%" height="100%" rx="14" pathLength="1" /></svg>
        <div className="stage-top">
          <span className="tile-name">{camera.name}<em>{label}</em></span>
          <div className="stage-top-right">
            <span className={`status-chip ${live ? 'is-live' : ''}`}><span className="status-dot" aria-hidden="true" />{status}</span>
            {live ? <button className="stage-button" type="button" aria-label={`Expand ${camera.name}`} onClick={() => void session.stageRef.current?.requestFullscreen?.().catch(() => undefined)}><ArrowsOut size={15} /></button> : null}
          </div>
        </div>
        {!live ? (
          <div className="tile-empty">
            <p>{session.camera.message ?? (camera.source.kind === 'none' ? 'Pick a source below.' : 'Stopped.')}</p>
            {camera.source.kind !== 'none' ? <button type="button" className="btn btn-light" onClick={restart}><Play size={14} weight="fill" /> Start</button> : null}
          </div>
        ) : null}
        {live && likelihood !== null ? (
          <div className="stage-bottom">
            <span className="live-caption"><RollingNumber value={session.metrics.poses} /> {session.metrics.poses === 1 ? 'person' : 'people'}</span>
            <span className="live-caption">{session.conflict.status === 'alert' ? 'Possible fight' : 'Watching'} · <RollingNumber value={likelihood} suffix="%" /></span>
          </div>
        ) : null}
      </div>
      <div className="tile-bar">
        <label className="inline-select"><span className="visually-hidden">Source for {camera.name}</span>
          <select aria-label={`Source for ${camera.name}`} value={sourceValue(camera.source)} onChange={event => choose(event.target.value)}>
            <option value="none">No source</option>
            {devices.filter(device => device.kind === 'videoinput').map((device, n) => <option key={device.deviceId || n} value={`camera:${device.deviceId}`}>{device.label || `Mac camera ${n + 1}`}</option>)}
            {devices.every(device => device.kind !== 'videoinput') ? <option value="camera:">This Mac's camera</option> : null}
            <option value="usb" disabled={!usbLinked || (usbBusy && !usesUsb)}>iPhone · USB cable{!usbLinked ? ' (link it first)' : usbBusy && !usesUsb ? ' (in use)' : ''}</option>
            <option value="demo">Test scenario</option>
            <option value="file">Video file…</option>
          </select>
        </label>
        {live ? <button type="button" className="btn btn-dark-quiet" onClick={() => { session.stop() }}><Stop size={13} weight="fill" /> Stop</button> : null}
        <button type="button" className="icon-button" aria-label={`Remove ${camera.name}`} onClick={() => { session.stop(); onRemove() }}><X size={14} /></button>
        <input ref={fileRef} className="file-input" type="file" accept="video/*" aria-label={`Open a video in ${camera.name}`}
          onChange={event => { const file = event.target.files?.[0]; if (file) void session.openClip(file); event.target.value = '' }} />
      </div>
    </section>
  )
}
