import { afterEach, describe, expect, it } from 'vitest'
import { readSite } from './site'

describe('saved site settings', () => {
  afterEach(() => localStorage.clear())
  it('defaults to a first run', () => {
    expect(readSite()).toEqual({ siteName: '', cameraName: 'Camera 1', setupDone: false, setupStep: 0 })
  })
  it('keeps valid values and clamps the rest', () => {
    localStorage.setItem('nivra.site.v1', JSON.stringify({ siteName: 'Gate', cameraName: ' ', setupDone: true, setupStep: 9 }))
    expect(readSite()).toEqual({ siteName: 'Gate', cameraName: 'Camera 1', setupDone: true, setupStep: 4 })
  })
  it('ignores broken storage', () => {
    localStorage.setItem('nivra.site.v1', '{oops')
    expect(readSite().setupDone).toBe(false)
  })
})
