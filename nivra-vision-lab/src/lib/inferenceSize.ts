import type { Size } from './geometry'

/** Bound upload cost without stretching the source or inventing extra pixels. */
export function inferenceSize(source: Size, longestSide: number): Size {
  if (![source.width, source.height, longestSide].every(value => Number.isFinite(value) && value > 0)) {
    return { width: 1, height: 1 }
  }
  const scale = Math.min(1, longestSide / Math.max(source.width, source.height))
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  }
}
