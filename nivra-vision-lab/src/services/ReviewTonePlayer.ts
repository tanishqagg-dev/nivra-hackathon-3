import type { ReviewEventType } from '../lib/sceneEngine'

export interface ToneStep {
  frequencyHz: number
  durationMs: number
  gapMs: number
}

const REVIEW_TONE_PATTERNS: Record<ReviewEventType, readonly ToneStep[]> = {
  'physical-conflict': [
    { frequencyHz: 740, durationMs: 140, gapMs: 60 },
    { frequencyHz: 980, durationMs: 180, gapMs: 60 },
    { frequencyHz: 740, durationMs: 220, gapMs: 0 },
  ],
  'rapid-transfer': [
    { frequencyHz: 720, durationMs: 105, gapMs: 45 },
    { frequencyHz: 940, durationMs: 130, gapMs: 0 },
  ],
  'unattended-bag': [
    { frequencyHz: 520, durationMs: 130, gapMs: 70 },
    { frequencyHz: 680, durationMs: 150, gapMs: 0 },
  ],
  'restricted-object': [
    { frequencyHz: 680, durationMs: 90, gapMs: 42 },
    { frequencyHz: 880, durationMs: 105, gapMs: 42 },
    { frequencyHz: 680, durationMs: 125, gapMs: 0 },
  ],
  'watched-item': [
    { frequencyHz: 640, durationMs: 160, gapMs: 65 },
    { frequencyHz: 920, durationMs: 230, gapMs: 0 },
  ],
}

const PREVIEW_PATTERN = REVIEW_TONE_PATTERNS['watched-item']

export function tonePatternFor(type: ReviewEventType): readonly ToneStep[] {
  return REVIEW_TONE_PATTERNS[type]
}

type WebkitAudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext
}

export type ReviewAudioState = 'idle' | 'ready' | 'blocked' | 'unsupported' | 'disposed'

interface ToneNodes {
  oscillator: OscillatorNode | null
  envelope: GainNode | null
}

export class ReviewTonePlayer {
  private context: AudioContext | null = null
  private state: ReviewAudioState = 'idle'
  private generation = 0
  private activeTones = new Set<ToneNodes>()
  private pendingResume: {
    promise: Promise<boolean>
    cancel: () => void
  } | null = null

  getState(): ReviewAudioState {
    if (this.state === 'disposed') return 'disposed'
    if (this.context?.state === 'running') return this.state === 'blocked' ? 'blocked' : 'ready'
    if (this.context) return 'blocked'
    return this.state
  }

  async prime(): Promise<boolean> {
    const generation = this.generation
    const context = this.getContext()
    if (!context) return false
    const ready = await this.ensureRunning(context)
    return ready && generation === this.generation
  }

  play(type: ReviewEventType): Promise<boolean> {
    return this.playPattern(tonePatternFor(type), 0.13)
  }

  playPreview(): Promise<boolean> {
    return this.playPattern(PREVIEW_PATTERN, 0.13)
  }

  stop(): void {
    this.generation += 1
    this.pendingResume?.cancel()
    for (const nodes of [...this.activeTones]) {
      try {
        nodes.oscillator?.stop()
      } catch {
        // A partially constructed or already ended oscillator cannot be stopped.
      }
      this.release(nodes)
    }
  }

  dispose(): void {
    this.stop()
    const context = this.context
    this.context = null
    this.state = 'disposed'
    if (context && context.state !== 'closed') {
      try {
        void context.close().catch(() => undefined)
      } catch {
        // Disposal must also work if the browser has already torn down audio.
      }
    }
  }

  private getContext(): AudioContext | null {
    if (this.state === 'disposed') return null
    if (this.context && this.context.state !== 'closed') return this.context
    if (typeof window === 'undefined') {
      this.state = 'unsupported'
      return null
    }

    const AudioContextConstructor =
      window.AudioContext ?? (window as WebkitAudioWindow).webkitAudioContext
    if (!AudioContextConstructor) {
      this.state = 'unsupported'
      return null
    }

    try {
      this.context = new AudioContextConstructor()
      return this.context
    } catch {
      this.state = 'blocked'
      return null
    }
  }

  private ensureRunning(context: AudioContext): Promise<boolean> {
    if (context.state === 'running') {
      this.state = 'ready'
      return Promise.resolve(true)
    }
    if (this.pendingResume) return this.pendingResume.promise

    this.state = 'blocked'
    let settle!: (ready: boolean) => void
    const promise = new Promise<boolean>((resolve) => { settle = resolve })
    let settled = false
    const finish = (resumed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (this.pendingResume?.promise === promise) this.pendingResume = null
      const ready = resumed && this.context === context && context.state === 'running'
      if (this.state !== 'disposed') this.state = ready ? 'ready' : 'blocked'
      settle(ready)
    }
    // Some browsers leave resume pending when autoplay is blocked.
    const timeout = setTimeout(() => finish(false), 1_500)
    this.pendingResume = { promise, cancel: () => finish(false) }
    try {
      // Call resume before yielding so a camera or sound-button gesture unlocks it.
      void context.resume().then(() => finish(true), () => finish(false))
    } catch {
      finish(false)
    }
    return promise
  }

  private release(nodes: ToneNodes): void {
    this.activeTones.delete(nodes)
    if (nodes.oscillator) {
      nodes.oscillator.onended = null
      try { nodes.oscillator.disconnect() } catch { /* Already disconnected. */ }
    }
    try { nodes.envelope?.disconnect() } catch { /* Already disconnected. */ }
  }

  private async playPattern(pattern: readonly ToneStep[], volume: number): Promise<boolean> {
    this.stop()
    const generation = this.generation
    const context = this.getContext()
    if (!context || !await this.ensureRunning(context)) return false
    if (generation !== this.generation || context.state !== 'running') return false

    try {
      let cursor = context.currentTime + 0.015
      for (const step of pattern) {
        const nodes: ToneNodes = { oscillator: null, envelope: null }
        this.activeTones.add(nodes)
        const oscillator = nodes.oscillator = context.createOscillator()
        const envelope = nodes.envelope = context.createGain()
        const end = cursor + step.durationMs / 1_000

        oscillator.onended = () => this.release(nodes)
        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(step.frequencyHz, cursor)
        envelope.gain.setValueAtTime(0.0001, cursor)
        envelope.gain.exponentialRampToValueAtTime(volume, cursor + 0.018)
        envelope.gain.exponentialRampToValueAtTime(0.0001, end)
        oscillator.connect(envelope)
        envelope.connect(context.destination)
        oscillator.start(cursor)
        oscillator.stop(end + 0.025)
        cursor = end + step.gapMs / 1_000
      }
      return true
    } catch {
      this.stop()
      this.state = 'blocked'
      return false
    }
  }
}
