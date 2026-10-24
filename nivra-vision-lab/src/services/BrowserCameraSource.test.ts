import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserCameraSource } from './BrowserCameraSource'

describe('BrowserCameraSource', () => {
  afterEach(() => vi.restoreAllMocks())

  it('requests video without audio and stops every track', async () => {
    const stop = vi.fn()
    const stream = {
      getTracks: () => [{ stop }],
    } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(stream)

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) },
    })

    const source = new BrowserCameraSource()
    await source.start()
    source.stop()

    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: false, video: expect.any(Object) }),
    )
    expect(stop).toHaveBeenCalledOnce()
    expect(source.getStream()).toBeNull()
  })

  it('uses an exact device constraint when a camera is selected', async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream
    const getUserMedia = vi.fn().mockResolvedValue(stream)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]) },
    })

    await new BrowserCameraSource().start('camera-two')

    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({ deviceId: { exact: 'camera-two' } }),
      }),
    )
  })

  it('releases a camera granted after the user has pressed stop', async () => {
    const stop = vi.fn()
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream
    let grantPermission!: (stream: MediaStream) => void
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () => new Promise<MediaStream>((resolve) => { grantPermission = resolve }),
      },
    })

    const source = new BrowserCameraSource()
    const pending = source.start()
    source.stop()
    grantPermission(stream)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(stop).toHaveBeenCalledOnce()
    expect(source.getStream()).toBeNull()
  })

  it('keeps the latest camera when earlier permission requests finish out of order', async () => {
    const firstStop = vi.fn()
    const secondStop = vi.fn()
    const first = { getTracks: () => [{ stop: firstStop }] } as unknown as MediaStream
    const second = { getTracks: () => [{ stop: secondStop }] } as unknown as MediaStream
    const pendingRequests: Array<(stream: MediaStream) => void> = []
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: () => new Promise<MediaStream>((resolve) => { pendingRequests.push(resolve) }),
      },
    })

    const source = new BrowserCameraSource()
    const firstRequest = source.start('first')
    const secondRequest = source.start('second')
    pendingRequests[1](second)
    await secondRequest
    pendingRequests[0](first)

    await expect(firstRequest).rejects.toMatchObject({ name: 'AbortError' })
    expect(source.getStream()).toBe(second)
    expect(firstStop).toHaveBeenCalledOnce()
    expect(secondStop).not.toHaveBeenCalled()
  })
})
