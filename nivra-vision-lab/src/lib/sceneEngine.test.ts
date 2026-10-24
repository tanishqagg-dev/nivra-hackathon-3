import { describe, expect, it } from 'vitest'
import { SceneEngine } from './sceneEngine'
import type { NormalizedBox, ObjectObservation, ObjectRole } from '../types/vision'

function observation(
  label: string,
  displayName: string,
  role: ObjectRole,
  box: NormalizedBox,
): ObjectObservation {
  return { label, displayName, role, box, score: 0.82 }
}

const personA = observation('person', 'Person', 'person', {
  x: 0.08,
  y: 0.08,
  width: 0.34,
  height: 0.84,
})
const personB = observation('person', 'Person', 'person', {
  x: 0.6,
  y: 0.08,
  width: 0.34,
  height: 0.84,
})

const isolatedBag = observation('backpack', 'Backpack', 'bag', {
  x: 0.45, y: 0.45, width: 0.12, height: 0.2,
})
const knife = observation('knife', 'Knife', 'restricted', {
  x: 0.5, y: 0.4, width: 0.08, height: 0.18,
})

function observeThrough(engine: SceneEngine, start: number, end: number, observations: ObjectObservation[]) {
  let scene = engine.snapshot(start)
  for (let timestamp = start; timestamp <= end; timestamp += 100) {
    scene = engine.update(timestamp, observations)
  }
  return scene
}

describe('SceneEngine', () => {
  it('classifies an object inside a stable person region as carried', () => {
    const engine = new SceneEngine()
    const bag = observation('handbag', 'Handbag / purse', 'bag', {
      x: 0.29,
      y: 0.4,
      width: 0.12,
      height: 0.2,
    })

    engine.update(0, [personA, bag])
    const scene = engine.update(300, [personA, bag])

    expect(scene.inventory).toEqual([
      expect.objectContaining({ displayName: 'Handbag / purse', status: 'carried' }),
    ])
  })

  it('flags a bag only after it remains away from nearby people for five seconds', () => {
    const engine = new SceneEngine()
    const bag = observation('backpack', 'Backpack', 'bag', {
      x: 0.45,
      y: 0.45,
      width: 0.12,
      height: 0.2,
    })

    expect(observeThrough(engine, 0, 4_900, [bag]).events).toHaveLength(0)
    const scene = engine.update(5_100, [bag])

    expect(scene.events[0]).toMatchObject({
      type: 'unattended-bag',
      title: 'Unattended bag observed',
    })
    expect(scene.objects[0].status).toBe('review')
  })

  it('flags a fast change between two temporary person associations', () => {
    const engine = new SceneEngine()
    const bagAtA = observation('handbag', 'Handbag / purse', 'bag', {
      x: 0.28,
      y: 0.42,
      width: 0.11,
      height: 0.18,
    })
    const bagAtB = observation('handbag', 'Handbag / purse', 'bag', {
      x: 0.62,
      y: 0.42,
      width: 0.11,
      height: 0.18,
    })

    engine.update(0, [personA, personB, bagAtA])
    engine.update(300, [personA, personB, bagAtA])
    engine.update(1_200, [personA, personB, bagAtA])
    engine.update(1_260, [personA, personB, bagAtB])
    const scene = engine.update(1_560, [personA, personB, bagAtB])

    expect(scene.events[0]).toMatchObject({ type: 'rapid-transfer' })
    expect(scene.events[0].detail).toContain('intent is not inferred')
  })

  it('requires a restricted object to persist across frames before review', () => {
    const engine = new SceneEngine()
    const knife = observation('knife', 'Knife', 'restricted', {
      x: 0.5,
      y: 0.4,
      width: 0.08,
      height: 0.18,
    })

    expect(engine.update(0, [knife]).events).toHaveLength(0)
    expect(engine.update(350, [knife]).events).toHaveLength(0)
    const scene = engine.update(700, [knife])

    expect(scene.events[0]).toMatchObject({
      type: 'restricted-object',
      title: 'Restricted object observed',
    })
  })

  it('does not turn a camera pause into an unattended event', () => {
    const engine = new SceneEngine()
    const firstKey = engine.update(0, [isolatedBag]).objects[0].trackKey
    const resumed = engine.update(5_200, [isolatedBag])
    expect(resumed.events).toHaveLength(0)
    expect(resumed.objects[0].trackKey).not.toBe(firstKey)
    expect(resumed.objects[0].reviewProgress).toBe(0)
  })

  it('resets confirmation after a detector dropout exceeds the tolerance', () => {
    const engine = new SceneEngine()
    engine.update(0, [knife])
    engine.update(350, [knife])
    engine.update(500, [])
    engine.update(800, [])
    expect(engine.update(900, [knife]).events).toHaveLength(0)
    expect(engine.update(1_250, [knife]).events).toHaveLength(0)
    expect(engine.update(1_600, [knife]).events).toHaveLength(1)
  })

  it('freezes confirmation during one missing frame and preserves progress on return', () => {
    const engine = new SceneEngine({ unattendedSeconds: 2 })
    const beforeDropout = observeThrough(engine, 0, 1_000, [isolatedBag])
    const missing = engine.update(1_100, [])
    const returned = engine.update(1_200, [isolatedBag])
    expect(beforeDropout.objects[0].reviewProgress).toBe(0.5)
    expect(missing.objects[0].reviewProgress).toBe(0.5)
    expect(returned.objects[0].reviewProgress).toBe(0.5)
    expect(observeThrough(engine, 1_300, 2_100, [isolatedBag]).events).toHaveLength(0)
    expect(engine.update(2_200, [isolatedBag]).events).toHaveLength(1)
  })

  it('eventually alerts for a persistent bag despite isolated detector flicker', () => {
    const engine = new SceneEngine()
    let scene = engine.update(0, [isolatedBag])
    for (let timestamp = 100; timestamp <= 6_200; timestamp += 100) {
      scene = engine.update(timestamp, timestamp % 1_000 === 0 ? [] : [isolatedBag])
    }
    expect(scene.events).toHaveLength(1)
    expect(scene.events[0].type).toBe('unattended-bag')
    expect(scene.events[0].occurredAtMs).toBeGreaterThanOrEqual(6_000)
  })

  it('resets confirmation after a full second without a captured observation', () => {
    const engine = new SceneEngine({ unattendedSeconds: 2 })
    observeThrough(engine, 0, 1_500, [isolatedBag])
    const afterGap = engine.update(2_500, [isolatedBag])
    expect(afterGap.objects[0].reviewProgress).toBe(0)
    expect(afterGap.events).toHaveLength(0)
  })

  it('does not confirm a restricted object with only two observations or duplicates', () => {
    const engine = new SceneEngine()
    engine.update(0, [knife])
    expect(engine.update(800, [knife]).events).toHaveLength(0)
    expect(engine.update(800, [knife]).events).toHaveLength(0)
    expect(engine.update(700, [knife]).events).toHaveLength(0)
    expect(engine.update(900, [knife]).events).toHaveLength(1)
  })

  it('holds an event once without repeating it for a continuously visible object', () => {
    const engine = new SceneEngine()
    const scene = observeThrough(engine, 0, 12_000, [knife])
    expect(scene.events).toHaveLength(1)
    engine.update(12_100, [])
    expect(observeThrough(engine, 12_200, 14_000, [knife]).events).toHaveLength(1)
  })

  it('requires fresh observations instead of advancing confirmation in snapshots', () => {
    const engine = new SceneEngine({ unattendedSeconds: 2 })
    observeThrough(engine, 0, 1_500, [isolatedBag])
    const stale = engine.snapshot(2_100)
    expect(stale.events).toHaveLength(0)
    expect(stale.objects[0].status).toBe('observed')
    expect(stale.objects[0].reviewProgress).toBe(0.75)
  })

  it('uses configured unattended duration and rearms when a person returns', () => {
    const engine = new SceneEngine({ unattendedSeconds: 2 })
    expect(observeThrough(engine, 0, 2_000, [isolatedBag]).events[0].detail).toContain('2 seconds')
    expect(observeThrough(engine, 2_100, 7_000, [isolatedBag]).events).toHaveLength(1)
    engine.update(7_100, [personA, isolatedBag])
    const afterReturn = observeThrough(engine, 7_200, 9_300, [isolatedBag])
    expect(afterReturn.events).toHaveLength(2)
  })

  it('does not call a moving unassociated bag unattended', () => {
    const engine = new SceneEngine({ unattendedSeconds: 2 })
    for (let index = 0; index <= 50; index += 1) {
      const bag = { ...isolatedBag, box: { ...isolatedBag.box, x: 0.15 + index * 0.01 } }
      expect(engine.update(index * 100, [bag]).events).toHaveLength(0)
    }
  })

  it('does not treat stationary object association changes as a rapid transfer', () => {
    const engine = new SceneEngine()
    const left = { ...personA, box: { ...personA.box, x: 0.22 } }
    const right = { ...personB, box: { ...personB.box, x: 0.42 } }
    observeThrough(engine, 0, 1_500, [left, isolatedBag])
    const scene = observeThrough(engine, 1_600, 3_000, [right, isolatedBag])
    expect(scene.events).toHaveLength(0)
  })

  it('allows separate objects of the same class to create their own review events', () => {
    const engine = new SceneEngine()
    const secondKnife = { ...knife, box: { ...knife.box, x: 0.1 } }
    const scene = observeThrough(engine, 0, 800, [knife, secondKnife])
    expect(scene.events).toHaveLength(2)
  })

  it('does not label a newly observed item as under review at timestamp zero', () => {
    expect(new SceneEngine().update(0, [isolatedBag]).objects[0].status).toBe('observed')
  })

  it('lets an operator watch an item and confirms persistent movement once', () => {
    const engine = new SceneEngine()
    const item = engine.update(0, [isolatedBag]).objects[0]
    expect(engine.watchObject(item.trackKey)).toBe(true)
    const moved = { ...isolatedBag, box: { ...isolatedBag.box, x: 0.65 } }
    expect(engine.update(100, [moved]).events).toHaveLength(0)
    expect(engine.update(350, [moved]).watch?.progress).toBe(0.5)
    const scene = engine.update(600, [moved])
    expect(scene.watch).toMatchObject({ state: 'moved', progress: 1, box: isolatedBag.box })
    expect(scene.events[0]).toMatchObject({ type: 'watched-item', title: 'Watched item moved' })
    expect(observeThrough(engine, 700, 3_000, [moved]).events.filter((event) => event.type === 'watched-item')).toHaveLength(1)
  })

  it('ignores jitter and a brief movement that returns to the watched position', () => {
    const engine = new SceneEngine()
    engine.watchObject(engine.update(0, [isolatedBag]).objects[0].trackKey)
    for (let index = 1; index <= 10; index += 1) {
      engine.update(index * 100, [{ ...isolatedBag, box: { ...isolatedBag.box, x: 0.45 + (index % 2) * 0.02 } }])
    }
    engine.update(1_100, [{ ...isolatedBag, box: { ...isolatedBag.box, x: 0.65 } }])
    const scene = engine.update(1_400, [isolatedBag])
    expect(scene.watch).toMatchObject({ state: 'watching', progress: 0 })
    expect(scene.events).toHaveLength(0)
  })

  it('confirms a watched item missing only after fresh absent observations', () => {
    const engine = new SceneEngine()
    engine.watchObject(engine.update(0, [isolatedBag]).objects[0].trackKey)
    expect(engine.snapshot(1_200).watch?.state).toBe('watching')
    expect(observeThrough(engine, 100, 1_700, []).events).toHaveLength(0)
    const missing = engine.update(1_800, [])
    expect(missing.watch).toMatchObject({ state: 'missing', progress: 1 })
    expect(missing.events[0]).toMatchObject({ type: 'watched-item', title: 'Watched item left view' })
    expect(observeThrough(engine, 1_900, 3_000, []).events).toHaveLength(1)
  })

  it('does not equate a stalled camera with a watched item disappearing', () => {
    const engine = new SceneEngine()
    engine.watchObject(engine.update(0, [isolatedBag]).objects[0].trackKey)
    const afterPause = engine.update(4_000, [])
    expect(afterPause.watch).toMatchObject({ state: 'watching', progress: 0 })
    expect(afterPause.events).toHaveLength(0)
  })

  it('reacquires the watched item at its position before absence confirmation finishes', () => {
    const engine = new SceneEngine()
    const key = engine.update(0, [isolatedBag]).objects[0].trackKey
    engine.watchObject(key)
    observeThrough(engine, 100, 1_400, [])
    const returned = engine.update(1_500, [isolatedBag])
    expect(returned.objects[0].trackKey).toBe(key)
    expect(returned.watch).toMatchObject({ trackKey: key, state: 'watching', progress: 0 })
    expect(observeThrough(engine, 1_600, 2_300, [isolatedBag]).events).toHaveLength(0)
  })

  it('does not assign a watched item to another same-label object after a dropout', () => {
    const engine = new SceneEngine()
    const key = engine.update(0, [isolatedBag]).objects[0].trackKey
    engine.watchObject(key)
    observeThrough(engine, 100, 1_400, [])
    const otherBag = { ...isolatedBag, box: { ...isolatedBag.box, x: 0.75 } }
    const returned = engine.update(1_500, [otherBag])
    expect(returned.objects[0].trackKey).not.toBe(key)
    const scene = observeThrough(engine, 1_600, 1_800, [otherBag])
    expect(scene.watch).toMatchObject({ trackKey: key, state: 'missing' })
    expect(scene.events[0].title).toBe('Watched item left view')
  })

  it('rearms a watch at the current position and can clear it', () => {
    const engine = new SceneEngine()
    const key = engine.update(0, [isolatedBag]).objects[0].trackKey
    engine.watchObject(key)
    const moved = { ...isolatedBag, box: { ...isolatedBag.box, x: 0.65 } }
    observeThrough(engine, 100, 700, [moved])
    expect(engine.watchObject(key)).toBe(true)
    const scene = observeThrough(engine, 800, 1_400, [isolatedBag])
    expect(scene.events.filter((event) => event.type === 'watched-item')).toHaveLength(2)
    expect(engine.watchObject('not-a-track')).toBe(false)
    engine.clearWatch()
    expect(engine.snapshot(1_400).watch).toBeNull()
  })

  it('keeps paused objects selectable and excludes paused time from watched absence', () => {
    const engine = new SceneEngine()
    const key = engine.update(0, [isolatedBag]).objects[0].trackKey
    engine.pause(100)
    expect(engine.snapshot(30_000).objects[0].trackKey).toBe(key)
    expect(engine.watchObject(key)).toBe(true)
    expect(engine.update(30_000, []).events).toHaveLength(0)
    const resumed = engine.resume(30_100)
    expect(resumed.watch).toMatchObject({ trackKey: key, state: 'watching', box: isolatedBag.box, progress: 0 })
    expect(resumed.objects[0].trackKey).toBe(key)
    const firstMissingFrame = engine.update(30_200, [])
    expect(firstMissingFrame.events).toHaveLength(0)
    expect(firstMissingFrame.watch?.state).toBe('watching')
    expect(engine.update(30_300, [isolatedBag]).watch?.progress).toBe(0)
  })

  it('still confirms watched movement after resuming a long pause', () => {
    const engine = new SceneEngine()
    const key = engine.update(0, [isolatedBag]).objects[0].trackKey
    engine.watchObject(key)
    engine.pause(0)
    engine.resume(10_000)
    const moved = { ...isolatedBag, box: { ...isolatedBag.box, x: 0.65 } }
    const scene = observeThrough(engine, 10_100, 10_600, [moved])
    expect(scene.events).toHaveLength(1)
    expect(scene.events[0].type).toBe('watched-item')
    expect(scene.watch).toMatchObject({ trackKey: key, state: 'moved', box: isolatedBag.box })
  })

  it('clears partial confirmation across a pause and preserves existing review history', () => {
    const engine = new SceneEngine({ unattendedSeconds: 2 })
    observeThrough(engine, 0, 800, [knife, isolatedBag])
    const event = engine.snapshot(800).events[0]
    engine.pause(800)
    engine.resume(20_800)
    const continued = observeThrough(engine, 20_900, 22_800, [knife, isolatedBag])
    expect(continued.events).toEqual([event])
    const confirmedBag = engine.update(22_900, [knife, isolatedBag])
    expect(confirmedBag.events).toHaveLength(2)
    expect(confirmedBag.events[0].type).toBe('unattended-bag')
  })

  it('does not count pre-pause watched movement toward a post-resume alert', () => {
    const engine = new SceneEngine()
    engine.watchObject(engine.update(0, [isolatedBag]).objects[0].trackKey)
    const moved = { ...isolatedBag, box: { ...isolatedBag.box, x: 0.65 } }
    observeThrough(engine, 100, 400, [moved])
    engine.pause(400)
    engine.resume(10_400)
    expect(observeThrough(engine, 10_500, 10_900, [moved]).events).toHaveLength(0)
    expect(engine.update(11_000, [moved]).events).toHaveLength(1)
  })

  it('treats repeated pause/resume calls as idempotent and reset clears pause state', () => {
    const engine = new SceneEngine()
    const key = engine.update(0, [isolatedBag]).objects[0].trackKey
    engine.pause(100)
    engine.pause(200)
    engine.resume(10_100)
    engine.resume(10_100)
    expect(engine.update(10_200, [isolatedBag]).objects[0].trackKey).toBe(key)
    engine.pause(10_200)
    engine.reset()
    expect(engine.update(20_000, [knife]).objects[0].label).toBe('knife')
  })

  it('resets temporary tracks and review history', () => {
    const engine = new SceneEngine()
    const bag = observation('suitcase', 'Suitcase', 'bag', {
      x: 0.4,
      y: 0.4,
      width: 0.2,
      height: 0.3,
    })
    engine.update(0, [bag])
    engine.update(5_200, [bag])
    engine.reset()

    const scene = engine.update(6_000, [])
    expect(scene).toMatchObject({ objects: [], inventory: [], events: [] })
  })
})
