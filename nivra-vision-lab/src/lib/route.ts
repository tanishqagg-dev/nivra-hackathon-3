import { useCallback, useEffect, useState } from 'react'

/** Pages of the operator app. The hash keeps them working from any static host and in tests. */
export type Page = 'console' | 'setup' | 'incidents' | 'settings'
export type Route = { page: Page; section: string | null; id: string | null }

const PAGES: readonly Page[] = ['console', 'setup', 'incidents', 'settings']

export function parseRoute(hash: string, fallback: Page = 'console'): Route {
  const [page, section = null, id = null] = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (!PAGES.includes(page as Page)) return { page: fallback, section: null, id: null }
  return { page: page as Page, section, id }
}

export function routeHref(page: Page, section?: string | null, id?: string | null) {
  return `#/${[page, section, id].filter(Boolean).join('/')}`
}

/** Current route plus a navigate function. `fallback` is used when the hash is empty or unknown. */
export function useRoute(fallback: Page = 'console') {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash, fallback))

  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.hash, fallback))
    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [fallback])

  const navigate = useCallback((page: Page, section?: string | null, id?: string | null) => {
    const href = routeHref(page, section, id)
    if (window.location.hash !== href) window.location.hash = href
    else setRoute(parseRoute(href, fallback))
  }, [fallback])

  return { route, navigate }
}
