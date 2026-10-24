import { useCallback, useEffect, useRef, useState } from 'react'
import type { GuardAlert } from './useGuards'

export type IncidentOutcome = 'acknowledged' | 'guard_on_scene' | 'police' | 'cleared' | 'dismissed'
export type Incident = {
  id: string; eventId: string; kind: 'fight' | 'test'
  title: string; detail: string; camera: string
  occurredAt: number; likelihood: number | null
  location: { lat: number; lng: number; label: string | null } | null
  note: string; outcome: IncidentOutcome | null
  timeline: { at: number; label: string; by: string | null }[]
  clip: { bytes: number; type: string; durationMs: number | null; createdAt: number } | null
  still: { bytes: number; createdAt: number } | null
  guards: GuardAlert[]
}
export type NewIncident = Pick<Incident, 'eventId' | 'kind' | 'title' | 'detail' | 'camera' | 'occurredAt' | 'likelihood'>

const BASE = '/api/fight/incidents'
export const clipUrl = (incident: Pick<Incident, 'id' | 'clip'>) => incident.clip ? `${BASE}/${encodeURIComponent(incident.id)}/clip?v=${incident.clip.createdAt}` : null
export const stillUrl = (incident: Pick<Incident, 'id' | 'still'>) => incident.still ? `${BASE}/${encodeURIComponent(incident.id)}/still?v=${incident.still.createdAt}` : null

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { cache: 'no-store', ...init })
  const data = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : 'Could not reach the local NIVRA service.')
  return data as T
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

/** Saved incidents with their clips. Polls while `live` so guard progress and new clips appear. */
export function useIncidents(live: boolean, pollMs = 3_000) {
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const byEvent = useRef(new Map<string, Promise<Incident | null>>())

  const refresh = useCallback(async () => {
    try {
      const result = await request<{ incidents: Incident[] }>('?limit=100')
      setIncidents(Array.isArray(result.incidents) ? result.incidents : [])
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Incidents are unavailable.')
    } finally { setLoaded(true) }
  }, [])

  useEffect(() => {
    let stopped = false
    let timer = 0
    const loop = async () => {
      await refresh()
      if (!stopped && live) timer = window.setTimeout(() => void loop(), pollMs)
    }
    void loop()
    return () => { stopped = true; clearTimeout(timer) }
  }, [live, pollMs, refresh])

  const merge = useCallback((incident: Incident) => {
    setIncidents(previous => [incident, ...previous.filter(item => item.id !== incident.id)].sort((a, b) => b.occurredAt - a.occurredAt))
    return incident
  }, [])

  /** Creates (or returns) the incident for an alert. Safe to call more than once per event. */
  const create = useCallback((incident: NewIncident) => {
    const existing = byEvent.current.get(incident.eventId)
    if (existing) return existing
    const pending = request<Incident>('', json('POST', incident)).then(merge).catch(() => null)
    byEvent.current.set(incident.eventId, pending)
    return pending
  }, [merge])

  const findForEvent = useCallback((eventId: string) => byEvent.current.get(eventId) ?? Promise.resolve(null), [])

  const upload = useCallback(async (id: string, kind: 'clip' | 'still', blob: Blob, durationMs?: number) => {
    const headers: Record<string, string> = { 'Content-Type': blob.type || (kind === 'clip' ? 'video/webm' : 'image/jpeg') }
    if (durationMs) headers['X-Duration-Ms'] = String(Math.round(durationMs))
    return merge(await request<Incident>(`/${encodeURIComponent(id)}/${kind}`, { method: 'PUT', headers, body: blob }))
  }, [merge])

  const log = useCallback(async (id: string, label: string, by?: string) =>
    merge(await request<Incident>(`/${encodeURIComponent(id)}/timeline`, json('POST', { label, by: by ?? null }))), [merge])

  const update = useCallback(async (id: string, patch: Partial<Pick<Incident, 'note' | 'outcome'>>) =>
    merge(await request<Incident>(`/${encodeURIComponent(id)}`, json('PATCH', patch))), [merge])

  const remove = useCallback(async (id: string) => {
    await request<null>(`/${encodeURIComponent(id)}`, { method: 'DELETE' })
    setIncidents(previous => previous.filter(item => item.id !== id))
  }, [])

  return { incidents, error, loaded, refresh, create, findForEvent, upload, log, update, remove }
}

export type IncidentsApi = ReturnType<typeof useIncidents>
