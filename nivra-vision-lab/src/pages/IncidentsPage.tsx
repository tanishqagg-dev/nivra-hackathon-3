import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Trash, VideoCamera } from '@phosphor-icons/react'
import { ClipPlayer } from '../components/ClipPlayer'
import { MiniMap } from '../components/MiniMap'
import { Segmented } from '../components/ui/Segmented'
import { clipUrl, stillUrl, type Incident, type IncidentOutcome, type IncidentsApi } from '../hooks/useIncidents'

type Range = 'today' | 'week' | 'all'
const OUTCOME: Record<IncidentOutcome, string> = {
  acknowledged: 'Acknowledged', guard_on_scene: 'Guard on scene', police: 'Police called', cleared: 'Cleared', dismissed: 'Dismissed',
}

const clock = (ms: number, seconds = false) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) })
const day = (ms: number) => {
  const date = new Date(ms), today = new Date()
  const diff = Math.round((new Date(today.toDateString()).getTime() - new Date(date.toDateString()).getTime()) / 86_400_000)
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : date.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/** Derived state: what happened last, using guard progress when the operator did not set an outcome. */
function incidentStatus(incident: Incident): { label: string; tone: 'red' | 'dark' | 'quiet' | 'live' } {
  const guard = incident.guards.at(-1)
  if (incident.outcome === 'police' || incident.guards.some(alert => alert.police)) return { label: 'Police called', tone: 'red' }
  if (incident.outcome) return { label: OUTCOME[incident.outcome], tone: incident.outcome === 'dismissed' ? 'quiet' : 'dark' }
  if (guard?.status === 'on_scene') return { label: `${guard.guardName} on scene`, tone: 'dark' }
  if (guard?.status === 'cleared') return { label: 'Cleared', tone: 'dark' }
  if (guard?.status === 'acknowledged') return { label: `${guard.guardName} answered`, tone: 'dark' }
  if (guard?.status === 'sent') return { label: `Ringing ${guard.guardName}`, tone: 'live' }
  return { label: 'Needs review', tone: 'live' }
}

/** Operator timeline merged with every guard step, oldest first. */
function timeline(incident: Incident) {
  const rows = incident.timeline.map(row => ({ at: row.at, label: row.label, by: row.by }))
  for (const alert of incident.guards) {
    rows.push({ at: alert.sentAt, label: `Guard called: ${alert.guardName}`, by: null })
    if (alert.ackAt) rows.push({ at: alert.ackAt, label: `${alert.guardName} answered`, by: null })
    if (alert.declinedAt) rows.push({ at: alert.declinedAt, label: `${alert.guardName} can't respond`, by: null })
    if (alert.onSceneAt) rows.push({ at: alert.onSceneAt, label: `${alert.guardName} on scene`, by: null })
    if (alert.police) rows.push({ at: alert.police.at, label: 'Police called', by: alert.police.by })
    if (alert.clearedAt) rows.push({ at: alert.clearedAt, label: 'Cleared', by: null })
  }
  // The Mac also logs "Guard called"; keep one entry per minute-identical label.
  const seen = new Set<string>()
  return rows.sort((a, b) => a.at - b.at).filter(row => {
    const key = `${row.label}:${Math.round(row.at / 5_000)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function IncidentsPage({ incidents, selectedId, onSelect, onBack }: { incidents: IncidentsApi; selectedId: string | null; onSelect(id: string | null): void; onBack(): void }) {
  const [range, setRange] = useState<Range>('today')
  const [camera, setCamera] = useState('all')
  const cameras = useMemo(() => [...new Set(incidents.incidents.map(item => item.camera))], [incidents.incidents])
  const list = incidents.incidents.filter(item => {
    const age = Date.now() - item.occurredAt
    if (range === 'today' && new Date(item.occurredAt).toDateString() !== new Date().toDateString()) return false
    if (range === 'week' && age > 7 * 86_400_000) return false
    return camera === 'all' || item.camera === camera
  })
  const selected = incidents.incidents.find(item => item.id === selectedId) ?? list[0] ?? null

  return (
    <div className="page incidents-page">
      <header className="page-head">
        <div>
          <h1 className="reveal">Incidents</h1>
          <p className="page-sub reveal" style={{ ['--i' as string]: 1 }}>Every alert, with its clip and who did what. Saved on this Mac.</p>
        </div>
        <div className="page-tools reveal" style={{ ['--i' as string]: 2 }}>
          <Segmented<Range> label="Time range" size="sm" value={range} onChange={setRange}
            options={[{ value: 'today', label: 'Today' }, { value: 'week', label: '7 days' }, { value: 'all', label: 'All' }]} />
          {cameras.length > 1 ? (
            <select aria-label="Camera" value={camera} onChange={event => setCamera(event.target.value)}>
              <option value="all">All cameras</option>
              {cameras.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          ) : null}
        </div>
      </header>

      {incidents.error && !incidents.incidents.length ? <p className="inline-problem" role="status">{incidents.error}</p> : null}

      <div className={`incidents-layout ${selected ? 'has-selection' : ''}`}>
        <ol className="incident-list" aria-label="Incidents">
          {list.length ? list.map((item, index) => {
            const status = incidentStatus(item)
            return (
              <li key={item.id} className="reveal" style={{ ['--i' as string]: Math.min(index, 8) + 2 }}>
                <button type="button" className={`incident-row ${selected?.id === item.id ? 'is-selected' : ''}`} aria-current={selected?.id === item.id} onClick={() => onSelect(item.id)}>
                  <span className="incident-thumb">
                    {item.still ? <img src={stillUrl(item) ?? undefined} alt="" loading="lazy" /> : <VideoCamera size={18} />}
                  </span>
                  <span className="incident-main">
                    <strong>{clock(item.occurredAt)}<span>{day(item.occurredAt)}</span></strong>
                    <span>{item.title} · {item.camera}</span>
                  </span>
                  <span className={`outcome is-${status.tone}`}>{status.label}</span>
                </button>
              </li>
            )
          }) : (
            <li className="incident-empty">
              <strong>{incidents.loaded ? 'No incidents here yet' : 'Loading incidents'}</strong>
              <span>{range === 'today' ? 'Alerts from today appear here as they happen.' : 'Nothing in this range.'}</span>
            </li>
          )}
        </ol>
        {selected ? <IncidentDetail key={selected.id} incident={selected} incidents={incidents} onClose={() => onSelect(null)} /> : null}
      </div>
      <button type="button" className="link-button page-back" onClick={onBack}><ArrowLeft size={14} /> Back to live view</button>
    </div>
  )
}

function IncidentDetail({ incident, incidents, onClose }: { incident: Incident; incidents: IncidentsApi; onClose(): void }) {
  const [note, setNote] = useState(incident.note)
  const [saved, setSaved] = useState<'idle' | 'saving' | 'saved'>('idle')
  useEffect(() => { setNote(incident.note) }, [incident.note])
  const status = incidentStatus(incident)
  const saveNote = async () => {
    if (note === incident.note) return
    setSaved('saving')
    try { await incidents.update(incident.id, { note }); setSaved('saved') } catch { setSaved('idle') }
  }
  const setOutcome = (outcome: IncidentOutcome) => void incidents.update(incident.id, { outcome }).catch(() => undefined)
  const remove = async () => {
    if (!confirm('Delete this incident and its clip from this Mac?')) return
    await incidents.remove(incident.id).catch(() => undefined)
    onClose()
  }

  return (
    <article className="incident-detail" aria-label="Incident detail">
      <header className="incident-detail-head reveal">
        <div>
          <p className="eyebrow">{incident.kind === 'test' ? 'Test alert' : 'Alert'} · {day(incident.occurredAt)} {clock(incident.occurredAt, true)}</p>
          <h2>{incident.title}</h2>
          <p className="page-sub">{incident.camera}{incident.likelihood !== null ? ` · ${incident.likelihood}% likelihood` : ''}</p>
        </div>
        <span className={`outcome is-${status.tone}`}>{status.label}</span>
      </header>
      <div className="reveal" style={{ ['--i' as string]: 1 }}>
        <ClipPlayer src={clipUrl(incident)} poster={stillUrl(incident)} autoPlay downloadName={`nivra-${incident.id}.webm`} />
      </div>
      <div className="incident-columns reveal" style={{ ['--i' as string]: 2 }}>
        <section aria-label="Timeline">
          <p className="eyebrow">Timeline</p>
          <ol className="timeline">
            {timeline(incident).map(row => (
              <li key={`${row.at}:${row.label}`}><time>{clock(row.at, true)}</time><span>{row.label}{row.by ? <em> · {row.by}</em> : null}</span></li>
            ))}
          </ol>
        </section>
        <section aria-label="Place and notes">
          {incident.location ? <MiniMap lat={incident.location.lat} lng={incident.location.lng} label={incident.location.label} height={150} /> : <p className="quiet">No location was set when this alert fired.</p>}
          <label className="field">
            <span className="field-label">Notes {saved === 'saved' ? <output>Saved</output> : saved === 'saving' ? <output>Saving…</output> : null}</span>
            <textarea value={note} maxLength={500} rows={3} placeholder="What happened? Who handled it?" onChange={event => { setNote(event.target.value); setSaved('idle') }} onBlur={() => void saveNote()} />
          </label>
          <div className="button-row">
            <button type="button" className="btn btn-quiet" onClick={() => setOutcome('cleared')} disabled={incident.outcome === 'cleared'}>Mark cleared</button>
            <button type="button" className="btn btn-quiet" onClick={() => setOutcome('dismissed')} disabled={incident.outcome === 'dismissed'}>False alarm</button>
            <button type="button" className="btn btn-icon" aria-label="Delete incident" onClick={() => void remove()}><Trash size={16} /></button>
          </div>
        </section>
      </div>
    </article>
  )
}
