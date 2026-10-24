import { useCallback, useState } from 'react'

/** Site details the owner enters once during setup. Kept in this browser only. */
export type SiteSettings = { siteName: string; cameraName: string; setupDone: boolean; setupStep: number }

const KEY = 'nivra.site.v1'
const DEFAULTS: SiteSettings = { siteName: '', cameraName: 'Camera 1', setupDone: false, setupStep: 0 }

export function readSite(): SiteSettings {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (!value || typeof value !== 'object') return DEFAULTS
    return {
      siteName: typeof value.siteName === 'string' ? value.siteName.slice(0, 80) : '',
      cameraName: typeof value.cameraName === 'string' && value.cameraName.trim() ? value.cameraName.slice(0, 60) : DEFAULTS.cameraName,
      setupDone: value.setupDone === true,
      setupStep: Number.isInteger(value.setupStep) ? Math.min(4, Math.max(0, value.setupStep)) : 0,
    }
  } catch { return DEFAULTS }
}

export function useSite() {
  const [site, setSite] = useState(readSite)
  const update = useCallback((patch: Partial<SiteSettings>) => {
    setSite(previous => {
      const next = { ...previous, ...patch }
      try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private mode keeps it for this tab */ }
      return next
    })
  }, [])
  return { site, update }
}
