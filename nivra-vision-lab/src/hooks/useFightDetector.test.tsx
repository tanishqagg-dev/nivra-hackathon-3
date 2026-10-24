import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFightDetector } from './useFightDetector'

describe('live fight inference lifecycle', () => {
  let video: HTMLVideoElement
  let paused: boolean
  let prediction: () => Promise<Response>
  const scores: number[] = []
  const response = (value: unknown) => Promise.resolve({ ok: true, json: async () => value } as Response)
  const predictionResponse = (score: number) => response({ score, aboveThreshold: score >= .4, threshold: .4, inferenceMs: 50, agreement: { votes: score >= .4 ? 2 : 0, required: 2 } })
  const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
    paused = false
    scores.length = 0
    video = document.createElement('video')
    Object.defineProperties(video, {
      paused: { get: () => paused }, ended: { value: false }, readyState: { value: 4 },
      videoWidth: { value: 640 }, currentTime: { get: () => Date.now() / 1000 },
    })
    const context = { drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray(0) }), putImageData: vi.fn() }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['frames'], { type: 'image/jpeg' })))
    prediction = () => predictionResponse(scores.shift() ?? .1)
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('health')
      ? response({ ready: true, device: 'cpu', engine: 'consensus-v2', requiredVotes: 2 }) : prediction()))
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('requires two complete positive windows and clears everything when stopped', async () => {
    scores.push(.8, .9)
    const ref = { current: video }
    const { result, rerender } = renderHook(({ active }) => useFightDetector(ref, active, 1), { initialProps: { active: true } })
    await advance(4_000)
    expect(result.current.prediction?.score).toBe(.8)
    expect(result.current.events).toHaveLength(0)
    await advance(1_000)
    expect(result.current.events).toHaveLength(1)
    expect(result.current.status).toBe('alert')
    rerender({ active: false })
    await advance(50)
    expect(result.current.events).toHaveLength(0)
    expect(result.current.prediction).toBeNull()
    expect(result.current.status).toBe('ready')
  })

  it('rejects a delayed result after the camera pauses and warms up from fresh frames', async () => {
    let resolve: (response: Response) => void = () => undefined
    prediction = () => new Promise<Response>(accept => { resolve = accept })
    const ref = { current: video }
    const { result } = renderHook(() => useFightDetector(ref, true, 1))
    await advance(4_000)
    paused = true
    await advance(1_000)
    await act(async () => { resolve(await predictionResponse(.9)) })
    expect(result.current.prediction).toBeNull()
    expect(result.current.streak).toBe(0)
    expect(result.current.events).toHaveLength(0)
    prediction = () => predictionResponse(.8)
    paused = false
    await advance(4_000)
    expect(result.current.prediction?.score).toBe(.8)
    expect(result.current.events).toHaveLength(0)
  })

  it('clears stale evidence on backend failure and recovers without carrying a positive streak', async () => {
    scores.push(.8)
    const ref = { current: video }
    const { result } = renderHook(() => useFightDetector(ref, true, 1))
    await advance(4_000)
    expect(result.current.streak).toBe(1)
    prediction = async () => { throw new Error('Backend disconnected') }
    await advance(1_000)
    expect(result.current.status).toBe('error')
    expect(result.current.prediction).toBeNull()
    expect(result.current.streak).toBe(0)
    prediction = () => predictionResponse(.8)
    await advance(7_100)
    expect(result.current.streak).toBe(1)
    expect(result.current.events).toHaveLength(0)
  })

  it('rejects a backend claiming a positive window from only one model', async () => {
    prediction = () => response({ score: .95, aboveThreshold: true, threshold: .4, inferenceMs: 10,
      agreement: { votes: 1, required: 2 } })
    const ref = { current: video }
    const { result } = renderHook(() => useFightDetector(ref, true, 1))
    await advance(4_000)
    expect(result.current.status).toBe('error')
    expect(result.current.events).toHaveLength(0)
    expect(result.current.prediction).toBeNull()
  })
})
