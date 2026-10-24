import { useId } from 'react'
import type { ConflictSnapshot } from '../lib/conflictEngine'
import './ConflictPanel.css'

interface ConflictPanelProps {
  snapshot: ConflictSnapshot
  enabled: boolean
  active: boolean
  simulated: boolean
  onToggle(enabled: boolean): void
}

const STATUS_LABELS: Record<ConflictSnapshot['status'], string> = {
  warming: 'Getting a clear view',
  clear: 'No conflict pattern',
  observing: 'Checking interaction',
  alert: 'Possible physical conflict',
  limited: 'View too limited',
}

export function ConflictPanel({ snapshot, enabled, active, simulated, onToggle }: ConflictPanelProps) {
  const headingId = useId()
  const explanationId = useId()
  const state = !enabled ? 'off' : !active ? 'waiting' : snapshot.status
  const label = !enabled ? 'Analysis off' : !active ? 'Waiting for input' : STATUS_LABELS[snapshot.status]
  const explanation = !enabled
    ? 'Enable to check motion between two people.'
    : !active
      ? 'Start a camera or video to analyze movement.'
      : snapshot.explanation
  const progress = Number.isFinite(snapshot.progress) ? Math.min(1, Math.max(0, snapshot.progress)) : 0
  const signals = enabled && active ? [...new Set(snapshot.signals)] : []

  return (
    <section className={`conflict-panel conflict-is-${state}`} aria-labelledby={headingId}>
      <div className="conflict-heading">
        <div>
          <h2 id={headingId}>Physical conflict</h2>
          <p>Motion analysis · experimental</p>
        </div>
        <label className="toggle-control conflict-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={event => onToggle(event.target.checked)}
            aria-label="Enable physical conflict analysis"
            data-testid="conflict-toggle"
          />
          <span className="toggle-track" aria-hidden="true"><span /></span>
          <span aria-hidden="true">{enabled ? 'On' : 'Off'}</span>
        </label>
      </div>

      {simulated && active ? <span className="conflict-simulated">Scripted observations</span> : null}

      <div className="conflict-state" aria-live="polite" aria-atomic="true">
        <span className="conflict-dot" aria-hidden="true" />
        <strong data-testid="conflict-status">{label}</strong>
      </div>
      <p className="conflict-explanation" id={explanationId}>{explanation}</p>

      {enabled && active ? (
        <dl className="pose-coverage" aria-label="Pose coverage">
          <div><dt>Skeletons detected</dt><dd data-testid="coverage-detected">{snapshot.diagnostics.detectedPoses}</dd></div>
          <div><dt>Usable upper bodies</dt><dd data-testid="coverage-usable">{snapshot.diagnostics.usablePeople}</dd></div>
          <div><dt>Usable arms</dt><dd data-testid="coverage-arms">{snapshot.diagnostics.usableArms}</dd></div>
          <div><dt>Nearby pairs</dt><dd data-testid="coverage-pairs">{snapshot.diagnostics.nearbyPairs}</dd></div>
        </dl>
      ) : null}
      {enabled && active ? (
        <p className={`partial-body-note ${snapshot.diagnostics.upperBodyOnlyPeople > 0 ? '' : 'is-reserved'}`} aria-hidden={snapshot.diagnostics.upperBodyOnlyPeople > 0 ? undefined : true}>Upper-body view supported. Hidden leg joints are not used as motion evidence.</p>
      ) : null}

      {enabled && active ? (
        <div className="conflict-confirmation">
          <div className="conflict-progress-label">
            <span>{state === 'alert' ? 'Pattern sustained across frames' : 'Confirmation across frames'}</span>
            <span>{snapshot.people} usable {snapshot.people === 1 ? 'pose' : 'poses'}</span>
          </div>
          <progress
            className="conflict-progress"
            value={progress}
            max={1}
            aria-label="Conflict confirmation"
            aria-describedby={explanationId}
            aria-valuetext={state === 'alert'
              ? 'Motion pattern sustained across frames'
              : state === 'observing'
                ? 'Gathering repeated motion evidence'
                : 'No motion pattern awaiting confirmation'}
            data-testid="conflict-progress"
          />
        </div>
      ) : null}

      {enabled && active ? (
        <ul className="conflict-signals is-stable" aria-label="Observed motion signals">
          {signals.slice(0, 3).map(signal => <li key={signal}><span aria-hidden="true" />{signal}</li>)}
        </ul>
      ) : null}

      <p className="conflict-framing">Keep both people’s shoulders and hands visible. Stand side-on to the camera so arm extension is visible. One person alone will not trigger a conflict alert.</p>
      <p className={`conflict-review-note ${state === 'alert' ? '' : 'is-reserved'}`} aria-hidden={state === 'alert' ? undefined : true}>Review the interaction before responding.</p>
    </section>
  )
}
