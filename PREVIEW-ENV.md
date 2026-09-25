# DUBFORGE — local preview environment

Notes on how this checkout is wired up to run inside the sandbox, plus what is
known to work there.

## Where things live (important)

The workspace (`/home/user`) is snapshotted at the end of every turn with a
~128 MB / 10k-file budget. Anything bigger — the Python venv (torch makes it
about 2 GB), the Postgres cluster, ffmpeg binaries, model weights, uploaded
videos — lives under `$DUBFORGE_HOME` (default `/opt/dubforge`), which is
outside that budget. `.env` points the app there:

```
PYTHON_BIN=/opt/dubforge/venv/bin/python
FFMPEG_PATH=/opt/dubforge/bin/ffmpeg
FFPROBE_PATH=/opt/dubforge/bin/ffprobe
DUB_DATA_DIR=/opt/dubforge/data    # models + jobs + uploads
```

Keeping the project folder tiny is what lets the checkout survive a reset at
all; the runtime itself is always rebuilt from npm + PyPI in a few minutes.

## After a sandbox reset

```bash
cd /home/user/dub-bro
git fetch origin 'refs/heads/*:refs/remotes/origin/*' && git reset --hard origin/arena/01a0d28f-dub-bro
bash scripts/start-sandbox.sh        # rebuilds the runtime if missing, then serves :3000
```

`scripts/setup-sandbox.sh` is the rebuild on its own (idempotent).

## Auto-pilot ("tu hi install kar de")

`/studio` ships with **Auto-pilot ON** (header pill). Once it is on, the page never
needs a second click:

1. **Install** — every model in `AUTO_ORDER` (whisper-base → xtts-v2 → whisper-small →
   kokoro-hi → piper-hi-male) is fetched by the *browser* (Hugging Face allows CORS;
   the sandbox itself cannot reach it) and written into `data/models/…` through
   `/api/models/upload`, 8 MB at a time. Interrupted downloads resume from the byte
   offset already on disk (`Range:` header + per-file `haveBytes` from `/api/models`).
   Only the 1.9 GB XTTS download asks for confirmation, once; declining is remembered.
2. **Resume** — as soon as any ASR model exists, a job parked at `awaiting_transcript`
   is re-queued automatically (`action: transcribe`), so the video runs itself.
3. **Translate** — at the review gate the Studio translates every line by itself: with
   the user's AI key when one is stored (`dubforge.aiKey`), else the free MyMemory
   endpoint, from the browser (the sandbox has no internet).
4. **Approve** — because translations exist, review is skipped automatically and
   synthesis starts.
5. **Re-dub with the clone** — if the first render used espeak/Piper/Kokoro because the
   1.9 GB XTTS model was still downloading, the finished job is re-synthesised once the
   clone lands (`PATCH /api/jobs/:id {action:"redub"}` → `enqueueJob(id, "review")`).
   The button "Re-dub with my cloned voice" on the done screen does the same by hand.

The status strip under the header always shows what auto-pilot is doing right now.

## Preview origin

`https://3000-<sandbox-id>.e2b.app` — the sandbox id changes whenever the E2B box is
recreated, so read the port-3000 preview link from the Arena UI rather than reusing an
old URL. The server must be started with `-H 0.0.0.0` for the proxy to reach it.

## Rebuilding after a sandbox reset

Everything below is reproducible:

```bash
bash scripts/setup-sandbox.sh          # venv, ffmpeg, node deps, postgres, schema, .env
npm run dev -- -H 0.0.0.0 -p 3000      # start the studio
```

Model weights live in `data/models` (gitignored) and are installed from the Studio in
the browser — re-install them after a reset.

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
| Voice | Edge-TTS neural voice | **XTTS-v2 voice clone** → Kokoro-82M → Piper → espeak-ng |
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

## Voice cloning

`XTTS-v2` (via `coqui-tts`) clones the speaker straight out of the video: during the
extract stage `scripts/voice_profile.py --reference` picks the cleanest ~12 s of
continuous speech (most speech energy, fewest internal pauses) and peak-normalises it.
Every dubbed line is then synthesized with `speaker_wav=<that clip>`, so the output is
in the voice of the person on screen.

- `GET /api/models` reports `active.clone` and `active.engine`.
- The pipeline prefers the clone whenever the model is installed and the language is
  supported (XTTS speaks 17 languages, Hindi included).
- Cloning runs on CPU, so `CLONE_MAX_SEC` (default 180 s) caps it: longer videos fall
  back to the neural voice and the log says why.
- Pitch/EQ matching is skipped for the clone (it would only smear an already-correct
  timbre); it still runs for Piper/Kokoro/espeak.

Timing: each line's budget is *the time until the next line starts* (not just its own
spoken duration), and the TTS worker fits lines with the engine's native rate control
first, then a small atempo correction, keeping a ~90 ms margin for MP3 encoder padding.
Result: lines fit their slots instead of overlapping or sounding sped-up.

Loudness: the assembled track is measured and lifted with a static gain + limiter to
-18 LUFS / ≈-1 dBFS true peak (two-pass, no dynamic pumping).

## Sandbox network limits

Only the npm registry and PyPI (plus github.com HTML) are reachable. Blocked:

- `huggingface.co` / `cdn-lfs.huggingface.co` → Faster-Whisper model download fails
- `speech.platform.bing.com` → Edge-TTS synthesis fails
- `api.mymemory.translated.net`, `api.groq.com`, `api.openai.com` → translation fails
- `fonts.googleapis.com` → Next.js falls back to system fonts

So in the sandbox the upload → extract (FFmpeg) stages run for real, while the
ASR / translate / TTS stages need network access (or an API key) that the sandbox
does not grant. Run it on a normal host for the full pipeline.
