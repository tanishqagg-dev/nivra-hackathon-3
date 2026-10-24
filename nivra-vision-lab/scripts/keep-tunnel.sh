#!/bin/sh
# Keeps https://nivra.aestrum.in serving this Mac's NIVRA (app, API and guard pages on 127.0.0.1:4180).
# A Cloudflare quick tunnel exposes the port; Vercel forwards every path to it.
# Health is checked on the public domain itself, so a route that only looks fine from this Mac does not fool it.
cd "$(dirname "$0")/.." || exit 1
echo $$ > logs/keep-tunnel.pid
PORT=${NIVRA_PUBLIC_PORT:-4180}
DOMAIN=https://nivra.aestrum.in
CONFIG=deploy/guard-domain/vercel.json
log() { echo "$(date '+%H:%M:%S') $*" >> logs/keep-alive.log; }
ok() { curl -s -m 15 -o /dev/null -f "$1/guard"; }
current() { grep -a -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$CONFIG" | head -1; }
valid() { echo "$1" | grep -Eq '^https://[a-z0-9-]+\.trycloudflare\.com$'; }
point() {
  valid "$1" || { log "refused invalid upstream: $1"; return 1; }
  cat > "$CONFIG" <<JSON
{
  "\$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [{ "source": "/(.*)", "destination": "$1/\$1" }],
  "headers": [{ "source": "/(.*)", "headers": [{ "key": "Cache-Control", "value": "no-store" }, { "key": "X-Robots-Tag", "value": "noindex" }] }]
}
JSON
  if (cd deploy/guard-domain && VERCEL_CLI_USE_NATIVE_BINARY=0 vercel deploy --prod --yes >/dev/null 2>&1); then log "domain now points to $1"; else log "vercel deploy failed for $1"; fi
}
start_tunnel() {
  kill "$(cat logs/cloudflared.pid 2>/dev/null)" 2>/dev/null
  nohup cloudflared tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:$PORT" > logs/cloudflared.log 2>&1 &
  echo $! > logs/cloudflared.pid
  NEW=""
  for i in $(seq 1 40); do NEW=$(grep -a -o 'https://[a-z0-9-]*\.trycloudflare\.com' logs/cloudflared.log | grep -v '^https://api\.' | head -1); [ -n "$NEW" ] && break; sleep 1; done
  if [ -n "$NEW" ] && valid "$NEW"; then
    # Wait for the new hostname to answer before switching the domain.
    for i in $(seq 1 20); do ok "$NEW" && break; sleep 2; done
    point "$NEW"; return 0
  fi
  log "quick tunnel failed ($(grep -a -o 'status_code="[0-9]*[^"]*"' logs/cloudflared.log | head -1)), retrying in 10 min"
  kill "$(cat logs/cloudflared.pid 2>/dev/null)" 2>/dev/null
  return 1
}
cf_until=0
fails=0
while true; do
  NOW=$(date +%s)
  if ok "$DOMAIN"; then
    fails=0
  else
    fails=$((fails + 1))
    CUR=$(current)
    if [ "$fails" -ge 3 ] && [ "$NOW" -ge "$cf_until" ]; then
      # Domain down. If the tunnel still answers, only the Vercel route is stale; otherwise make a new tunnel.
      if valid "$CUR" && ok "$CUR" && kill -0 "$(cat logs/cloudflared.pid 2>/dev/null)" 2>/dev/null; then point "$CUR"
      else log "domain down, starting a new tunnel"; start_tunnel || cf_until=$((NOW + 600)); fi
      fails=0
    fi
  fi
  sleep 20
done
