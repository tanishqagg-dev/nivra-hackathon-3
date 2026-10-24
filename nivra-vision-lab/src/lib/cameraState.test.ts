import { describe, expect, it } from 'vitest'
import { cameraErrorState, cameraReducer, type CameraState } from './cameraState'

describe('camera state', () => {
  const idle: CameraState = { status: 'idle', message: null }

  it('moves through request, live, and stopped states', () => {
    const requesting = cameraReducer(idle, { type: 'request' })
    const live = cameraReducer(requesting, { type: 'started' })
    const stopped = cameraReducer(live, { type: 'stopped' })

    expect(requesting.status).toBe('requesting')
    expect(live.status).toBe('live')
    expect(stopped).toEqual(idle)
  })

  it('provides a recovery message for denied permission', () => {
    const result = cameraErrorState(new DOMException('Denied', 'NotAllowedError'))

    expect(result.status).toBe('permission-denied')
    expect(result.message).toContain('Allow camera permission')
  })

  it('distinguishes a missing camera', () => {
    const result = cameraErrorState(new DOMException('Missing', 'NotFoundError'))

    expect(result.status).toBe('not-found')
  })

  it('keeps unsupported cameras unavailable after cleanup', () => {
    const unavailable = cameraReducer(idle, { type: 'unsupported' })
    expect(cameraReducer(unavailable, { type: 'stopped' })).toEqual(unavailable)
  })

  it('explains a busy or unreadable camera', () => {
    const result = cameraErrorState(new DOMException('Busy', 'NotReadableError'))
    expect(result.status).toBe('error')
    expect(result.message).toContain('Close other apps')
  })
})
