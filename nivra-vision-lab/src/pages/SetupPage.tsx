import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, DeviceMobile, FilmStrip, Laptop, PlayCircle } from '@phosphor-icons/react'
import { CameraLocationPanel } from '../components/CameraLocationPanel'
import { GuardPanel } from '../components/GuardPanel'
import { UsbPhonePanel } from '../components/UsbPhonePanel'
import type { GuardsApi } from '../hooks/useGuards'
import type { useUsbPhone } from '../hooks/useUsbPhone'
import type { useVisionSession } from '../hooks/useVisionSession'
import type { SiteSettings } from '../lib/site'

type Session = ReturnType<typeof useVisionSession>
type Props = {
  site: SiteSettings
  onSite(patch: Partial<SiteSettings>): void
  session: Session
  guards: GuardsApi
  usb: ReturnType<typeof useUsbPhone>
  usbInUse: boolean
  isLive: boolean
  liveLabel: string
  onCamera(): void
  onUsb(): void
  onFile(): void
  onDemo(): void
  onUsbUnlinked(): void
  onFinish(): void
}

const STEPS = ['Name the site', 'Connect a camera', 'Set the location', 'Pair a guard', 'Test alert']

export function SetupPage(props: Props) {
  const { site, onSite } = props
  const step = site.setupStep
  const go = (next: number) => onSite({ setupStep: Math.max(0, Math.min(STEPS.length - 1, next)) })
  const pairedGuards = (props.guards.snapshot?.guards ?? []).filter(guard => guard.paired)
  // Picking USB opens the phone panel straight away, even before a phone is plugged in.
  const [usbPick, setUsbPick] = useState(false)
  const autoStarted = useRef<string | null>(null)
  const { usb, usbInUse, onUsb } = props
  useEffect(() => {
    // Once the phone is linked by code, start it as the camera without another click.
    if (!usbPick || !usb.linked || usbInUse || autoStarted.current === usb.linked.id) return
    autoStarted.current = usb.linked.id
    onUsb()
  }, [usbPick, usb.linked, usbInUse, onUsb])
  const canContinue = step === 0 ? site.siteName.trim().length > 0 : step === 1 ? props.isLive : true

  return (
    <div className="page setup-page">
      <div className="setup-progress" aria-label={`Setup step ${step + 1} of ${STEPS.length}`}>
        {STEPS.map((label, index) => <span key={label} className={index < step ? 'is-done' : index === step ? 'is-current' : ''}><i style={{ transform: `scaleX(${index < step ? 1 : index === step ? 0.5 : 0})` }} /></span>)}
        <em>{step + 1} of {STEPS.length}</em>
      </div>
      <div className="setup-layout">
        <ol className="setup-steps" aria-label="Setup steps">
          {STEPS.map((label, index) => (
            <li key={label} className={index < step ? 'is-done' : index === step ? 'is-current' : ''}>
              <button type="button" disabled={index > step} onClick={() => go(index)}>
                <span className="setup-dot" aria-hidden="true">{index < step ? <Check size={12} weight="bold" /> : index + 1}</span>{label}
              </button>
            </li>
          ))}
        </ol>
        <section className="setup-card" key={step} aria-live="polite">
          {step === 0 ? (
            <Step title="Name the site" sub="Guards see this name on every alert.">
              <label className="field" htmlFor="setup-site">
                <span className="field-label">Site name</span>
                <input id="setup-site" autoFocus value={site.siteName} maxLength={80} placeholder="Main gate, Sector 21" onChange={event => onSite({ siteName: event.target.value })}
                  onKeyDown={event => { if (event.key === 'Enter' && site.siteName.trim()) go(1) }} />
              </label>
              <label className="field" htmlFor="setup-camera">
                <span className="field-label">Camera name</span>
                <input id="setup-camera" value={site.cameraName} maxLength={60} placeholder="Camera 1" onChange={event => onSite({ cameraName: event.target.value })} />
              </label>
            </Step>
          ) : null}
          {step === 1 ? (
            <Step title="Connect a camera" sub="Pick where the video comes from. You can change it later.">
              <div className="source-choices">
                <SourceChoice icon={<Laptop size={26} />} label="This Mac" hint="Built-in or webcam" selected={!usbPick && props.isLive && props.session.kind === 'camera' && !usbInUse} onClick={() => { setUsbPick(false); props.onCamera() }} />
                <SourceChoice icon={<DeviceMobile size={26} />} label="iPhone over USB" hint={usb.linked ? `${usb.linked.name} linked` : usb.devices.length ? `${usb.devices[0].name} found` : 'Needs the NIVRA app'} selected={usbPick || (props.isLive && usbInUse)}
                  onClick={() => { setUsbPick(true); if (usb.linked) onUsb(); else window.setTimeout(() => document.getElementById('setup-usb-code')?.focus(), 80) }} />
                <SourceChoice icon={<FilmStrip size={26} />} label="Video file" hint="Check a recording" selected={!usbPick && props.isLive && props.session.kind === 'clip'} onClick={() => { setUsbPick(false); props.onFile() }} />
                <SourceChoice icon={<PlayCircle size={26} />} label="Test scenario" hint="Scripted, no camera" selected={!usbPick && props.isLive && props.session.kind === 'demo'} onClick={() => { setUsbPick(false); props.onDemo() }} />
              </div>
              {usbPick || usbInUse ? (
                <div className="setup-usb" data-testid="setup-usb">
                  {usb.available
                    ? <UsbPhonePanel usb={usb} inUse={usbInUse} onUse={onUsb} onUnlinked={props.onUsbUnlinked} idPrefix="setup-" autoFocus />
                    : <p className="inline-problem" role="status">The local NIVRA service is not answering, so this Mac cannot look for the phone. Start NIVRA on the Mac, then try again.</p>}
                </div>
              ) : null}
              <SourcePreview session={props.session} live={props.isLive} label={props.liveLabel} />
            </Step>
          ) : null}
          {step === 2 ? (
            <Step title="Set the location" sub="The guard gets this map with every alert.">
              <CameraLocationPanel guards={props.guards} />
            </Step>
          ) : null}
          {step === 3 ? (
            <Step title="Pair your first guard" sub="They scan the QR with their phone camera. No app store needed.">
              <GuardPanel guards={props.guards} showLocation={false} />
              {pairedGuards.length ? <p className="setup-success"><Check size={16} weight="bold" /> {pairedGuards.map(guard => guard.name).join(', ')} {pairedGuards.length === 1 ? 'is' : 'are'} linked.</p> : null}
            </Step>
          ) : null}
          {step === 4 ? <TestAlert guards={props.guards} cameraName={site.cameraName} siteName={site.siteName} /> : null}

          <footer className="setup-actions">
            {step > 0 ? <button type="button" className="btn btn-quiet" onClick={() => go(step - 1)}><ArrowLeft size={16} /> Back</button> : <span />}
            <div>
              {step >= 2 && step < STEPS.length - 1 ? <button type="button" className="link-button" onClick={() => go(step + 1)}>Skip for now</button> : null}
              {step < STEPS.length - 1
                ? <button type="button" className="btn btn-primary" disabled={!canContinue} onClick={() => go(step + 1)}>Continue <ArrowRight size={16} /></button>
                : <button type="button" className="btn btn-primary" onClick={props.onFinish}>Open the console <ArrowRight size={16} /></button>}
            </div>
          </footer>
        </section>
      </div>
    </div>
  )
}

function Step({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="setup-step">
      <h1 className="reveal">{title}</h1>
      <p className="page-sub reveal" style={{ ['--i' as string]: 1 }}>{sub}</p>
      <div className="setup-body reveal" style={{ ['--i' as string]: 2 }}>{children}</div>
    </div>
  )
}

function SourceChoice({ icon, label, hint, selected, onClick }: { icon: ReactNode; label: string; hint: string; selected: boolean; onClick(): void }) {
  return (
    <button type="button" className={`source-choice ${selected ? 'is-selected' : ''}`} aria-pressed={selected} onClick={onClick}>
      <span className="source-choice-icon">{icon}</span>
      <strong>{label}</strong>
      <span>{hint}</span>
      <span className="source-choice-check" aria-hidden="true"><Check size={12} weight="bold" /></span>
    </button>
  )
}

/** Copies the live stage (video or test scene, plus skeletons) into a small preview. */
function SourcePreview({ session, live, label }: { session: Session; live: boolean; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let frame = 0
    const draw = () => {
      const target = canvas.current, context = target?.getContext('2d')
      if (target && context) {
        const source: HTMLVideoElement | HTMLCanvasElement | null = session.kind === 'demo' ? session.demoCanvasRef.current : session.videoRef.current
        const width = source instanceof HTMLVideoElement ? source.videoWidth : source?.width ?? 0
        const height = source instanceof HTMLVideoElement ? source.videoHeight : source?.height ?? 0
        if (target.width !== 640) { target.width = 640; target.height = 360 }
        context.fillStyle = '#0a0a0a'
        context.fillRect(0, 0, 640, 360)
        if (live && source && width && height) {
          const scale = Math.max(640 / width, 360 / height)
          context.save()
          if (session.kind === 'camera' && session.mirrored) { context.translate(640, 0); context.scale(-1, 1) }
          context.drawImage(source, (640 - width * scale) / 2, (360 - height * scale) / 2, width * scale, height * scale)
          context.restore()
          const overlay = session.canvasRef.current
          if (overlay?.width) context.drawImage(overlay, 0, 0, 640, 360)
        }
      }
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [session.kind, session.mirrored, session.videoRef, session.demoCanvasRef, session.canvasRef, live])
  return (
    <div className={`source-preview ${live ? 'is-live' : ''}`}>
      <canvas ref={canvas} aria-hidden="true" />
      <span className="source-preview-label"><span className="status-dot" aria-hidden="true" />{label}</span>
    </div>
  )
}

function TestAlert({ guards, cameraName, siteName }: { guards: GuardsApi; cameraName: string; siteName: string }) {
  const paired = (guards.snapshot?.guards ?? []).filter(guard => guard.paired)
  const [guardId, setGuardId] = useState('')
  const [sentKey, setSentKey] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const target = paired.find(guard => guard.id === guardId) ?? paired[0]
  const alert = sentKey ? guards.snapshot?.alerts.find(item => item.eventId === sentKey) : undefined
  const send = async () => {
    if (!target) return
    const key = `setup-test:${Date.now()}`
    setProblem(null)
    try {
      await guards.send({ guardId: target.id, eventId: key, title: 'Test alert', detail: 'Setup test from the Mac. Slide to stop, then tap I\'m on scene.', camera: [siteName, cameraName].filter(Boolean).join(' · ') })
      setSentKey(key)
    } catch (reason) { setProblem(reason instanceof Error ? reason.message : 'Could not reach the guard.') }
  }
  const steps = [
    { label: 'Sent', done: !!alert },
    { label: 'Answered', done: !!alert?.ackAt },
    { label: 'On scene', done: !!alert?.onSceneAt },
  ]
  return (
    <Step title="Send a test alert" sub={target ? `${target.name}'s phone will ring. Nothing is saved as an incident.` : 'Pair a guard first to test the phone alert. You can do it later in Settings.'}>
      {target ? (
        <>
          {paired.length > 1 ? (
            <label className="field" htmlFor="setup-test-guard"><span className="field-label">Guard</span>
              <select id="setup-test-guard" value={target.id} onChange={event => setGuardId(event.target.value)}>{paired.map(guard => <option key={guard.id} value={guard.id}>{guard.name}</option>)}</select>
            </label>
          ) : null}
          <button type="button" className={`btn btn-primary btn-wide ${alert?.status === 'sent' ? 'is-ringing' : ''}`} onClick={() => void send()}>
            {alert ? alert.status === 'sent' ? `Ringing ${target.name}…` : 'Send again' : `Ring ${target.name}'s phone`}
          </button>
          <ol className="test-steps">
            {steps.map(item => <li key={item.label} className={item.done ? 'is-done' : ''}><span aria-hidden="true">{item.done ? <Check size={12} weight="bold" /> : null}</span>{item.label}</li>)}
          </ol>
          {problem ? <p className="inline-problem" role="alert">{problem}</p> : null}
        </>
      ) : null}
    </Step>
  )
}
