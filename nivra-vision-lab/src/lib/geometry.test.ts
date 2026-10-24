import { describe, expect, it } from 'vitest'
import {
  getContainTransform,
  getCoverTransform,
  mapLandmarkToCover,
  mapLandmarkToFit,
  mapNormalizedBoxToCover,
  mapNormalizedBoxToFit,
} from './geometry'

describe('camera geometry', () => {
  const source = { width: 1920, height: 1080 }
  const square = { width: 600, height: 600 }

  it('centres and crops a wide source in cover mode', () => {
    const transform = getCoverTransform(source, square)

    expect(transform.scale).toBeCloseTo(600 / 1080)
    expect(transform.renderedWidth).toBeCloseTo(1066.67, 1)
    expect(transform.offsetX).toBeCloseTo(-233.33, 1)
    expect(transform.offsetY).toBeCloseTo(0)
  })

  it('letterboxes a wide source in contain mode', () => {
    const transform = getContainTransform(source, square)

    expect(transform.scale).toBeCloseTo(600 / 1920)
    expect(transform.renderedHeight).toBeCloseTo(337.5)
    expect(transform.offsetX).toBeCloseTo(0)
    expect(transform.offsetY).toBeCloseTo(131.25)
  })

  it('maps the centre identically with and without mirroring', () => {
    const centre = { x: 0.5, y: 0.5 }

    expect(mapLandmarkToCover(centre, source, square, false)).toEqual({
      x: 300,
      y: 300,
    })
    expect(mapLandmarkToCover(centre, source, square, true)).toEqual({
      x: 300,
      y: 300,
    })
  })

  it('mirrors horizontal landmark coordinates', () => {
    const normal = mapLandmarkToCover({ x: 0.25, y: 0.5 }, source, source, false)
    const mirrored = mapLandmarkToCover({ x: 0.25, y: 0.5 }, source, source, true)

    expect(normal.x).toBe(480)
    expect(mirrored.x).toBe(1440)
    expect(normal.y).toBe(mirrored.y)
  })

  it('mirrors a bounding box without changing its dimensions', () => {
    const box = { x: 0.1, y: 0.2, width: 0.25, height: 0.3 }
    const normal = mapNormalizedBoxToCover(box, source, source, false)
    const mirrored = mapNormalizedBoxToCover(box, source, source, true)

    expect(normal).toEqual({ x: 192, y: 216, width: 480, height: 324 })
    expect(mirrored).toEqual({ x: 1248, y: 216, width: 480, height: 324 })
  })

  it('contains a portrait clip without cropping the head or feet', () => {
    const portrait = { width: 720, height: 1280 }
    const wide = { width: 1280, height: 720 }
    const transform = getContainTransform(portrait, wide)
    expect(transform).toEqual({ scale: .5625, renderedWidth: 405, renderedHeight: 720, offsetX: 437.5, offsetY: 0 })
    expect(mapLandmarkToFit({ x: 0, y: 0 }, portrait, wide, false, 'contain')).toEqual({ x: 437.5, y: 0 })
    expect(mapLandmarkToFit({ x: 1, y: 1 }, portrait, wide, false, 'contain')).toEqual({ x: 842.5, y: 720 })
  })

  it('mirrors a contained portrait within its centered image bounds', () => {
    const portrait = { width: 720, height: 1280 }
    const wide = { width: 1280, height: 720 }
    expect(mapLandmarkToFit({ x: .25, y: .3 }, portrait, wide, false, 'contain')).toEqual({ x: 538.75, y: 216 })
    expect(mapLandmarkToFit({ x: .25, y: .3 }, portrait, wide, true, 'contain')).toEqual({ x: 741.25, y: 216 })
    const box = { x: .1, y: .2, width: .3, height: .4 }
    expect(mapNormalizedBoxToFit(box, portrait, wide, false, 'contain')).toEqual({ x: 478, y: 144, width: 121.5, height: 288 })
    expect(mapNormalizedBoxToFit(box, portrait, wide, true, 'contain')).toEqual({ x: 680.5, y: 144, width: 121.5, height: 288 })
  })

  it('contains landscape footage in a portrait display with vertical letterboxing', () => {
    const mobile = { width: 390, height: 640 }
    expect(mapLandmarkToFit({ x: 0, y: 0 }, source, mobile, false, 'contain')).toEqual({ x: 0, y: 210.3125 })
    expect(mapLandmarkToFit({ x: 1, y: 1 }, source, mobile, false, 'contain')).toEqual({ x: 390, y: 429.6875 })
    expect(mapNormalizedBoxToFit({ x: 0, y: 0, width: 1, height: 1 }, source, mobile, true, 'contain'))
      .toEqual({ x: 0, y: 210.3125, width: 390, height: 219.375 })
  })

  it('keeps existing cover exports and the default fit equivalent', () => {
    const point = { x: .2, y: .4 }
    const box = { x: .2, y: .4, width: .3, height: .2 }
    for (const mirrored of [false, true]) {
      expect(mapLandmarkToFit(point, source, square, mirrored)).toEqual(mapLandmarkToCover(point, source, square, mirrored))
      expect(mapNormalizedBoxToFit(box, source, square, mirrored)).toEqual(mapNormalizedBoxToCover(box, source, square, mirrored))
    }
  })
})
