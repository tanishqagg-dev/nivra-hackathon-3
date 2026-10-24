import { useEffect, useState, type FormEvent } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import type { Guard, GuardsApi } from '../hooks/useGuards'
import { CameraLocationPanel } from './CameraLocationPanel'

const SHIFT_LABEL: Record<Guard['shift'], string> = { on_shift: 'On shift', break: 'On break', off: 'Off shift' }

function guardStatus(guard: Guard) {
  if (!guard.paired) return 'Phone not linked'
  return `${SHIFT_LABEL[guard.shift]} · ${guard.online ? 'phone online' : 'phone offline'}`
}

export function GuardPanel({ guards, showLocation = true }: { guards: GuardsApi; showLocation?: boolean }) {
  const { snapshot, error } = guards
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [invite, setInvite] = useState<{ guardId: string; url: string; expires: number; issued: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!invite) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [invite])

  const invited = invite ? snapshot?.guards.find(guard => guard.id === invite.guardId) : undefined
  const linkedNow = !!invited && invited.paired && invited.online && (invited.lastSeen ?? 0) >= invite!.issued
  useEffect(() => {
    if (!linkedNow) return
    const timer = window.setTimeout(() => setInvite(null), 2_500)
    return () => clearTimeout(timer)
  }, [linkedNow])

  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true); setProblem(null)
    try {
      const guard = await guards.addGuard(name.trim())
      setName('')
      await showQR(guard.id)
    } catch (reason) { setProblem(reason instanceof Error ? reason.message : 'Could not add the guard.') }
    finally { setBusy(false) }
  }
  const showQR = async (guardId: string) => {
    setProblem(null)
    try {
      const result = await guards.invite(guardId)
      const issued = Date.now()
      setNow(issued)
      setInvite({ guardId, url: result.url, issued, expires: issued + result.expiresInSeconds * 1_000 })
    } catch (reason) { setProblem(reason instanceof Error ? reason.message : 'Could not create the QR.') }
  }
  const remove = async (guard: Guard) => {
    if (!confirm(`Remove ${guard.name}? Their phone stops getting alerts.`)) return
    setProblem(null)
    try { await guards.removeGuard(guard.id); if (invite?.guardId === guard.id) setInvite(null) }
    catch (reason) { setProblem(reason instanceof Error ? reason.message : 'Could not remove the guard.') }
  }

  const list = snapshot?.guards ?? []
  const onShift = list.filter(guard => guard.paired && guard.shift === 'on_shift').length
  const seconds = invite ? Math.max(0, Math.ceil((invite.expires - now) / 1_000)) : 0

  return (
    <section className="guard-panel" aria-labelledby="guards-heading" data-testid="guard-panel">
      <div className="panel-heading">
        <h2 id="guards-heading">Guards</h2>
        <span className="count" aria-label={`${onShift} guards on shift`}>{onShift} on shift</span>
      </div>
      <p className="panel-description">{snapshot?.publicUrl ? <>Guard phones connect through <strong>{snapshot.publicUrl.replace(/^https:\/\//, '')}</strong> on any network.</> : 'Guard phones join the same Wi-Fi as this Mac.'} You review each alert here first, then call a guard.</p>
      {error && !snapshot ? <p className="guard-problem" role="status">{error}</p> : null}
      {snapshot && !snapshot.publicUrl && !snapshot.lan.host ? <p className="guard-problem" role="status">This Mac is not on Wi-Fi. Guard phones cannot connect until it joins one.</p> : null}

      {invite && invited ? (
        <div className="guard-invite" aria-label={`Link ${invited.name}'s phone`}>
          {linkedNow ? <p className="guard-linked" role="status">{invited.name}'s phone is linked.</p> : seconds > 0 ? <>
            <div className="guard-qr"><QRCodeSVG value={invite.url} size={184} marginSize={2} title={`Guard QR for ${invited.name}`} /></div>
            <ol>
              {snapshot?.publicUrl ? null : <li>Join the guard phone to this Mac's Wi-Fi.</li>}
              <li>Scan this QR with the NIVRA app or the phone camera.</li>
              <li>Tap On shift. Keep the page open.</li>
            </ol>
            <p className="guard-url">Can't scan? Open <span>{invite.url.split('#')[0]}</span> on the phone, then scan again.</p>
            <p className="guard-expiry" role="status">One-time QR for {invited.name} · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</p>
          </> : <p role="status">This QR expired. <button className="text-button" type="button" onClick={() => void showQR(invited.id)}>New QR</button></p>}
          <button className="text-button" type="button" onClick={() => setInvite(null)}>Close</button>
        </div>
      ) : null}

      {list.length ? (
        <ul className="guard-list">
          {list.map(guard => (
            <li key={guard.id} className="guard-row">
              <span className={`guard-dot ${guard.paired && guard.online ? guard.shift === 'on_shift' ? 'is-on' : 'is-idle' : ''}`} aria-hidden="true" />
              <div><strong>{guard.name}</strong><span>{guardStatus(guard)}</span></div>
              <button className="text-button" type="button" onClick={() => void showQR(guard.id)}>{guard.paired ? 'Relink' : 'Show QR'}</button>
              <button className="text-button guard-remove" type="button" aria-label={`Remove ${guard.name}`} onClick={() => void remove(guard)}>Remove</button>
            </li>
          ))}
        </ul>
      ) : null}

      <form className="guard-add" onSubmit={event => void add(event)}>
        <label className="visually-hidden" htmlFor="guard-name">Guard name</label>
        <input id="guard-name" value={name} maxLength={60} placeholder="Guard name" onChange={event => setName(event.target.value)} />
        <button className="secondary-action" type="submit" disabled={busy || !name.trim()}>Add guard</button>
      </form>
      {problem ? <p className="guard-problem" role="alert">{problem}</p> : null}
      {showLocation ? <CameraLocationPanel guards={guards} /> : null}
    </section>
  )
}
