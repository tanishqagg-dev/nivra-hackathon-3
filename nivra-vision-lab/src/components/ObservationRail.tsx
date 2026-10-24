import type { SceneObjectStatus, SceneSnapshot, ReviewEvent } from '../lib/sceneEngine'
import type { ReactNode } from 'react'

interface ObservationRailProps {
  scene: SceneSnapshot
  active: boolean
  simulated: boolean
  acknowledged: ReadonlySet<string>
  onAcknowledge(id: string): void
  onWatch(trackKey: string): void
  showObjects?: boolean
  conflictPanel?: ReactNode
  trainedFight?: boolean
  guardPanel?: ReactNode
  alertPanel?: ReactNode
  onClose?(): void
  renderEventActions?(event: ReviewEvent, reviewed: boolean): ReactNode
}

const STATUS_LABELS: Record<SceneObjectStatus, string> = {
  observed: 'In view',
  carried: 'Near a person',
  separated: 'Separated',
  unattended: 'Unattended',
  review: 'Needs review',
}

function eventAge(event: ReviewEvent, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - event.occurredAtMs) / 1_000))
  if (seconds < 2) return 'Now'
  if (seconds < 60) return `${seconds}s ago`
  return `${Math.floor(seconds / 60)}m ago`
}

export function ObservationRail({ scene, active, simulated, acknowledged, onAcknowledge, onWatch, showObjects = true, conflictPanel, trainedFight = false, guardPanel, alertPanel, onClose, renderEventActions }: ObservationRailProps) {
  const pending = scene.events.filter(event => !acknowledged.has(event.id)).length

  return (
    <aside className="observation-rail" aria-label="Scene observations">
      {onClose ? <div className="rail-head"><strong>Alerts</strong><button type="button" className="icon-button" aria-label="Close alerts" onClick={onClose}>×</button></div> : null}
      {alertPanel}
      {conflictPanel}
      <section className="event-panel" aria-labelledby="review-heading">
        <div className="panel-heading">
          <h2 id="review-heading">Review queue</h2>
          <span className={`count ${pending ? 'needs-review' : ''}`} aria-label={`${pending} pending reviews`}>{pending}</span>
        </div>
        <p className="panel-description">Changes that need a person to check.</p>
        {scene.events.length ? (
          <ol className="event-list">
            {scene.events.map(event => {
              const reviewed = acknowledged.has(event.id)
              return (
                <li key={event.id} className={`event-row ${reviewed ? 'is-acknowledged' : ''}`}>
                  <div className="event-title-line">
                    <strong>{event.title}</strong>
                    <time>{eventAge(event, scene.timestampMs)}</time>
                  </div>
                  <p>{event.detail}</p>
                  {simulated ? <span className="review-label">Scripted test event</span> : null}
                  {renderEventActions ? renderEventActions(event, reviewed) : reviewed ? <span className="acknowledged-label">Acknowledged</span> : (
                    <button className="review-action" type="button" onClick={() => onAcknowledge(event.id)}>
                      Acknowledge
                    </button>
                  )}
                </li>
              )
            })}
          </ol>
        ) : (
          <div className="event-empty">
            <div className="empty-rings" aria-hidden="true"><span /><span /></div>
            <strong>{active ? 'No changes to review' : 'Your review queue is clear'}</strong>
            <p>{active ? trainedFight ? 'Two consecutive fight-like video windows can create a review.' : showObjects ? 'Watch an item to receive an alert when it moves or leaves the view.' : 'Repeated directed arm movements between two nearby people can create a review.' : 'Start a camera, open a video, or try the test scenario.'}</p>
          </div>
        )}
      </section>

      {guardPanel}

      {showObjects ? <section className="inventory-panel" aria-labelledby="objects-heading">
        <div className="panel-heading">
          <h2 id="objects-heading">Objects in view</h2>
          <span className="count" data-testid="objects-visible">{scene.objects.length}</span>
        </div>
        <p className="panel-description">Choose an item to watch its current position.</p>
        {scene.objects.length ? (
          <ul className="inventory-list">
            {scene.objects.map(item => {
              const watched = scene.watch?.trackKey === item.trackKey
              const armed = watched && scene.watch?.state === 'watching'
              const progress = watched ? scene.watch?.progress : item.reviewProgress
              const hint = watched
                ? armed ? 'Watching for movement or disappearance' : 'Watch triggered. Rearm at its new position.'
                : item.reviewHint
              return (
                <li className={`inventory-row ${armed ? 'is-armed' : ''}`} key={item.trackKey}>
                  <div className="inventory-top">
                    <strong>{item.displayName}</strong>
                    <span title="Model detection confidence">{Math.round(item.score * 100)}%</span>
                  </div>
                  <div className="inventory-bottom">
                    <span>{STATUS_LABELS[item.status]}</span>
                    <button
                      type="button"
                      className="text-button"
                      disabled={!active || armed}
                      onClick={() => onWatch(item.trackKey)}
                      aria-label={`${armed ? 'Watching' : watched ? 'Rearm watch for' : 'Watch'} ${item.displayName}`}
                    >
                      {armed ? 'Watching' : watched ? 'Rearm watch' : 'Watch item'}
                    </button>
                  </div>
                  {hint ? <p>{hint}</p> : null}
                  {progress !== undefined && progress > 0 && progress < 1 ? (
                    <progress className="evidence-progress" value={progress} max={1} aria-label={`${item.displayName} review evidence`} />
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="rail-empty">{active ? 'Hold a bag, bottle, phone, or laptop clearly in view. Small or hidden items may be missed.' : 'Detected items will appear here.'}</p>
        )}
      </section> : null}

      <div className="rail-note">
        <strong>What triggers an alert?</strong>
        <p>{trainedFight ? 'The fight-trained video model checks overlapping live windows. Two consecutive windows above its decision threshold raise a review. This does not establish contact or intent.' : "Conflict analysis looks for repeated fast arm extensions toward another person's upper body. It does not establish contact or intent."}</p>
        {showObjects ? <p>Object alerts cover a watched item moving or leaving view, an unattended bag, or a repeated restricted-object observation.</p> : null}
        <p>Sports, play, and occlusion can cause mistakes. Every alert needs a person to check the scene.</p>
      </div>
    </aside>
  )
}
