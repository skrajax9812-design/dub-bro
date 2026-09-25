#!/usr/bin/env bash
# One command to bring the studio up: rebuild the runtime if it is missing,
# make sure Postgres is running, then serve on 0.0.0.0:3000 (the Arena preview
# proxies that port). Safe to run again at any time.
#
#   bash scripts/start-sandbox.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${DUBFORGE_HOME:-/opt/dubforge}"
PORT="${PORT:-3000}"

if [ ! -x "$WORK/venv/bin/python" ] || [ ! -d "$ROOT/node_modules" ] || [ ! -d "$WORK/pgdata" ]; then
  echo "runtime missing — rebuilding first…"
  bash "$ROOT/scripts/setup-sandbox.sh"
fi

export PATH="$WORK/venv/bin:$WORK/bin:$PATH"
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# Postgres must be up before the app serves its first request.
if ! pgrep -f "postgres -D $WORK/pgdata" >/dev/null 2>&1; then
  PGBIN="$WORK/pgserver/node_modules/@embedded-postgres/linux-x64/native/bin"
  nohup "$PGBIN/postgres" -D "$WORK/pgdata" -p 5432 -c listen_addresses=127.0.0.1 -k /tmp \
    > "$WORK/pglog.txt" 2>&1 &
  sleep 3
fi

cd "$ROOT"
echo "serving $ROOT on 0.0.0.0:$PORT (data: $WORK/data)"
exec npm run dev -- -H 0.0.0.0 -p "$PORT"
