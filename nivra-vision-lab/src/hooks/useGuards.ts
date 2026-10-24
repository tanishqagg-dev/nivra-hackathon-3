import { useCallback, useEffect, useRef, useState } from 'react'

export type Shift = 'on_shift' | 'break' | 'off'
export type Guard = { id: string; name: string; shift: Shift; paired: boolean; online: boolean; lastSeen: number | null }
export type GuardAlert = {
  id: string; guardId: string; guardName: string; eventId: string | null; title: string; detail: string; camera: string
  note: string | null; sentAt: number; ackAt: number | null; declinedAt: number | null; onSceneAt: number | null
  clearedAt: number | null; police: { at: number; by: string } | null; location?: CameraLocation | null
  status: 'sent' | 'acknowledged' | 'declined' | 'on_scene' | 'cleared'; revision: number
}
export type CameraLocation = { lat: number; lng: number; accuracy: number | null; label: string | null; updatedAt: number }
export type GuardSnapshot = { guards: Guard[]; alerts: GuardAlert[]; lan: { host: string | null; port: number }; publicUrl?: string | null; location?: CameraLocation | null }
export type SendRequest = { guardId: string; eventId: string; title: string; detail: string; camera: string; note?: string }

/** The site's emergency number. India uses 112. */
export const POLICE_NUMBER = '112'

async function guardRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/fight/guards${path}`, {
    method, cache: 'no-store',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  const data = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : 'Could not reach the local NIVRA service.')
  return data as T
}

export function useGuards(pollMs = 2_000) {
  const [snapshot, setSnapshot] = useState<GuardSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refreshRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    let stopped = false
    let timer = 0
    const refresh = async () => {
      try {
        const next = await guardRequest<GuardSnapshot>('')
        if (stopped) return
        setSnapshot(next)
        setError(null)
      } catch (reason) {
        if (!stopped) setError(reason instanceof Error ? reason.message : 'Guard service unavailable.')
      }
    }
    refreshRef.current = refresh
    const loop = async () => {
      await refresh()
      if (!stopped) timer = window.setTimeout(() => void loop(), pollMs)
    }
    void loop()
    return () => { stopped = true; clearTimeout(timer) }
  }, [pollMs])

  const run = useCallback(async <T,>(path: string, method: string, body?: unknown) => {
    const result = await guardRequest<T>(path, method, body)
    await refreshRef.current()
    return result
  }, [])

  return {
    snapshot, error,
    addGuard: (name: string) => run<Guard>('', 'POST', { name }),
    removeGuard: (id: string) => run<null>(`/${encodeURIComponent(id)}`, 'DELETE'),
    invite: (id: string) => guardRequest<{ url: string; expiresInSeconds: number }>(`/${encodeURIComponent(id)}/invite`, 'POST'),
    send: (request: SendRequest) => run<GuardAlert>('/alerts', 'POST', request),
    recordPolice: (alertId: string) => run<GuardAlert>(`/alerts/${encodeURIComponent(alertId)}/police`, 'POST'),
    setLocation: (location: { lat: number; lng: number; accuracy?: number | null; label?: string } | null) => run<CameraLocation>('/location', 'PUT', location ?? {}),
    clearAlert: (alertId: string) => run<GuardAlert>(`/alerts/${encodeURIComponent(alertId)}/clear`, 'POST'),
  }
}

export type GuardsApi = ReturnType<typeof useGuards>
