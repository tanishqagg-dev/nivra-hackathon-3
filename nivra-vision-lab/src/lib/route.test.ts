import { describe, expect, it } from 'vitest'
import { parseRoute, routeHref } from './route'

describe('hash routes', () => {
  it('reads page, section and id', () => {
    expect(parseRoute('#/settings/guards')).toEqual({ page: 'settings', section: 'guards', id: null })
    expect(parseRoute('#/incidents//inc_abc')).toEqual({ page: 'incidents', section: 'inc_abc', id: null })
    expect(parseRoute('#/incidents')).toEqual({ page: 'incidents', section: null, id: null })
  })
  it('falls back for empty or unknown hashes', () => {
    expect(parseRoute('').page).toBe('console')
    expect(parseRoute('#/nope', 'setup').page).toBe('setup')
  })
  it('builds hrefs without empty parts', () => {
    expect(routeHref('incidents', null, 'inc_1')).toBe('#/incidents/inc_1')
    expect(routeHref('settings', 'detection')).toBe('#/settings/detection')
  })
})
