import { describe, expect, it } from 'vitest'
import { FrameGate } from './frameGate'

describe('FrameGate', () => {
  it('allows only one frame until the current frame finishes', () => {
    const gate = new FrameGate()

    expect(gate.tryAcquire()).toBe(true)
    expect(gate.tryAcquire()).toBe(false)
    expect(gate.isBusy).toBe(true)

    gate.release()

    expect(gate.tryAcquire()).toBe(true)
  })
})

