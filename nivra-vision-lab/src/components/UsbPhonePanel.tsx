import { useState, type FormEvent } from 'react'
import type { useUsbPhone } from '../hooks/useUsbPhone'
import { usbHealth } from '../lib/usbHealth'

type Props = { usb: ReturnType<typeof useUsbPhone>; inUse: boolean; onUse(): void; onUnlinked(): void; idPrefix?: string; autoFocus?: boolean }

// Automatic states that still need a person to do something on the phone, or to type the code.
const NEEDS_CODE = new Set(['needs_code', 'no_xcode', 'launch_failed'])

/**
 * iPhone over USB. With "Open NIVRA automatically" on (the default), plugging the phone in is enough:
 * the Mac opens NIVRA on it, links it and starts the camera. The code box stays as a fallback.
 */
export function UsbPhonePanel({ usb, inUse, onUse, onUnlinked, idPrefix = '', autoFocus = false }: Props) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [typeCode, setTypeCode] = useState(false)
  if (!usb.available) return null
  const phone = usb.linked ?? usb.devices[0] ?? null
  const health = usbHealth(usb, inUse)
  const normalized = code.toUpperCase().replace(/[\s-]/g, '')
  const auto = usb.auto
  const autoOn = auto.enabled
  const showCodeForm = !autoOn || typeCode || NEEDS_CODE.has(auto.state)

  const connect = async (event: FormEvent) => {
    event.preventDefault()
    if (!phone || busy || !/^[A-Z0-9]{8}$/.test(normalized)) return
    setBusy(true); setProblem(null)
    try {
      await usb.connect(phone.id, normalized)
      setCode('')
      setTypeCode(false)
      onUse()
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Could not link the phone.') }
    finally { setBusy(false) }
  }
  const unlink = async () => {
    setBusy(true); setProblem(null)
    try { onUnlinked(); await usb.disconnect() }
    catch (error) { setProblem(error instanceof Error ? error.message : 'Could not unlink the phone.') }
    finally { setBusy(false) }
  }

  const autoSwitch = (
    <label className="usb-auto">
      <span className="switch"><input type="checkbox" checked={autoOn} onChange={event => void usb.setAuto(event.target.checked)} /><span aria-hidden="true" /></span>
      Open NIVRA automatically when an iPhone is plugged in
    </label>
  )
  const codeForm = (title: string) => (
    <form className="usb-link" onSubmit={event => void connect(event)}>
      <div>
        <strong>{title}</strong>
        <p>{autoOn && auto.message ? `${auto.message} ` : ''}On the phone, open NIVRA, tap Other options, then Start camera without scanning. Type the code it shows.</p>
      </div>
      <label className="visually-hidden" htmlFor={`${idPrefix}usb-code`}>Phone code</label>
      <input id={`${idPrefix}usb-code`} autoFocus={autoFocus} value={code} maxLength={9} autoComplete="off" spellCheck={false} placeholder="ABCD 2345"
        onChange={event => { setCode(event.target.value.toUpperCase()); setProblem(null) }} />
      <button className="primary-action" type="submit" disabled={busy || !/^[A-Z0-9]{8}$/.test(normalized)}>{busy ? 'Linking…' : 'Link phone'}</button>
    </form>
  )

  return (
    <section className={`usb-bar ${usb.linked ? 'is-linked' : ''}`} aria-label="iPhone camera over USB" data-testid="usb-panel">
      <svg className="usb-glyph" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="7" y="2.5" width="10" height="16" rx="2" /><path d="M10.5 15.5h3M12 18.5v3" /></svg>
      {!phone ? (
        <div className="usb-waiting">
          <strong><span className="usb-searching" aria-hidden="true" />{autoOn ? 'Plug in your iPhone' : 'Looking for an iPhone'}</strong>
          {autoOn ? (
            <p>Use a data cable and unlock the phone. NIVRA opens on it and the camera starts here by itself. The first time, tap Trust on the phone.</p>
          ) : (
            <ol>
              <li>Connect it with a cable that carries data. Charge-only cables do not work.</li>
              <li>Unlock the phone. If it asks, tap Trust and enter the passcode.</li>
              <li>Open NIVRA, tap Other options, then Start camera without scanning.</li>
            </ol>
          )}
        </div>
      ) : usb.linked && health.title !== 'New code needed' ? (
        <>
          <div>
            <strong>{usb.linked.name}</strong>
            <p className={`usb-health is-${health.tone}`} role="status"><span aria-hidden="true" />{health.title}</p>
            {health.detail ? <p>{health.detail}</p> : null}
          </div>
          {!inUse ? <button className="primary-action" type="button" disabled={busy} onClick={onUse}>Use phone camera</button> : null}
          <button className="text-button" type="button" disabled={busy} onClick={() => void unlink()}>Unlink</button>
          <details className="usb-tips">
            <summary>Keep it connected</summary>
            <ul>
              <li>Use a data cable and plug straight into the Mac, not a hub.</li>
              <li>On the phone: Settings, Display and Brightness, Auto-Lock, Never.</li>
              <li>Keep NIVRA on screen. If it closes, the Mac opens it again by itself.</li>
              <li>Keep the phone charging and out of direct sun so it does not overheat.</li>
              <li>If the cable comes out, plug it back in and unlock the phone. The camera comes back by itself.</li>
            </ul>
          </details>
        </>
      ) : showCodeForm ? (
        codeForm(usb.linked ? `${phone.name} needs a new code` : `${phone.name} found on USB`)
      ) : (
        <div className="usb-waiting">
          <strong className={`usb-step is-${auto.state}`}>
            {auto.state === 'launching' || auto.state === 'idle' || auto.state === 'connected' ? <span className="usb-spinner" aria-hidden="true" /> : <span className="usb-searching" aria-hidden="true" />}
            {auto.state === 'locked' ? `Unlock ${phone.name}` : auto.state === 'launching' || auto.state === 'idle' || auto.state === 'connected' ? `Opening NIVRA on ${phone.name}…` : `${phone.name} needs one step`}
          </strong>
          <p role="status">{auto.state === 'launching' || auto.state === 'idle' || auto.state === 'connected' ? 'Starting the phone camera over the cable. Keep the phone unlocked.' : auto.message}</p>
          <button type="button" className="text-button" onClick={() => setTypeCode(true)}>Type the code instead</button>
        </div>
      )}
      {autoSwitch}
      {problem ? <p className="usb-problem" role="alert">{problem}</p> : null}
    </section>
  )
}
