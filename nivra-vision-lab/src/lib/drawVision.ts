import {
  mapLandmarkToFit,
  mapNormalizedBoxToFit,
  type ObjectFitMode,
  type Size,
} from './geometry'
import type { SceneObject, SceneWatch } from './sceneEngine'
import type { ConflictSnapshot } from './conflictEngine'
import type { PoseLandmark, PoseLandmarks } from '../types/vision'

const NIVRA_BLUE = '#d2f56a'
const INTERVENTION_CORAL = '#ff5b4d'
// NIVRA skeleton colours (from the NIVRA camera wall overlay).
const SKELETON_GREEN = '#73ffb9'
const JOINT_FILL = '#f7fff9'
const JOINT_EDGE = '#123b2a'

// MediaPipe PoseLandmarker.POSE_CONNECTIONS, kept local to avoid loading the
// model runtime in the UI thread just to obtain its landmark topology.
export const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 7],
  [0, 4],
  [4, 5],
  [5, 6],
  [6, 8],
  [9, 10],
  [11, 12],
  [11, 13],
  [13, 15],
  [15, 17],
  [15, 19],
  [15, 21],
  [17, 19],
  [12, 14],
  [14, 16],
  [16, 18],
  [16, 20],
  [16, 22],
  [18, 20],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [24, 26],
  [25, 27],
  [26, 28],
  [27, 29],
  [28, 30],
  [29, 31],
  [30, 32],
  [27, 31],
  [28, 32],
]

const LANDMARK_COUNT = 33
const JOINT_CONFIDENCE = 0.35
const BONE_CONFIDENCE = 0.5

export interface DrawVisionOptions {
  source: Size
  container: Size
  mirrored: boolean
  fit?: ObjectFitMode
  showSkeleton: boolean
  showObjects: boolean
  watch?: SceneWatch | null
  conflict?: ConflictSnapshot
}

function landmarkConfidence(landmark: PoseLandmark | undefined): number {
  if (!landmark || !Number.isFinite(landmark.x) || !Number.isFinite(landmark.y) || !Number.isFinite(landmark.z)) return 0
  if (landmark.x < 0 || landmark.x > 1 || landmark.y < 0 || landmark.y > 1) return 0
  const visibility = landmark.visibility ?? 1
  const presence = landmark.presence ?? 1
  if (!Number.isFinite(visibility) || !Number.isFinite(presence)) return 0
  return Math.min(1, visibility, presence)
}

function hasValidSize(size: Size): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
}

function isDetailJoint(index: number): boolean {
  return index <= 10 || (index >= 17 && index <= 22) || index >= 29
}

function setupCanvas(canvas: HTMLCanvasElement, size: Size): CanvasRenderingContext2D | null {
  const deviceRatio = window.devicePixelRatio
  const pixelRatio = Number.isFinite(deviceRatio) && deviceRatio > 0 ? Math.min(deviceRatio, 2) : 1
  const pixelWidth = Math.max(1, Math.round(size.width * pixelRatio))
  const pixelHeight = Math.max(1, Math.round(size.height * pixelRatio))

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }

  const context = canvas.getContext('2d')
  if (!context) return null
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  context.clearRect(0, 0, size.width, size.height)
  return context
}

function drawSkeletons(
  context: CanvasRenderingContext2D,
  poses: PoseLandmarks[],
  options: DrawVisionOptions,
): void {
  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.strokeStyle = SKELETON_GREEN
  context.fillStyle = JOINT_FILL
  context.shadowColor = 'rgba(18, 59, 42, 0.35)'
  context.shadowBlur = 5
  const bodyLineWidth = Math.max(2, Math.min(options.container.width / 420, 3.2))
  const sourceDiagonal = Math.hypot(options.source.width, options.source.height)

  for (const pose of poses) {
    const points = Array.from({ length: LANDMARK_COUNT }, (_, index) => {
      const confidence = landmarkConfidence(pose[index])
      if (confidence < JOINT_CONFIDENCE) return null
      return {
        ...mapLandmarkToFit(pose[index], options.source, options.container, options.mirrored, options.fit),
        confidence,
      }
    })

    for (const [fromIndex, toIndex] of POSE_CONNECTIONS) {
      const start = points[fromIndex]
      const end = points[toIndex]
      if (!start || !end) continue
      const confidence = Math.min(start.confidence, end.confidence)
      if (confidence < BONE_CONFIDENCE) continue

      // Keep isolated visible joints, but do not stretch an uncertain bone
      // across most of the source image when a landmark estimate jumps.
      const sourceLength = Math.hypot(
        (pose[fromIndex].x - pose[toIndex].x) * options.source.width,
        (pose[fromIndex].y - pose[toIndex].y) * options.source.height,
      )
      if (confidence < 0.75 && sourceLength > sourceDiagonal * 0.5) continue
      context.globalAlpha = 0.6 + confidence * 0.4
      context.lineWidth = isDetailJoint(fromIndex) || isDetailJoint(toIndex) ? bodyLineWidth * 0.65 : bodyLineWidth
      context.beginPath()
      context.moveTo(start.x, start.y)
      context.lineTo(end.x, end.y)
      context.stroke()
    }

    context.shadowBlur = 0
    context.strokeStyle = JOINT_EDGE
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]
      if (!point) continue
      const radius = index <= 10 ? 1.8 : isDetailJoint(index) ? 2.3 : 3.2
      context.globalAlpha = 0.5 + point.confidence * 0.5
      context.lineWidth = index <= 10 ? 0.9 : 1.2
      context.beginPath()
      context.arc(point.x, point.y, radius, 0, Math.PI * 2)
      context.fill()
      context.stroke()
    }
    context.shadowBlur = 5
    context.strokeStyle = SKELETON_GREEN
  }
  context.restore()
}

function objectLabel(object: SceneObject): string {
  const confidence = `${Math.round(object.score * 100)}%`
  if (object.status === 'observed') return `${object.displayName} · ${confidence}`
  if (object.status === 'review' || object.status === 'unattended') {
    return `${object.displayName} · review`
  }
  return `${object.displayName} · ${object.status}`
}

function drawCornerBox(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const corner = Math.max(7, Math.min(18, width * 0.22, height * 0.22))
  context.beginPath()
  context.moveTo(x + corner, y)
  context.lineTo(x, y)
  context.lineTo(x, y + corner)
  context.moveTo(x + width - corner, y)
  context.lineTo(x + width, y)
  context.lineTo(x + width, y + corner)
  context.moveTo(x, y + height - corner)
  context.lineTo(x, y + height)
  context.lineTo(x + corner, y + height)
  context.moveTo(x + width - corner, y + height)
  context.lineTo(x + width, y + height)
  context.lineTo(x + width, y + height - corner)
  context.stroke()
}

function drawObjects(
  context: CanvasRenderingContext2D,
  objects: SceneObject[],
  options: DrawVisionOptions,
): void {
  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.font = '650 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  context.textBaseline = 'middle'

  for (const object of objects) {
    const box = mapNormalizedBoxToFit(
      object.box,
      options.source,
      options.container,
      options.mirrored,
      options.fit,
    )
    if (
      box.x + box.width < 0 ||
      box.y + box.height < 0 ||
      box.x > options.container.width ||
      box.y > options.container.height
    ) {
      continue
    }

    const needsReview = object.status === 'review' || object.status === 'unattended'
    const color = needsReview ? INTERVENTION_CORAL : NIVRA_BLUE
    context.strokeStyle = color
    context.lineWidth = needsReview ? 2.4 : 1.8
    context.shadowColor = 'rgba(11, 16, 21, 0.28)'
    context.shadowBlur = 6
    drawCornerBox(context, box.x, box.y, box.width, box.height)

    const label = objectLabel(object)
    const textWidth = context.measureText(label).width
    const labelWidth = Math.min(textWidth + 18, options.container.width - 16)
    const labelHeight = 25
    const labelX = Math.min(
      Math.max(8, box.x),
      Math.max(8, options.container.width - labelWidth - 8),
    )
    const labelY = Math.max(8, box.y - labelHeight - 6)
    context.shadowBlur = 0
    context.fillStyle = needsReview ? '#ac3025' : color
    context.beginPath()
    context.roundRect(labelX, labelY, labelWidth, labelHeight, 7)
    context.fill()
    context.fillStyle = '#ffffff'
    context.fillText(label, labelX + 9, labelY + labelHeight / 2, labelWidth - 18)
  }
  context.restore()
}

export function drawVisionOverlay(
  canvas: HTMLCanvasElement,
  poses: PoseLandmarks[],
  objects: SceneObject[],
  options: DrawVisionOptions,
): void {
  if (!hasValidSize(options.container)) {
    clearVisionOverlay(canvas)
    return
  }
  const context = setupCanvas(canvas, options.container)
  if (!context || !hasValidSize(options.source)) return
  if (options.watch) {
    const box = mapNormalizedBoxToFit(options.watch.box, options.source, options.container, options.mirrored, options.fit)
    context.save()
    context.strokeStyle = '#e9fbb8'
    context.lineWidth = 1.5
    context.setLineDash([5, 5])
    context.strokeRect(box.x - 5, box.y - 5, box.width + 10, box.height + 10)
    context.setLineDash([])
    context.fillStyle = '#e9fbb8'
    context.font = '600 10px -apple-system, BlinkMacSystemFont, sans-serif'
    context.fillText('Watched position', Math.max(8, box.x - 5), Math.min(options.container.height - 12, box.y + box.height + 21))
    context.restore()
  }
  if (options.showObjects) drawObjects(context, objects, options)
  if (options.showSkeleton) drawSkeletons(context, poses, options)
  if (options.conflict && ['observing', 'alert'].includes(options.conflict.status)) {
    context.save()
    context.strokeStyle = options.conflict.status === 'alert' ? INTERVENTION_CORAL : '#d2f56a'
    context.lineWidth = 3
    context.setLineDash(options.conflict.status === 'alert' ? [] : [6, 5])
    for (const region of options.conflict.regions) {
      const box = mapNormalizedBoxToFit(region, options.source, options.container, options.mirrored, options.fit)
      drawCornerBox(context, box.x, box.y, box.width, box.height)
    }
    context.restore()
  }
}

export function clearVisionOverlay(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d')
  if (!context) return
  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  context.restore()
}
