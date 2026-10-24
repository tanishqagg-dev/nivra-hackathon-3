import { describe, expect, it } from 'vitest'
import { SourceClock } from './sourceClock'

describe('source clock', () => {
  it('uses forty milliseconds of source time regardless of inference wall time', () => {
    const clock = new SourceClock()
    clock.begin('clip', 1000)
    expect(clock.frame(1000, 0)).toBe(1000)
    expect(clock.frame(1600, 0.04)).toBe(1040)
    expect(clock.frame(2200, 0.08)).toBe(1080)
    expect(clock.read(9000, 0.08)).toBe(1080)
  })

  it('keeps replay and switching back to camera ahead of prior transport timestamps', () => {
    const clock = new SourceClock()
    clock.begin('clip', 1000)
    const end = clock.frame(1100, 30)
    clock.begin('clip', 1200)
    const replay = clock.frame(1200, 0)
    expect(replay).toBeGreaterThan(end)
    clock.begin('camera', 1300)
    const camera = clock.frame(1300)
    expect(camera).toBeGreaterThan(replay)
    expect(clock.frame(1340) - camera).toBe(40)
  })

  it('can retry a cancelled in-flight position without skipping it or rewinding the worker clock', () => {
    const clock = new SourceClock()
    clock.begin('clip', 1000)
    const cancelled = clock.frame(1000, 0.04)
    const resumed = clock.frame(5000, 0.04)
    expect(resumed).toBeGreaterThan(cancelled)
    expect(resumed - cancelled).toBeCloseTo(0.001, 6)
    expect(clock.frame(7000, 0.08) - resumed).toBeCloseTo(39.999, 6)
  })
})
