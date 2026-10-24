import type { PoseLandmarks } from '../types/vision'

type Track = { landmarks: PoseLandmarks; center: { x: number; y: number }; lastSeen: number }

const TORSO = [11, 12, 23, 24]
const HOLD_MS = 350
const MATCH_DISTANCE = 0.22
const ALPHA = 0.55

function center(pose: PoseLandmarks) {
  const points = TORSO.map(index => pose[index]).filter(point => point && (point.visibility ?? 1) > 0.3)
  const source = points.length >= 2 ? points : pose
  const sum = source.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), { x: 0, y: 0 })
  return { x: sum.x / source.length, y: sum.y / source.length }
}

/**
 * Display-only smoothing. Matches each pose to the nearest previous person, blends
 * landmarks to remove jitter, and holds a person briefly through single missed frames
 * so skeletons do not flicker. Detection logic keeps using the raw poses.
 */
export class PoseSmoother {
  private tracks: Track[] = []

  reset() { this.tracks = [] }

  update(poses: PoseLandmarks[], now: number): PoseLandmarks[] {
    const unmatched = new Set(this.tracks.map((_, index) => index))
    const next: Track[] = []
    for (const pose of poses) {
      if (!pose.length) continue
      const at = center(pose)
      let best = -1, bestDistance = MATCH_DISTANCE
      for (const index of unmatched) {
        const track = this.tracks[index]
        const distance = Math.hypot(track.center.x - at.x, track.center.y - at.y)
        if (distance < bestDistance) { best = index; bestDistance = distance }
      }
      if (best >= 0 && this.tracks[best].landmarks.length === pose.length) {
        unmatched.delete(best)
        const previous = this.tracks[best].landmarks
        const landmarks = pose.map((point, index) => ({
          ...point,
          x: previous[index].x + ALPHA * (point.x - previous[index].x),
          y: previous[index].y + ALPHA * (point.y - previous[index].y),
          z: previous[index].z + ALPHA * (point.z - previous[index].z),
        }))
        next.push({ landmarks, center: center(landmarks), lastSeen: now })
      } else {
        next.push({ landmarks: pose, center: at, lastSeen: now })
      }
    }
    for (const index of unmatched) {
      if (now - this.tracks[index].lastSeen <= HOLD_MS) next.push(this.tracks[index])
    }
    this.tracks = next
    return next.map(track => track.landmarks)
  }
}
