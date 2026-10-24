import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReviewTonePlayer, tonePatternFor } from './ReviewTonePlayer'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function createMockOscillator() {
  return {
    type: 'sine',
    frequency: { setValueAtTime: vi.fn() },
    onended: null as (() => void) | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }
}

function createMockGain() {
  return {
    gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
}

function installAudioContext(options: {
  state?: AudioContextState
  resume?: () => Promise<void>
} = {}) {
  const oscillators: ReturnType<typeof createMockOscillator>[] = []
  const envelopes: ReturnType<typeof createMockGain>[] = []
  const contexts: FakeAudioContext[] = []

  class FakeAudioContext {
    state: AudioContextState = options.state ?? 'running'
    currentTime = 1
    destination = {}

    constructor() { contexts.push(this) }

    createOscillator() {
      const oscillator = createMockOscillator()
      oscillators.push(oscillator)
      return oscillator
    }

    createGain() {
      const envelope = createMockGain()
      envelopes.push(envelope)
      return envelope
    }

    resume = vi.fn(() => {
      if (options.resume) return options.resume()
      this.state = 'running'
      return Promise.resolve()
    })

    close = vi.fn(() => {
      this.state = 'closed'
      return Promise.resolve()
    })
  }

  vi.stubGlobal('AudioContext', FakeAudioContext)
  return { contexts, oscillators, envelopes }
}

describe('NIVRA review tones', () => {
  it('gives each review event a distinct pattern under half a second', () => {
    const types = ['rapid-transfer', 'unattended-bag', 'restricted-object', 'watched-item'] as const
    const patterns = types.map(tonePatternFor)
    expect(new Set(patterns.map((pattern) => JSON.stringify(pattern))).size).toBe(types.length)
    for (const pattern of patterns) {
      expect(pattern.reduce((total, step) => total + step.durationMs + step.gapMs, 0)).toBeLessThan(500)
    }
  })

  it('reports success only after scheduling through a running audio context', async () => {
    const { contexts, oscillators, envelopes } = installAudioContext()
    const player = new ReviewTonePlayer()

    expect(await player.play('restricted-object')).toBe(true)
    expect(player.getState()).toBe('ready')
    expect(oscillators.map((node) => node.frequency.setValueAtTime.mock.calls[0][0])).toEqual([680, 880, 680])
    expect(oscillators[0].start).toHaveBeenCalledWith(1.015)
    expect(envelopes[0].connect).toHaveBeenCalledWith(contexts[0].destination)
    player.dispose()
  })

  it('previews the full watched-item alert', async () => {
    const { oscillators } = installAudioContext()
    const player = new ReviewTonePlayer()
    expect(await player.playPreview()).toBe(true)
    expect(oscillators.map((node) => node.frequency.setValueAtTime.mock.calls[0][0]))
      .toEqual(tonePatternFor('watched-item').map((step) => step.frequencyHz))
    player.dispose()
  })

  it('primes audio during the user gesture and awaits running state', async () => {
    const { contexts } = installAudioContext({ state: 'suspended' })
    const player = new ReviewTonePlayer()
    const primed = player.prime()
    expect(contexts[0].resume).toHaveBeenCalledOnce()
    expect(await primed).toBe(true)
    expect(player.getState()).toBe('ready')
    player.dispose()
  })

  it('handles missing audio support without throwing', async () => {
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', undefined)
    const player = new ReviewTonePlayer()
    expect(await player.prime()).toBe(false)
    expect(await player.playPreview()).toBe(false)
    expect(player.getState()).toBe('unsupported')
    player.dispose()
  })

  it('reports rejected browser autoplay instead of scheduling a tone', async () => {
    const { oscillators } = installAudioContext({
      state: 'suspended',
      resume: () => Promise.reject(new Error('Autoplay blocked')),
    })
    const player = new ReviewTonePlayer()
    expect(await player.playPreview()).toBe(false)
    expect(player.getState()).toBe('blocked')
    expect(oscillators).toHaveLength(0)
    player.dispose()
  })

  it('does not treat a fulfilled resume as success if audio remains suspended', async () => {
    installAudioContext({ state: 'suspended', resume: () => Promise.resolve() })
    const player = new ReviewTonePlayer()
    expect(await player.prime()).toBe(false)
    expect(player.getState()).toBe('blocked')
    player.dispose()
  })

  it('times out blocked autoplay and never plays the old alert after a late resume', async () => {
    vi.useFakeTimers()
    let resume!: () => void
    const { contexts, oscillators } = installAudioContext({
      state: 'suspended',
      resume: () => new Promise<void>((resolve) => { resume = resolve }),
    })
    const player = new ReviewTonePlayer()
    const played = player.playPreview()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await played).toBe(false)
    contexts[0].state = 'running'
    resume()
    await Promise.resolve()
    expect(oscillators).toHaveLength(0)
    player.dispose()
  })

  it('stop cancels a pending resume without waiting for the browser', async () => {
    let resume!: () => void
    const { contexts, oscillators } = installAudioContext({
      state: 'suspended',
      resume: () => new Promise<void>((resolve) => { resume = resolve }),
    })
    const player = new ReviewTonePlayer()
    const played = player.play('restricted-object')
    player.stop()
    expect(await played).toBe(false)
    contexts[0].state = 'running'
    resume()
    await Promise.resolve()
    expect(oscillators).toHaveLength(0)
    player.dispose()
  })

  it('replaces older alerts while resume is pending', async () => {
    const resumes: Array<() => void> = []
    const { contexts, oscillators } = installAudioContext({
      state: 'suspended',
      resume: () => new Promise<void>((resolve) => { resumes.push(resolve) }),
    })
    const player = new ReviewTonePlayer()
    const oldAlert = player.play('restricted-object')
    const newAlert = player.play('watched-item')
    contexts[0].state = 'running'
    for (const resume of resumes) resume()
    expect(await oldAlert).toBe(false)
    expect(await newAlert).toBe(true)
    expect(oscillators.map((node) => node.frequency.setValueAtTime.mock.calls[0][0])).toEqual([640, 920])
    player.dispose()
  })

  it('stop disconnects active and scheduled tones and allows a later alert', async () => {
    const { oscillators, envelopes } = installAudioContext()
    const player = new ReviewTonePlayer()
    await player.play('restricted-object')
    player.stop()
    expect(oscillators.every((node) => node.stop.mock.calls.some((args) => args.length === 0))).toBe(true)
    expect(oscillators.every((node) => node.disconnect.mock.calls.length === 1 && node.onended === null)).toBe(true)
    expect(envelopes.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true)
    expect(await player.playPreview()).toBe(true)
    player.dispose()
  })

  it('disconnects completed tones without retaining them until disposal', async () => {
    const { oscillators, envelopes } = installAudioContext()
    const player = new ReviewTonePlayer()
    await player.playPreview()
    for (const node of oscillators) node.onended?.()
    player.stop()
    expect(oscillators.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true)
    expect(envelopes.every((node) => node.disconnect.mock.calls.length === 1)).toBe(true)
    player.dispose()
  })

  it('cleans up partly scheduled tones when an audio node fails', async () => {
    const { contexts, oscillators } = installAudioContext()
    const player = new ReviewTonePlayer()
    await player.prime()
    vi.spyOn(contexts[0], 'createGain').mockImplementation(() => { throw new Error('Audio device failed') })
    expect(await player.playPreview()).toBe(false)
    expect(player.getState()).toBe('blocked')
    expect(oscillators[0].disconnect).toHaveBeenCalledOnce()
    player.dispose()
  })

  it('disposal closes audio, cancels resume, and prevents use after unmount', async () => {
    const { contexts, oscillators } = installAudioContext({
      state: 'suspended',
      resume: () => new Promise<void>(() => {}),
    })
    const player = new ReviewTonePlayer()
    const primed = player.prime()
    player.dispose()
    expect(await primed).toBe(false)
    expect(player.getState()).toBe('disposed')
    expect(contexts[0].close).toHaveBeenCalledOnce()
    expect(await player.playPreview()).toBe(false)
    expect(await player.prime()).toBe(false)
    expect(contexts).toHaveLength(1)
    expect(oscillators).toHaveLength(0)
    player.dispose()
    expect(contexts[0].close).toHaveBeenCalledOnce()
  })
})
