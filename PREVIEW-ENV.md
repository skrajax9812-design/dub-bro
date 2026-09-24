# DUBFORGE — local preview environment

Notes on how this checkout is wired up to run inside the sandbox, plus what is
known to work there.

## Services

| Service | How it runs | Port |
| --- | --- | --- |
| Next.js dev server (landing + studio + API) | `npm run dev -- -H 0.0.0.0 -p 3000` | 3000 |
| PostgreSQL 17 | `embedded-postgres` binaries, data dir `/home/user/pgdata` | 5432 |

## Environment variables (`.env`)

```
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db
PYTHON_BIN=/home/user/venv/bin/python   # exported in the shell, not in .env
```

Optional keys the pipeline picks up when present: `GROQ_API_KEY` / `OPENAI_API_KEY`
(translation), `WHISPER_MODEL` (default `base`), `DUB_DATA_DIR` (default `./data`).

## How it was set up

1. **PostgreSQL** — Debian apt mirrors are unreachable from the sandbox, so the
   `embedded-postgres` npm package supplies the server binaries:

   ```bash
   PGBIN=/home/user/pgserver/node_modules/@embedded-postgres/linux-x64/native/bin
   $PGBIN/postgres -D /home/user/pgdata -p 5432 -c listen_addresses=127.0.0.1 -k /tmp
   ```

   Database `app_db` created, schema pushed with `npx drizzle-kit push --force`.

2. **Node deps** — `ffmpeg-static` / `ffprobe-static` postinstall scripts download
   their binaries from GitHub release assets, which is blocked here, so install
   runs with `--ignore-scripts`:

   ```bash
   NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt npm install --ignore-scripts
   ```

   Binaries are then taken from the registry-hosted `@ffmpeg-installer/linux-x64`
   and `@ffprobe-installer/linux-x64` packages and copied to the paths
   `src/lib/fftools.ts` expects:

   ```bash
   cp node_modules/@ffmpeg-installer/linux-x64/ffmpeg node_modules/ffmpeg-static/ffmpeg
   cp node_modules/@ffprobe-installer/linux-x64/ffprobe node_modules/ffprobe-static/bin/linux/x64/ffprobe
   ```

3. **Python** — `/home/user/venv` with `faster-whisper` and `edge-tts`.

## Sandbox network limits

Only the npm registry and PyPI (plus github.com HTML) are reachable. Blocked:

- `huggingface.co` / `cdn-lfs.huggingface.co` → Faster-Whisper model download fails
- `speech.platform.bing.com` → Edge-TTS synthesis fails
- `api.mymemory.translated.net`, `api.groq.com`, `api.openai.com` → translation fails
- `fonts.googleapis.com` → Next.js falls back to system fonts

So in the sandbox the upload → extract (FFmpeg) stages run for real, while the
ASR / translate / TTS stages need network access (or an API key) that the sandbox
does not grant. Run it on a normal host for the full pipeline.
