/**
 * Google Map of the camera, embedded without an API key (the same map the guard phone shows).
 * Loads lazily. "Open in Google Maps" gives directions in a new tab.
 */
export function MiniMap({ lat, lng, label, height = 150 }: { lat: number; lng: number; label?: string | null; height?: number }) {
  const query = `${lat},${lng}`
  const src = `https://maps.google.com/maps?q=${encodeURIComponent(query)}&z=17&hl=en&output=embed`
  const href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
  return (
    <figure className="mini-map" style={{ height }} data-testid="mini-map">
      <iframe src={src} title={`Map of ${label || 'the camera location'}`} loading="lazy" referrerPolicy="no-referrer-when-downgrade" allowFullScreen />
      <figcaption>
        {label ? <span className="mini-map-label">{label}</span> : <span />}
        <a className="mini-map-open" href={href} target="_blank" rel="noreferrer">Open in Google Maps ↗</a>
      </figcaption>
    </figure>
  )
}
