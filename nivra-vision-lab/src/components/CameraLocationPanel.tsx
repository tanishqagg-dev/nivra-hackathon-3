import { useEffect, useState, type FormEvent } from 'react'
import type { GuardsApi } from '../hooks/useGuards'
import { parseLocation } from '../lib/parseLocation'
import { MiniMap } from './MiniMap'

export function CameraLocationPanel({ guards }: { guards: GuardsApi }) {
  const saved = guards.snapshot?.location ?? null
  const [label, setLabel] = useState('')
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  useEffect(() => { if (saved?.label) setLabel(current => current || saved.label || '') }, [saved?.label])

  const save = async (point: { lat: number; lng: number; accuracy?: number | null }) => {
    setBusy(true); setProblem(null)
    try { await guards.setLocation({ ...point, label: label.trim() }); setManual('') }
    catch (error) { setProblem(error instanceof Error ? error.message : 'Could not save the location.') }
    finally { setBusy(false) }
  }
  const useMac = () => {
    if (!navigator.geolocation) { setProblem('This browser cannot read the Mac location. Paste coordinates instead.'); return }
    setBusy(true); setProblem(null)
    navigator.geolocation.getCurrentPosition(
      position => void save({ lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy }),
      error => { setBusy(false); setProblem(error.code === 1 ? 'Location is blocked. Allow it for this site in the browser, or paste coordinates.' : 'Could not get the Mac location. Paste coordinates instead.') },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    )
  }
  const submitManual = (event: FormEvent) => {
    event.preventDefault()
    const point = parseLocation(manual)
    if (!point) { setProblem('Paste coordinates like 28.6139, 77.2090 or a Google Maps link.'); return }
    void save({ ...point, accuracy: null })
  }
  const renameOnly = () => { if (saved && label.trim() !== (saved.label ?? '')) void save({ lat: saved.lat, lng: saved.lng, accuracy: saved.accuracy }) }

  return (
    <div className="camera-location" data-testid="camera-location">
      <div className="camera-location-head">
        <strong>Camera location</strong>
        <span>{saved ? 'Sent with every guard alert' : 'Not set. Guards get no map yet.'}</span>
      </div>
      {saved ? (
        <div className="camera-location-saved">
          <MiniMap lat={saved.lat} lng={saved.lng} label={saved.label} height={160} />
          <p>{saved.lat.toFixed(5)}, {saved.lng.toFixed(5)}{saved.accuracy ? ` · ±${saved.accuracy} m` : ''}</p>
        </div>
      ) : null}
      <label className="visually-hidden" htmlFor="camera-place">Place name</label>
      <input id="camera-place" value={label} maxLength={80} placeholder="Place name, e.g. Main gate, Block B" onChange={event => setLabel(event.target.value)} onBlur={renameOnly} />
      <div className="camera-location-actions">
        <button className="secondary-action" type="button" disabled={busy} onClick={useMac}>{busy ? 'Locating…' : saved ? "Update to this Mac's location" : "Use this Mac's location"}</button>
      </div>
      <form className="camera-location-manual" onSubmit={submitManual}>
        <label className="visually-hidden" htmlFor="camera-coords">Coordinates or Google Maps link</label>
        <input id="camera-coords" value={manual} placeholder="or paste coordinates / Maps link" onChange={event => { setManual(event.target.value); setProblem(null) }} />
        <button className="text-button" type="submit" disabled={busy || !manual.trim()}>Set</button>
      </form>
      {problem ? <p className="guard-problem" role="alert">{problem}</p> : null}
    </div>
  )
}
