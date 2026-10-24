#!/bin/sh
# Keeps the demo running for a presentation: restarts on crash, keeps the Mac awake.
# Start:  nohup sh scripts/keep-alive.sh >/dev/null 2>&1 &
# Stop:   kill "$(cat logs/keep-alive.pid)"
cd "$(dirname "$0")/.." || exit 1
echo $$ > logs/keep-alive.pid
caffeinate -dimsu -w $$ &
trap 'pkill -P $$; lsof -ti tcp:18765 -ti tcp:18766 -ti tcp:5173 | xargs kill 2>/dev/null; exit 0' TERM INT
while true; do
  lsof -ti tcp:18765 -ti tcp:18766 -ti tcp:5173 | xargs kill 2>/dev/null
  sleep 1
  echo "$(date '+%H:%M:%S') starting demo" >> logs/keep-alive.log
  node scripts/start-fight-demo.mjs >> logs/demo.log 2>&1 &
  wait $!
  echo "$(date '+%H:%M:%S') demo exited ($?), restarting in 3 s" >> logs/keep-alive.log
  sleep 3
done
