#!/usr/bin/env bash
# Rebuilds the whole DUBFORGE runtime inside an Arena sandbox.
# Idempotent — safe to re-run after a sandbox reset.
#
#   bash scripts/setup-sandbox.sh
#
# The sandbox can only reach the npm and PyPI registries, so ffmpeg comes from a
# PyPI wheel and PostgreSQL from an npm package instead of the system packages.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK=/home/user
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
export PATH="$WORK/venv/bin:$PATH"

say() { printf "\n\033[1;36m== %s\033[0m\n" "$*"; }

say "1/7 Python venv + AI packages"
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

say "2/7 ffmpeg + ffprobe binaries"
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

say "3/7 Node dependencies"
cd "$ROOT"
npm install --no-audit --no-fund --ignore-scripts >/dev/null 2>&1

say "4/7 PostgreSQL (embedded-postgres binaries)"
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

say "5/7 start PostgreSQL + create app_db"
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

say "6/7 environment file + schema"
cd "$ROOT"
cat > .env <<EOF
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db
FFMPEG_PATH=$WORK/bin/ffmpeg
FFPROBE_PATH=$WORK/bin/ffprobe
PYTHON_BIN=$WORK/venv/bin/python
TTS_ENGINE=auto
EOF
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/app_db" \
  npx drizzle-kit push --config=drizzle.config.json --force >/dev/null 2>&1 || \
  echo "  (drizzle push failed — retry after the server is up)"

say "7/7 done — start the studio with:"
cat <<EOF
  cd $ROOT && export PATH=$WORK/venv/bin:\$PATH NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \\
    && npm run dev -- -H 0.0.0.0 -p 3000
EOF
