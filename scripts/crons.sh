#!/usr/bin/env bash
# Self-sustaining loops for the Streak tournament board (local / Railway worker).
#   ./scripts/crons.sh catalog   — create markets for new upcoming WC fixtures every 30 min
#   ./scripts/crons.sh settle     — settle finished markets (two-wave HT/FT) every 5 min
# On Railway, run each as its own worker service (or a cron) instead of an infinite loop.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

run_catalog() { (cd "$ROOT/engine" && npx tsx scripts/run-catalog.ts); }
run_settle()  { (cd "$ROOT/keeper" && npx tsx settle-all.ts); }

case "${1:-}" in
  catalog)
    while true; do echo "[catalog $(date -u +%H:%M:%S)]"; run_catalog || echo "catalog run failed"; sleep 1800; done ;;
  settle)
    while true; do echo "[settle $(date -u +%H:%M:%S)]"; run_settle || echo "settle run failed"; sleep 300; done ;;
  *)
    echo "usage: crons.sh catalog|settle"; exit 1 ;;
esac
