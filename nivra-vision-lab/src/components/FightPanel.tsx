import type { FightState } from '../hooks/useFightDetector'
import { FIGHT_FRAMES } from '../lib/fightDecision'
import './ConflictPanel.css'

const LABELS: Record<FightState['status'], string> = {
  connecting: 'Connecting to fight model', ready: 'Fight model ready', warming: 'Collecting live video',
  clear: 'No fight pattern', observing: 'Checking possible fight', alert: 'Possible fight · review now', error: 'Fight analysis unavailable',
}

export function FightPanel({ state, active, onRetry }: { state: FightState; active: boolean; onRetry(): void }) {
  return (
    <section className={`conflict-panel conflict-is-${state.status}`} aria-labelledby="fight-heading">
      <div className="conflict-heading">
        <div><h2 id="fight-heading">Fight detection</h2><p>X3D-M video models + ViT appearance</p></div>
        <span className="conflict-simulated">Local model</span>
      </div>
      <div className="conflict-state" aria-live="polite" aria-atomic="true">
        <span className="conflict-dot" aria-hidden="true" />
        <strong data-testid="fight-status">{LABELS[state.status]}</strong>
      </div>
      <p className="conflict-explanation">{state.message}</p>
      {active ? <div className={`conflict-confirmation ${state.samples < FIGHT_FRAMES && state.status !== 'error' ? '' : 'is-reserved'}`}>
        <div className="conflict-progress-label"><span>Building a video window</span><span>{state.samples} / {FIGHT_FRAMES} frames</span></div>
        <progress className="conflict-progress" max={FIGHT_FRAMES} value={state.samples} aria-label="Video window preparation" />
      </div> : null}
      <dl className="pose-coverage" aria-label="Fight model diagnostics">
        <div><dt>Fast video score</dt><dd data-testid="fight-score">{state.prediction ? `${(state.prediction.score * 100).toFixed(1)}%` : '—'}</dd></div>
        <div><dt>Long video score</dt><dd>{typeof state.prediction?.scores?.temporal === 'number' ? `${(state.prediction.scores.temporal * 100).toFixed(1)}%` : '—'}</dd></div>
        <div><dt>Appearance score</dt><dd>{state.prediction?.scores ? `${(state.prediction.scores.visual * 100).toFixed(1)}%` : '—'}</dd></div>
        <div><dt>Positive windows</dt><dd data-testid="fight-streak">{Math.min(2, state.streak)} / 2</dd></div>
        <div><dt>Model agreement</dt><dd data-testid="fight-agreement">{state.prediction?.agreement ? `${state.prediction.agreement.votes} / ${state.prediction.agreement.required} required` : '—'}</dd></div>
        <div><dt>Inference time</dt><dd data-testid="fight-latency">{state.prediction ? `${Math.round(state.prediction.inferenceMs)} ms` : '—'}</dd></div>
        <div><dt>Runtime</dt><dd>{state.device?.toUpperCase() ?? 'Connecting'}</dd></div>
      </dl>
      {active ? <ul className="conflict-signals is-stable" aria-label="Models above threshold">
        {(state.prediction?.triggers ?? []).map(name => <li key={name}><span aria-hidden="true" />{name === 'fast' ? 'Fast video model' : name === 'temporal' ? 'Longer video model' : 'Appearance model'} above threshold</li>)}
      </ul> : null}
      {state.status === 'error' ? <button type="button" className="secondary-action" onClick={onRetry}>Retry fight model</button> : null}
      <p className="conflict-framing">Two models must agree in two consecutive video windows before an alert. Keep the interaction clearly visible. Analysis starts after about four seconds. Model scores are not measured accuracy.</p>
      <p className={`conflict-review-note ${state.status === 'alert' ? '' : 'is-reserved'}`} aria-hidden={state.status === 'alert' ? undefined : true}>Review the interaction before responding. Sports and play can also trigger alerts.</p>
      <p className="partial-body-note">Camera windows stay on this Mac. No cloud inference or recording.</p>
    </section>
  )
}
