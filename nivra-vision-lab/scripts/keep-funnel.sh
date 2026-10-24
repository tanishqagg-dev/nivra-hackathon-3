#!/bin/sh
# Re-applies the public Funnel route for the guard page if another app changes Tailscale serve config.
cd "$(dirname "$0")/.." || exit 1
echo $$ > logs/keep-funnel.pid
while true; do
  if ! tailscale serve status --json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin); h='${NIVRA_TAILSCALE_HOST:?Set NIVRA_TAILSCALE_HOST to your Funnel DNS name}:443'
ok=(d.get('AllowFunnel') or {}).get(h) and (d.get('Web',{}).get(h,{}).get('Handlers',{}).get('/nivra-lab',{}).get('Proxy')=='http://127.0.0.1:18766')
sys.exit(0 if ok else 1)"; then
    tailscale funnel --bg --set-path /nivra-lab http://127.0.0.1:18766 >/dev/null 2>&1
    echo "$(date '+%H:%M:%S') funnel route re-applied" >> logs/keep-alive.log
  fi
  sleep 20
done
