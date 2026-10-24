import type { ReviewEvent } from './sceneEngine'

// Scene event ids restart with each source. This makes the alert key unique per page load and event,
// so guard alerts and saved incidents always refer to the same detection.
const PAGE = Math.random().toString(36).slice(2, 10)

export const alertKey = (event: Pick<ReviewEvent, 'id' | 'occurredAtMs'>) => `${PAGE}:${event.id}:${Math.round(event.occurredAtMs)}`
