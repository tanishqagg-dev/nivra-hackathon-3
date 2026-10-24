import type {
  NormalizedBox,
  ObjectObservation,
  ObjectRole,
} from '../types/vision'

const TRACK_EXPIRY_MS = 1_000
const OBJECT_EXPIRY_MS = 1_400
const CARRIER_CONFIRM_MS = 240
const MAX_OBSERVATION_GAP_MS = 1_000
const DETECTOR_DROPOUT_TOLERANCE_MS = 400
const EVENT_COOLDOWN_MS = 5_000
const REVIEW_HOLD_MS = 3_500

export interface SceneEngineSettings {
  unattendedSeconds: number
  restrictedConfirmMs: number
}

export const DEFAULT_SCENE_SETTINGS: Readonly<SceneEngineSettings> = Object.freeze({
  unattendedSeconds: 5,
  restrictedConfirmMs: 700,
})

interface Point {
  x: number
  y: number
}

interface BaseTrack {
  id: string
  label: string
  box: NormalizedBox
  score: number
  firstSeenMs: number
  lastSeenMs: number
  matchedThisFrame: boolean
}

interface PersonTrack extends BaseTrack {}

interface ObjectTrack extends BaseTrack {
  displayName: string
  role: Exclude<ObjectRole, 'person'>
  speed: number
  missedSinceMs: number | null
  previousCenter: Point | null
  carrierId: string | null
  carrierSinceMs: number | null
  pendingCarrierId: string | null | undefined
  pendingCarrierSinceMs: number | null
  pendingCarrierOrigin: Point | null
  pendingCarrierPeakSpeed: number
  lastCarrierId: string | null
  lastCarrierStableMs: number
  separationOrigin: Point | null
  separatedSinceMs: number | null
  unattendedSinceMs: number | null
  unattendedOrigin: Point | null
  unattendedAlerted: boolean
  restrictedSinceMs: number | null
  restrictedFrames: number
  restrictedAlerted: boolean
  reviewUntilMs: number
}

export type SceneObjectStatus =
  | 'observed'
  | 'carried'
  | 'separated'
  | 'unattended'
  | 'review'

export interface SceneObject {
  trackKey: string
  label: string
  displayName: string
  role: Exclude<ObjectRole, 'person'>
  score: number
  box: NormalizedBox
  status: SceneObjectStatus
  reviewProgress?: number
  reviewHint?: string
}

export interface InventoryItem {
  key: string
  label: string
  displayName: string
  role: Exclude<ObjectRole, 'person'>
  count: number
  score: number
  status: SceneObjectStatus
}

export type ReviewEventType =
  | 'rapid-transfer'
  | 'unattended-bag'
  | 'restricted-object'
  | 'watched-item'
  | 'physical-conflict'

export interface SceneWatch {
  trackKey: string
  displayName: string
  box: NormalizedBox
  state: 'watching' | 'moved' | 'missing'
  progress: number
}

interface WatchState {
  track: ObjectTrack
  baseline: NormalizedBox
  movementSinceMs: number | null
  movementFrames: number
  missingSinceMs: number | null
  missingFrames: number
  lastUpdateMs: number
  state: SceneWatch['state']
  progress: number
}

export interface ReviewEvent {
  id: string
  type: ReviewEventType
  title: string
  detail: string
  objectName: string
  occurredAtMs: number
}

export interface SceneSnapshot {
  timestampMs: number
  objects: SceneObject[]
  inventory: InventoryItem[]
  events: ReviewEvent[]
  watch: SceneWatch | null
}

export const EMPTY_SCENE: SceneSnapshot = {
  timestampMs: 0,
  objects: [],
  inventory: [],
  events: [],
  watch: null,
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value))
}

function center(box: NormalizedBox): Point {
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  }
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function intersectionOverUnion(a: NormalizedBox, b: NormalizedBox): number {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top)
  const union = a.width * a.height + b.width * b.height - intersection
  return union > 0 ? intersection / union : 0
}

function expanded(box: NormalizedBox, ratio: number, minimum: number): NormalizedBox {
  const addX = Math.max(box.width * ratio, minimum)
  const addY = Math.max(box.height * ratio, minimum)
  return {
    x: clamp(box.x - addX),
    y: clamp(box.y - addY),
    width: clamp(box.width + addX * 2, 0, 1),
    height: clamp(box.height + addY * 2, 0, 1),
  }
}

function contains(box: NormalizedBox, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  )
}

function matchScore(track: BaseTrack, observation: ObjectObservation): number | null {
  if (track.label !== observation.label) return null
  const overlap = intersectionOverUnion(track.box, observation.box)
  const distance = pointDistance(center(track.box), center(observation.box))
  const diagonal = Math.hypot(track.box.width, track.box.height)
  const trackScale =
    observation.role === 'person'
      ? Math.max(0.18, diagonal * 0.7)
      : Math.max(0.4, diagonal * 1.5)
  if (overlap < 0.04 && distance > trackScale) return null
  return overlap * 2.2 - distance
}

function statusPriority(status: SceneObjectStatus): number {
  return {
    observed: 0,
    carried: 1,
    separated: 2,
    unattended: 3,
    review: 4,
  }[status]
}

export class SceneEngine {
  private personSequence = 0
  private objectSequence = 0
  private eventSequence = 0
  private people = new Map<string, PersonTrack>()
  private objects = new Map<string, ObjectTrack>()
  private events: ReviewEvent[] = []
  private lastEventAt = new Map<string, number>()
  private lastObservationMs = Number.NEGATIVE_INFINITY
  private settings: SceneEngineSettings
  private watched: WatchState | null = null
  private pausedAtMs: number | null = null

  constructor(settings: Partial<SceneEngineSettings> = {}) {
    this.settings = { ...DEFAULT_SCENE_SETTINGS }
    this.configure(settings)
  }

  configure(settings: Partial<SceneEngineSettings>): void {
    if (Number.isFinite(settings.unattendedSeconds)) {
      this.settings.unattendedSeconds = clamp(settings.unattendedSeconds!, 2, 60)
    }
    if (Number.isFinite(settings.restrictedConfirmMs)) {
      this.settings.restrictedConfirmMs = clamp(settings.restrictedConfirmMs!, 700, 5_000)
    }
  }

  update(timestampMs: number, observations: ObjectObservation[]): SceneSnapshot {
    if (this.pausedAtMs !== null) return this.snapshot(this.pausedAtMs)
    if (!Number.isFinite(timestampMs) || timestampMs <= this.lastObservationMs) {
      return this.snapshot(this.lastObservationMs === Number.NEGATIVE_INFINITY ? 0 : this.lastObservationMs)
    }
    this.lastObservationMs = timestampMs
    // Expire before matching so a detection after a long pause cannot revive old evidence.
    this.expireTracks(timestampMs)
    const people = observations.filter((observation) => observation.role === 'person')
    const objects = observations.filter(
      (observation): observation is ObjectObservation & {
        role: Exclude<ObjectRole, 'person'>
      } => observation.role !== 'person',
    )

    this.updatePeople(timestampMs, people)
    this.updateObjects(timestampMs, objects)
    this.updateWatch(timestampMs)
    this.expireTracks(timestampMs)

    return this.snapshot(timestampMs)
  }

  snapshot(timestampMs: number): SceneSnapshot {
    timestampMs = this.pausedAtMs ?? timestampMs
    this.expireTracks(timestampMs)

    const visibleObjects = [...this.objects.values()]
      .filter((track) => timestampMs - track.lastSeenMs <= OBJECT_EXPIRY_MS)
      .map((track) => this.toSceneObject(track, timestampMs))
      .sort((a, b) => {
        const statusDifference = statusPriority(b.status) - statusPriority(a.status)
        return statusDifference || b.score - a.score
      })

    return {
      timestampMs,
      objects: visibleObjects,
      inventory: this.toInventory(visibleObjects),
      events: [...this.events],
      watch: this.watched ? {
        trackKey: this.watched.track.id,
        displayName: this.watched.track.displayName,
        box: { ...this.watched.baseline },
        state: this.watched.state,
        progress: this.watched.progress,
      } : null,
    }
  }

  pause(timestampMs: number): SceneSnapshot {
    if (this.pausedAtMs === null && Number.isFinite(timestampMs)) {
      this.pausedAtMs = Math.max(timestampMs, this.lastObservationMs)
    }
    return this.snapshot(this.pausedAtMs ?? (Number.isFinite(this.lastObservationMs) ? this.lastObservationMs : 0))
  }

  resume(timestampMs: number): SceneSnapshot {
    if (this.pausedAtMs === null) return this.snapshot(timestampMs)
    if (!Number.isFinite(timestampMs) || timestampMs < this.pausedAtMs) return this.snapshot(this.pausedAtMs)
    const pausedDurationMs = timestampMs - this.pausedAtMs
    for (const person of this.people.values()) {
      person.firstSeenMs += pausedDurationMs
      person.lastSeenMs += pausedDurationMs
    }
    for (const track of this.objects.values()) {
      track.firstSeenMs += pausedDurationMs
      track.lastSeenMs += pausedDurationMs
      track.reviewUntilMs += pausedDurationMs
      track.missedSinceMs = null
      this.clearEvidence(track)
    }
    for (const [key, lastEventMs] of this.lastEventAt) {
      this.lastEventAt.set(key, lastEventMs + pausedDurationMs)
    }
    this.lastObservationMs += pausedDurationMs
    if (this.watched?.state === 'watching') {
      this.watched.movementSinceMs = null
      this.watched.movementFrames = 0
      this.watched.missingSinceMs = timestampMs
      this.watched.missingFrames = 0
      this.watched.lastUpdateMs = timestampMs
      this.watched.progress = 0
    }
    this.pausedAtMs = null
    return this.snapshot(timestampMs)
  }

  watchObject(trackKey: string): boolean {
    const track = this.objects.get(trackKey)
    if (!track || !track.matchedThisFrame || this.lastObservationMs - track.lastSeenMs > MAX_OBSERVATION_GAP_MS) return false
    this.watched = {
      track,
      baseline: { ...track.box },
      movementSinceMs: null,
      movementFrames: 0,
      missingSinceMs: null,
      missingFrames: 0,
      lastUpdateMs: this.lastObservationMs,
      state: 'watching',
      progress: 0,
    }
    // Rearming is an explicit operator action and starts a new alert episode.
    this.lastEventAt.delete(`watched-item:${track.id}`)
    return true
  }

  clearWatch(): void {
    this.watched = null
  }

  private updateWatch(timestampMs: number): void {
    const watched = this.watched
    if (!watched || watched.state !== 'watching') return
    const track = watched.track
    if (timestampMs - watched.lastUpdateMs > MAX_OBSERVATION_GAP_MS) {
      watched.movementSinceMs = null
      watched.movementFrames = 0
      watched.missingSinceMs = timestampMs
      watched.missingFrames = 0
    }
    watched.lastUpdateMs = timestampMs
    const currentlyObserved = this.objects.has(track.id) && track.matchedThisFrame
    if (!currentlyObserved) {
      watched.movementSinceMs = null
      watched.movementFrames = 0
      watched.missingSinceMs ??= track.lastSeenMs
      watched.missingFrames += 1
      watched.progress = Math.min(clamp((timestampMs - watched.missingSinceMs) / 1_800), clamp(watched.missingFrames / 3))
      if (watched.progress < 1) return
      watched.state = 'missing'
      this.addEvent(track, timestampMs, 'watched-item', 'Watched item left view',
        `${track.displayName} has not been detected for 1.8 seconds. It may have moved or become hidden. Check the camera view.`)
      return
    }

    watched.missingSinceMs = null
    watched.missingFrames = 0

    const threshold = Math.max(0.065, Math.hypot(watched.baseline.width, watched.baseline.height) * 0.4)
    const displacement = pointDistance(center(track.box), center(watched.baseline))
    if (displacement <= threshold) {
      watched.movementSinceMs = null
      watched.movementFrames = 0
      watched.progress = 0
      return
    }

    watched.movementSinceMs ??= timestampMs
    watched.movementFrames += 1
    watched.progress = Math.min(clamp((timestampMs - watched.movementSinceMs) / 500), clamp(watched.movementFrames / 3))
    if (watched.progress < 1) return
    watched.state = 'moved'
    this.addEvent(track, timestampMs, 'watched-item', 'Watched item moved',
      `${track.displayName} moved away from the position you selected and stayed there across multiple frames. Check who moved it.`)
    track.reviewUntilMs = timestampMs + REVIEW_HOLD_MS
  }

  reset(): void {
    this.personSequence = 0
    this.objectSequence = 0
    this.people.clear()
    this.objects.clear()
    this.events = []
    this.lastEventAt.clear()
    this.lastObservationMs = Number.NEGATIVE_INFINITY
    this.watched = null
    this.pausedAtMs = null
  }

  private updatePeople(timestampMs: number, observations: ObjectObservation[]): void {
    for (const track of this.people.values()) track.matchedThisFrame = false
    const unmatched = new Set(this.people.keys())

    for (const observation of observations) {
      const track = this.bestMatch(unmatched, this.people, observation)
      if (track) {
        track.box = observation.box
        track.score = observation.score
        track.lastSeenMs = timestampMs
        track.matchedThisFrame = true
        unmatched.delete(track.id)
        continue
      }

      const id = `person-${++this.personSequence}`
      this.people.set(id, {
        id,
        label: observation.label,
        box: observation.box,
        score: observation.score,
        firstSeenMs: timestampMs,
        lastSeenMs: timestampMs,
        matchedThisFrame: true,
      })
    }
  }

  private updateObjects(
    timestampMs: number,
    observations: Array<ObjectObservation & { role: Exclude<ObjectRole, 'person'> }>,
  ): void {
    for (const track of this.objects.values()) track.matchedThisFrame = false
    const unmatched = new Set(this.objects.keys())

    for (const observation of observations) {
      let track = this.bestMatch(unmatched, this.objects, observation)
      if (track) {
        const elapsedMs = Math.max(1, timestampMs - track.lastSeenMs)
        const hadDropout = track.missedSinceMs !== null
        const evidenceExpired = elapsedMs >= MAX_OBSERVATION_GAP_MS ||
          (hadDropout && elapsedMs > DETECTOR_DROPOUT_TOLERANCE_MS)
        if (evidenceExpired) this.clearEvidence(track)
        else if (hadDropout) this.pauseEvidence(track, elapsedMs)
        track.missedSinceMs = null
        track.previousCenter = center(track.box)
        const instantSpeed =
          (pointDistance(center(track.box), center(observation.box)) / elapsedMs) * 1_000
        track.speed = evidenceExpired || hadDropout
          ? 0
          : track.speed * 0.62 + instantSpeed * 0.38
        track.box = observation.box
        track.score = observation.score
        track.lastSeenMs = timestampMs
        track.matchedThisFrame = true
        unmatched.delete(track.id)
      } else {
        const id = `object-${++this.objectSequence}`
        track = {
          id,
          label: observation.label,
          displayName: observation.displayName,
          role: observation.role,
          box: observation.box,
          score: observation.score,
          firstSeenMs: timestampMs,
          lastSeenMs: timestampMs,
          matchedThisFrame: true,
          speed: 0,
          missedSinceMs: null,
          previousCenter: null,
          carrierId: null,
          carrierSinceMs: null,
          pendingCarrierId: undefined,
          pendingCarrierSinceMs: null,
          pendingCarrierOrigin: null,
          pendingCarrierPeakSpeed: 0,
          lastCarrierId: null,
          lastCarrierStableMs: 0,
          separationOrigin: null,
          separatedSinceMs: null,
          unattendedSinceMs: null,
          unattendedOrigin: null,
          unattendedAlerted: false,
          restrictedSinceMs: null,
          restrictedFrames: 0,
          restrictedAlerted: false,
          reviewUntilMs: Number.NEGATIVE_INFINITY,
        }
        this.objects.set(id, track)
      }

      this.updateObjectState(track, timestampMs)
    }

    for (const id of unmatched) {
      const track = this.objects.get(id)
      if (!track) continue
      track.missedSinceMs ??= track.lastSeenMs
      if (timestampMs - track.lastSeenMs > DETECTOR_DROPOUT_TOLERANCE_MS) this.clearEvidence(track)
    }
  }

  private pauseEvidence(track: ObjectTrack, missingMs: number): void {
    // Shift the start time so a short detector dropout preserves progress but
    // contributes no time toward an alert. Snapshots freeze at lastSeenMs too.
    if (track.unattendedSinceMs !== null) track.unattendedSinceMs += missingMs
    if (track.restrictedSinceMs !== null) track.restrictedSinceMs += missingMs
    if (track.carrierSinceMs !== null) track.carrierSinceMs += missingMs
    if (track.separatedSinceMs !== null) track.separatedSinceMs += missingMs
    track.pendingCarrierId = undefined
    track.pendingCarrierSinceMs = null
    track.pendingCarrierOrigin = null
    track.pendingCarrierPeakSpeed = 0
  }

  private clearEvidence(track: ObjectTrack): void {
    track.speed = 0
    track.previousCenter = null
    track.carrierId = null
    track.carrierSinceMs = null
    track.pendingCarrierId = undefined
    track.pendingCarrierSinceMs = null
    track.pendingCarrierOrigin = null
    track.pendingCarrierPeakSpeed = 0
    track.lastCarrierId = null
    track.lastCarrierStableMs = 0
    track.separationOrigin = null
    track.separatedSinceMs = null
    track.unattendedSinceMs = null
    track.unattendedOrigin = null
    track.restrictedSinceMs = null
    track.restrictedFrames = 0
    // Keep fired-event latches through brief detector dropouts. They rearm when
    // the bag is attended again, or the object leaves long enough to expire.
  }

  private updateObjectState(track: ObjectTrack, timestampMs: number): void {
    const proposedCarrier = this.findCarrier(track.box, track.carrierId)
    if (proposedCarrier !== undefined) this.updateCarrier(track, proposedCarrier, timestampMs)
    else {
      track.pendingCarrierId = undefined
      track.pendingCarrierSinceMs = null
      track.pendingCarrierOrigin = null
      track.pendingCarrierPeakSpeed = 0
    }

    if (track.role === 'bag' && track.carrierId === null) {
      const personNearby = this.hasNearbyPerson(track.box)
      if (personNearby) {
        track.unattendedSinceMs = null
        track.unattendedOrigin = null
        track.unattendedAlerted = false
      } else if (
        track.speed > 0.25 ||
        (track.unattendedOrigin && pointDistance(center(track.box), track.unattendedOrigin) > 0.06)
      ) {
        track.unattendedSinceMs = null
        track.unattendedOrigin = null
      } else if (track.unattendedSinceMs === null) {
        track.unattendedSinceMs = timestampMs
        track.unattendedOrigin = center(track.box)
      } else if (
        !track.unattendedAlerted &&
        timestampMs - track.unattendedSinceMs >= this.settings.unattendedSeconds * 1_000
      ) {
        if (
          this.addEvent(
            track,
            timestampMs,
            'unattended-bag',
            'Unattended bag observed',
            `${track.displayName} stayed in place with no person detected nearby for ${this.settings.unattendedSeconds} seconds. Check whether someone is attending it outside the camera view.`,
          )
        ) {
          track.reviewUntilMs = timestampMs + REVIEW_HOLD_MS
          track.unattendedAlerted = true
        }
      }
    } else {
      track.unattendedSinceMs = null
      track.unattendedOrigin = null
      track.unattendedAlerted = false
    }

    if (track.role === 'restricted') {
      track.restrictedSinceMs ??= timestampMs
      track.restrictedFrames += 1
      if (
        !track.restrictedAlerted && track.restrictedFrames >= 3 &&
        timestampMs - track.restrictedSinceMs >= this.settings.restrictedConfirmMs
      ) {
        if (
          this.addEvent(
            track,
            timestampMs,
            'restricted-object',
            'Restricted object observed',
            `${track.displayName} remained visible across multiple frames. Confirm context before any action.`,
          )
        ) {
          track.reviewUntilMs = timestampMs + REVIEW_HOLD_MS
          track.restrictedAlerted = true
        }
      }
    }

    if (
      track.role === 'bag' &&
      track.carrierId === null &&
      track.separatedSinceMs !== null &&
      track.separationOrigin &&
      track.lastCarrierStableMs >= 900 &&
      timestampMs - track.separatedSinceMs >= 280 &&
      timestampMs - track.separatedSinceMs <= 2_000 &&
      track.speed >= 0.3 &&
      pointDistance(center(track.box), track.separationOrigin) >= 0.07
    ) {
      if (
        this.addEvent(
          track,
          timestampMs,
          'rapid-transfer',
          'Possible rapid bag removal',
          `${track.displayName} moved quickly after separating from a person. Review the transition; intent is not inferred.`,
        )
      ) {
        track.reviewUntilMs = timestampMs + REVIEW_HOLD_MS
      }
    }
  }

  private updateCarrier(
    track: ObjectTrack,
    proposedCarrierId: string | null,
    timestampMs: number,
  ): void {
    if (proposedCarrierId === track.carrierId) {
      track.pendingCarrierId = undefined
      track.pendingCarrierSinceMs = null
      track.pendingCarrierOrigin = null
      track.pendingCarrierPeakSpeed = 0
      if (proposedCarrierId !== null) {
        track.separatedSinceMs = null
        track.unattendedSinceMs = null
      }
      return
    }

    if (track.pendingCarrierId !== proposedCarrierId) {
      track.pendingCarrierId = proposedCarrierId
      track.pendingCarrierSinceMs = timestampMs
      track.pendingCarrierOrigin = track.previousCenter ?? center(track.box)
      track.pendingCarrierPeakSpeed = track.speed
      return
    }

    track.pendingCarrierPeakSpeed = Math.max(track.pendingCarrierPeakSpeed, track.speed)

    if (
      track.pendingCarrierSinceMs === null ||
      timestampMs - track.pendingCarrierSinceMs < CARRIER_CONFIRM_MS
    ) {
      return
    }

    const previousCarrierId = track.carrierId
    const previousStableMs =
      previousCarrierId !== null && track.carrierSinceMs !== null
        ? track.pendingCarrierSinceMs - track.carrierSinceMs
        : track.lastCarrierStableMs
    const movedDuringTransition = track.pendingCarrierOrigin !== null &&
      pointDistance(track.pendingCarrierOrigin, center(track.box)) >= 0.08
    const rapidTransition = movedDuringTransition && track.pendingCarrierPeakSpeed >= 0.18

    if (previousCarrierId !== null && proposedCarrierId === null) {
      track.lastCarrierId = previousCarrierId
      track.lastCarrierStableMs = previousStableMs
      track.separatedSinceMs = timestampMs
      track.separationOrigin = track.pendingCarrierOrigin ?? center(track.box)
    }

    if (
      proposedCarrierId !== null &&
      track.lastCarrierId !== null &&
      proposedCarrierId !== track.lastCarrierId &&
      track.separatedSinceMs !== null &&
      timestampMs - track.separatedSinceMs <= 1_800 &&
      track.lastCarrierStableMs >= 900 &&
      rapidTransition
    ) {
      if (
        this.addEvent(
          track,
          timestampMs,
          'rapid-transfer',
          'Possible rapid object transfer',
          `${track.displayName} changed person association after fast movement. Review the handoff; intent is not inferred.`,
        )
      ) {
        track.reviewUntilMs = timestampMs + REVIEW_HOLD_MS
      }
    } else if (
      previousCarrierId !== null &&
      proposedCarrierId !== null &&
      previousCarrierId !== proposedCarrierId &&
      previousStableMs >= 900 &&
      rapidTransition
    ) {
      if (
        this.addEvent(
          track,
          timestampMs,
          'rapid-transfer',
          'Possible rapid object transfer',
          `${track.displayName} changed person association after fast movement. Review the handoff; intent is not inferred.`,
        )
      ) {
        track.reviewUntilMs = timestampMs + REVIEW_HOLD_MS
      }
    }

    track.carrierId = proposedCarrierId
    track.carrierSinceMs = proposedCarrierId === null ? null : timestampMs
    if (proposedCarrierId !== null) {
      track.separatedSinceMs = null
      track.unattendedSinceMs = null
    }
    track.pendingCarrierId = undefined
    track.pendingCarrierSinceMs = null
    track.pendingCarrierOrigin = null
    track.pendingCarrierPeakSpeed = 0
  }

  private findCarrier(box: NormalizedBox, currentId: string | null): string | null | undefined {
    const objectCenter = center(box)
    const candidates: Array<{ id: string; distance: number }> = []

    for (const person of this.people.values()) {
      if (!person.matchedThisFrame) continue
      const interactionArea = expanded(person.box, 0.24, 0.065)
      if (!contains(interactionArea, objectCenter)) continue
      const distance = pointDistance(center(person.box), objectCenter)
      candidates.push({ id: person.id, distance })
    }

    candidates.sort((a, b) => a.distance - b.distance)
    if (!candidates.length) return null
    const current = candidates.find((candidate) => candidate.id === currentId)
    if (current && current.distance <= candidates[0].distance + 0.05) return current.id
    if (candidates[1] && candidates[1].distance - candidates[0].distance < 0.04) return undefined
    return candidates[0].id
  }

  private hasNearbyPerson(box: NormalizedBox): boolean {
    const objectCenter = center(box)
    for (const person of this.people.values()) {
      if (!person.matchedThisFrame) continue
      if (contains(expanded(person.box, 0.5, 0.14), objectCenter)) return true
    }
    return false
  }

  private bestMatch<T extends BaseTrack>(
    unmatched: Set<string>,
    tracks: Map<string, T>,
    observation: ObjectObservation,
  ): T | null {
    let best: { track: T; score: number } | null = null
    for (const id of unmatched) {
      const track = tracks.get(id)
      if (!track) continue
      if (
        this.watched?.state === 'watching' && this.watched.track.id === track.id &&
        this.lastObservationMs - track.lastSeenMs > DETECTOR_DROPOUT_TOLERANCE_MS
      ) {
        // After a long dropout, only reacquire at the last observed position.
        // A different item of the same class elsewhere must not inherit a watch.
        const radius = Math.max(0.035, Math.hypot(track.box.width, track.box.height) * 0.25)
        if (
          intersectionOverUnion(track.box, observation.box) < 0.35 ||
          pointDistance(center(track.box), center(observation.box)) > radius
        ) continue
      }
      const score = matchScore(track, observation)
      if (score === null) continue
      if (!best || score > best.score) best = { track, score }
    }
    return best?.track ?? null
  }

  private addEvent(
    track: ObjectTrack,
    timestampMs: number,
    type: ReviewEventType,
    title: string,
    detail: string,
  ): boolean {
    const cooldownKey = `${type}:${track.id}`
    const previous = this.lastEventAt.get(cooldownKey) ?? Number.NEGATIVE_INFINITY
    if (timestampMs - previous < EVENT_COOLDOWN_MS) return false

    this.lastEventAt.set(cooldownKey, timestampMs)
    this.events = [
      {
        id: `event-${++this.eventSequence}`,
        type,
        title,
        detail,
        objectName: track.displayName,
        occurredAtMs: timestampMs,
      },
      ...this.events,
    ].slice(0, 6)
    return true
  }

  private expireTracks(timestampMs: number): void {
    for (const [id, track] of this.people) {
      if (timestampMs - track.lastSeenMs > TRACK_EXPIRY_MS) this.people.delete(id)
    }
    for (const [id, track] of this.objects) {
      // Keep the selected track available for conservative reacquisition while
      // absence is still being confirmed. Hidden tracks are not rendered.
      if (this.watched?.track.id === id && this.watched.state === 'watching') continue
      if (timestampMs - track.lastSeenMs > OBJECT_EXPIRY_MS) this.objects.delete(id)
    }
  }

  private toSceneObject(track: ObjectTrack, timestampMs: number): SceneObject {
    let status: SceneObjectStatus = 'observed'
    if (track.carrierId !== null) status = 'carried'
    else if (track.separatedSinceMs !== null) status = 'separated'
    if (
      track.role === 'bag' &&
      track.unattendedSinceMs !== null &&
      track.unattendedAlerted
    ) {
      status = 'unattended'
    }
    if (timestampMs <= track.reviewUntilMs) status = 'review'

    let reviewProgress: number | undefined
    let reviewHint: string | undefined
    if (track.role === 'bag' && track.unattendedSinceMs !== null && !track.unattendedAlerted) {
      reviewProgress = clamp((track.lastSeenMs - track.unattendedSinceMs) / (this.settings.unattendedSeconds * 1_000))
      reviewHint = `Checking unattended bag · ${this.settings.unattendedSeconds}s required`
    } else if (track.role === 'restricted' && track.restrictedSinceMs !== null && !track.restrictedAlerted) {
      reviewProgress = Math.min(clamp((track.lastSeenMs - track.restrictedSinceMs) / this.settings.restrictedConfirmMs), clamp(track.restrictedFrames / 3))
      reviewHint = 'Confirming object across frames'
    }

    return {
      trackKey: track.id,
      label: track.label,
      displayName: track.displayName,
      role: track.role,
      score: track.score,
      box: track.box,
      status,
      ...(reviewProgress !== undefined ? { reviewProgress, reviewHint } : {}),
    }
  }

  private toInventory(objects: SceneObject[]): InventoryItem[] {
    const inventory = new Map<string, InventoryItem>()
    for (const object of objects) {
      const existing = inventory.get(object.label)
      if (!existing) {
        inventory.set(object.label, {
          key: object.label,
          label: object.label,
          displayName: object.displayName,
          role: object.role,
          count: 1,
          score: object.score,
          status: object.status,
        })
        continue
      }
      existing.count += 1
      existing.score = Math.max(existing.score, object.score)
      if (statusPriority(object.status) > statusPriority(existing.status)) {
        existing.status = object.status
      }
    }
    return [...inventory.values()].sort((a, b) => {
      const statusDifference = statusPriority(b.status) - statusPriority(a.status)
      return statusDifference || a.displayName.localeCompare(b.displayName)
    })
  }
}
