import { describe, expect, it } from 'vitest'
import { PoseSmoother } from './poseSmoother'

const pose = (x: number, y = .5) => Array.from({ length: 33 }, () => ({ x, y, z: 0, visibility: 1 }))

describe('display pose smoothing', () => {
  it('holds a person through a brief miss, then drops them', () => {
    const smoother = new PoseSmoother()
    expect(smoother.update([pose(.3), pose(.7)], 0)).toHaveLength(2)
    expect(smoother.update([pose(.3)], 100)).toHaveLength(2)
    expect(smoother.update([pose(.3)], 600)).toHaveLength(1)
  })

  it('blends jitter for the same person and keeps two people separate', () => {
    const smoother = new PoseSmoother()
    smoother.update([pose(.30), pose(.70)], 0)
    const [left, right] = smoother.update([pose(.34), pose(.70)], 33)
    expect(left[0].x).toBeGreaterThan(.30)
    expect(left[0].x).toBeLessThan(.34)
    expect(right[0].x).toBeCloseTo(.70)
  })
})
