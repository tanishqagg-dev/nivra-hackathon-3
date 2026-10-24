import { useCallback, useState } from 'react'

/** What an added camera shows. Video files are picked each time, so they are not saved. */
export type CameraSource = { kind: 'camera'; deviceId: string } | { kind: 'usb' } | { kind: 'demo' } | { kind: 'none' }
/** Cameras added beside the main one (CAM-01). Each runs its own MediaPipe detector. */
export type ExtraCamera = { id: string; name: string; source: CameraSource }

const KEY = 'nivra.cameras.v1'
export const MAX_EXTRA_CAMERAS = 3

function read(): ExtraCamera[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string').slice(0, MAX_EXTRA_CAMERAS).map(item => ({
      id: item.id.slice(0, 24), name: item.name.slice(0, 60) || 'Camera',
      source: item.source?.kind === 'camera' && typeof item.source.deviceId === 'string' ? { kind: 'camera', deviceId: item.source.deviceId }
        : item.source?.kind === 'usb' ? { kind: 'usb' } : item.source?.kind === 'demo' ? { kind: 'demo' } : { kind: 'none' },
    }))
  } catch { return [] }
}

/** Events from added cameras carry this prefix so their ids never clash with CAM-01 or each other. */
export const extraEventPrefix = (cameraId: string) => `x:${cameraId}:`
export const cameraIdOfEvent = (eventId: string) => eventId.startsWith('x:') ? eventId.split(':')[1] ?? null : null

export function useCameras() {
  const [cameras, setCameras] = useState(read)
  const save = useCallback((update: (previous: ExtraCamera[]) => ExtraCamera[]) => {
    setCameras(previous => {
      const next = update(previous).slice(0, MAX_EXTRA_CAMERAS)
      try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private mode */ }
      return next
    })
  }, [])
  const add = useCallback((source: CameraSource = { kind: 'none' }, name?: string) => save(previous => {
    const used = new Set(previous.map(item => item.id))
    let n = 2
    while (used.has(`cam${n}`)) n++
    return [...previous, { id: `cam${n}`, name: name ?? `Camera ${n}`, source }]
  }), [save])
  const update = useCallback((id: string, patch: Partial<Omit<ExtraCamera, 'id'>>) => save(previous => previous.map(item => item.id === id ? { ...item, ...patch } : item)), [save])
  const remove = useCallback((id: string) => save(previous => previous.filter(item => item.id !== id)), [save])
  return { cameras, add, update, remove }
}
