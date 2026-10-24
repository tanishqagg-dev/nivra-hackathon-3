export type CameraStatus =
  | 'unsupported'
  | 'idle'
  | 'requesting'
  | 'live'
  | 'permission-denied'
  | 'not-found'
  | 'interrupted'
  | 'error'

export interface CameraState {
  status: CameraStatus
  message: string | null
}

export type CameraAction =
  | { type: 'unsupported' }
  | { type: 'request' }
  | { type: 'started' }
  | { type: 'stopped' }
  | { type: 'interrupted' }
  | { type: 'failed'; error: unknown }

export const initialCameraState: CameraState = {
  status:
    typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
      ? 'idle'
      : 'unsupported',
  message: null,
}

export function cameraReducer(
  state: CameraState,
  action: CameraAction,
): CameraState {
  switch (action.type) {
    case 'unsupported':
      return {
        status: 'unsupported',
        message: 'This browser cannot access a camera.',
      }
    case 'request':
      return { status: 'requesting', message: null }
    case 'started':
      return { status: 'live', message: null }
    case 'stopped':
      return state.status === 'unsupported' ? state : { status: 'idle', message: null }
    case 'interrupted':
      return {
        status: 'interrupted',
        message: 'The camera stream ended unexpectedly. Start it again to resume.',
      }
    case 'failed':
      return cameraErrorState(action.error)
    default:
      return state
  }
}

export function cameraErrorState(error: unknown): CameraState {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return {
        status: 'permission-denied',
        message:
          'Camera access is blocked. Allow camera permission for this site and browser in macOS System Settings → Privacy & Security → Camera, then try again. If the embedded browser stays blocked, open this address in Chrome.',
      }
    }

    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return {
        status: 'not-found',
        message: 'No usable camera was found. Connect a camera and try again.',
      }
    }

    if (error.name === 'NotReadableError' || error.name === 'AbortError') {
      return {
        status: 'error',
        message: 'The camera could not be opened. Close other apps using it, reconnect it if needed, and try again.',
      }
    }
  }

  return {
    status: 'error',
    message: error instanceof Error ? error.message : 'The camera could not start.',
  }
}
