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
FFMPEG_PATH=/home/user/bin/ffmpeg
FFPROBE_PATH=/home/user/bin/ffprobe
PYTHON_BIN=/home/user/venv/bin/python
```

`.env` is gitignored; `.env.example` documents the same keys for other machines.
Optional: `GROQ_API_KEY` / `OPENAI_API_KEY` (translation), `WHISPER_MODEL`
(default `base`), `DUB_DATA_DIR` (default `./data`).

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

   Binaries come from the registry-hosted `@ffmpeg-installer/linux-x64` and
   `@ffprobe-installer/linux-x64` packages and are copied to a stable location
   outside `node_modules` (an `npm install` would prune a manual drop-in inside
   the package folder). `src/lib/fftools.ts` honours `FFMPEG_PATH` / `FFPROBE_PATH`:

   ```bash
   cp node_modules/@ffmpeg-installer/linux-x64/ffmpeg /home/user/bin/ffmpeg
   cp node_modules/@ffprobe-installer/linux-x64/ffprobe /home/user/bin/ffprobe
   ```

3. **Python** — `/home/user/venv` with `faster-whisper` and `edge-tts`.

## Proxied preview origin (important)

The preview is served from `https://<port>-<sandboxId>.e2b.app`, not from
localhost. Next.js blocks cross-origin dev resources by default, which returned
**403 for every `/_next/static/chunks/*.js` request** and silently killed
hydration — the page rendered but no button, file picker or upload worked.
`next.config.ts` therefore allows the proxy origins:

```ts
allowedDevOrigins: ["*.e2b.app", "*.arena.ai", "*.host-ai.app", "localhost", "127.0.0.1"],
```

Fonts are self-hosted from the `@fontsource*` packages (`src/app/layout.tsx` uses
`next/font/local`) because `fonts.googleapis.com` is unreachable.

## Dubbing offline in this sandbox

Only the npm and PyPI registries are reachable here, so the three neural stages
of the pipeline have offline paths:

| Stage | Online engine | Offline engine (used here) |
| --- | --- | --- |
| Speech recognition | Faster-Whisper (downloads from HF) | model installed from the **Studio** → runs locally |
| Translation | Groq / OpenAI / MyMemory (server) | the visitor's browser (CORS-enabled MT API) or manual edits in review |
| Voice | Edge-TTS neural voice | Kokoro-82M → Piper → bundled espeak-ng |
| Voice cloning | — | `scripts/voice_profile.py` + `scripts/offline_tts.py` match the dub's pitch and tone to the speaker in the source video |

**Quality ladder.** The pipeline picks the best engine it can actually run:
Kokoro-82M (best) → Piper (very good) → espeak-ng (fallback). `/api/models` reports
`active.engine`, and `TTS_ENGINE=kokoro|piper|edge|offline|auto` can pin it.
`POST /api/models/selftest {kind:"tts"|"asr"}` renders a sample sentence (audio comes
back) or runs a round-trip transcription, so a broken model download is caught before
a dub starts.

**Bring your own model.** `GET /api/models` lists presets (Whisper tiny/base/small/medium,
Kokoro-82M Hindi, Piper Hindi voices). The browser downloads those files from Hugging Face and
streams them into `data/models` with `POST /api/models/upload`
(headers `x-rel-path` + `x-offset`, raw chunk body, 8 MB chunks). Everything
afterwards runs locally: `src/lib/models.ts` finds the installed model and the
pipeline uses it automatically.

**Timing.** Each line is fitted to its own time slot with the engine's *native* rate
control first (Kokoro speed / Piper length_scale) and only then atempo — stacking big
atempo passes is what makes machine dubs sound sped-up. The pipeline applies just a
±12% residual correction.

**Mixing.** 12 ms fades on every segment edge (no clicks), the dub track is normalised
to -16 LUFS / -1.5 dBTP at 48 kHz, and the final mux copies the video stream and writes
192 kbps AAC. `mixOriginal` keeps the source audio at 10 % as ambience.

**Translation.** With a Groq/OpenAI key pasted in the Studio the *browser* translates
(context-aware, one request per 40 lines, each line asked to fit its time slot). Without
a key it falls back to a free CORS MT API, and any line can still be hand-edited.

Flow states: `awaiting_transcript` (no Whisper yet — the Studio offers the
one-click install, then `PATCH {action:"transcribe"}`) and `awaiting_review`
(lines need translating — the Studio can translate them in the browser, then
`PATCH {action:"continue"}`).

`scripts/voice_profile.py` reports the speaker's median F0 and band energies;
`scripts/offline_tts.py` shifts the TTS voice onto that pitch and EQ curve
(`VOICEMATCH` line on stderr). Example: source speaker 88.4 Hz male,
raw espeak Hindi 210 Hz female → matched dub 97 Hz male.

FFmpeg: the `@ffmpeg-installer/ffmpeg` build is from 2018 and lacks
`amix=normalize`, so ffmpeg 7.0.2 is taken from the PyPI `imageio-ffmpeg` wheel
(`/home/user/bin/ffmpeg`), with `FFPROBE_PATH` pointing at the installer build.

## Sandbox network limits

Only the npm registry and PyPI (plus github.com HTML) are reachable. Blocked:

- `huggingface.co` / `cdn-lfs.huggingface.co` → Faster-Whisper model download fails
- `speech.platform.bing.com` → Edge-TTS synthesis fails
- `api.mymemory.translated.net`, `api.groq.com`, `api.openai.com` → translation fails
- `fonts.googleapis.com` → Next.js falls back to system fonts

So in the sandbox the upload → extract (FFmpeg) stages run for real, while the
ASR / translate / TTS stages need network access (or an API key) that the sandbox
does not grant. Run it on a normal host for the full pipeline.
