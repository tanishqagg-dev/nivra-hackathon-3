import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PoseLandmark, PoseLandmarks } from '../types/vision'
import { clearVisionOverlay, drawVisionOverlay, type DrawVisionOptions } from './drawVision'
import { EMPTY_CONFLICT } from './conflictEngine'
import type { SceneObject } from './sceneEngine'

afterEach(() => vi.unstubAllGlobals())

const BASE_OPTIONS: DrawVisionOptions = {
  source: { width: 1280, height: 720 },
  container: { width: 640, height: 360 },
  mirrored: false,
  showSkeleton: true,
  showObjects: false,
}

function landmark(x: number, y: number, confidence = 0.95): PoseLandmark {
  return { x, y, z: 0, visibility: confidence, presence: confidence }
}

function partialPose(visible: Record<number, PoseLandmark>): PoseLandmarks {
  return Array.from({ length: 33 }, (_, index) => visible[index] ?? landmark(0, 0, 0))
}

function mockCanvas() {
  let start = { x: 0, y: 0 }
  const lines: Array<{ from: { x: number; y: number }; to: { x: number; y: number }; color: string }> = []
  const context = {
    strokeStyle: '',
    fillStyle: '',
    lineCap: '',
    lineJoin: '',
    lineWidth: 1,
    globalAlpha: 1,
    shadowColor: '',
    shadowBlur: 0,
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn((x: number, y: number) => { start = { x, y } }),
    lineTo: vi.fn((x: number, y: number) => { lines.push({ from: start, to: { x, y }, color: context.strokeStyle }) }),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    strokeRect: vi.fn(),
    roundRect: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 80 })),
  }
  const canvas = document.createElement('canvas')
  vi.spyOn(canvas, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  return { canvas, context, lines }
}

describe('pose overlay rendering', () => {
  it('draws all 33 observed joints and 35 official MediaPipe connections', () => {
    const { canvas, context, lines } = mockCanvas()
    const pose = Array.from({ length: 33 }, (_, index) => landmark(0.25 + (index % 5) * .05, .15 + Math.floor(index / 5) * .08))
    drawVisionOverlay(canvas, [pose], [], BASE_OPTIONS)

    expect(context.arc).toHaveBeenCalledTimes(33)
    expect(lines).toHaveLength(35)
    expect(lines.every(line => line.color === '#73ffb9')).toBe(true)
    expect(context.fillStyle).toBe('#f7fff9')
    const hasConnection = (from: number, to: number) => lines.some(line =>
      line.from.x === pose[from].x * 640 && line.from.y === pose[from].y * 360 &&
      line.to.x === pose[to].x * 640 && line.to.y === pose[to].y * 360,
    )
    for (const [from, to] of [[0, 1], [3, 7], [6, 8], [9, 10], [15, 17], [15, 19], [15, 21], [17, 19], [16, 18], [16, 20], [16, 22], [18, 20], [27, 31], [28, 32]]) {
      expect(hasConnection(from, to), `Missing detail connection ${from}-${to}`).toBe(true)
    }
    // The head is observed facial landmarks, not an estimated extra circle.
    expect(context.arc.mock.calls.every(([, , radius]) => radius <= 3.2)).toBe(true)
  })

  it('keeps visible partial-body joints when the rest of the person is outside view', () => {
    const { canvas, context, lines } = mockCanvas()
    const pose = partialPose({ 13: landmark(.4, .4), 15: landmark(.5, .45), 19: landmark(.53, .47) })
    drawVisionOverlay(canvas, [pose], [], BASE_OPTIONS)
    expect(context.arc).toHaveBeenCalledTimes(3)
    expect(lines).toHaveLength(2)
  })

  it('requires both presence and visibility for each joint and connecting bone', () => {
    const { canvas, context, lines } = mockCanvas()
    const pose = partialPose({
      11: { ...landmark(.35, .3), presence: .2 },
      12: { ...landmark(.55, .3), visibility: .2 },
      13: landmark(.3, .4),
      14: landmark(.6, .4),
    })
    drawVisionOverlay(canvas, [pose], [], BASE_OPTIONS)
    expect(context.arc).toHaveBeenCalledTimes(2)
    expect(lines).toHaveLength(0)
  })

  it('shows a weaker observed joint without implying a confirmed connecting bone', () => {
    const { canvas, context, lines } = mockCanvas()
    drawVisionOverlay(canvas, [partialPose({ 13: landmark(.3, .4), 15: landmark(.4, .5, .4) })], [], BASE_OPTIONS)
    expect(context.arc).toHaveBeenCalledTimes(2)
    expect(lines).toHaveLength(0)
  })

  it('drops uncertain long bones but retains their observed endpoints', () => {
    const { canvas, context, lines } = mockCanvas()
    const pose = partialPose({ 11: landmark(.05, .5, .6), 13: landmark(.95, .5, .6) })
    drawVisionOverlay(canvas, [pose], [], BASE_OPTIONS)
    expect(context.arc).toHaveBeenCalledTimes(2)
    expect(lines).toHaveLength(0)
  })

  it('keeps strongly observed long limbs in close-up views', () => {
    const { canvas, lines } = mockCanvas()
    drawVisionOverlay(canvas, [partialPose({ 11: landmark(.05, .5), 13: landmark(.95, .5) })], [], BASE_OPTIONS)
    expect(lines).toHaveLength(1)
  })

  it('rejects non-finite coordinates, scores, and extrapolated out-of-frame joints', () => {
    const { canvas, context, lines } = mockCanvas()
    const pose = partialPose({
      0: { ...landmark(.5, .3), x: NaN },
      1: { ...landmark(.5, .3), y: Infinity },
      2: { ...landmark(.5, .3), z: NaN },
      3: { ...landmark(.5, .3), visibility: NaN },
      4: { ...landmark(.5, .3), presence: Infinity },
      5: landmark(-.1, .3),
      6: landmark(.5, 1.2),
      11: landmark(.4, .5),
    })
    drawVisionOverlay(canvas, [pose], [], BASE_OPTIONS)
    expect(context.arc).toHaveBeenCalledTimes(1)
    expect(context.arc).toHaveBeenCalledWith(256, 180, 3.2, 0, Math.PI * 2)
    expect(lines).toHaveLength(0)
  })

  it('supports finite landmarks without optional confidence fields', () => {
    const { canvas, context } = mockCanvas()
    drawVisionOverlay(canvas, [partialPose({ 0: { x: .5, y: .3, z: 0 } })], [], BASE_OPTIONS)
    expect(context.arc).toHaveBeenCalledTimes(1)
  })

  it('does not connect different people or reuse a previous pose by array position', () => {
    const { canvas, context, lines } = mockCanvas()
    const left = partialPose({ 13: landmark(.2, .4) })
    const right = partialPose({ 15: landmark(.8, .4) })
    drawVisionOverlay(canvas, [left, right], [], BASE_OPTIONS)
    drawVisionOverlay(canvas, [right], [], BASE_OPTIONS)
    expect(lines).toHaveLength(0)
    expect(context.arc).toHaveBeenCalledTimes(3)
    expect(context.arc.mock.calls.at(-1)?.slice(0, 2)).toEqual([512, 144])
    expect(context.clearRect).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])('aligns source landmarks to a square cover crop, mirrored=%s', mirrored => {
    vi.stubGlobal('devicePixelRatio', 2)
    const { canvas, context } = mockCanvas()
    drawVisionOverlay(canvas, [partialPose({ 0: landmark(.25, .5) })], [], {
      ...BASE_OPTIONS, source: { width: 1920, height: 1080 }, container: { width: 600, height: 600 }, mirrored,
    })
    expect(canvas.width).toBe(1200)
    expect(canvas.height).toBe(1200)
    expect(context.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0)
    expect(context.arc.mock.calls[0][0]).toBeCloseTo(mirrored ? 566.6667 : 33.3333, 3)
    expect(context.arc.mock.calls[0][1]).toBe(300)
  })

  it('recomputes crop geometry and backing size after a portrait resize', () => {
    vi.stubGlobal('devicePixelRatio', 2)
    const { canvas, context } = mockCanvas()
    const pose = partialPose({ 0: landmark(.5, .5) })
    drawVisionOverlay(canvas, [pose], [], BASE_OPTIONS)
    drawVisionOverlay(canvas, [pose], [], { ...BASE_OPTIONS, container: { width: 390, height: 640 } })
    expect(canvas.width).toBe(780)
    expect(canvas.height).toBe(1280)
    expect(context.arc.mock.calls.at(-1)?.slice(0, 2)).toEqual([195, 320])
  })

  it.each([false, true])('shows the full portrait skeleton in contain mode, mirrored=%s', mirrored => {
    vi.stubGlobal('devicePixelRatio', 2)
    const { canvas, context } = mockCanvas()
    const pose = partialPose({ 0: landmark(.25, .05), 27: landmark(.75, .95) })
    drawVisionOverlay(canvas, [pose], [], {
      ...BASE_OPTIONS,
      source: { width: 720, height: 1280 },
      container: { width: 1280, height: 720 },
      fit: 'contain',
      mirrored,
    })
    expect(context.arc.mock.calls[0].slice(0, 2)).toEqual([mirrored ? 741.25 : 538.75, 36])
    expect(context.arc.mock.calls[1].slice(0, 2)).toEqual([mirrored ? 538.75 : 741.25, 684])
    expect(canvas.width).toBe(2560)
    expect(canvas.height).toBe(1440)
    expect(context.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0)
  })

  it.each([false, true])('uses the same portrait contain geometry for objects, watch and conflict regions, mirrored=%s', mirrored => {
    const { canvas, context, lines } = mockCanvas()
    const item: SceneObject = {
      trackKey: 'book-1', label: 'book', displayName: 'Book', role: 'portable', score: .95,
      box: { x: .1, y: .2, width: .3, height: .4 }, status: 'observed',
    }
    drawVisionOverlay(canvas, [], [item], {
      ...BASE_OPTIONS,
      source: { width: 720, height: 1280 },
      container: { width: 1280, height: 720 },
      fit: 'contain',
      mirrored,
      showSkeleton: false,
      showObjects: true,
      watch: { trackKey: item.trackKey, displayName: item.displayName, box: item.box, state: 'watching', progress: 0 },
      conflict: { ...EMPTY_CONFLICT, status: 'alert', regions: [item.box] },
    })
    const x = mirrored ? 680.5 : 478
    expect(context.strokeRect).toHaveBeenCalledWith(x - 5, 139, 131.5, 298)
    const objectLines = lines.filter(line => line.color === '#d2f56a')
    const conflictLines = lines.filter(line => line.color === '#ff5b4d')
    expect(objectLines).toHaveLength(8)
    expect(conflictLines).toHaveLength(8)
    expect(objectLines.map(({ from, to }) => ({ from, to }))).toEqual(conflictLines.map(({ from, to }) => ({ from, to })))
    expect(objectLines[0]).toMatchObject({ from: { x: x + 18, y: 144 }, to: { x, y: 144 } })
    expect(context.roundRect).toHaveBeenCalledWith(x, 113, 98, 25, 7)
  })

  it('clears an old overlay without drawing while video dimensions are unavailable', () => {
    const { canvas, context } = mockCanvas()
    drawVisionOverlay(canvas, [partialPose({ 0: landmark(.5, .5) })], [], { ...BASE_OPTIONS, source: { width: 0, height: 0 } })
    expect(context.clearRect).toHaveBeenCalled()
    expect(context.arc).not.toHaveBeenCalled()
  })

  it('clears invalid container dimensions without sending NaN to canvas', () => {
    const { canvas, context } = mockCanvas()
    drawVisionOverlay(canvas, [partialPose({ 0: landmark(.5, .5) })], [], { ...BASE_OPTIONS, container: { width: NaN, height: 400 } })
    expect(context.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0)
    expect(context.arc).not.toHaveBeenCalled()
    expect(context.clearRect.mock.calls.flat().every(Number.isFinite)).toBe(true)
  })

  it('respects the skeleton visibility control', () => {
    const { canvas, context } = mockCanvas()
    drawVisionOverlay(canvas, [partialPose({ 0: landmark(.5, .5) })], [], { ...BASE_OPTIONS, showSkeleton: false })
    expect(context.clearRect).toHaveBeenCalled()
    expect(context.arc).not.toHaveBeenCalled()
  })

  it('clears the full backing buffer independently of the DPR transform', () => {
    const { canvas, context } = mockCanvas()
    canvas.width = 1280
    canvas.height = 720
    clearVisionOverlay(canvas)
    expect(context.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0)
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 1280, 720)
    expect(context.save).toHaveBeenCalledOnce()
    expect(context.restore).toHaveBeenCalledOnce()
  })
})
