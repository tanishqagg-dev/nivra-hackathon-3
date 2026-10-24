import { describe, expect, it } from 'vitest'
import { FightDecision } from './fightDecision'

describe('fight alert confirmation', () => {
  it('can confirm supporting-model evidence even when the fast model stays below threshold', () => {
    const decision = new FightDecision()
    expect(decision.update(.27, 1000, true).event).toBeNull()
    expect(decision.update(.28, 2000, true).event?.type).toBe('physical-conflict')
  })

  it('requires consecutive positive windows and suppresses a continuing incident', () => {
    const decision = new FightDecision()
    expect(decision.update(.9, 1000).event).toBeNull()
    expect(decision.update(.1, 2000).streak).toBe(0)
    expect(decision.update(.7, 3000).event).toBeNull()
    expect(decision.update(.8, 4000).event?.type).toBe('physical-conflict')
    expect(decision.update(.9, 5000).event).toBeNull()
    expect(decision.update(.9, 13000).event).toBeNull()
  })

  it('rearms after two quiet windows and observes the alert cooldown', () => {
    const decision = new FightDecision()
    decision.update(.8, 1000)
    expect(decision.update(.8, 2000).event).not.toBeNull()
    decision.update(.1, 3000)
    decision.update(.1, 4000)
    decision.update(.8, 5000)
    expect(decision.update(.8, 6000).event).toBeNull()
    decision.update(.8, 9000)
    expect(decision.update(.8, 10000).event).not.toBeNull()
  })

  it('does not combine evidence across a gap or a source restart', () => {
    const decision = new FightDecision()
    decision.update(.8, 1000)
    expect(decision.update(.8, 7000).event).toBeNull()
    decision.reset()
    expect(decision.update(.8, 8000).event).toBeNull()
  })

  it('rejects invalid probabilities and stale responses', () => {
    const decision = new FightDecision()
    expect(() => decision.update(NaN, 1000)).toThrow()
    expect(() => decision.update(1.2, 1000)).toThrow()
    decision.update(.8, 1000)
    expect(() => decision.update(.8, 999)).toThrow()
    expect(() => decision.update(.8, 1000)).toThrow()
  })
})
