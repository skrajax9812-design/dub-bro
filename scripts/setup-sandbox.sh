#!/usr/bin/env bash
# Rebuilds the whole DUBFORGE runtime inside an Arena sandbox.
# Idempotent — safe to re-run after a sandbox reset.
#
#   bash scripts/setup-sandbox.sh          # rebuild everything
#   bash scripts/start-sandbox.sh          # ensure + run the studio
#
# IMPORTANT — why nothing heavy lives in the project folder:
# the workspace (`/home/user`) is captured in a snapshot at the end of every
# turn with a ~128 MB / 10k-file budget. A Python venv with torch (about 2 GB),
# the Postgres cluster and the model weights blow that budget, and the snapshot
# then comes back partial or empty — which is what kept wiping the runtime.
# So every big artifact is created under $DUBFORGE_HOME (default /opt/dubforge,
# outside the snapshot) and the app is pointed at it through .env.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# ---- pick a home for the heavy runtime, outside the workspace snapshot -----
WORK="${DUBFORGE_HOME:-/opt/dubforge}"
if ! mkdir -p "$WORK" 2>/dev/null || [ ! -w "$WORK" ]; then
  sudo -n mkdir -p "$WORK" >/dev/null 2>&1 && sudo -n chown -R "$(id -un):$(id -gn)" "$WORK" >/dev/null 2>&1 || true
fi
if [ ! -w "$WORK" ]; then
  echo "WARN: $WORK is not writable — falling back to /home/user (snapshots will be large)"
  WORK=/home/user
fi
export DUBFORGE_HOME="$WORK"
export PATH="$WORK/venv/bin:$PATH"

say() { printf "\n\033[1;36m== %s\033[0m\n" "$*"; }

# ---- keep the workspace itself tiny ---------------------------------------
say "0/8 keeping the project folder small"
cd "$ROOT"
if [ "$WORK" != "/home/user/dub-bro" ] && [ -d "$ROOT/data" ]; then
  # Move anything already downloaded (models/jobs) out of the snapshot budget.
  mkdir -p "$WORK/data"
  for sub in models jobs uploads; do
    if [ -e "$ROOT/data/$sub" ] && [ ! -e "$WORK/data/$sub" ]; then mv "$ROOT/data/$sub" "$WORK/data/$sub"; fi
  done
fi
if [ "$WORK" = "/opt/dubforge" ]; then
  for legacy in "$ROOT/data" /home/user/venv /home/user/bin /home/user/pgdata /home/user/pgserver /home/user/pgpw.txt /home/user/pglog.txt; do
    [ -e "$legacy" ] && rm -rf "$legacy" && echo "  cleared $legacy"
  done
fi

say "1/8 Python venv + AI packages"
if [ ! -x "$WORK/venv/bin/python" ]; then
  python3 -m venv "$WORK/venv" >/dev/null
fi
"$WORK/venv/bin/pip" install --quiet --no-cache-dir --upgrade pip
"$WORK/venv/bin/pip" install --quiet --no-cache-dir \
  numpy espeakng-loader piper-tts kokoro-onnx "misaki[en]" num2words \
  faster-whisper edge-tts imageio-ffmpeg
# XTTS-v2 voice cloning (heavy: pulls torch). Optional — the pipeline falls back
# to Kokoro/Piper/espeak when this is missing.
"$WORK/venv/bin/pip" install --quiet --no-cache-dir coqui-tts torchaudio torchcodec \
  || echo "  (coqui-tts unavailable — cloning engine disabled, everything else works)"
# coqui-tts 0.27 needs transformers>=4.57 but breaks on the 5.x line.
"$WORK/venv/bin/pip" install --quiet --no-cache-dir "transformers>=4.57,<5" \
  || echo "  (transformers pin failed)"

say "2/8 ffmpeg + ffprobe binaries"
mkdir -p "$WORK/bin"
FFMPEG_BIN="$("$WORK/venv/bin/python" -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')"
cp -f "$FFMPEG_BIN" "$WORK/bin/ffmpeg"
chmod +x "$WORK/bin/ffmpeg"
# ffmpeg-static's postinstall download is blocked; the registry copy of ffprobe works.
if [ ! -x "$WORK/bin/ffprobe" ]; then
  cd "$ROOT"
  npm install --no-audit --no-fund --ignore-scripts --no-save @ffprobe-installer/ffprobe >/dev/null 2>&1 || true
  if [ -f "$ROOT/node_modules/@ffprobe-installer/linux-x64/ffprobe" ]; then
    cp -f "$ROOT/node_modules/@ffprobe-installer/linux-x64/ffprobe" "$WORK/bin/ffprobe"
    chmod +x "$WORK/bin/ffprobe"
  fi
fi
"$WORK/bin/ffmpeg" -version | head -1
"$WORK/bin/ffprobe" -version | head -1 || echo "  (ffprobe missing — ffmpeg-only mode)"

say "3/8 Node dependencies"
cd "$ROOT"
npm install --no-audit --no-fund --ignore-scripts >/dev/null 2>&1

say "4/8 PostgreSQL (embedded-postgres binaries)"
PGSRV="$WORK/pgserver"
if [ ! -x "$PGSRV/node_modules/@embedded-postgres/linux-x64/native/bin/postgres" ]; then
  mkdir -p "$PGSRV" && cd "$PGSRV"
  [ -f package.json ] || npm init -y >/dev/null 2>&1
  npm install --no-audit --no-fund embedded-postgres@17.10.0-beta.17 >/dev/null 2>&1
fi
PGBIN="$PGSRV/node_modules/@embedded-postgres/linux-x64/native/bin"
if [ ! -d "$WORK/pgdata" ]; then
  echo postgres > "$WORK/pgpw.txt"
  "$PGBIN/initdb" -D "$WORK/pgdata" -U postgres --pwfile="$WORK/pgpw.txt" -A trust --encoding=UTF8 >/dev/null
fi

say "5/8 start PostgreSQL + create app_db"
if ! pgrep -f "postgres -D $WORK/pgdata" >/dev/null 2>&1; then
  nohup "$PGBIN/postgres" -D "$WORK/pgdata" -p 5432 -c listen_addresses=127.0.0.1 -k /tmp \
    > "$WORK/pglog.txt" 2>&1 &
  sleep 3
fi
cd "$PGSRV"
node -e '
const {Client}=require("pg");
(async()=>{
  const c=new Client({host:"127.0.0.1",port:5432,user:"postgres",password:"postgres",database:"postgres"});
  await c.connect();
  const r=await c.query("select 1 from pg_database where datname=$1",["app_db"]);
  if(r.rowCount===0){await c.query("CREATE DATABASE app_db");console.log("  created app_db");}
  else console.log("  app_db present");
  await c.end();
})().catch(e=>{console.error("  DB error",e.message);process.exit(1)});'

say "6/8 environment file"
cd "$ROOT"
cat > .env <<EOF
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db
FFMPEG_PATH=$WORK/bin/ffmpeg
FFPROBE_PATH=$WORK/bin/ffprobe
PYTHON_BIN=$WORK/venv/bin/python
# Models, uploads and job outputs live outside the workspace snapshot.
DUB_DATA_DIR=$WORK/data
TTS_ENGINE=auto
EOF

say "7/8 database schema"
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/app_db" \
  npx drizzle-kit push --config=drizzle.config.json --force >/dev/null 2>&1 || \
  echo "  (drizzle push failed — retry after the server is up)"

say "8/8 done — start the studio with:  bash scripts/start-sandbox.sh"
du -sh "$WORK" 2>/dev/null | sed 's/^/  runtime: /'
du -sh "$ROOT" --exclude=node_modules --exclude=.next --exclude=.git 2>/dev/null | sed 's/^/  project: /'
