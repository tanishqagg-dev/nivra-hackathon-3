import type { useVisionSession } from '../hooks/useVisionSession'
import type { PoseQuality } from '../types/vision'
import { sensitivityText } from '../lib/sensitivity'

type Session = ReturnType<typeof useVisionSession>
type Props = {
  session: Session
  clipLocked: boolean
  simulated: boolean
}

const LEVELS = [
  { at: 0, label: 'Careful' }, { at: 0.25, label: 'Balanced' }, { at: 0.5, label: 'Sensitive' }, { at: 0.75, label: 'High' }, { at: 1, label: 'Maximum' },
]

export function DetectionSettings({ session, clipLocked, simulated }: Props) {
  const { vision } = session
  const power = session.detectionPower
  const level = sensitivityText(power)
  return (
    <div className="detection-settings">
      <div className="sensitivity">
        <label className="field-label" htmlFor="detection-power">
          <span>Detection sensitivity</span>
          <output>{level.name} · {Math.round(power * 100)}%</output>
        </label>
        <input id="detection-power" type="range" min="0" max="1" step="0.05" value={power} aria-label="Detection sensitivity"
          aria-valuetext={`${level.name}, ${Math.round(power * 100)} percent`}
          onChange={event => session.setDetectionPower(Number(event.target.value))}
          style={{ ['--fill' as string]: `${power * 100}%` }} />
        <div className="sensitivity-stops" aria-hidden="true">
          {LEVELS.map(stop => (
            <button key={stop.label} type="button" tabIndex={-1} className={Math.abs(power - stop.at) < 0.13 ? 'is-near' : ''} onClick={() => session.setDetectionPower(stop.at)}>{stop.label}</button>
          ))}
        </div>
        <p className="sensitivity-detail">{level.detail} Live cameras use this. MediaPipe pose runs on this Mac.</p>
      </div>
      <div className="field-grid is-three">
        <label className="field" htmlFor="pose-quality">
          <span className="field-label">Pose model</span>
          <select id="pose-quality" aria-label="Pose model" value={vision.quality} disabled={vision.status === 'loading'} onChange={event => vision.setQuality(event.target.value as PoseQuality)}>
            <option value="full">Full · more detail</option>
            <option value="lite">Lite · faster</option>
          </select>
          <small>Reloads analysis. The camera stays open.</small>
        </label>
        <label className="field" htmlFor="max-poses">
          <span className="field-label">People limit</span>
          <select id="max-poses" aria-label="People limit" value={session.maxPoses} onChange={event => session.setMaxPoses(Number(event.target.value))}>
            {[2, 4, 6, 8].map(count => <option key={count} value={count}>{count} people</option>)}
          </select>
          <small>A higher limit uses more processing time.</small>
        </label>
        <label className="field" htmlFor="pose-confidence">
          <span className="field-label">Pose confidence <output>{Math.round(session.poseConfidence * 100)}%</output></span>
          <input id="pose-confidence" type="range" min="0.35" max="0.7" step="0.05" value={session.poseConfidence} onChange={event => session.setPoseConfidence(Number(event.target.value))}
            style={{ ['--fill' as string]: `${(session.poseConfidence - 0.35) / 0.35 * 100}%` }} />
          <small>Lower it to recover weak detections. May add false poses.</small>
        </label>
      </div>
      <p className="field-note">{vision.quality === 'full' ? 'Full model with up to 960 px input. Switch to Lite if motion analysis is slow.' : 'Lite model with up to 640 px input. Switch to Full for the larger landmark model.'} Both run on this Mac.</p>
      <div className="field-grid">
        <label className="field" htmlFor="clip-mode">
          <span className="field-label">Video analysis</span>
          <select id="clip-mode" aria-label="Video analysis" value={session.clipMode} disabled={clipLocked} onChange={event => session.setClipMode(event.target.value as 'review' | 'realtime')}>
            <option value="review">Review scan · wait for every sample</option>
            <option value="realtime">Real-time playback · skip busy frames</option>
          </select>
          <small>{clipLocked ? 'Stop the clip before changing mode.' : 'Video files only. Live cameras stay real-time.'}</small>
        </label>
        <label className="field" htmlFor="clip-sensitivity">
          <span className="field-label">Video review sensitivity</span>
          <select id="clip-sensitivity" aria-label="Video review sensitivity" value={session.clipSensitivity} disabled={clipLocked} onChange={event => session.setClipSensitivity(event.target.value as 'instant' | 'early' | 'standard')}>
            <option value="instant">Instant · 1 clear arm-motion episode</option>
            <option value="early">Early · 2 clear arm-motion episodes</option>
            <option value="standard">Standard · 3 clear arm-motion episodes</option>
          </select>
          <small>Instant and Early can flag sparring or play. Live cameras use Instant.</small>
        </label>
      </div>
      <dl className="model-facts">
        <div><dt>Pose runtime</dt><dd>{simulated ? 'Simulated' : vision.delegates?.pose ?? 'Loading'}</dd></div>
        <div><dt>Landmarks</dt><dd>33 per pose</dd></div>
      </dl>
    </div>
  )
}
