import { describe, expect, it } from 'vitest'
import { parseLocation } from '../lib/parseLocation'

describe('camera location input', () => {
  it('reads plain coordinates and Google Maps links', () => {
    expect(parseLocation('28.6139, 77.2090')).toEqual({ lat: 28.6139, lng: 77.209 })
    expect(parseLocation('https://www.google.com/maps/place/X/@28.61,77.21,17z')).toEqual({ lat: 28.61, lng: 77.21 })
    expect(parseLocation('https://maps.google.com/?q=12.97,77.59')).toEqual({ lat: 12.97, lng: 77.59 })
  })
  it('rejects text, out-of-range and zero points', () => {
    expect(parseLocation('Main gate')).toBeNull()
    expect(parseLocation('95, 10')).toBeNull()
    expect(parseLocation('0, 0')).toBeNull()
  })
})
