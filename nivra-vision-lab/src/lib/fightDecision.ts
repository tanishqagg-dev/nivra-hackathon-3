import type { ReviewEvent } from './sceneEngine'

export const FIGHT_THRESHOLD = 0.4
export const FIGHT_FRAMES = 32
export const FIGHT_WINDOW_MS = 3_875
export const FIGHT_SAMPLE_MS = 125
export const FIGHT_STRIDE_MS = 1_000

export interface FightPrediction {
  score: number
  threshold: number
  inferenceMs: number
  aboveThreshold: boolean
  scores?: { fast: number; temporal: number | null; visual: number }
  agreement?: { votes: number; required: number }
  triggers?: string[]
}

/** Session-local confirmation; overlapping windows are evidence, not independent votes. */
export class FightDecision {
  private streak = 0
  private lastWindow = -Infinity
  private lastAlert = -Infinity
  private armed = true
  private quietWindows = 0

  reset() {
    this.streak = 0
    this.lastWindow = -Infinity
    this.lastAlert = -Infinity
    this.armed = true
    this.quietWindows = 0
  }

  update(score: number, windowEnd: number, positive = score >= FIGHT_THRESHOLD): { streak: number; event: ReviewEvent | null } {
    if (!Number.isFinite(score) || score < 0 || score > 1 || !Number.isFinite(windowEnd) || windowEnd <= this.lastWindow) {
      throw new Error('Invalid or out-of-order fight prediction')
    }
    if (windowEnd - this.lastWindow > 5_000) this.streak = 0
    this.lastWindow = windowEnd
    this.streak = positive ? this.streak + 1 : 0
    this.quietWindows = positive ? 0 : this.quietWindows + 1
    if (this.quietWindows >= 2) this.armed = true
    if (!this.armed || this.streak < 2 || windowEnd - this.lastAlert < 8_000) {
      return { streak: this.streak, event: null }
    }
    this.armed = false
    this.lastAlert = windowEnd
    return { streak: this.streak, event: {
      id: `x3d-${Math.round(windowEnd)}`,
      type: 'physical-conflict',
      title: 'Possible fight · review now',
      objectName: 'Video action pattern',
      detail: 'The local detector flagged two consecutive video windows. Check the scene before responding.',
      occurredAtMs: windowEnd,
    } }
  }
}
