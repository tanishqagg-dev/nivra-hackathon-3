import type { NormalizedBox, PoseLandmark } from '../types/vision'

export interface Size {
  width: number
  height: number
}

export interface CoverTransform {
  scale: number
  offsetX: number
  offsetY: number
  renderedWidth: number
  renderedHeight: number
}

export type ObjectFitMode = 'cover' | 'contain'

export interface Point {
  x: number
  y: number
}

export function getFitTransform(
  source: Size,
  container: Size,
  mode: ObjectFitMode,
): CoverTransform {
  if (
    source.width <= 0 ||
    source.height <= 0 ||
    container.width <= 0 ||
    container.height <= 0
  ) {
    return {
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      renderedWidth: container.width,
      renderedHeight: container.height,
    }
  }

  const ratios = [
    container.width / source.width,
    container.height / source.height,
  ]
  const scale = mode === 'cover' ? Math.max(...ratios) : Math.min(...ratios)
  const renderedWidth = source.width * scale
  const renderedHeight = source.height * scale

  return {
    scale,
    renderedWidth,
    renderedHeight,
    offsetX: (container.width - renderedWidth) / 2,
    offsetY: (container.height - renderedHeight) / 2,
  }
}

export function getCoverTransform(source: Size, container: Size): CoverTransform {
  return getFitTransform(source, container, 'cover')
}

export function getContainTransform(source: Size, container: Size): CoverTransform {
  return getFitTransform(source, container, 'contain')
}

export function mapLandmarkToFit(
  landmark: Pick<PoseLandmark, 'x' | 'y'>,
  source: Size,
  container: Size,
  mirrored: boolean,
  fit: ObjectFitMode = 'cover',
): Point {
  const transform = getFitTransform(source, container, fit)
  const normalizedX = mirrored ? 1 - landmark.x : landmark.x

  return {
    x: transform.offsetX + normalizedX * source.width * transform.scale,
    y: transform.offsetY + landmark.y * source.height * transform.scale,
  }
}

export function mapNormalizedBoxToFit(
  box: NormalizedBox,
  source: Size,
  container: Size,
  mirrored: boolean,
  fit: ObjectFitMode = 'cover',
): NormalizedBox {
  const transform = getFitTransform(source, container, fit)
  const normalizedX = mirrored ? 1 - box.x - box.width : box.x

  return {
    x: transform.offsetX + normalizedX * source.width * transform.scale,
    y: transform.offsetY + box.y * source.height * transform.scale,
    width: box.width * source.width * transform.scale,
    height: box.height * source.height * transform.scale,
  }
}

export function mapLandmarkToCover(
  landmark: Pick<PoseLandmark, 'x' | 'y'>,
  source: Size,
  container: Size,
  mirrored: boolean,
): Point {
  return mapLandmarkToFit(landmark, source, container, mirrored, 'cover')
}

export function mapNormalizedBoxToCover(
  box: NormalizedBox,
  source: Size,
  container: Size,
  mirrored: boolean,
): NormalizedBox {
  return mapNormalizedBoxToFit(box, source, container, mirrored, 'cover')
}
