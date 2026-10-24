// NIVRA guard phone. Served on the Mac's Wi-Fi address; no build step.
'use strict'

// India's single emergency number. Change here if the site uses another.
const POLICE_NUMBER = '112'
const SECRET_KEY = 'nivra.guard.secret'
const POLL_MS = 1500

const root = document.getElementById('app')
const link = document.getElementById('link')
let secret = null
try { secret = localStorage.getItem(SECRET_KEY) } catch { /* private mode */ }
let state = null
let problem = ''
let busy = false
let ringTimer = 0
let failures = 0

function h(tag, props, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue
    if (key.startsWith('on')) {
      const event = key.slice(2)
      node.addEventListener(event, value)
      ;(node._events ||= {})[event] = value
    }
    else if (key === 'class') node.className = value
    else node.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child)
  return node
}

// Keep live maps, media and the slider mounted while other parts of the page change.
// Fresh event handlers still receive the newest alert data.
function reconcile(parent, children) {
  const wanted = children.filter(Boolean)
  const old = [...parent.childNodes]
  const keys = new Set(wanted.filter(node => node.nodeType === 1).map(node => node.dataset.key).filter(Boolean))
  // Remove retired keyed siblings first so an unchanged iframe never needs a DOM move.
  for (const node of old) if (node.nodeType === 1 && node.dataset.key && !keys.has(node.dataset.key)) node.remove()
  const used = new Set()
  wanted.forEach((fresh, index) => {
    const key = fresh.nodeType === 1 ? fresh.dataset.key : null
    const current = key
      ? old.find(node => !used.has(node) && node.nodeType === 1 && node.dataset.key === key)
      : old.find(node => !used.has(node) && !(node.nodeType === 1 && node.dataset.key) && node.nodeType === fresh.nodeType && node.nodeName === fresh.nodeName)
    let node = fresh
    if (current && current.nodeName === fresh.nodeName) {
      node = current
      if (node.nodeType === 3) {
        if (node.textContent !== fresh.textContent) node.textContent = fresh.textContent
      } else if (!fresh.hasAttribute('data-retain')) {
        for (const attr of [...node.attributes]) if (!fresh.hasAttribute(attr.name)) node.removeAttribute(attr.name)
        for (const attr of [...fresh.attributes]) if (node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value)
        for (const [event, handler] of Object.entries(node._events || {})) node.removeEventListener(event, handler)
        node._events = fresh._events
        for (const [event, handler] of Object.entries(node._events || {})) node.addEventListener(event, handler)
        reconcile(node, [...fresh.childNodes])
      }
    }
    used.add(node)
    if (parent.childNodes[index] !== node) parent.insertBefore(node, parent.childNodes[index] || null)
  })
  for (const node of old) if (!used.has(node)) node.remove()
}

function icon(name) {
  const paths = {
    arrow: 'M4 12h16m-6-6 6 6-6 6',
    phone: 'M8 3H5a2 2 0 0 0-2 2c0 8.8 7.2 16 16 16a2 2 0 0 0 2-2v-3l-5-2-2 2a14 14 0 0 1-6-6l2-2-2-5Z',
    pin: 'M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0ZM14.5 10a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
    check: 'm5 12 4 4L19 6',
    shield: 'm12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z',
    sound: 'm11 4-6 5H2v6h3l6 5V4Zm4 4c2 2 2 6 0 8m3-11c4 4 4 10 0 14',
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon' })) svg.setAttribute(key, value)
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', paths[name] || paths.arrow)
  svg.append(path)
  return svg
}

async function call(path, method = 'GET', body) {
  const response = await fetch(path, {
    method, cache: 'no-store',
    headers: { ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(data && typeof data.detail === 'string' ? data.detail : 'Could not reach NIVRA on the Mac.')
    error.status = response.status
    if (secret && (response.status === 401 || response.status === 403)) forget(error.message)
    throw error
  }
  return data
}

function forget(message) {
  secret = null; state = null
  try { localStorage.removeItem(SECRET_KEY) } catch { /* ignore */ }
  problem = message
  stopRing()
  pruneMedia()
  link.dataset.state = 'offline'; link.textContent = 'Not linked'
  render()
}

async function pairFromLink() {
  const token = new URLSearchParams(location.hash.slice(1)).get('pair')
  if (!token) return
  history.replaceState(null, '', location.pathname)
  try {
    const result = await call('/guard/api/pair', 'POST', { token })
    secret = result.secret
    try { localStorage.setItem(SECRET_KEY, secret) } catch { /* stays for this tab */ }
    problem = ''
  } catch (error) { problem = error.message }
}

async function poll() {
  if (secret) {
    try {
      state = await call('/guard/api/state')
      failures = 0
      if (problem.startsWith('Lost')) problem = ''
      link.dataset.state = 'online'; link.textContent = 'Connected'
    } catch (error) {
      if (error.status === 401 || error.status === 403) { forget(error.message); link.dataset.state = 'offline'; link.textContent = 'Not linked' }
      else if (++failures >= 3) { link.dataset.state = 'offline'; link.textContent = 'Reconnecting'; problem = 'Lost connection to the Mac. Stay on the same Wi-Fi.' }
    }
  } else { link.dataset.state = 'offline'; link.textContent = 'Not linked' }
  syncRing()
  syncMedia()
  if (!busy && !sliding) renderIfChanged()
  setTimeout(poll, POLL_MS)
}

const ringing = alert => alert.status === 'sent'

// Phones block sound until a tap. The guard taps Enable alarm sound once per page load.
// A looping <audio> siren plays through the media channel, which iOS lets ignore the ringer switch.
let soundReady = false
let siren = null
let wakeLock = null

function sirenUrl() {
  const rate = 22050, seconds = 2, count = rate * seconds
  const data = new DataView(new ArrayBuffer(44 + count * 2))
  const text = (offset, value) => [...value].forEach((char, index) => data.setUint8(offset + index, char.charCodeAt(0)))
  text(0, 'RIFF'); data.setUint32(4, 36 + count * 2, true); text(8, 'WAVE'); text(12, 'fmt ')
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true)
  data.setUint32(24, rate, true); data.setUint32(28, rate * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true)
  text(36, 'data'); data.setUint32(40, count * 2, true)
  let phase = 0
  for (let index = 0; index < count; index++) {
    const t = index / rate
    // Two-tone wailing siren, square-ish wave clipped for maximum loudness.
    const freq = (Math.floor(t * 4) % 2 ? 1250 : 950) + 120 * Math.sin(t * 2 * Math.PI * 6)
    phase += 2 * Math.PI * freq / rate
    const sample = Math.max(-1, Math.min(1, Math.sin(phase) * 3 + Math.sin(phase * 3) * 0.6))
    data.setInt16(44 + index * 2, sample * 32000, true)
  }
  return URL.createObjectURL(new Blob([data], { type: 'audio/wav' }))
}

function unlockAudio() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback' } catch { /* older Safari */ }
  if (!siren) {
    siren = new Audio(sirenUrl())
    siren.loop = true
    siren.preload = 'auto'
    siren.setAttribute('playsinline', '')
  }
  siren.volume = 1
  // Playing inside the tap is what unlocks later plays without a tap.
  return siren.play().then(() => {
    if (!ringTimer) { siren.pause(); siren.currentTime = 0 }
    if (!soundReady) { soundReady = true; if (!sliding) render() }
    return true
  }).catch(() => false)
}

async function testSound() {
  if (!(await unlockAudio())) { problem = 'Sound is blocked. Turn up the volume and tap again.'; render(); return }
  siren.currentTime = 0
  await siren.play().catch(() => {})
  setTimeout(() => { if (!ringTimer) { siren.pause(); siren.currentTime = 0 } }, 1200)
}

async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen')
      wakeLock.addEventListener('release', () => { wakeLock = null })
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null }
  } catch { wakeLock = null }
}

function vibrate(pattern) {
  if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(pattern)
}

function beep() {
  vibrate([600, 200, 600, 200, 600])
  if (siren && siren.paused) { siren.currentTime = 0; void siren.play().catch(() => {}) }
}

function syncRing() {
  const should = !!state && state.alerts.some(ringing)
  if (should && !ringTimer) { beep(); ringTimer = setInterval(beep, 2000); document.body.classList.add('is-ringing') }
  if (!should) stopRing()
  void keepAwake(!!state && (state.guard.shift === 'on_shift' || should))
}
function stopRing() {
  clearInterval(ringTimer); ringTimer = 0
  vibrate(0)
  if (siren) { siren.pause(); siren.currentTime = 0 }
  document.body.classList.remove('is-ringing')
}

async function act(alert, action) {
  if (!soundReady) void unlockAudio()
  busy = true; render()
  try {
    const updated = await call(`/guard/api/alerts/${encodeURIComponent(alert.id)}`, 'POST', { action })
    state.alerts = state.alerts.map(item => item.id === updated.id ? updated : item)
    problem = ''
  } catch (error) {
    if (action === 'ack') slideRevision++
    problem = error.message
  }
  busy = false; syncRing(); render()
}

async function setShift(shift) {
  if (!soundReady) void unlockAudio()
  busy = true; render()
  try { state.guard = await call('/guard/api/shift', 'POST', { shift }); problem = '' }
  catch (error) { problem = error.message }
  busy = false; render()
}

function police(alert) {
  // The tap dials the phone's own dialer. The record tells the Mac a person called.
  fetch(`/guard/api/alerts/${encodeURIComponent(alert.id)}`, {
    method: 'POST', keepalive: true,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'police' }),
  }).catch(() => {})
}

function ago(ms) {
  const seconds = Math.max(0, Math.round(((state?.serverTime ?? Date.now()) - ms) / 1000))
  if (seconds < 5) return 'Now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}
const clock = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// Map of the camera's position, with turn-by-turn directions from the guard's phone.
function mapBlock(where) {
  const point = `${where.lat},${where.lng}`
  const frame = h('iframe', {
    class: 'map-frame', title: `Map of ${where.label || 'the camera'}`, loading: 'lazy', referrerpolicy: 'no-referrer-when-downgrade',
    src: `https://www.google.com/maps?q=${encodeURIComponent(point)}&z=18&output=embed`,
  })
  return h('div', { class: 'map', 'data-key': `map:${point}:${where.label || ''}:${where.accuracy || ''}`, 'data-retain': true },
    h('p', { class: 'map-label' }, icon('pin'), h('strong', {}, where.label || 'Camera location'),
      where.accuracy ? ` · within ~${where.accuracy} m` : ''),
    frame,
    h('a', { class: 'btn outline', href: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(point)}&travelmode=walking`, target: '_blank', rel: 'noopener' }, 'Directions', icon('arrow')),
  )
}

// Drag the thumb to the end to stop the alarm and acknowledge. Harder to hit by accident than a tap.
let sliding = false
let slideRevision = 0
function slideToStop(alert) {
  const thumb = h('span', { class: 'slide-thumb', 'aria-hidden': 'true' }, icon('arrow'))
  const fill = h('span', { class: 'slide-fill', 'aria-hidden': 'true' })
  const label = h('span', { class: 'slide-text' }, 'Slide to stop alarm')
  const track = h('div', {
    class: 'slide', 'data-key': `slide:${alert.id}:${slideRevision}`, 'data-retain': true, role: 'slider', tabindex: '0', 'aria-label': 'Slide to stop alarm and acknowledge',
    'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
  }, fill, label, thumb)
  let start = 0, offset = 0, max = 0, done = false
  const place = (value, animate) => {
    offset = Math.max(0, Math.min(max, value))
    const share = max ? offset / max : 0
    const motion = animate && !matchMedia('(prefers-reduced-motion: reduce)').matches
    for (const node of [thumb, fill]) node.style.transition = motion ? 'transform 350ms cubic-bezier(.25,1,.5,1)' : 'none'
    track.classList.toggle('is-sliding', share > 0)
    thumb.style.transform = `translateX(${offset}px)`
    fill.style.transform = `scaleX(${(offset + thumb.offsetWidth + 4) / track.clientWidth})`
    label.style.opacity = String(1 - share * 1.4)
    track.setAttribute('aria-valuenow', String(Math.round(share * 100)))
  }
  const finish = () => {
    sliding = false
    if (done) return
    if (max && offset >= max * 0.88) {
      done = true
      place(max, true)
      label.textContent = 'Stopping…'
      label.style.opacity = '1'
      void act(alert, 'ack')
    } else place(0, true)
  }
  thumb.addEventListener('pointerdown', event => {
    if (busy || done) return
    if (!soundReady) void unlockAudio()
    sliding = true
    max = track.clientWidth - thumb.offsetWidth - 12
    start = event.clientX - offset
    try { thumb.setPointerCapture(event.pointerId) } catch { /* synthetic or lost pointer */ }
    event.preventDefault()
  })
  thumb.addEventListener('pointermove', event => { if (sliding) place(event.clientX - start, false) })
  thumb.addEventListener('pointerup', finish)
  thumb.addEventListener('pointercancel', () => { sliding = false; if (!done) place(0, true) })
  // Keyboard and switch access: Enter or arrow-right to the end.
  track.addEventListener('keydown', event => {
    if (done || busy) return
    if (event.key === 'Enter' || event.key === 'ArrowRight' || event.key === 'End') {
      event.preventDefault()
      max = track.clientWidth - thumb.offsetWidth - 12
      place(max, true); finish()
    }
  })
  return track
}

// Authenticated footage never puts the pairing secret into a URL.
// Each asset is cached per open alert. A not-ready route gets a backed-off retry.
const mediaCache = new Map()
function pruneMedia() {
  const active = new Set(state?.alerts.filter(alert => alert.status !== 'cleared').map(alert => alert.id) || [])
  for (const [id, entry] of mediaCache) if (!active.has(id)) {
    entry.controller.abort()
    for (const kind of ['clip', 'still']) if (entry[kind]?.url) URL.revokeObjectURL(entry[kind].url)
    mediaCache.delete(id)
  }
}
function mediaBlock(alert) {
  return h('div', { class: 'media', 'data-key': `media:${alert.id}`, 'data-retain': true, 'data-media-id': alert.id, 'aria-label': 'Camera footage' },
    h('div', { class: 'media-placeholder' }, icon('shield'), h('span', {}, 'Clip arrives in a few seconds')))
}
function paintMedia(id, entry) {
  const slot = [...root.querySelectorAll('[data-media-id]')].find(node => node.dataset.mediaId === id)
  if (!slot) return
  const kind = entry.clip?.url ? 'clip' : entry.still?.url ? 'still' : null
  if (!kind || slot.dataset.showing === kind) return
  slot.dataset.showing = kind
  if (kind === 'clip') {
    const video = h('video', { src: entry.clip.url, muted: true, autoplay: true, loop: true, playsinline: true, 'aria-label': 'Five-second camera clip' })
    video.muted = true
    if (entry.still?.url) video.poster = entry.still.url
    const duration = h('span', { class: 'media-badge' }, '0:05')
    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration)) duration.textContent = `0:${String(Math.round(video.duration)).padStart(2, '0')}`
    })
    slot.replaceChildren(video, duration)
    void video.play().catch(() => {})
  } else slot.replaceChildren(h('img', { src: entry.still.url, alt: 'Camera still from this alert' }), h('span', { class: 'media-badge' }, 'Still · clip on its way'))
}
async function fetchMedia(alert, kind, entry) {
  const asset = entry[kind] ||= { url: null, pending: false, tries: 0, retryAt: 0 }
  if (asset.url || asset.pending || Date.now() < asset.retryAt) return
  asset.pending = true
  try {
    const response = await fetch(`/guard/api/alerts/${encodeURIComponent(alert.id)}/${kind}`, {
      headers: { Authorization: `Bearer ${secret}` }, cache: 'no-store', signal: entry.controller.signal,
    })
    if (response.status === 401 || response.status === 403) { forget('This phone is no longer linked. Ask for a new guard QR.'); return }
    if (!response.ok) throw new Error('Footage is not ready')
    const blob = await response.blob()
    if (mediaCache.get(alert.id) !== entry) return
    asset.url = URL.createObjectURL(blob)
    paintMedia(alert.id, entry)
  } catch {
    asset.retryAt = Date.now() + Math.min(30000, 5000 * 2 ** Math.min(asset.tries++, 3))
  } finally { asset.pending = false }
}
function syncMedia() {
  pruneMedia()
  for (const alert of state?.alerts || []) {
    if (alert.status === 'cleared') continue
    let entry = mediaCache.get(alert.id)
    if (!entry) { entry = { controller: new AbortController() }; mediaCache.set(alert.id, entry) }
    paintMedia(alert.id, entry)
    if (alert.clip) void fetchMedia(alert, 'clip', entry)
    if (alert.still && !entry.clip?.url) void fetchMedia(alert, 'still', entry)
  }
}

function progress(alert) {
  return h('ol', { class: 'steps', 'data-key': 'steps', 'aria-label': 'Response progress' },
    ...[['Answered', alert.ackAt], ['On scene', alert.onSceneAt], ['Cleared', alert.clearedAt]].map(([label, at]) =>
      h('li', { class: at ? 'done' : '' },
        h('span', { class: 'step-dot', 'aria-hidden': 'true' }, h('span', { class: 'step-fill' }, icon('check'))),
        h('span', {}, label), h('time', {}, at ? clock(at) : 'Pending'))))
}

function alertCard(alert) {
  const actions = []
  if (alert.status === 'sent') {
    actions.push(slideToStop(alert))
    actions.push(h('button', { class: 'btn quiet', disabled: busy, onclick: () => act(alert, 'decline') }, "Can't respond"))
  } else if (alert.status === 'acknowledged') {
    actions.push(h('button', { class: 'btn solid', disabled: busy, onclick: () => act(alert, 'on_scene') }, "I'm on scene", icon('arrow')))
    actions.push(h('button', { class: 'btn outline', disabled: busy, onclick: () => act(alert, 'clear') }, 'Clear alert', icon('check')))
  } else if (alert.status === 'on_scene' || alert.status === 'declined') {
    actions.push(h('button', { class: 'btn outline', disabled: busy, onclick: () => act(alert, 'clear') }, 'Clear alert', icon('check')))
  }
  const status = ringing(alert) ? 'Alarm ringing' : alert.status === 'on_scene' ? 'On scene' : alert.status === 'declined' ? "Can't respond" : 'Responding'
  const previous = [...root.querySelectorAll('.alert')].find(node => node.dataset.key === `alert:${alert.id}`)?.querySelector('.status-text')?.textContent
  return h('section', { class: `alert ${ringing(alert) ? 'is-ringing' : 'is-handled'}`, 'data-key': `alert:${alert.id}`, 'aria-label': alert.title },
    h('div', { class: 'alert-heading', 'data-key': `heading:${alert.status}` },
      h('div', { class: 'alert-top' }, h('span', { class: ringing(alert) ? 'ring' : 'status-tag', role: 'status' }, h('span', { class: 'status-text' }, status), previous && previous !== status ? h('span', { class: 'status-previous', 'aria-hidden': 'true' }, previous) : null), h('time', { 'data-sent': String(alert.sentAt) }, ago(alert.sentAt))),
      h('h2', {}, alert.title),
      h('p', { class: 'where' }, alert.camera, h('span', { 'aria-hidden': 'true' }, ' · '), h('time', {}, clock(alert.sentAt))),
      alert.detail ? h('p', { class: 'detail' }, alert.detail) : null,
      alert.note ? h('p', { class: 'note' }, alert.note) : null),
    mediaBlock(alert),
    alert.location ? mapBlock(alert.location) : null,
    !ringing(alert) ? progress(alert) : null,
    h('div', { class: 'actions', 'data-key': `actions:${alert.status}` }, actions),
    h('div', { class: 'police-block', 'data-key': 'police' },
      h('a', { class: 'btn police', href: `tel:${POLICE_NUMBER}`, onclick: () => police(alert) }, icon('phone'), `Call police · ${POLICE_NUMBER}`),
      h('p', { class: 'police-note' }, 'Only after you check the scene.'),
      alert.police ? h('p', { class: 'police-done' }, `Police call recorded · ${alert.police.by} · ${clock(alert.police.at)}`) : null))
}

// Redraw only when what the guard sees changes, so the map does not reload every poll.
let lastView = ''
function renderIfChanged() {
  const view = JSON.stringify([secret, problem, soundReady, state && { name: state.guard.name, shift: state.guard.shift, alerts: state.alerts }])
  if (view !== lastView) { render(); return }
  for (const node of root.querySelectorAll('time[data-sent]')) node.textContent = ago(Number(node.dataset.sent))
}

function shiftControl(guard) {
  return h('div', { class: 'shift', role: 'group', 'aria-label': 'Shift' },
    ...[['on_shift', 'On shift'], ['break', 'Break'], ['off', 'Off']].map(([value, label]) =>
      h('button', { 'aria-pressed': String(guard.shift === value), disabled: busy, onclick: () => setShift(value) }, label)))
}

function render() {
  if (sliding) return
  lastView = JSON.stringify([secret, problem, soundReady, state && { name: state.guard.name, shift: state.guard.shift, alerts: state.alerts }])
  const content = []
  if (problem) content.push(h('p', { class: 'problem', role: 'alert', 'data-key': 'problem' }, problem))
  if (!secret) {
    content.push(h('section', { class: 'hero', 'data-key': 'unpaired' },
      h('span', { class: 'hero-icon' }, icon('shield')),
      h('p', { class: 'eyebrow' }, 'Guard phone'),
      h('h1', {}, 'Link this phone.'),
      h('p', { class: 'sub' }, 'Your alerts. One place.'),
      h('ol', { class: 'pair-steps' },
        h('li', {}, 'On the Mac, open Guards.'),
        h('li', {}, 'Add your name and show the QR.'),
        h('li', {}, "Scan it with this phone's camera.")),
      h('p', { class: 'pair-note' }, icon('phone'), 'Keep this page open once linked.')))
  } else if (!state) content.push(h('section', { class: 'hero', 'data-key': 'connecting' }, icon('shield'), h('h1', {}, 'Connecting.'), h('p', { class: 'sub' }, 'Finding your guard connection.')))
  else {
    const { guard, alerts } = state
    const open = alerts.filter(alert => alert.status !== 'cleared')
    const done = alerts.filter(alert => alert.status === 'cleared')
    const onShift = guard.shift === 'on_shift'
    root.classList.toggle('has-alert', open.length > 0)
    content.push(h('div', { class: 'who', 'data-key': 'who' },
      h('p', {}, guard.name, h('span', {}, onShift ? 'On shift' : guard.shift === 'break' ? 'On break' : 'Off shift')),
      soundReady ? h('button', { class: 'chip', onclick: () => void testSound() }, icon('sound'), 'Test alarm') : null))
    if (open.length) content.push(...open.map(alertCard))
    else content.push(h('section', { class: `calm ${onShift ? 'is-on' : ''}`, 'data-key': `calm:${guard.shift}` },
      h('span', { class: 'calm-ring', 'aria-hidden': 'true' }, icon('shield')),
      h('h1', {}, onShift ? 'All clear' : guard.shift === 'break' ? 'On a break' : 'Off shift'),
      h('p', {}, onShift ? "You're ready for the next alert." : 'Choose On shift to receive alerts.'),
      onShift ? h('p', { class: 'calm-hint' }, 'Keep this page open.') : null))
    if (!soundReady) content.push(h('div', { class: 'sound-setup', 'data-key': 'sound' },
      h('button', { class: 'btn solid sound-gate', onclick: () => void testSound() }, icon('sound'), 'Enable alarm sound', icon('arrow')),
      h('p', {}, 'Tap once. Turn your volume all the way up.')))
    content.push(h('section', { class: 'panel shift-panel', 'data-key': 'shift' }, h('p', { class: 'label' }, 'Your shift'), shiftControl(guard)))
    if (done.length) content.push(h('section', { class: 'panel history', 'data-key': 'history' }, h('h2', { class: 'label' }, 'Cleared · last 30 min'),
      h('ol', {}, ...done.map(alert => h('li', { 'data-key': alert.id }, icon('check'), h('span', {}, h('strong', {}, alert.title), h('span', {}, alert.location?.label || alert.camera)), h('time', {}, clock(alert.clearedAt)))))))
    content.push(h('p', { class: 'foot', 'data-key': 'foot' }, 'Keep the screen on. Locked phones may not ring.'))
  }
  reconcile(root, content)
  syncMedia()
}

document.addEventListener('click', () => { if (!soundReady) void unlockAudio() })
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { void keepAwake(!!state && state.guard.shift === 'on_shift'); if (ringTimer) beep() } })
render()
pairFromLink().then(() => { render(); poll() })
