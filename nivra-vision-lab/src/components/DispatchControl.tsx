import { useState } from 'react'
import { Check, Phone, PhoneCall } from '@phosphor-icons/react'
import { POLICE_NUMBER, type Guard, type GuardAlert, type GuardsApi } from '../hooks/useGuards'
import type { ReviewEvent } from '../lib/sceneEngine'
import { alertKey } from '../lib/alertKey'

const STATUS: Record<GuardAlert['status'], string> = {
  sent: 'Ringing', acknowledged: 'Acknowledged', declined: "Can't respond", on_scene: 'On scene', cleared: 'Cleared',
}
const SHIFT_ORDER = { on_shift: 0, break: 1, off: 2 } as const
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const rank = (a: Guard, b: Guard) => Number(b.online) - Number(a.online) || SHIFT_ORDER[a.shift] - SHIFT_ORDER[b.shift]

type Props = {
  event: ReviewEvent
  camera: string
  guards: GuardsApi
  acknowledged: boolean
  onAcknowledge(): void
  onNeedGuard(): void
  compact?: boolean
  stacked?: boolean
  /** Called after a guard alert is sent, for the incident timeline. */
  onGuardCalled?(guardName: string): void
  onPolice?(): void
}

/** Acknowledge, call a guard, or call police. Nothing leaves the Mac without a click. */
export function DispatchControl({ event, camera, guards, acknowledged, onAcknowledge, onNeedGuard, compact = false, stacked = false, onGuardCalled, onPolice }: Props) {
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const snapshot = guards.snapshot
  const linked = (snapshot?.guards ?? []).filter(guard => guard.paired).sort(rank)
  const sent = (snapshot?.alerts ?? []).filter(alert => alert.eventId === alertKey(event))
  const open = sent.find(alert => alert.status !== 'cleared')
  const selected = linked.find(guard => guard.id === choice) ?? linked[0]

  const callGuard = async () => {
    if (busy) return
    if (!selected) { onNeedGuard(); return }
    setBusy(true); setProblem(null)
    try { await guards.send({ guardId: selected.id, eventId: alertKey(event), title: event.title, detail: event.detail, camera }); onGuardCalled?.(selected.name) }
    catch (error) { setProblem(error instanceof Error ? error.message : 'Could not reach the guard.') }
    finally { setBusy(false) }
  }
  const police = () => { onPolice?.(); if (open) void guards.recordPolice(open.id).catch(() => undefined) }
  const guardLabel = busy ? 'Calling…' : open && open.guardId === selected?.id ? 'Guard called' : stacked && selected ? `Call guard · ${selected.name}` : 'Call guard'

  return (
    <div className={`alert-actions ${compact ? 'is-compact' : ''} ${stacked ? 'is-stacked' : ''}`} data-testid="dispatch">
      <div className="alert-buttons">
        <button type="button" className={`alert-button is-ack ${acknowledged ? 'is-done' : ''}`} disabled={acknowledged} onClick={onAcknowledge}>
          <span className="alert-icon" aria-hidden="true">{acknowledged ? <Check size={16} weight="bold" /> : null}</span>{acknowledged ? 'Acknowledged' : 'Acknowledge'}
        </button>
        <button type="button" className={`alert-button is-guard ${open?.status === 'sent' ? 'is-ringing' : open ? 'is-answered' : ''}`} disabled={busy || (!!open && open.guardId === selected?.id)} onClick={() => void callGuard()}>
          <span className="alert-icon" aria-hidden="true">{open?.status === 'sent' ? <PhoneCall size={16} /> : <Phone size={16} />}</span>{guardLabel}
        </button>
        <a className="alert-button is-police" href={`tel:${POLICE_NUMBER}`} onClick={police}>
          <span className="alert-icon" aria-hidden="true"><Phone size={16} weight="fill" /></span>{stacked ? `Call police · ${POLICE_NUMBER}` : 'Call police'}
        </a>
      </div>
      {linked.length > 1 ? (
        <label className="alert-guard-pick">
          <span>Guard</span>
          <select value={selected?.id ?? ''} onChange={change => setChoice(change.target.value)} disabled={busy}>
            {linked.map(guard => <option key={guard.id} value={guard.id}>{guard.name} · {guard.online ? guard.shift === 'on_shift' ? 'on shift' : guard.shift === 'break' ? 'on break' : 'off shift' : 'offline'}</option>)}
          </select>
        </label>
      ) : null}
      {sent.map(alert => (
        <p key={alert.id} className={`dispatch-status is-${alert.status}`} data-testid="dispatch-status">
          <span aria-hidden="true" />{alert.guardName} · {STATUS[alert.status]}{alert.status === 'sent' ? <i className="ringing-dots" aria-hidden="true"><b /><b /><b /></i> : null}{alert.police ? ` · Police called by ${alert.police.by} at ${time(alert.police.at)}` : ''}
        </p>
      ))}
      {open?.location ? <p className="dispatch-location">Location sent · {open.location.label || `${open.location.lat.toFixed(4)}, ${open.location.lng.toFixed(4)}`}</p> : null}
      {!linked.length && !compact ? <p className="dispatch-hint">No guard linked yet. Call guard opens setup.</p> : null}
      {problem ? <p className="dispatch-problem" role="alert">{problem}</p> : null}
    </div>
  )
}
