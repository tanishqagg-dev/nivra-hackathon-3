import { describe, expect, it } from 'vitest'
import { ConflictEngine } from './conflictEngine'
import { demoFrame } from './demoScene'
import type { PoseLandmarks } from '../types/vision'

const ASPECT = 16 / 9

function person(centerX: number, extension = 0, wave = 0): PoseLandmarks {
  const pose: PoseLandmarks = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }))
  const points: Record<number, [number, number]> = {
    0: [centerX, .25], 11: [centerX - .065, .34], 12: [centerX + .065, .34],
    13: [centerX - .08, .42], 15: [centerX - .075, .49],
    14: [centerX + .08 + extension * .08, .42 - extension * .05 - wave * .09],
    16: [centerX + .075 + extension * .175, .49 - extension * .09 - wave * .25],
    23: [centerX - .055, .60], 24: [centerX + .055, .60],
    25: [centerX - .055, .75], 26: [centerX + .055, .75],
    27: [centerX - .055, .91], 28: [centerX + .055, .91],
  }
  for (const [index, [x, y]] of Object.entries(points)) pose[Number(index)] = { x, y, z: 0, visibility: .99, presence: .99 }
  return pose
}

function translate(pose: PoseLandmarks, dx: number, dy = 0): PoseLandmarks {
  return pose.map(point => ({ ...point, x: point.x + dx, y: point.y + dy }))
}

function croppedUpperBody(pose: PoseLandmarks): PoseLandmarks {
  return pose.map((point, index) => index >= 23
    ? { ...point, y: 1.15, visibility: .1, presence: .1 }
    : { ...point })
}

function turnShoulders(pose: PoseLandmarks, width: number): PoseLandmarks {
  const result = pose.map(point => ({ ...point }))
  const center = (pose[11].x + pose[12].x) / 2
  for (const [shoulder, elbow, wrist, sign] of [[11, 13, 15, -1], [12, 14, 16, 1]]) {
    const dx = center + width / 2 * sign - pose[shoulder].x
    for (const index of [shoulder, elbow, wrist]) result[index].x += dx
  }
  return result
}

function bentArmPerson(extension: number): PoseLandmarks {
  const pose = person(.35, extension)
  if (extension) pose[14] = { ...pose[14], x: .51, y: .52 }
  return pose
}

function extensionAt(timestamp: number): number {
  if (timestamp < 700) return 0
  return (timestamp - 700) % 700 < 200 ? 1 : 0
}

function run(engine: ConflictEngine, end: number, frames: (timestamp: number) => PoseLandmarks[], step = 100, start = 0) {
  let result = engine.snapshot(start)
  for (let timestamp = start; timestamp <= end; timestamp += step) result = engine.update(timestamp, frames(timestamp))
  return result
}

describe('ConflictEngine', () => {
  it('requires repeated directed extension/retraction pulses before an alert', () => {
    const engine = new ConflictEngine()
    const frames = (time: number) => [person(.35, extensionAt(time)), person(.65)]
    const first = run(engine, 800, frames)
    expect(first.status).toBe('observing')
    expect(first.progress).toBeCloseTo(1 / 3)
    expect(first.events).toHaveLength(0)
    const result = run(engine, 2_200, frames, 100, 900)
    expect(result.status).toBe('alert')
    expect(result.progress).toBe(1)
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({ id: 'conflict-1', type: 'physical-conflict', title: 'Possible physical conflict' })
    expect(result.regions).toHaveLength(2)
  })

  it('detects repeated staged arm thrusts with approximately seven pose samples per second', () => {
    const engine = new ConflictEngine()
    const result = run(engine, 3_000, time => [person(.35, extensionAt(time)), person(.65)], 143)
    expect(result.events).toHaveLength(1)
  })

  it('processes smooth directed motion at twenty-five pose samples per second', () => {
    const result = run(new ConflictEngine(), 4_000, time => {
      const phase = Math.max(0, time - 700) % 900
      const extension = time < 700 ? 0 : phase < 200 ? phase / 200 : phase < 400 ? (400 - phase) / 200 : 0
      return [person(.35, extension), person(.65)]
    }, 40)
    expect(result.events).toHaveLength(1)
  })

  it('does not accumulate twenty-five-hertz wrist jitter into motion episodes', () => {
    const result = run(new ConflictEngine(), 6_000, time => {
      const actor = person(.35)
      actor[16].x += Math.sin(time / 37) * .012
      actor[16].y += Math.cos(time / 43) * .01
      return [actor, person(.65)]
    }, 40)
    expect(result.progress).toBe(0)
    expect(result.events).toHaveLength(0)
  })

  it('detects a directed wrist crossing the target between low-rate samples', () => {
    const result = run(new ConflictEngine(), 3_000, time => {
      const extension = extensionAt(time)
      const actor = person(.35, extension)
      if (extension) actor[16].x = .665
      return [actor, person(.65)]
    }, 143)
    expect(result.events).toHaveLength(1)
  })

  it('rejects implausible jumps across the target even when their swept path intersects it', () => {
    const result = run(new ConflictEngine(), 5_000, time => {
      const actor = person(.35)
      if (extensionAt(time)) {
        actor[14] = { ...actor[14], x: .615, y: .38 }
        actor[16] = { ...actor[16], x: .8, y: .4 }
      }
      return [actor, person(.65)]
    }, 143)
    expect(result.events).toHaveLength(0)
  })

  it('does not count a held overshoot followed by repeated motion away from the target', () => {
    const result = run(new ConflictEngine(), 5_000, time => {
      const actor = person(.35, 1)
      actor[14] = { ...actor[14], x: .53, y: .36 }
      actor[16] = { ...actor[16], x: .665 + extensionAt(time) * .025, y: .4 }
      return [actor, person(.65)]
    }, 143)
    expect(result.events).toHaveLength(0)
  })

  it('keeps matching people when pose-array order reverses', () => {
    const engine = new ConflictEngine()
    const result = run(engine, 2_300, time => {
      const pair = [person(.35, extensionAt(time)), person(.65)]
      return time % 200 ? pair.reverse() : pair
    })
    expect(result.events).toHaveLength(1)
  })

  it('keeps full-torso people usable while projected shoulder width becomes narrow', () => {
    const engine = new ConflictEngine()
    const result = run(engine, 3_000, time => [
      turnShoulders(person(.35, extensionAt(time)), time % 300 ? .008 : .13), person(.65),
    ])
    expect(result.people).toBe(2)
    expect(result.events).toHaveLength(1)
    expect(result.diagnostics.upperBodyOnlyPeople).toBe(0)
  })

  it('rejects tiny projected shoulders when no torso can establish body scale', () => {
    const result = new ConflictEngine().update(0, [croppedUpperBody(turnShoulders(person(.35), .008))])
    expect(result.people).toBe(0)
  })

  it('keeps a turning pair matched among reordered crowd observations', () => {
    const result = run(new ConflictEngine(), 3_000, time => {
      const poses = [turnShoulders(person(.35, extensionAt(time)), time % 300 ? .01 : .13),
        turnShoulders(person(.65), .012), person(.05), person(.95)]
      const offset = Math.floor(time / 100) % poses.length
      return [...poses.slice(offset), ...poses.slice(0, offset)]
    })
    expect(result.people).toBe(4)
    expect(result.events).toHaveLength(1)
  })

  it('does not count shoulder foreshortening and camera panning as an arm thrust', () => {
    const result = run(new ConflictEngine(), 5_000, time => [person(.35), person(.65)].map(pose =>
      translate(turnShoulders(pose, time % 300 ? .008 : .13), Math.sin(time / 350) * .02)))
    expect(result.events).toHaveLength(0)
    expect(result.progress).toBe(0)
  })

  it('requires three completed fast bent-arm approaches and withdrawals', () => {
    const engine = new ConflictEngine()
    const frames = (time: number) => [bentArmPerson(extensionAt(time)), person(.65)]
    const approach = run(engine, 800, frames)
    expect(approach.progress).toBe(0)
    const two = run(engine, 2_000, frames, 100, 900)
    expect(two.progress).toBeCloseTo(2 / 3)
    expect(two.events).toHaveLength(0)
    const three = run(engine, 3_000, frames, 100, 2_100)
    expect(three.events).toHaveLength(1)
  })

  it('offers early human review after two completed bent-arm cycles, while standard still needs three', () => {
    const frames = (time: number) => {
      const extension = time >= 700 && (time - 700) % 1_000 < 200 ? 1 : 0
      return [bentArmPerson(extension), person(.65)]
    }
    const early = new ConflictEngine()
    early.configureSensitivity('early')
    const first = run(early, 1_300, frames)
    expect(first.events).toHaveLength(0)
    expect(first.progress).toBe(.5)
    const second = run(early, 2_100, frames, 100, 1_400)
    expect(second.events).toHaveLength(1)
    expect(second.events[0].detail).toContain('2 distinct')
    expect(second.events[0].detail).toContain('person must review')
    expect(second.diagnostics.requiredPulses).toBe(2)
    const standard = run(new ConflictEngine(), 2_100, frames)
    expect(standard.events).toHaveLength(0)
    expect(standard.diagnostics.requiredPulses).toBe(3)
  })

  it('alerts on the first directed thrust in instant mode, while two people still need to be near', () => {
    const frames = (time: number) => {
      const extension = time >= 700 && (time - 700) % 1_000 < 200 ? 1 : 0
      return [bentArmPerson(extension), person(.65)]
    }
    const instant = new ConflictEngine()
    instant.configureSensitivity('instant')
    const result = run(instant, 1_300, frames)
    expect(result.events).toHaveLength(1)
    expect(result.events[0].detail).toContain('A fast arm-motion episode')
    expect(result.diagnostics.requiredPulses).toBe(1)
    const alone = new ConflictEngine()
    alone.configureSensitivity('instant')
    expect(run(alone, 1_300, time => [bentArmPerson(time >= 700 && time < 900 ? 1 : 0)]).events).toHaveLength(0)
  })

  it('keeps four-pulse confirmation for wrist-only observations in early mode', () => {
    const engine = new ConflictEngine()
    engine.configureSensitivity('early')
    const frames = (time: number) => {
      const actor = croppedUpperBody(person(.35, extensionAt(time)))
      actor[14].visibility = .1
      return [actor, croppedUpperBody(person(.65))]
    }
    const three = run(engine, 2_300, frames)
    expect(three.events).toHaveLength(0)
    expect(three.diagnostics.requiredPulses).toBe(4)
    const four = run(engine, 3_000, frames, 100, 2_400)
    expect(four.events).toHaveLength(1)
    expect(four.events[0].detail).toContain('4 distinct')
  })

  it('keeps guard adjustments, slow hugs, high fives, waving and jitter quiet in early mode', () => {
    for (const scenario of ['guard', 'hug', 'high-five', 'wave', 'jitter']) {
      const engine = new ConflictEngine()
      engine.configureSensitivity('early')
      const result = run(engine, 6_000, time => {
        const actor = scenario === 'hug' ? bentArmPerson(Math.min(1, time / 3_000))
          : person(.35, 0, scenario === 'wave' ? extensionAt(time) : 0)
        if (scenario === 'high-five' && extensionAt(time)) {
          actor[14] = { ...actor[14], x: .5, y: .2 }
          actor[16] = { ...actor[16], x: .57, y: .10 }
        }
        if (scenario === 'guard') {
          actor[14] = { ...actor[14], x: .46, y: .43 }
          actor[16] = { ...actor[16], x: .455 + Math.sin(time / 100) * .01, y: .34 }
        }
        if (scenario === 'jitter') {
          actor[16].x += Math.sin(time / 37) * .012
          actor[16].y += Math.cos(time / 43) * .01
        }
        return [actor, person(.65)]
      }, scenario === 'jitter' ? 40 : 100)
      expect(result.events, scenario).toHaveLength(0)
    }
  })

  it('clears pending evidence on sensitivity changes but keeps completed reviews and event IDs', () => {
    const engine = new ConflictEngine()
    run(engine, 800, time => [person(.35, extensionAt(time)), person(.65)])
    engine.configureSensitivity('early')
    const frames = (time: number) => [person(.35, time >= 1_600 && (time - 1_600) % 1_000 < 200 ? 1 : 0), person(.65)]
    const oneFresh = run(engine, 2_000, frames, 100, 900)
    expect(oneFresh.events).toHaveLength(0)
    expect(oneFresh.progress).toBe(.5)
    engine.configureSensitivity('early')
    const second = run(engine, 2_700, frames, 100, 2_100)
    expect(second.events).toHaveLength(1)
    engine.configureSensitivity('standard')
    const reset = engine.snapshot(2_800)
    expect(reset.events[0].id).toBe('conflict-1')
    expect(reset.diagnostics.requiredPulses).toBe(3)
    expect(reset.progress).toBe(0)
    const next = run(engine, 14_400, time => [person(.35, extensionAt(time - 12_000)), person(.65)], 100, 12_000)
    expect(next.events).toHaveLength(2)
    expect(next.events[0].id).toBe('conflict-2')
    expect(next.events[0].detail).toContain('3 distinct')
  })

  it('measures a bent-arm withdrawal from the later peak, not the first qualifying approach', () => {
    const frames = (time: number, withdraw: boolean) => {
      const phase = Math.max(0, time - 700)
      const extension = phase < 240 ? .2 + .75 * phase / 240
        : withdraw ? Math.max(.48, .95 - (phase - 240) * .47 / 160) : .95
      const actor = person(.35)
      const shoulder = actor[12]
      const reach = extension * .26
      actor[14] = { ...actor[14], x: shoulder.x + reach / ASPECT / 2, y: shoulder.y + reach / 2 }
      actor[16] = { ...actor[16], x: shoulder.x + reach / ASPECT, y: shoulder.y }
      return [actor, person(.62)]
    }
    const withdrawn = run(new ConflictEngine(), 1_800, time => frames(time, true), 40)
    expect(withdrawn.progress).toBeCloseTo(1 / 3)
    expect(withdrawn.events).toHaveLength(0)
    const held = run(new ConflictEngine(), 1_800, time => frames(time, false), 40)
    expect(held.progress).toBe(0)
    expect(held.events).toHaveLength(0)
  })

  it('does not count a held bent-arm reach or framewise flicker as repeated episodes', () => {
    const held = run(new ConflictEngine(), 3_000, time => [bentArmPerson(time >= 700 ? 1 : 0), person(.65)])
    expect(held.progress).toBe(0)
    expect(held.events).toHaveLength(0)
    const oneEpisode = run(new ConflictEngine(), 2_000, time => [
      bentArmPerson(time >= 700 && time < 1_100 && time % 200 ? 1 : 0), person(.65),
    ])
    expect(oneEpisode.progress).toBeCloseTo(1 / 3)
    expect(oneEpisode.events).toHaveLength(0)
  })

  it('ignores slow hugging reaches, above-head high fives, and small guard adjustments', () => {
    for (const scenario of ['hug', 'high-five', 'guard']) {
      const result = run(new ConflictEngine(), 6_000, time => {
        const actor = scenario === 'hug' ? bentArmPerson(Math.min(1, time / 3_000)) : person(.35)
        if (scenario === 'high-five' && extensionAt(time)) {
          actor[14] = { ...actor[14], x: .5, y: .2 }
          actor[16] = { ...actor[16], x: .57, y: .10 }
        }
        if (scenario === 'guard') {
          actor[14] = { ...actor[14], x: .46, y: .43 }
          actor[16] = { ...actor[16], x: .455 + Math.sin(time / 100) * .01, y: .34 }
        }
        return [actor, person(.65)]
      })
      expect(result.events, scenario).toHaveLength(0)
    }
  })

  it('does not reset an established pair status when a third person enters', () => {
    const engine = new ConflictEngine()
    run(engine, 1_600, time => [person(.35, extensionAt(time)), person(.65)])
    const result = engine.update(1_700, [person(.35), person(.65), person(.05)])
    expect(result.status).toBe('observing')
    expect(result.progress).toBeCloseTo(2 / 3)
    expect(result.diagnostics.reason).toBe('ready')
  })

  it('reports the selected pair wrist occlusion even when another pair has visible arms', () => {
    const engine = new ConflictEngine()
    run(engine, 1_600, time => [person(.35, extensionAt(time)), person(.65)])
    const hiddenPair = [person(.35), person(.65)].map(pose => {
      pose[15].visibility = .1
      pose[16].visibility = .1
      return pose
    })
    const result = engine.update(1_700, [...hiddenPair, person(.08), person(.92)])
    expect(result.diagnostics.usableArms).toBeGreaterThan(0)
    expect(result.status).toBe('limited')
    expect(result.diagnostics.reason).toBe('arms-hidden')
  })

  it('does not alert for stationary people or a held extended arm', () => {
    for (const extension of [0, 1]) {
      const result = run(new ConflictEngine(), 6_000, () => [person(.35, extension), person(.65)])
      expect(result.events).toHaveLength(0)
      expect(result.progress).toBe(0)
    }
  })

  it('does not alert for a single reach toward another person', () => {
    const result = run(new ConflictEngine(), 6_000, time => [person(.35, time >= 700 && time < 1_000 ? 1 : 0), person(.65)])
    expect(result.events).toHaveLength(0)
    expect(result.progress).toBe(0)
  })

  it('does not alert for repetitive overhead waving', () => {
    const result = run(new ConflictEngine(), 6_000, time => [person(.35, 0, extensionAt(time)), person(.65)])
    expect(result.events).toHaveLength(0)
  })

  it('does not alert for one person shadowboxing', () => {
    const result = run(new ConflictEngine(), 5_000, time => [person(.35, extensionAt(time))])
    expect(result.events).toHaveLength(0)
    expect(result.status).toBe('limited')
  })

  it('rejects duplicate body observations of one person', () => {
    const result = run(new ConflictEngine(), 5_000, time => {
      const pose = person(.35, extensionAt(time))
      return [pose, translate(pose, .008, .004)]
    })
    expect(result.events).toHaveLength(0)
    expect(result.people).toBe(1)
    expect(result.status).toBe('limited')
  })

  it('does not alert for thrusts away from a distant person', () => {
    const result = run(new ConflictEngine(), 5_000, time => [person(.22, extensionAt(time)), person(.90)])
    expect(result.events).toHaveLength(0)
  })

  it('does not alert for people walking past each other without arm extensions', () => {
    const result = run(new ConflictEngine(), 5_000, time => [
      translate(person(.35), time / 20_000), translate(person(.65), -time / 20_000),
    ])
    expect(result.events).toHaveLength(0)
  })

  it('cancels shared camera translation and body translation', () => {
    const result = run(new ConflictEngine(), 5_000, time => {
      const pan = Math.sin(time / 350) * .05
      return [translate(person(.35), pan), translate(person(.65), pan)]
    })
    expect(result.events).toHaveLength(0)
    expect(result.progress).toBe(0)
  })

  it('keeps detecting the repeated arm motion while both bodies translate', () => {
    const result = run(new ConflictEngine(), 2_300, time => {
      const pan = Math.sin(time / 350) * .025
      return [translate(person(.35, extensionAt(time)), pan), translate(person(.65), pan)]
    })
    expect(result.events).toHaveLength(1)
  })

  it('requires visible shoulders and ignores occluded striking wrists', () => {
    for (const index of [11, 16]) {
      const result = run(new ConflictEngine(), 4_000, time => {
        const actor = person(.35, extensionAt(time))
        actor[index].visibility = .2
        return [actor, person(.65)]
      })
      expect(result.events).toHaveLength(0)
    }
  })

  it('detects the repeated interaction when both people have cropped hips', () => {
    const result = run(new ConflictEngine(), 3_000, time => [
      croppedUpperBody(person(.35, extensionAt(time))), croppedUpperBody(person(.65)),
    ], 143)
    expect(result.events).toHaveLength(1)
    expect(result.people).toBe(2)
    expect(result.diagnostics).toMatchObject({ detectedPoses: 2, usablePeople: 2, upperBodyOnlyPeople: 2, visibleArms: 4 })
    expect(result.signals).toContain('Upper-body framing supported')
  })

  it('uses upper-body scale when confident hip landmarks are extrapolated below the frame', () => {
    const result = run(new ConflictEngine(), 3_000, time => [person(.35, extensionAt(time)), person(.65)].map(pose => {
      pose[23].y = 1.25
      pose[24].y = 1.25
      return pose
    }))
    expect(result.events).toHaveLength(1)
    expect(result.diagnostics).toMatchObject({ usablePeople: 2, upperBodyOnlyPeople: 2 })
  })

  it('does not use confident shoulders or wrists outside the image', () => {
    const outsideShoulder = person(.35)
    outsideShoulder[11].x = -.08
    expect(new ConflictEngine().update(0, [outsideShoulder]).diagnostics.usablePeople).toBe(0)
    const outsideWrists = [person(.35), person(.65)].map(pose => {
      pose[15].y = 1.08
      pose[16].y = 1.08
      return pose
    })
    expect(new ConflictEngine().update(0, outsideWrists).diagnostics).toMatchObject({
      usablePeople: 2, usableArms: 0, reason: 'arms-hidden',
    })
  })

  it('calibrates shoulder-based size from a previously visible torso', () => {
    const engine = new ConflictEngine()
    const result = run(engine, 3_000, time => {
      const pair = [person(.35, extensionAt(time)), person(.65)]
      return time >= 600 ? pair.map(croppedUpperBody) : pair
    })
    expect(result.events).toHaveLength(1)
    expect(result.diagnostics.upperBodyOnlyPeople).toBe(2)
  })

  it('preserves upper-body matches when pose order and hip visibility change', () => {
    const result = run(new ConflictEngine(), 3_000, time => {
      const pair = [person(.35, extensionAt(time)), person(.65)]
        .map((pose, index) => (time / 100 + index) % 2 ? croppedUpperBody(pose) : pose)
      return time % 200 ? pair.reverse() : pair
    })
    expect(result.events).toHaveLength(1)
  })

  it('uses one visible striking arm even when the other arm is outside the frame', () => {
    const result = run(new ConflictEngine(), 3_000, time => {
      const actor = croppedUpperBody(person(.35, extensionAt(time)))
      actor[13].visibility = .1
      actor[15].visibility = .1
      return [actor, croppedUpperBody(person(.65))]
    })
    expect(result.events).toHaveLength(1)
    expect(result.diagnostics.usableArms).toBe(3)
  })

  it('requires four stronger pulses when the striking elbow is hidden', () => {
    const engine = new ConflictEngine()
    const frames = (time: number) => {
      const actor = croppedUpperBody(person(.35, extensionAt(time)))
      actor[14].visibility = .1
      return [actor, croppedUpperBody(person(.65))]
    }
    const threePulses = run(engine, 2_300, frames)
    expect(threePulses.events).toHaveLength(0)
    expect(threePulses.progress).toBe(.75)
    expect(threePulses.diagnostics).toMatchObject({ visibleArms: 3, usableArms: 4, requiredPulses: 4 })
    const fourPulses = run(engine, 3_000, frames, 100, 2_400)
    expect(fourPulses.events).toHaveLength(1)
  })

  it('does not convert upper-body waving or a single reach into an alert', () => {
    for (const waving of [true, false]) {
      const result = run(new ConflictEngine(), 5_000, time => {
        const actor = person(.35, waving ? 0 : time >= 700 && time < 1_000 ? 1 : 0, waving ? extensionAt(time) : 0)
        actor[14].visibility = .1
        return [croppedUpperBody(actor), croppedUpperBody(person(.65))]
      })
      expect(result.events).toHaveLength(0)
    }
  })

  it('keeps one cropped person and duplicate observations out of two-person analysis', () => {
    for (const duplicate of [false, true]) {
      const result = run(new ConflictEngine(), 4_000, time => {
        const actor = croppedUpperBody(person(.35, extensionAt(time)))
        return duplicate ? [actor, translate(actor, .008, .003)] : [actor]
      })
      expect(result.events).toHaveLength(0)
      expect(result.people).toBe(1)
      expect(result.diagnostics.reason).toBe('single-person')
    }
  })

  it('rejects unreliable shoulder confidence despite confidently extrapolated hips', () => {
    const result = run(new ConflictEngine(), 4_000, time => {
      const actor = person(.35, extensionAt(time))
      actor[11].presence = .2
      return [actor, croppedUpperBody(person(.65))]
    })
    expect(result.events).toHaveLength(0)
    expect(result.diagnostics).toMatchObject({ detectedPoses: 2, usablePeople: 1, reason: 'single-person' })
  })

  it('explains missing landmarks, shoulders, wrists and pair distance separately', () => {
    expect(new ConflictEngine().update(0, []).diagnostics.reason).toBe('no-poses')
    const hiddenShoulders = person(.35)
    hiddenShoulders[11].visibility = .1
    expect(new ConflictEngine().update(0, [hiddenShoulders]).diagnostics.reason).toBe('shoulders-hidden')
    const withoutWrists = [croppedUpperBody(person(.35)), croppedUpperBody(person(.65))].map(pose => {
      pose[15].visibility = .1
      pose[16].visibility = .1
      return pose
    })
    expect(new ConflictEngine().update(0, withoutWrists).diagnostics.reason).toBe('arms-hidden')
    expect(new ConflictEngine().update(0, [person(.05), person(.95)]).diagnostics.reason).toBe('too-far')
  })

  it('does not count camera panning or framing changes as cropped-body strikes', () => {
    const result = run(new ConflictEngine(), 5_000, time => [person(.35), person(.65)].map(pose => {
      const moved = translate(pose, Math.sin(time / 400) * .04, Math.sin(time / 500) * .02)
      return time % 500 ? croppedUpperBody(moved) : moved
    }))
    expect(result.events).toHaveLength(0)
  })

  it('discards motion across model changes without clearing review history or reusing IDs', () => {
    const engine = new ConflictEngine()
    const frames = (time: number) => [person(.35, extensionAt(time)), person(.65)]
    run(engine, 2_300, frames)
    engine.resetMotion()
    expect(engine.snapshot(2_400).events[0].id).toBe('conflict-1')
    const oneNewPulse = run(engine, 3_100, time => frames(time - 2_400), 100, 2_400)
    expect(oneNewPulse.events).toHaveLength(1)
    expect(oneNewPulse.progress).toBeCloseTo(1 / 3)
    engine.resetMotion()
    const nextEpisode = run(engine, 13_000, time => frames(time - 10_500), 100, 10_500)
    expect(nextEpisode.events).toHaveLength(2)
    expect(nextEpisode.events[0].id).toBe('conflict-2')
  })

  it('ignores implausible wrist jumps', () => {
    const result = run(new ConflictEngine(), 5_000, time => {
      const actor = person(.35)
      if (extensionAt(time)) actor[16].x = 1.8
      return [actor, person(.65)]
    })
    expect(result.events).toHaveLength(0)
  })

  it('does not combine pulses across a stalled stream', () => {
    const engine = new ConflictEngine()
    run(engine, 1_600, time => [person(.35, extensionAt(time)), person(.65)])
    expect(engine.snapshot(3_000).status).toBe('limited')
    const result = run(engine, 4_600, time => [person(.35, extensionAt(time - 3_000)), person(.65)], 100, 3_000)
    expect(result.events).toHaveLength(0)
  })

  it('keeps confirmed evidence through a short unambiguous full-torso occlusion', () => {
    const engine = new ConflictEngine()
    run(engine, 1_600, time => [person(.35, extensionAt(time)), person(.65)])
    const absent = run(engine, 2_900, () => [person(.65)], 100, 1_700)
    expect(absent.people).toBe(1)
    expect(absent.regions).toHaveLength(0)
    expect(absent.events).toHaveLength(0)
    const rejoined = engine.update(3_000, [person(.35), person(.65)])
    expect(rejoined.status).toBe('warming')
    expect(rejoined.progress).toBeCloseTo(2 / 3)
    run(engine, 3_400, () => [person(.35), person(.65)], 100, 3_100)
    const third = engine.update(3_500, [person(.35, 1), person(.65)])
    expect(third.events).toHaveLength(1)
  })

  it('does not count an arm position jump across the missing interval', () => {
    const engine = new ConflictEngine()
    run(engine, 1_600, time => [person(.35, extensionAt(time)), person(.65)])
    run(engine, 2_900, () => [person(.65)], 100, 1_700)
    const rejoined = run(engine, 3_700, () => [person(.35, 1), person(.65)], 100, 3_000)
    expect(rejoined.progress).toBeCloseTo(2 / 3)
    expect(rejoined.events).toHaveLength(0)
  })

  it('discards occlusion history when the person returns beyond the retention limit', () => {
    const engine = new ConflictEngine()
    run(engine, 1_600, time => [person(.35, extensionAt(time)), person(.65)])
    run(engine, 3_900, () => [person(.65)], 100, 1_700)
    run(engine, 4_500, () => [person(.35), person(.65)], 100, 4_000)
    const result = engine.update(4_600, [person(.35, 1), person(.65)])
    expect(result.events).toHaveLength(0)
    expect(result.progress).toBeCloseTo(1 / 3)
  })

  it('does not transfer confirmed history to a differently placed new entrant', () => {
    const engine = new ConflictEngine()
    run(engine, 1_600, time => [person(.35, extensionAt(time)), person(.65)])
    run(engine, 2_900, () => [person(.65)], 100, 1_700)
    run(engine, 3_400, () => [person(.45), person(.65)], 100, 3_000)
    const result = engine.update(3_500, [person(.45, 1), person(.65)])
    expect(result.events).toHaveLength(0)
    expect(result.progress).toBeCloseTo(1 / 3)
  })

  it('discards history when two people are plausible matches for one returning torso', () => {
    const engine = new ConflictEngine()
    run(engine, 1_600, time => [person(.35, extensionAt(time)), person(.65)])
    run(engine, 2_900, () => [person(.65)], 100, 1_700)
    const crowd = (extension = 0) => [person(.30, extension), person(.40), person(.65)]
    run(engine, 3_400, () => crowd(), 100, 3_000)
    const result = engine.update(3_500, crowd(1))
    expect(result.people).toBe(3)
    expect(result.events).toHaveLength(0)
    expect(result.progress).toBeLessThanOrEqual(1 / 3)
  })

  it('cannot reconnect an occluded person using only extrapolated torso size', () => {
    const engine = new ConflictEngine()
    run(engine, 1_600, time => [person(.35, extensionAt(time)), person(.65)])
    run(engine, 2_900, () => [person(.65)], 100, 1_700)
    run(engine, 3_600, () => [croppedUpperBody(person(.35)), person(.65)], 100, 3_000)
    const result = engine.update(3_700, [croppedUpperBody(person(.35, 1)), person(.65)])
    expect(result.events).toHaveLength(0)
    expect(result.progress).toBeLessThanOrEqual(1 / 3)
  })

  it('uses a five-second evidence window without needing three rapid repetitions', () => {
    const result = run(new ConflictEngine(), 5_000, time => {
      const extension = [700, 2_500, 4_600].some(start => time >= start && time < start + 200) ? 1 : 0
      return [person(.35, extension), person(.65)]
    })
    expect(result.events).toHaveLength(1)
  })

  it('does not emit an alert every frame or repeatedly during continuous activity', () => {
    const result = run(new ConflictEngine(), 14_000, time => [person(.35, extensionAt(time)), person(.65)])
    expect(result.events).toHaveLength(1)
  })

  it('rearms after a quiet period and cooldown', () => {
    const engine = new ConflictEngine()
    run(engine, 2_500, time => [person(.35, extensionAt(time)), person(.65)])
    run(engine, 10_000, () => [person(.35), person(.65)], 100, 2_600)
    const result = run(engine, 12_400, time => [person(.35, extensionAt(time - 10_000)), person(.65)], 100, 10_100)
    expect(result.events).toHaveLength(2)
    expect(result.events[0].id).toBe('conflict-2')
  })

  it('uses aspect-corrected positions for portrait video', () => {
    const engine = new ConflictEngine()
    const aspect = 9 / 16
    let result = engine.snapshot(0)
    for (let time = 0; time <= 2_300; time += 100) {
      const poses = [person(.35, extensionAt(time)), person(.65)].map(pose => pose.map(point => ({
        ...point, x: .5 + (point.x - .5) * ASPECT / aspect * .5, y: .5 + (point.y - .5) * .5,
      })))
      result = engine.update(time, poses, aspect)
    }
    expect(result.events).toHaveLength(1)
  })

  it('ignores duplicate timestamps and reset removes history', () => {
    const engine = new ConflictEngine()
    run(engine, 2_300, time => [person(.35, extensionAt(time)), person(.65)])
    expect(engine.update(2_300, []).events).toHaveLength(1)
    engine.reset()
    expect(engine.update(3_000, []).events).toHaveLength(0)
  })

  it('keeps event IDs unique after resetting the session', () => {
    const engine = new ConflictEngine()
    run(engine, 2_300, time => [person(.35, extensionAt(time)), person(.65)])
    engine.reset()
    const next = run(engine, 2_300, time => [person(.35, extensionAt(time)), person(.65)])
    expect(next.events[0].id).toBe('conflict-2')
  })

  it('does not revive stale status from a delayed snapshot timestamp', () => {
    const engine = new ConflictEngine()
    run(engine, 2_300, time => [person(.35, extensionAt(time)), person(.65)])
    expect(engine.snapshot(4_000).status).toBe('limited')
    expect(engine.snapshot(2_400).status).toBe('limited')
  })

  it('alerts on the actual scripted interaction scenario and stays quiet for calm waving', () => {
    const conflict = run(new ConflictEngine(), 6_000, time => demoFrame(time, 'conflict').poses)
    const calm = run(new ConflictEngine(), 6_000, time => demoFrame(time, 'calm').poses)
    expect(conflict.events).toHaveLength(1)
    expect(conflict.events[0].type).toBe('physical-conflict')
    expect(calm.events).toHaveLength(0)
  })

  it('keeps an ongoing flagged pattern in alert status without repeated events', () => {
    const engine = new ConflictEngine()
    const ongoing = run(engine, 20_000, time => demoFrame(time, 'conflict').poses)
    expect(ongoing.status).toBe('alert')
    expect(ongoing.progress).toBe(1)
    expect(ongoing.events).toHaveLength(1)
    const quiet = run(engine, 24_000, time => demoFrame(time, 'calm').poses, 100, 20_100)
    expect(quiet.status).toBe('clear')
    expect(quiet.progress).toBe(0)
    expect(quiet.events).toHaveLength(1)
  })
})

describe('live sensitivity power', () => {
  it('maps the slider to the number of strikes needed', () => {
    const engine = new ConflictEngine()
    const strikes = (power: number) => { engine.configurePower(power); return engine.update(1_000 + power * 1_000, []).diagnostics.requiredPulses }
    expect(strikes(0)).toBe(3)
    expect(strikes(0.3)).toBe(2)
    expect(strikes(0.6)).toBe(1)
    expect(strikes(1)).toBe(1)
  })
  it('null power keeps the named sensitivity', () => {
    const engine = new ConflictEngine()
    engine.configureSensitivity('early')
    engine.configurePower(null)
    expect(engine.update(1_000, []).diagnostics.requiredPulses).toBe(2)
  })
})
