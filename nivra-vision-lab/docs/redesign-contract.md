# Redesign contract (product-ui branch)

Shared rules for everyone working on the product redesign. Work only inside
The NIVRA product UI worktree used during development.
The live demo runs from a different folder (`3.0/nivra-vision-lab`) on ports 5173 / 18765 / 18766. Never touch that folder, never stop those processes, never deploy anything.

## Dev ports for this worktree

| What | Port | How |
| --- | --- | --- |
| Fight + owner API (uvicorn `server:app`) | 28765 | `NIVRA_FIGHT_PORT=28765` |
| Guard phone listener (`lan_app`) | 28766 | `NIVRA_GUARD_PORT=28766` |
| Vite dev | 5174 | `npm run dev -- --port 5174` with `NIVRA_FIGHT_PORT=28765` |

`NIVRA_GUARD_PUBLIC_URL=` (empty) for dev, so invite links use the LAN address.

## Look (copied from nivra.tanishq.work and `~/Documents/T3 Codex/nivra/src/command/command.css`)

- Font: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", sans-serif`. No Manrope, no Inter, no webfonts.
- Light surfaces: `--bg #ffffff`, `--surface #fafafa`, `--surface-2 #f4f4f5`, `--line #e4e4e7`, `--line-strong #d4d4d8`, `--ink #09090b`, `--ink-2 #27272a`, `--muted #5f5f68`.
- Dark surfaces (live console, camera tiles): `--d-bg #000000`, `--d-surface #0a0a0a`, `--d-raised #171717`, `--d-line #262626`, `--d-ink #ffffff`, `--d-muted #a1a1a1`.
- State colours only: red `#dc2626` (alarm, police; never decorative), green `#16a34a` (tiny "Live"/online dot only), amber `#f59e0b` only for "waiting/ringing" dots. No lime, no forest green, no tinted greys, no gradients, no glow, no coloured shadows.
- Primary button: black pill (`#09090b`, white text), min-height 48px, full width in narrow columns, with a thin arrow icon when it moves you forward. Secondary: white pill with 1px `--line-strong` border. Danger: white pill, red text, 1px red border. On dark: white pill with black text is primary.
- Segmented control: grey `--surface-2` track, black selected pill with white text.
- Radius: 999px pills, 14px tiles and cards, 10px small controls.
- Icons: thin line icons (Phosphor style, 1.5px stroke). In plain JS pages use inline SVG.
- Headlines: bold 700, tight tracking (-0.03em). Body 15-17px, grey `--muted` for secondary lines. Sentence case. Short copy.
- Logo: `/brand/nivra-mark.png` (guard page: `/guard/nivra-mark.png`) shown greyscale (`filter: grayscale(1)`), wordmark "NIVRA" bold.

## Motion

- Easing: `cubic-bezier(.16,1,.3,1)` for entrances, `cubic-bezier(.25,1,.5,1)` for hover/state, `cubic-bezier(.65,0,.35,1)` for panel moves. No bounce, no elastic.
- Durations: press 120ms, hover 200-240ms, state 300-400ms, entrances 500-700ms.
- Every button: `:active { transform: scale(.98) }`. Hover changes background only.
- Only `transform` and `opacity` animate (plus clip-path/stroke-dashoffset for drawing). No layout animation.
- `@media (prefers-reduced-motion: reduce)` turns motion off; everything stays visible.

## Copy

Plain words, no em dashes, no hype. Police are never called automatically; a person always decides.

## Incident and clip API (backend, owner side, loopback only, reached from the browser at `/api/fight/...`)

All JSON. Times are epoch milliseconds.

```
Incident = {
  id: string,                 // "inc_" + 10 url-safe chars
  eventId: string,            // same key the Mac uses for guard alerts (alertKey), unique per alert
  kind: "fight" | "test",
  title: string, detail: string, camera: string,
  occurredAt: number, likelihood: number | null,   // 0-100
  location: {lat,lng,label} | null,                 // copied from GuardHub location at creation
  note: string,                                     // operator note, <= 500 chars
  outcome: null | "acknowledged" | "guard_on_scene" | "police" | "cleared" | "dismissed",
  timeline: [{ at: number, label: string, by: string | null }],   // oldest first
  clip: null | { bytes: number, type: string, durationMs: number | null, createdAt: number },
  still: null | { bytes: number, createdAt: number },
  guards: [GuardAlert]        // live join: GuardHub alerts whose eventId == incident.eventId
}
```

- `POST /incidents` body `{eventId, kind, title, detail, camera, occurredAt, likelihood}` → Incident. Idempotent on `eventId` (returns the existing one). Adds timeline entry "Detected" (with likelihood).
- `GET /incidents?limit=100` → `{ incidents: Incident[] }`, newest first.
- `GET /incidents/{id}` → Incident.
- `PATCH /incidents/{id}` body any of `{ note, outcome }` → Incident. Outcome changes append a timeline entry.
- `POST /incidents/{id}/timeline` body `{ label, by? }` → Incident (operator actions such as "Acknowledged on the Mac", "Guard called: Asha").
- `PUT /incidents/{id}/clip` raw body, `Content-Type: video/webm` or `video/mp4`, at most 12 MB, optional header `X-Duration-Ms` → Incident.
- `GET /incidents/{id}/clip` → the file, with HTTP Range support (Starlette `FileResponse`).
- `PUT /incidents/{id}/still` raw `image/jpeg`, at most 1.5 MB → Incident. `GET /incidents/{id}/still` → the JPEG.
- `DELETE /incidents/{id}` → 204, removes files.
- Storage: `backend/incidents.local.json` plus `backend/incidents.local/<id>.webm|.mp4|.jpg` (both gitignored by `*.local*`). Retention: delete clip/still files older than 7 days, and oldest clips first when the folder passes 500 MB. Keep at most 1000 incidents.

Guard phone side (`lan_app`, needs `Authorization: Bearer <secret>`, and the alert must belong to that guard):

- Each alert in `GET /guard/api/state` gains `clip: boolean` and `still: boolean` (true once the matching incident has that file).
- `GET /guard/api/alerts/{alert_id}/clip` and `/guard/api/alerts/{alert_id}/still` → the file for the incident whose `eventId` equals that alert's `eventId`. 404 when not ready yet. The phone fetches with the header and plays it from a blob URL.
- The guard page also accepts new asset names if added to the whitelist in `guards.py`.

## Landing page

Static files in `deploy/guard-domain/` (Vercel project `nivra-guard`). `/` becomes the landing page. `/guard` and `/guard/:path+` keep rewriting to the guard listener upstream (`scripts/keep-tunnel.sh` rewrites only the destinations of those two rules, so keep their shape: `<base>/guard` and `<base>/guard/:path+`). Do not deploy.
