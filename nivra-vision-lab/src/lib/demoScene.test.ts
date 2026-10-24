import { describe, expect, it } from 'vitest'
import { demoFrame } from './demoScene'
import { SceneEngine } from './sceneEngine'

describe('scripted scenario inputs', () => {
  it('raises an unattended review after the person leaves the stationary bag', () => {
    const engine = new SceneEngine()
    let scene = engine.update(0, demoFrame(0, 'unattended').objects)
    for (let timestamp = 100; timestamp <= 8_000; timestamp += 100) {
      scene = engine.update(timestamp, demoFrame(timestamp, 'unattended').objects)
      if (timestamp < 5_000) expect(scene.events).toHaveLength(0)
    }

    expect(scene.events).toHaveLength(1)
    expect(scene.events[0]).toMatchObject({ type: 'unattended-bag', title: 'Unattended bag observed' })
    expect(scene.events[0].occurredAtMs).toBeGreaterThanOrEqual(5_000)
    expect(scene.events[0].occurredAtMs).toBeLessThanOrEqual(6_500)
  })

  it('keeps a stationary watched bag quiet and alerts when the scripted movement persists', () => {
    const engine = new SceneEngine()
    let scene = engine.update(0, demoFrame(0, 'watched').objects)
    expect(engine.watchObject(scene.objects[0].trackKey)).toBe(true)
    for (let timestamp = 100; timestamp <= 9_000; timestamp += 100) {
      scene = engine.update(timestamp, demoFrame(timestamp, 'watched').objects)
      if (timestamp <= 7_000) expect(scene.events).toHaveLength(0)
    }

    expect(scene.events).toHaveLength(1)
    expect(scene.watch?.state).toBe('moved')
    expect(scene.events[0]).toMatchObject({ type: 'watched-item', title: 'Watched item moved' })
    expect(scene.events[0].occurredAtMs).toBeGreaterThanOrEqual(8_100)
    expect(scene.events[0].occurredAtMs).toBeLessThanOrEqual(8_300)
  })
})
