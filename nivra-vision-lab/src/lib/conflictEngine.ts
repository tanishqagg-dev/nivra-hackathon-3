import type { ReviewEvent } from './sceneEngine'
import type { NormalizedBox, PoseLandmark, PoseLandmarks } from '../types/vision'

const VISIBILITY = 0.55
const MAX_GAP_MS = 600
const TRACK_RETENTION_MS = 2_000
const MIN_SAMPLE_MS = 35
const WARMUP_MS = 400
const PULSE_WINDOW_MS = 5_000
const MIN_PULSE_INTERVAL_MS = 300
const ARM_REFRACTORY_MS = 450
const QUIET_REARM_MS = 2_500
const EVENT_COOLDOWN_MS = 8_000
const ALERT_HOLD_MS = 4_000

type Point = { x: number; y: number }
type ArmName = 'left' | 'right'
export type ConflictStatus = 'warming' | 'clear' | 'observing' | 'alert' | 'limited'
export type ConflictSensitivity = 'instant' | 'early' | 'standard'

export interface ConflictDiagnostics {
  detectedPoses: number
  usablePeople: number
  upperBodyOnlyPeople: number
  visibleArms: number
  usableArms: number
  nearbyPairs: number
  requiredPulses: number
  reason: 'no-poses' | 'shoulders-hidden' | 'single-person' | 'arms-hidden' | 'too-far' | 'warming' | 'ready' | 'stale'
}

const EMPTY_DIAGNOSTICS: ConflictDiagnostics = {
  detectedPoses: 0, usablePeople: 0, upperBodyOnlyPeople: 0, visibleArms: 0,
  usableArms: 0, nearbyPairs: 0, requiredPulses: 3, reason: 'no-poses',
}

export interface ConflictSnapshot {
  status: ConflictStatus
  people: number
  progress: number
  signals: string[]
  explanation: string
  events: ReviewEvent[]
  regions: NormalizedBox[]
  diagnostics: ConflictDiagnostics
}

export const EMPTY_CONFLICT: ConflictSnapshot = {
  status: 'warming', people: 0, progress: 0, signals: [],
  explanation: 'Waiting for two people with visible upper bodies.',
  events: [], regions: [],
  diagnostics: { ...EMPTY_DIAGNOSTICS },
}

interface Arm {
  shoulder: Point
  wrist: Point
  relative: Point
  extension: number
  angle: number | null
  quality: 'complete' | 'wrist-only'
}

interface Body {
  center: Point
  upper: Point
  scale: number
  box: NormalizedBox
  arms: Partial<Record<ArmName, Arm>>
  torso: Point[]
  shoulder: Point
  shoulderWidth: number
  inferredTorso: boolean
  torsoDirection: Point
}

interface BodyTrack {
  id: number
  body: Body
  previous: Body | null
  firstSeenMs: number
  lastSeenMs: number
  previousMs: number
  seen: boolean
  samples: number
  scaleToShoulder: number | null
}

interface ArmCycle {
  restExtension: number
  peakExtension: number
  armed: boolean
  lastPulseMs: number
  bentApproachMs: number | null
  bentPeakExtension: number
}

interface PairState {
  ids: [number, number]
  arms: Map<string, ArmCycle>
  pulses: number[]
  lastPulseMs: number
  lastSeenMs: number
  lastEventMs: number
  alerted: boolean
  regions: NormalizedBox[]
  lastWristOnlyPulseMs: number
  requiredPulses: number
  warmed: boolean
  usableArms: boolean
}

function subtract(a: Point, b: Point): Point { return { x: a.x - b.x, y: a.y - b.y } }
function length(point: Point): number { return Math.hypot(point.x, point.y) }
function distance(a: Point, b: Point): number { return length(subtract(a, b)) }
function midpoint(a: Point, b: Point): Point { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
function clamp(value: number): number { return Math.max(0, Math.min(1, value)) }
function dot(a: Point, b: Point): number { return a.x * b.x + a.y * b.y }

function inFrame(point: PoseLandmark, tolerance = 0.02): boolean {
  return point.x >= -tolerance && point.x <= 1 + tolerance && point.y >= -tolerance && point.y <= 1 + tolerance
}

function visible(point: PoseLandmark | undefined): point is PoseLandmark {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    inFrame(point) &&
    (point.visibility ?? 1) >= VISIBILITY && (point.presence ?? 1) >= VISIBILITY
}

function extractBody(pose: PoseLandmarks, aspect: number): Body | null {
  if (![11, 12].every(index => visible(pose[index]))) return null
  const point = (index: number): Point => ({ x: pose[index].x * aspect, y: pose[index].y })
  const shoulder = midpoint(point(11), point(12))
  const shoulderWidth = distance(point(11), point(12))
  const inferredTorso = ![23, 24].every(index => visible(pose[index]) && inFrame(pose[index], 0))
  // Profile shoulders can overlap in the image. A visible torso still provides
  // body size; projected shoulder width is needed only when the hips are hidden.
  if (shoulderWidth > 0.8 || (inferredTorso && shoulderWidth < 0.055)) return null
  const shoulderAxis = subtract(point(12), point(11))
  const directionSign = shoulderAxis.x < 0 ? -1 : 1
  const inferredDirection = { x: -shoulderAxis.y / Math.max(shoulderWidth, 1e-6) * directionSign,
    y: shoulderAxis.x / Math.max(shoulderWidth, 1e-6) * directionSign }
  // This is a body-size estimate, not a reconstructed hip landmark. Per-track
  // calibration replaces it if this person previously had a visible torso.
  const estimatedScale = shoulderWidth * 1.2
  const hip = inferredTorso
    ? { x: shoulder.x + inferredDirection.x * estimatedScale, y: shoulder.y + inferredDirection.y * estimatedScale }
    : midpoint(point(23), point(24))
  const scale = Math.max(distance(shoulder, hip), shoulderWidth * 0.8)
  if (scale < 0.07 || scale > 1) return null
  const torsoAxis = subtract(hip, shoulder)
  const torsoLength = length(torsoAxis)
  const torsoDirection = { x: torsoAxis.x / Math.max(torsoLength, 1e-6), y: torsoAxis.y / Math.max(torsoLength, 1e-6) }
  const arms: Body['arms'] = {}
  for (const [name, shoulderIndex, elbowIndex, wristIndex] of [
    ['left', 11, 13, 15], ['right', 12, 14, 16],
  ] as const) {
    if (![shoulderIndex, wristIndex].every(index => visible(pose[index]))) continue
    const origin = point(shoulderIndex)
    const wrist = point(wristIndex)
    const relative = subtract(wrist, origin)
    const extension = length(relative) / scale
    if (extension > 2.5 || extension < 0.08) continue
    if (!visible(pose[elbowIndex])) {
      arms[name] = { shoulder: origin, wrist, relative, extension, angle: null, quality: 'wrist-only' }
      continue
    }
    const elbow = point(elbowIndex)
    const upperArm = distance(origin, elbow) / scale
    const forearm = distance(elbow, wrist) / scale
    if (upperArm < 0.12 || upperArm > 1.4 || forearm < 0.12 || forearm > 1.4) continue
    const first = subtract(origin, elbow)
    const second = subtract(wrist, elbow)
    const cosine = Math.max(-1, Math.min(1, dot(first, second) / (length(first) * length(second))))
    arms[name] = { shoulder: origin, wrist, relative, extension, angle: Math.acos(cosine) * 180 / Math.PI, quality: 'complete' }
  }
  const points = pose.filter(visible)
  const left = clamp(Math.min(...points.map(p => p.x)))
  const top = clamp(Math.min(...points.map(p => p.y)))
  const right = clamp(Math.max(...points.map(p => p.x)))
  const bottom = clamp(Math.max(...points.map(p => p.y)))
  return {
    center: midpoint(shoulder, hip),
    upper: { x: shoulder.x * 0.78 + hip.x * 0.22, y: shoulder.y * 0.78 + hip.y * 0.22 },
    scale, arms, box: { x: left, y: top, width: right - left, height: bottom - top },
    torso: [point(11), point(12)],
    shoulder, shoulderWidth, inferredTorso, torsoDirection,
  }
}

function calibrateBody(body: Body, ratio: number | null): Body {
  if (!body.inferredTorso || ratio === null) return body
  const scale = body.shoulderWidth * ratio
  const hip = { x: body.shoulder.x + body.torsoDirection.x * scale, y: body.shoulder.y + body.torsoDirection.y * scale }
  const arms: Body['arms'] = {}
  for (const name of ['left', 'right'] as const) {
    const arm = body.arms[name]
    if (arm) arms[name] = { ...arm, extension: length(arm.relative) / scale }
  }
  return { ...body, scale, arms, center: midpoint(body.shoulder, hip),
    upper: { x: body.shoulder.x * .78 + hip.x * .22, y: body.shoulder.y * .78 + hip.y * .22 } }
}

function deduplicateBodies(bodies: Body[]): Body[] {
  const distinct: Body[] = []
  for (const body of bodies) {
    const duplicate = distinct.findIndex(other => {
      const scale = (body.scale + other.scale) / 2
      const sizeRatio = !body.inferredTorso && !other.inferredTorso
        ? body.scale / other.scale : body.shoulderWidth / other.shoulderWidth
      return distance(body.shoulder, other.shoulder) < scale * 0.35 &&
        Math.abs(sizeRatio - 1) < 0.25 &&
        body.torso.every((point, index) => distance(point, other.torso[index]) < scale * 0.25)
    })
    if (duplicate < 0) distinct.push(body)
    else if (Object.keys(body.arms).length > Object.keys(distinct[duplicate].arms).length) distinct[duplicate] = body
  }
  return distinct
}

function shoulderCalibration(body: Body): number | null {
  // Do not learn a frontal shoulder-to-torso ratio from a foreshortened profile.
  if (body.inferredTorso || body.shoulderWidth < Math.max(0.055, body.scale * 0.45)) return null
  return Math.max(0.8, Math.min(2.2, body.scale / body.shoulderWidth))
}

/** Observable 2D arm-motion rules. This is not a trained fight classifier. */
export class ConflictEngine {
  private tracks = new Map<number, BodyTrack>()
  private pairs = new Map<string, PairState>()
  private sequence = 0
  private eventSequence = 0
  private lastUpdateMs = Number.NEGATIVE_INFINITY
  private lastSnapshotMs = Number.NEGATIVE_INFINITY
  private lastAspect = 16 / 9
  private events: ReviewEvent[] = []
  private current: ConflictSnapshot = { ...EMPTY_CONFLICT }
  private lastAlertAtMs = Number.NEGATIVE_INFINITY
  private sensitivity: ConflictSensitivity = 'standard'
  /** Live-camera sensitivity from 0 (careful) to 1 (maximum). Null uses the named sensitivity only. */
  private power: number | null = null

  configureSensitivity(sensitivity: ConflictSensitivity): void {
    if (sensitivity === this.sensitivity) return
    this.sensitivity = sensitivity
    this.resetMotion()
  }

  /**
   * 0-0.19 needs 3 strikes, 0.2-0.39 needs 2, 0.4 and up needs 1. Above 0.6 the motion thresholds
   * relax step by step (slower, less direct, shorter reaches count) up to maximum at 1.
   */
  configurePower(power: number | null): void {
    const next = power === null || !Number.isFinite(power) ? null : clamp(power)
    if (next === this.power) return
    this.power = next
    this.resetMotion()
  }

  /** 0 at default thresholds, 1 at maximum sensitivity. */
  private relax(): number { return this.power === null ? 0 : clamp((this.power - 0.6) / 0.4) }

  private completePulseCount(): number {
    if (this.power !== null) return this.power < 0.2 ? 3 : this.power < 0.4 ? 2 : 1
    return this.sensitivity === 'instant' ? 1 : this.sensitivity === 'early' ? 2 : 3
  }

  update(timestampMs: number, poses: PoseLandmarks[], aspectRatio = 16 / 9): ConflictSnapshot {
    if (!Number.isFinite(timestampMs) || timestampMs <= this.lastUpdateMs) return this.snapshot(this.lastUpdateMs)
    const aspect = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 16 / 9
    const gap = timestampMs - this.lastUpdateMs
    if (gap < MIN_SAMPLE_MS) return this.snapshot(timestampMs)
    if (gap > MAX_GAP_MS || Math.abs(aspect - this.lastAspect) > 0.05) {
      this.tracks.clear()
      this.pairs.clear()
    }
    this.lastUpdateMs = timestampMs
    this.lastAspect = aspect
    const bodies = deduplicateBodies(poses.map(pose => extractBody(pose, aspect)).filter((body): body is Body => body !== null))
    this.matchBodies(bodies, timestampMs)
    const available = [...this.tracks.values()].filter(track => track.seen)
    let nearestPair: PairState | null = null
    let strongest: PairState | null = null
    let nearbyPairs = 0

    for (let first = 0; first < available.length; first += 1) {
      for (let second = first + 1; second < available.length; second += 1) {
        const a = available[first]
        const b = available[second]
        const scale = (a.body.scale + b.body.scale) / 2
        if (distance(a.body.center, b.body.center) > scale * 3.4 ||
          Math.abs(a.body.center.y - b.body.center.y) > scale * 1.15 ||
          Math.max(a.body.scale, b.body.scale) / Math.min(a.body.scale, b.body.scale) > 1.8) continue
        nearbyPairs += 1
        const key = [a.id, b.id].sort((x, y) => x - y).join(':')
        let pair = this.pairs.get(key)
        if (!pair) {
          pair = { ids: [a.id, b.id], arms: new Map(), pulses: [], lastPulseMs: Number.NEGATIVE_INFINITY,
            lastSeenMs: timestampMs, lastEventMs: Number.NEGATIVE_INFINITY, alerted: false, regions: [],
            lastWristOnlyPulseMs: Number.NEGATIVE_INFINITY, requiredPulses: this.completePulseCount(), warmed: false, usableArms: false }
          this.pairs.set(key, pair)
        }
        pair.lastSeenMs = timestampMs
        pair.regions = [a.body.box, b.body.box]
        pair.pulses = pair.pulses.filter(time => timestampMs - time <= PULSE_WINDOW_MS)
        if (pair.alerted && timestampMs - pair.lastPulseMs > QUIET_REARM_MS) {
          pair.alerted = false
          pair.pulses = []
          pair.lastWristOnlyPulseMs = Number.NEGATIVE_INFINITY
        }
        nearestPair ??= pair
        const pairWarm = [a, b].every(track => track.samples >= 3 && timestampMs - track.firstSeenMs >=
          (track.body.inferredTorso ? 600 : WARMUP_MS))
        pair.warmed = pairWarm
        pair.usableArms = [a, b].some(track => Object.keys(track.body.arms).length > 0)
        // Cycles are initialized during warmup so held-out arms do not count as a thrust.
        const firstPulse = this.observeArms(pair, a, b, timestampMs, pairWarm)
        const secondPulse = this.observeArms(pair, b, a, timestampMs, pairWarm)
        const pulsed = firstPulse || secondPulse
        if (pulsed && timestampMs - pair.lastPulseMs >= MIN_PULSE_INTERVAL_MS) {
          pair.pulses.push(timestampMs)
          pair.lastPulseMs = timestampMs
          if (firstPulse !== 1 && secondPulse !== 1) pair.lastWristOnlyPulseMs = timestampMs
        }
        // Instant mode alerts on the first directed thrust, including wrist-only ones.
        pair.requiredPulses = this.completePulseCount() > 1 && timestampMs - pair.lastWristOnlyPulseMs <= PULSE_WINDOW_MS ? 4 : this.completePulseCount()
        if (!strongest || pair.pulses.length > strongest.pulses.length) strongest = pair
        const repeated = pair.pulses.length >= pair.requiredPulses && (pair.requiredPulses === 1 || timestampMs - pair.pulses[0] >=
          (pair.requiredPulses === 4 ? 1_200 : 800))
        if (repeated && pairWarm && pair.lastPulseMs === timestampMs && !pair.alerted && timestampMs - pair.lastEventMs >= EVENT_COOLDOWN_MS &&
          timestampMs - this.lastAlertAtMs >= EVENT_COOLDOWN_MS) {
          pair.alerted = true
          pair.lastEventMs = timestampMs
          this.lastAlertAtMs = timestampMs
          const event: ReviewEvent = { id: `conflict-${++this.eventSequence}`, type: 'physical-conflict',
            title: 'Possible physical conflict', objectName: 'Two-person interaction', occurredAtMs: timestampMs,
            detail: `${pair.requiredPulses === 1 ? 'A fast arm-motion episode toward another person\'s upper body was' : `${pair.requiredPulses} distinct fast arm-motion episodes toward another person's upper body were`} observed. A person must review the interaction before responding.`,
          }
          this.events = [event, ...this.events].slice(0, 6)
        }
      }
    }
    for (const [key, pair] of this.pairs) {
      if (timestampMs - pair.lastSeenMs > TRACK_RETENTION_MS || pair.ids.some(id => !this.tracks.has(id))) this.pairs.delete(key)
    }

    const selected = strongest ?? nearestPair
    const recentAlert = selected && (
      timestampMs - selected.lastEventMs <= ALERT_HOLD_MS ||
      (selected.alerted && timestampMs - selected.lastPulseMs < QUIET_REARM_MS)
    )
    const pulses = selected?.pulses.length ?? 0
    const requiredPulses = selected?.requiredPulses ?? this.completePulseCount()
    const people = available.length
    const upperBodyOnlyPeople = available.filter(track => track.body.inferredTorso).length
    const allArms = available.flatMap(track => Object.values(track.body.arms))
    const diagnostics: ConflictDiagnostics = {
      detectedPoses: poses.length, usablePeople: people, upperBodyOnlyPeople,
      visibleArms: allArms.filter(arm => arm.quality === 'complete').length,
      usableArms: allArms.length, nearbyPairs, requiredPulses, reason: 'ready',
    }
    let status: ConflictStatus = 'clear'
    let explanation = 'No repeated directed arm motion observed.'
    let signals: string[] = []
    if (people < 2) {
      status = 'limited'
      if (!poses.length) {
        diagnostics.reason = 'no-poses'
        explanation = 'No body landmarks yet. Keep two people inside the camera view.'
        signals = ['No people located by the pose model']
      } else if (!people) {
        diagnostics.reason = 'shoulders-hidden'
        explanation = 'The model sees a body, but both shoulders are not reliable. Move back or turn slightly toward the camera.'
        signals = [`${poses.length} pose observation${poses.length === 1 ? '' : 's'}`, 'Shoulder framing needs attention']
      } else {
        diagnostics.reason = 'single-person'
        explanation = poses.length > 1
          ? 'Only one distinct upper body is reliable. Keep the second person\'s shoulders inside the camera view.'
          : 'One person is visible. A second person is required to assess an interaction.'
        signals = ['One usable upper body', 'Waiting for a second person']
      }
    } else if (!selected) {
      diagnostics.reason = 'too-far'
      explanation = 'People are visible but too far apart, or at different depths, for an arm interaction.'
      signals = [`${people} usable upper bodies`, 'No nearby pair']
    }
    else if (recentAlert) {
      status = 'alert'
      explanation = 'Repeated directed arm motion needs a person to review the scene.'
      signals = ['Two nearby people', 'Repeated directed arm thrusts', 'Extension and retraction observed']
    } else if (!selected.usableArms) {
      status = 'limited'
      diagnostics.reason = 'arms-hidden'
      explanation = 'Upper bodies are visible but wrists are hidden or unreliable. Keep hands inside the frame.'
      signals = ['Two nearby people', 'No usable wrist motion']
    } else if (!selected.warmed) {
      status = 'warming'
      diagnostics.reason = 'warming'
      explanation = 'Establishing upper-body motion over several frames.'
    } else if (pulses > 0) {
      status = 'observing'
      explanation = 'A directed arm movement was seen. Waiting for repeated motion.'
      signals = ['Two nearby people', `${Math.min(requiredPulses, pulses)} of ${requiredPulses} directed motion pulses`]
    } else signals = ['Two nearby people', 'No repeated directed arm motion']
    if (upperBodyOnlyPeople && people >= 2) signals.push('Upper-body framing supported')
    if (diagnostics.usableArms > diagnostics.visibleArms) signals.push('Some elbows are hidden; wrist-only motion needs extra confirmation')
    this.current = { status, people, progress: recentAlert ? 1 : Math.min(1, pulses / requiredPulses), signals, explanation,
      events: [...this.events], regions: selected?.regions ?? [], diagnostics }
    return this.snapshot(timestampMs)
  }

  snapshot(timestampMs: number): ConflictSnapshot {
    timestampMs = Math.max(Number.isFinite(timestampMs) ? timestampMs : 0, this.lastSnapshotMs)
    this.lastSnapshotMs = timestampMs
    if (Number.isFinite(timestampMs) && timestampMs - this.lastUpdateMs > MAX_GAP_MS) {
      return { status: 'limited', people: 0, progress: 0, signals: [],
        explanation: 'Waiting for fresh upper-body observations.', events: [...this.events], regions: [],
        diagnostics: { ...EMPTY_DIAGNOSTICS, requiredPulses: this.completePulseCount(), reason: 'stale' } }
    }
    return { ...this.current, signals: [...this.current.signals], events: [...this.events], regions: [...this.current.regions],
      diagnostics: { ...this.current.diagnostics } }
  }

  reset(): void {
    this.tracks.clear()
    this.pairs.clear()
    this.events = []
    this.sequence = 0
    this.lastUpdateMs = Number.NEGATIVE_INFINITY
    this.lastSnapshotMs = Number.NEGATIVE_INFINITY
    this.lastAlertAtMs = Number.NEGATIVE_INFINITY
    this.current = { ...EMPTY_CONFLICT, diagnostics: { ...EMPTY_DIAGNOSTICS, requiredPulses: this.completePulseCount() } }
  }

  resetMotion(): void {
    this.tracks.clear()
    this.pairs.clear()
    this.lastUpdateMs = Number.NEGATIVE_INFINITY
    this.lastSnapshotMs = Number.NEGATIVE_INFINITY
    this.current = { ...EMPTY_CONFLICT, events: [...this.events],
      diagnostics: { ...EMPTY_DIAGNOSTICS, requiredPulses: this.completePulseCount(), reason: 'warming' } }
  }

  private matchBodies(bodies: Body[], timestampMs: number): void {
    for (const track of this.tracks.values()) track.seen = false
    const candidates: Array<{ track: BodyTrack; index: number; cost: number; rejoining: boolean }> = []
    for (const track of this.tracks.values()) {
      const elapsed = timestampMs - track.lastSeenMs
      if (elapsed > TRACK_RETENTION_MS) continue
      bodies.forEach((body, index) => {
        const bothTorsosVisible = !body.inferredTorso && !track.body.inferredTorso
        const ratio = bothTorsosVisible ? body.scale / track.body.scale : body.shoulderWidth / track.body.shoulderWidth
        const scale = Math.max(body.scale, track.body.scale)
        const cost = distance(body.shoulder, track.body.shoulder) / scale
        const rejoining = elapsed > MAX_GAP_MS
        const eligible = rejoining
          ? bothTorsosVisible && cost < 0.4 && distance(body.center, track.body.center) / scale < 0.4 && ratio >= 0.8 && ratio <= 1.25
          : cost <= 1.15 && ratio >= 0.65 && ratio <= 1.5
        if (eligible) candidates.push({ track, index, cost: cost + Math.abs(Math.log(ratio)), rejoining })
      })
    }
    // Returning observations are anonymous spatial matches, not persistent IDs.
    // If another body or track is a plausible match, discard the old evidence.
    const ambiguous = new Set<number>()
    for (const candidate of candidates) {
      if (!candidate.rejoining) continue
      if (candidates.some(other => other !== candidate && (
        other.track.id === candidate.track.id ||
        (other.index === candidate.index && other.cost <= candidate.cost + 0.25)
      ))) ambiguous.add(candidate.track.id)
    }
    for (const id of ambiguous) {
      this.tracks.delete(id)
      for (const [key, pair] of this.pairs) if (pair.ids.includes(id)) this.pairs.delete(key)
    }
    candidates.sort((a, b) => a.cost - b.cost)
    const used = new Set<number>()
    for (const { track, index } of candidates) {
      if (!this.tracks.has(track.id) || track.seen || used.has(index)) continue
      const continuous = timestampMs - track.lastSeenMs <= MAX_GAP_MS
      track.previous = continuous ? track.body : null
      track.previousMs = continuous ? track.lastSeenMs : timestampMs
      if (!continuous) {
        track.firstSeenMs = timestampMs
        track.samples = 0
        for (const pair of this.pairs.values()) if (pair.ids.includes(track.id)) pair.arms.clear()
      }
      const observed = bodies[index]
      track.body = calibrateBody(observed, track.scaleToShoulder)
      const ratio = shoulderCalibration(observed)
      if (ratio !== null) {
        track.scaleToShoulder = track.scaleToShoulder === null ? ratio : track.scaleToShoulder * .85 + ratio * .15
      }
      track.lastSeenMs = timestampMs
      track.seen = true
      track.samples += 1
      used.add(index)
    }
    bodies.forEach((body, index) => {
      if (used.has(index)) return
      const id = ++this.sequence
      this.tracks.set(id, { id, body, previous: null, firstSeenMs: timestampMs, lastSeenMs: timestampMs,
        previousMs: timestampMs, seen: true, samples: 1,
        scaleToShoulder: shoulderCalibration(body) })
    })
    for (const [id, track] of this.tracks) if (timestampMs - track.lastSeenMs > TRACK_RETENTION_MS) this.tracks.delete(id)
  }

  private observeArms(pair: PairState, actor: BodyTrack, target: BodyTrack, timestampMs: number, warm: boolean): number {
    let pulse = 0
    for (const name of ['left', 'right'] as const) {
      const arm = actor.body.arms[name]
      const before = actor.previous?.arms[name]
      const key = `${actor.id}:${name}`
      if (!arm || !before) { pair.arms.delete(key); continue }
      let cycle = pair.arms.get(key)
      if (!cycle) {
        cycle = { restExtension: before.extension, peakExtension: before.extension, armed: true,
          lastPulseMs: Number.NEGATIVE_INFINITY, bentApproachMs: null, bentPeakExtension: 0 }
        pair.arms.set(key, cycle)
      }
      const elapsedSeconds = (timestampMs - actor.previousMs) / 1_000
      const scale = (actor.body.scale + (actor.previous?.scale ?? actor.body.scale)) / 2
      // Shoulder-relative velocity cancels the person's translation and common camera panning.
      const relativeDelta = subtract(arm.relative, before.relative)
      const displacement = length(relativeDelta) / scale
      const speed = displacement / elapsedSeconds
      const scaleChange = Math.abs(actor.body.scale / (actor.previous?.scale ?? actor.body.scale) - 1)
      if (displacement > 1.75 || speed > 14 || scaleChange > 0.2) {
        pair.arms.delete(key)
        continue
      }
      if (cycle.bentApproachMs !== null) cycle.bentPeakExtension = Math.max(cycle.bentPeakExtension, arm.extension)
      cycle.peakExtension = Math.max(cycle.peakExtension, arm.extension)
      if (!cycle.armed && cycle.peakExtension - arm.extension >= 0.25 && timestampMs - cycle.lastPulseMs >= ARM_REFRACTORY_MS) {
        cycle.armed = true
        cycle.restExtension = arm.extension
        cycle.peakExtension = arm.extension
      }
      if (cycle.armed) cycle.restExtension = Math.min(cycle.restExtension, arm.extension)
      const previousWrist = { x: arm.shoulder.x + before.relative.x, y: arm.shoulder.y + before.relative.y }
      const towardTarget = subtract(target.body.upper, previousWrist)
      const direction = dot(relativeDelta, towardTarget) / Math.max(1e-6, length(relativeDelta) * length(towardTarget))
      const segmentFraction = clamp(dot(towardTarget, relativeDelta) / Math.max(1e-6, dot(relativeDelta, relativeDelta)))
      const closestWrist = {
        x: previousWrist.x + relativeDelta.x * segmentFraction,
        y: previousWrist.y + relativeDelta.y * segmentFraction,
      }
      // A fast extension can pass the upper body between pose samples. Test its
      // swept path, with the same jump gate above and a bounded end position.
      const relax = this.relax()
      const reachesUpperBody = distance(target.body.upper, closestWrist) <= target.body.scale * 0.95 * (1 + 0.35 * relax) &&
        distance(target.body.upper, arm.wrist) <= target.body.scale * 1.3 * (1 + 0.3 * relax)
      const wristOnly = arm.quality === 'wrist-only'
      // At 25 Hz, the same extension is split into smaller steps than at 7 Hz.
      // Scale the per-step floor only; cumulative reach and speed gates remain.
      const extending = arm.extension - before.extension >= Math.min(0.08, elapsedSeconds * 0.8) &&
        arm.extension - cycle.restExtension >= (wristOnly ? .4 : .28) * (1 - 0.3 * relax)
      // A bent elbow is common in close-range motion and perspective projection.
      // It needs a faster, more directed approach plus an observed withdrawal;
      // a single bent-arm reach is not a completed pulse.
      if (cycle.bentApproachMs !== null) {
        const age = timestampMs - cycle.bentApproachMs
        if (age > 700) cycle.bentApproachMs = null
        else if (!wristOnly && cycle.bentPeakExtension - arm.extension >= 0.25 &&
          speed >= 0.8 && direction <= -0.4) {
          pulse = 1
          cycle.bentApproachMs = null
        }
      }
      if (warm && cycle.armed && timestampMs - cycle.lastPulseMs >= ARM_REFRACTORY_MS - 150 * relax &&
        speed >= (wristOnly ? 1.5 : 1.2) * (1 - 0.35 * relax) && direction >= (wristOnly ? .75 : .65) - 0.15 * relax && reachesUpperBody &&
        extending && arm.extension >= 0.65 - 0.1 * relax && (arm.angle === null || arm.angle >= 115 - 15 * relax)) {
        pulse = wristOnly && pulse !== 1 ? 2 : 1
        cycle.armed = false
        cycle.lastPulseMs = timestampMs
        cycle.peakExtension = arm.extension
      } else if (warm && cycle.armed && !wristOnly && arm.angle !== null && arm.angle >= 50 && arm.angle < 115 &&
        timestampMs - cycle.lastPulseMs >= ARM_REFRACTORY_MS &&
        speed >= 1.8 * (1 - 0.3 * relax) && direction >= (this.sensitivity === 'early' ? 0.75 : 0.8) - 0.1 * relax && reachesUpperBody &&
        arm.extension >= 0.55 && arm.extension - before.extension >= Math.min(0.1, elapsedSeconds) && arm.extension - cycle.restExtension >= 0.3) {
        cycle.armed = false
        cycle.lastPulseMs = timestampMs
        cycle.peakExtension = arm.extension
        cycle.bentApproachMs = timestampMs
        cycle.bentPeakExtension = arm.extension
      }
    }
    return pulse
  }
}
