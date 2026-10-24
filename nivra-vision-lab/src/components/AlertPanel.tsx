import { ArrowRight } from '@phosphor-icons/react'
import type { GuardsApi } from '../hooks/useGuards'
import { clipUrl, stillUrl, type Incident } from '../hooks/useIncidents'
import type { ReviewEvent } from '../lib/sceneEngine'
import { ClipPlayer } from './ClipPlayer'
import { DispatchControl } from './DispatchControl'
import { MiniMap } from './MiniMap'
import { RollingNumber } from './ui/RollingNumber'

type Props = {
  event: ReviewEvent
  simulated: boolean
  where: string
  camera: string
  age: string
  likelihood: number | null
  guards: GuardsApi
  incident: Incident | null
  clipPending: boolean
  onAcknowledge(): void
  onNeedGuard(): void
  onGuardCalled(name: string): void
  onPolice(): void
  onOpenIncident(id: string): void
}

/** The active alert: what, where, the clip, and the three human decisions. */
export function AlertPanel({ event, simulated, where, camera, age, likelihood, guards, incident, clipPending, onAcknowledge, onNeedGuard, onGuardCalled, onPolice, onOpenIncident }: Props) {
  const linked = (guards.snapshot?.guards ?? []).filter(guard => guard.paired)
  const onDuty = [...linked].sort((a, b) => Number(b.shift === 'on_shift') - Number(a.shift === 'on_shift') || Number(b.online) - Number(a.online))
  const location = guards.snapshot?.location
  return (
    <section className="alert-panel" role="alert" data-testid="review-alert" key={`${event.id}:${event.occurredAtMs}`}>
      <p className="alert-eyebrow stagger" style={{ ['--i' as string]: 0 }}><span className="alert-eyebrow-dot" aria-hidden="true" />{simulated ? 'Test alert' : 'Alert'}<span className="alert-age">{age}</span></p>
      <h2 className="alert-title stagger" style={{ ['--i' as string]: 1 }}>{event.title}</h2>
      <p className="alert-where stagger" style={{ ['--i' as string]: 1 }}>{where}</p>
      {likelihood !== null ? (
        <p className="alert-score stagger" style={{ ['--i' as string]: 2 }}><RollingNumber value={likelihood} suffix="%" proportional /><span>likelihood</span></p>
      ) : null}
      <div className="stagger" style={{ ['--i' as string]: 3 }}>
        <ClipPlayer src={incident ? clipUrl(incident) : null} poster={incident ? stillUrl(incident) : null} pending={clipPending || (!!incident && !incident.clip)} downloadName={`nivra-${incident?.id ?? 'clip'}.webm`} />
      </div>
      <div className="stagger" style={{ ['--i' as string]: 4 }}>
        <DispatchControl event={event} camera={camera} guards={guards} stacked acknowledged={false} onAcknowledge={onAcknowledge} onNeedGuard={onNeedGuard} onGuardCalled={onGuardCalled} onPolice={onPolice} />
      </div>
      <div className="alert-duty stagger" style={{ ['--i' as string]: 5 }}>
        <p className="alert-label">Guards on duty</p>
        {onDuty.length ? onDuty.map(guard => (
          <div key={guard.id} className="duty-row">
            <span className="duty-avatar">{guard.name.slice(0, 1).toUpperCase()}<i className={guard.online ? 'is-online' : ''} /></span>
            <div><strong>{guard.name}</strong><span>{guard.shift === 'on_shift' ? 'On shift' : guard.shift === 'break' ? 'On break' : 'Off shift'}{guard.online ? '' : ' · offline'}</span></div>
          </div>
        )) : <p className="alert-hint">No guard phone linked. <button type="button" className="link-button" onClick={onNeedGuard}>Add a guard</button></p>}
      </div>
      {location ? <div className="stagger" style={{ ['--i' as string]: 6 }}><MiniMap lat={location.lat} lng={location.lng} label={location.label} height={140} /></div> : null}
      {incident ? (
        <button type="button" className="link-button alert-open stagger" style={{ ['--i' as string]: 7 }} onClick={() => onOpenIncident(incident.id)}>
          Open incident <ArrowRight size={14} />
        </button>
      ) : null}
    </section>
  )
}
