import { describe, expect, it } from 'vitest'
import { inferenceSize } from './inferenceSize'

describe('inferenceSize', () => {
  it('keeps widescreen proportions at the detail and performance settings', () => {
    expect(inferenceSize({ width: 1280, height: 720 }, 960)).toEqual({ width: 960, height: 540 })
    expect(inferenceSize({ width: 1280, height: 720 }, 640)).toEqual({ width: 640, height: 360 })
  })
  it('keeps portrait proportions and does not upscale small sources', () => {
    expect(inferenceSize({ width: 720, height: 1280 }, 960)).toEqual({ width: 540, height: 960 })
    expect(inferenceSize({ width: 320, height: 240 }, 960)).toEqual({ width: 320, height: 240 })
  })
  it('rejects invalid dimensions and handles an extreme aspect ratio', () => {
    expect(inferenceSize({ width: NaN, height: 720 }, 960)).toEqual({ width: 1, height: 1 })
    expect(inferenceSize({ width: 1280, height: 0 }, 960)).toEqual({ width: 1, height: 1 })
    expect(inferenceSize({ width: 10000, height: 1 }, 640)).toEqual({ width: 640, height: 1 })
  })
})
