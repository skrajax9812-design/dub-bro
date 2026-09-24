import fs from "fs";
import path from "path";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { dubJobs, dubSegments } from "@/db/schema";
import {
  FFMPEG,
  probeDurationSec,
  probeStreams,
  run,
  runChecked,
  fmtTime,
} from "@/lib/fftools";
import { jobDir } from "@/lib/storage";
import { defaultVoiceFor, voiceById } from "@/lib/voices";
import {
  findLocalKokoro,
  findLocalPiperVoice,
  findLocalWhisperModel,
  findLocalXtts,
  kokoroVoiceFor,
  xttsSupports,
} from "@/lib/models";
import { translateAll } from "./translate";

/* ------------------------------------------------------------------ */
/* Engine availability                                                 */
/* ------------------------------------------------------------------ */

let edgeReachable: Promise<boolean> | null = null;

/**
 * Reachability probe. A bare TCP connect is not trustworthy here — filtered
 * networks happily accept the handshake and only then drop the request — so we
 * request a real URL and require an HTTP response.
 */
function httpReachable(url: string, timeoutMs = 5000): Promise<boolean> {
  return fetch(url, { method: "GET", signal: AbortSignal.timeout(timeoutMs) })
    .then((r) => r.status > 0)
    .catch(() => false);
}

/** Can this process reach the Edge-TTS endpoint? (Blocked in the sandbox.) */
function canReachEdgeTts(): Promise<boolean> {
  edgeReachable ??= httpReachable("https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list");
  return edgeReachable;
}

let hfReachable: Promise<boolean> | null = null;

/** Can this process reach huggingface.co (i.e. may Faster-Whisper download)? */
function canReachHf(): Promise<boolean> {
  hfReachable ??= httpReachable("https://huggingface.co/api/models?limit=1");
  return hfReachable;
}

type TtsEngine = "edge" | "xtts" | "kokoro" | "piper" | "offline";

/**
 * auto  -> online neural voice when reachable, else Piper, else the built-in
 *          espeak-ng fallback (always works, even with zero internet).
 */
async function resolveTtsEngine(job: JobRow): Promise<TtsEngine> {
  const forced = (process.env.TTS_ENGINE ?? "auto").toLowerCase();
  const gender = voiceById(job.voiceId)?.gender ?? "M";
  const kokoro = findLocalKokoro();
  const piper = findLocalPiperVoice(job.targetLang, gender);
  // Voice cloning wins whenever the model and a speaker clip are available — but
  // XTTS runs on CPU here, so very long videos would take hours. Past the budget
  // the pipeline uses the neural voice instead (raise CLONE_MAX_SEC to override).
  const cloneBudgetSec = Number(process.env.CLONE_MAX_SEC ?? 180);
  const withinCloneBudget = (job.durationSec ?? 0) <= cloneBudgetSec;
  const clone =
    findLocalXtts() && xttsSupports(job.targetLang) && withinCloneBudget ? "xtts" : null;
  if (findLocalXtts() && xttsSupports(job.targetLang) && !withinCloneBudget) {
    void addLog(
      job.id,
      `Video is ${((job.durationSec ?? 0) / 60).toFixed(1)} min — longer than the ${(cloneBudgetSec / 60).toFixed(0)} min cloning budget, so the neural voice is used instead (set CLONE_MAX_SEC to change).`,
    );
  }
  const best = (): TtsEngine => clone ?? (kokoro ? "kokoro" : piper ? "piper" : "offline");
  if (forced === "edge") return "edge";
  if (forced === "xtts") return clone ?? best();
  if (forced === "kokoro") return kokoro ? "kokoro" : best();
  if (forced === "piper") return piper ? "piper" : best();
  if (forced === "offline") return best();
  // auto: the visitor's own browser may reach Edge-TTS, but a local clone is
  // better than a generic cloud voice, so only prefer Edge when no clone exists.
  if (!clone && (await canReachEdgeTts())) return "edge";
  return best();
}

export function activeEngineLabel(): string {
  const forced = (process.env.TTS_ENGINE ?? "auto").toLowerCase();
  return forced === "auto" ? "auto-detect" : forced;
}

type JobRow = typeof dubJobs.$inferSelect;
type SegmentRow = typeof dubSegments.$inferSelect;

const PY = process.env.PYTHON_BIN || "python3";
const SCRIPTS = path.join(process.cwd(), "scripts");
const WHISPER_MODEL = process.env.WHISPER_MODEL || "base";
const CHUNK_SEC = 600; // 10-minute ASR chunks -> unlimited total duration
const MIX_WINDOW = 140; // segments per mixing window (keeps filtergraphs sane)

/* ------------------------------------------------------------------ */
/* DB + logging helpers                                                */
/* ------------------------------------------------------------------ */

export async function getJob(id: string): Promise<JobRow> {
  const [row] = await db.select().from(dubJobs).where(eq(dubJobs.id, id)).limit(1);
  if (!row) throw new Error("Job not found");
  return row;
}

async function setJob(id: string, patch: Partial<typeof dubJobs.$inferInsert>) {
  await db
    .update(dubJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(dubJobs.id, id));
}

async function addLog(id: string, msg: string) {
  const entry = { t: Date.now(), msg };
  await db
    .update(dubJobs)
    .set({
      log: sql`(${dubJobs.log} || ${JSON.stringify([entry])}::jsonb)`,
      stageDetail: msg,
      updatedAt: new Date(),
    })
    .where(eq(dubJobs.id, id));
}

async function setProgress(id: string, stage: string, progress: number, detail?: string) {
  await setJob(id, {
    stage,
    progress: Math.max(0, Math.min(100, Math.round(progress))),
    ...(detail ? { stageDetail: detail } : {}),
  });
}

async function getSegments(jobId: string): Promise<SegmentRow[]> {
  return db
    .select()
    .from(dubSegments)
    .where(eq(dubSegments.jobId, jobId))
    .orderBy(asc(dubSegments.idx));
}

async function pMap<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, i: number) => Promise<void>,
): Promise<void> {
  let i = 0;
  await Promise.all(
    new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
      while (i < items.length) {
        const cur = i++;
        await fn(items[cur], cur);
      }
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Stage 1 — Audio extraction & web remuxing (FFmpeg)                  */
/* ------------------------------------------------------------------ */

async function stageExtract(job: JobRow, dir: string) {
  await setProgress(job.id, "extract", 2, "Probing source streams…");
  await addLog(job.id, `FFmpeg binary: ${FFMPEG}`);

  const streams = await probeStreams(job.srcPath);
  const video = streams.find((s) => s.type === "video");
  if (!video) throw new Error("No video stream found in the uploaded file.");
  const hasAudio = streams.some((s) => s.type === "audio");
  if (!hasAudio)
    throw new Error("This video has no audio track — nothing to dub.");

  const duration = await probeDurationSec(job.srcPath);
  const webPath = path.join(dir, "web.mp4");
  const audioPath = path.join(dir, "audio_16k.wav");

  await addLog(
    job.id,
    `Source: ${video.codec} ${video.width ?? "?"}x${video.height ?? "?"} · ${fmtTime(duration)} · audio: ${streams.find((s) => s.type === "audio")?.codec}`,
  );

  // Web remux: stream-copy when already H.264 MP4, otherwise transcode once.
  const isWebReady =
    /\.(mp4|m4v|mov)$/i.test(job.srcPath) && video.codec === "h264";
  if (isWebReady) {
    await addLog(job.id, "Web remux: H.264 stream-copy (zero quality loss)…");
    await runChecked(
      FFMPEG,
      ["-y", "-i", job.srcPath, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", webPath],
      { killAfterMs: 30 * 60_000 },
    );
  } else {
    await addLog(job.id, `Transcoding ${video.codec} → H.264 for the web player…`);
    await runChecked(
      FFMPEG,
      [
        "-y", "-i", job.srcPath,
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart",
        webPath,
      ],
      { killAfterMs: 60 * 60_000 },
    );
  }

  await setProgress(job.id, "extract", 5, "Extracting 16 kHz mono track…");
  await runChecked(
    FFMPEG,
    ["-y", "-i", job.srcPath, "-vn", "-ac", "1", "-ar", "16000", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-f", "wav", audioPath],
    { killAfterMs: 30 * 60_000 },
  );

  await setJob(job.id, { webPath, audioPath, durationSec: duration });
  await addLog(job.id, `Extraction complete — normalized WAV ready for ASR.`);

  // Offline speaker analysis — drives voice matching at synthesis time.
  if (job.voiceMatch) {
    const profilePath = path.join(dir, "voice_profile.json");
    try {
      const res = await run(
        PY,
        [
          path.join(SCRIPTS, "voice_profile.py"),
          "--audio", audioPath,
          "--out", profilePath,
          "--reference", path.join(dir, "reference.wav"),
          "--ref-seconds", "12",
        ],
        { killAfterMs: 15 * 60_000 },
      );
      if (res.code === 0) {
        const prof = JSON.parse(res.stdout.trim() || "{}") as {
          f0Median?: number;
          genderHint?: string;
        };
        await addLog(
          job.id,
          `Voice profile — ${prof.f0Median ?? "?"} Hz (${prof.genderHint ?? "unknown"}). The dub will be matched to this voice.`,
        );
      }
    } catch {
      await addLog(job.id, "Voice profile skipped — analysis failed, synthesizing with the raw voice.");
    }
  }
}

/* ------------------------------------------------------------------ */
/* Stage 2 — Faster-Whisper ASR (INT8, CPU), chunked for any length    */
/* ------------------------------------------------------------------ */

async function stageTranscribe(job: JobRow, dir: string): Promise<"ok" | "awaiting"> {
  await setProgress(job.id, "transcribe", 8, "Splitting audio into ASR chunks…");

  // A transcript that the browser already produced (it has internet, the
  // sandbox does not) is used as-is.
  const supplied = await getSegments(job.id);
  if (supplied.length > 0) {
    await addLog(job.id, `Transcript supplied by the Studio — ${supplied.length} lines in hand.`);
    await setProgress(job.id, "transcribe", 38, `${supplied.length} lines ready`);
    return "ok";
  }

  // Clean retry residue
  await db.delete(dubSegments).where(eq(dubSegments.jobId, job.id));

  const localModel = findLocalWhisperModel();
  if (!localModel && !(await canReachHf())) {
    await addLog(
      job.id,
      "Whisper model not installed and huggingface.co is unreachable from the server. Open the Studio — your browser downloads the model (one click) and the transcript comes from there.",
    );
    await setJob(job.id, {
      status: "awaiting_transcript",
      stage: "transcribe",
      progress: 8,
      stageDetail: "Speech-to-text model missing — install it from the Studio",
      error: null,
    });
    return "awaiting";
  }
  const modelRef = localModel ?? WHISPER_MODEL;

  const duration = job.durationSec ?? (await probeDurationSec(job.audioPath!));
  const chunkCount = Math.max(1, Math.ceil(duration / CHUNK_SEC));
  await addLog(job.id, `Faster-Whisper (${modelRef}, INT8, CPU) · ${chunkCount} chunk(s) of ${CHUNK_SEC / 60} min`);

  type RawSeg = { start: number; end: number; text: string };
  const all: RawSeg[] = [];
  let detected: string | null = null;
  let failedChunks = 0;

  for (let c = 0; c < chunkCount; c++) {
    const offsetSec = c * CHUNK_SEC;
    const chunkPath = path.join(dir, `chunk_${c}.wav`);
    await runChecked(FFMPEG, [
      "-y", "-ss", String(offsetSec), "-t", String(CHUNK_SEC),
      "-i", job.audioPath!, "-c", "copy", chunkPath,
    ]);

    await setProgress(
      job.id, "transcribe", 8 + ((c + 0.3) / chunkCount) * 30,
      `ASR chunk ${c + 1}/${chunkCount} — @${fmtTime(offsetSec)}`,
    );
    const res = await run(
      PY,
      [
        path.join(SCRIPTS, "transcribe.py"),
        "--audio", chunkPath,
        "--model", modelRef,
        "--lang", job.sourceLang || "auto",
      ],
      { killAfterMs: 4 * 60 * 60_000 },
    );
    if (res.code !== 0) {
      failedChunks++;
      await addLog(job.id, `ASR chunk ${c + 1} failed (${res.stderr.slice(-160)}) — skipping`);
      continue;
    }
    let parsed: { language?: string; segments?: RawSeg[] };
    try {
      parsed = JSON.parse(res.stdout.trim());
    } catch {
      failedChunks++;
      await addLog(job.id, `ASR chunk ${c + 1}: unparseable output — skipping`);
      continue;
    }
    detected = detected ?? parsed.language ?? null;
    const segs = parsed.segments ?? [];
    for (const s of segs) {
      const start = s.start + offsetSec;
      const end = s.end + offsetSec;
      if (end - start < 0.25) continue;
      all.push({ start, end, text: s.text });
    }
    await setProgress(
      job.id, "transcribe", 8 + ((c + 1) / chunkCount) * 30,
      `Chunk ${c + 1}/${chunkCount}: ${segs.length} utterances`,
    );
    try { fs.unlinkSync(chunkPath); } catch { /* ignore */ }
  }

  // De-overlap & clamp
  all.sort((a, b) => a.start - b.start);
  const merged: RawSeg[] = [];
  for (const s of all) {
    const prev = merged[merged.length - 1];
    if (prev && s.start < prev.end - 0.05) s.start = prev.end;
    if (s.end - s.start < 0.25) continue;
    if (s.start >= duration - 0.1) continue;
    merged.push({ start: s.start, end: Math.min(s.end, duration), text: s.text });
  }

  if (merged.length === 0 && failedChunks >= chunkCount) {
    // Every chunk failed — that is an engine problem, not a silent video.
    await addLog(
      job.id,
      "Speech recognition could not run: no local Whisper model and no route to huggingface.co. Install a model from the Studio — your browser fetches it.",
    );
    await setJob(job.id, {
      status: "awaiting_transcript",
      stage: "transcribe",
      progress: 8,
      stageDetail: "Speech-to-text model missing — install it from the Studio",
    });
    return "awaiting";
  }

  if (merged.length === 0) {
    throw new Error("No speech detected — the audio seems to be silent or music-only.");
  }

  const CH = 200;
  for (let i = 0; i < merged.length; i += CH) {
    const batch = merged.slice(i, i + CH);
    await db.insert(dubSegments).values(
      batch.map((s, k) => ({
        jobId: job.id,
        idx: i + k,
        startMs: Math.round(s.start * 1000),
        endMs: Math.round(s.end * 1000),
        sourceText: s.text,
        status: "pending",
      })),
    );
  }

  await setJob(job.id, {
    segmentCount: merged.length,
    detectedLang: detected,
    ...(job.sourceLang === "auto" && detected ? { sourceLang: detected } : {}),
  });
  await addLog(
    job.id,
    `ASR complete: ${merged.length} utterances · detected language: ${(detected ?? "unknown").toUpperCase()}`,
  );
  return "ok";
}

/* ------------------------------------------------------------------ */
/* Stage 3 — Chunked neural translation                                */
/* ------------------------------------------------------------------ */

async function stageTranslate(job: JobRow) {
  const segs = await getSegments(job.id);
  const src = job.sourceLang && job.sourceLang !== "auto" ? job.sourceLang : (job.detectedLang ?? "en");
  const tgt = job.targetLang;
  await setProgress(job.id, "translate", 38, `Translating ${segs.length} lines ${src.toUpperCase()} → ${tgt.toUpperCase()}…`);

  if (src === tgt) {
    await addLog(job.id, "Source = target language — carrying text through unchanged.");
    await pMap(segs, 4, async (s) => {
      await db.update(dubSegments).set({ translatedText: s.sourceText, status: "translated" }).where(eq(dubSegments.id, s.id));
    });
    await setProgress(job.id, "translate", 55, "Translation pass-through complete");
    return;
  }

  // Lines that the Studio (or a human) already translated are left untouched.
  const pending = segs.filter(
    (s) => !s.translatedText || s.translatedText.trim() === s.sourceText.trim(),
  );
  if (pending.length === 0) {
    await addLog(job.id, "Translations already supplied by the Studio — skipping the translation stage.");
    await setProgress(job.id, "translate", 55, "Translation already supplied");
    return;
  }

  const texts = pending.map((s) => s.sourceText);
  const { viaLLM } = await translateAll(
    texts,
    src,
    tgt,
    async (i, translated) => {
      await db
        .update(dubSegments)
        .set({ translatedText: translated, status: "translated" })
        .where(eq(dubSegments.id, pending[i].id));
    },
    (done, total) => {
      const pct = 38 + (done / Math.max(1, total)) * 17;
      void setProgress(job.id, "translate", pct, `Translating… ${done}/${total}`);
    },
  );
  const after = await getSegments(job.id);
  const realTranslations = after.filter(
    (s) => s.translatedText && s.translatedText.trim() !== s.sourceText.trim(),
  ).length;
  if (realTranslations === 0) {
    // Server-side providers are all unreachable (sandbox) — hand the job to the
    // Studio, whose browser *can* reach a translation service.
    await addLog(
      job.id,
      "No translation API reachable from the server. The Studio can translate these lines in your browser — do that, then press Synthesize.",
    );
    await setJob(job.id, {
      status: "awaiting_review",
      stage: "review",
      progress: 55,
      stageDetail: "Waiting for translation — the Studio fills this in from your browser",
    });
    return;
  }
  await addLog(job.id, `Translation complete via ${viaLLM ? "LLM (chunked, context-aware)" : "MyMemory neural MT"}.`);
  await setProgress(job.id, "translate", 55, "Translation complete");
}

/* ------------------------------------------------------------------ */
/* Stage 4 — Edge-TTS neural synthesis per segment                     */
/* ------------------------------------------------------------------ */

function fmtSigned(v: number, unit: string): string {
  return `${v >= 0 ? "+" : ""}${v}${unit}`;
}

async function stageSynthesize(job: JobRow, dir: string) {
  const segs = await getSegments(job.id);
  const segDir = path.join(dir, "segs");
  fs.mkdirSync(segDir, { recursive: true });

  let voiceId = job.voiceId;
  if (!voiceById(voiceId)) voiceId = defaultVoiceFor(job.targetLang);
  const voice = voiceById(voiceId);
  const rate = fmtSigned(job.ratePct, "%");
  const pitch = fmtSigned(job.pitchHz, "Hz");

  const engine = await resolveTtsEngine(job);
  const gender = voice?.gender ?? "M";
  const piperModel = engine === "piper" ? findLocalPiperVoice(job.targetLang, gender) : null;
  const kokoro = engine === "kokoro" ? findLocalKokoro() : null;
  const xttsModel = engine === "xtts" ? findLocalXtts() : null;
  const reference = path.join(dir, "reference.wav");
  // Kokoro voices are picked by language + gender; Piper by the installed voice.
  const synthVoice =
    engine === "kokoro" ? kokoroVoiceFor(job.targetLang, gender) : engine === "piper" ? "" : voiceId;
  const profilePath = path.join(dir, "voice_profile.json");
  const hasProfile = job.voiceMatch && fs.existsSync(profilePath);

  const engineLabel =
    engine === "edge"
      ? `Edge neural voice ${voiceId}`
      : engine === "xtts"
        ? "XTTS-v2 voice clone (speaking as the person in your video)"
        : engine === "kokoro"
        ? `Kokoro-82M neural voice ${synthVoice}`
        : engine === "piper"
          ? `Piper neural voice ${piperModel ? path.basename(piperModel) : job.targetLang}`
          : `built-in offline voice (${job.targetLang}, ${gender === "F" ? "female" : "male"})`;

  await setProgress(job.id, "synthesize", 56, `TTS: ${engineLabel} — ${segs.length} lines`);
  await addLog(
    job.id,
    `TTS engine — ${engineLabel} · rate ${rate} · pitch ${pitch}${hasProfile ? " · voice-matched to the source speaker" : ""}`,
  );
  if (engine === "xtts") {
    await addLog(
      job.id,
      "Cloning the speaker from a clean 12 s reference taken out of your video — the dub will use that voice.",
    );
    const minutes = (job.durationSec ?? 0) / 60;
    if (minutes > 4) {
      await addLog(
        job.id,
        `Heads-up: cloning runs on CPU, so ${minutes.toFixed(1)} min of speech takes a while (roughly ${Math.ceil(minutes * 3)}–${Math.ceil(minutes * 6)} min). Keep this tab open.`,
      );
    }
  } else if (engine !== "edge" && !hasProfile) {
    await addLog(job.id, "Voice matching unavailable for this job — synthesizing with the raw voice timbre.");
  }

  // A line may use the pause that follows it, so its real budget runs until the
  // next line begins. That alone removes most of the "compressed, rushed" sound.
  const ordered = [...segs].sort((a, b) => a.startMs - b.startMs);
  const nextStart = new Map<number, number>();
  ordered.forEach((s, i) => {
    const next = ordered[i + 1];
    nextStart.set(s.idx, next ? next.startMs : s.endMs);
  });

  const items = ordered
    .map((s) => {
      const budget = Math.max(300, (nextStart.get(s.idx) ?? s.endMs) - s.startMs);
      return {
        i: s.idx,
        text: (s.translatedText ?? s.sourceText).trim(),
        voice: synthVoice,
        lang: job.targetLang,
        gender,
        rate,
        pitch,
        slotMs: budget,
        out: path.join(segDir, `seg_${s.idx}.mp3`),
      };
    })
    .filter((it) => it.text.length > 0);

  const manifest = path.join(dir, "tts_manifest.json");
  fs.writeFileSync(manifest, JSON.stringify(items));

  let doneCount = 0;
  const okIdx = new Set<number>();
  const ttsArgs =
    engine === "edge"
      ? [path.join(SCRIPTS, "tts_batch.py"), "--manifest", manifest, "--concurrency", "5"]
      : [
          path.join(SCRIPTS, "offline_tts.py"),
          "--manifest", manifest,
          "--engine", engine === "piper" ? "piper" : engine === "kokoro" ? "kokoro" : "espeak",
          ...(hasProfile ? ["--profile", profilePath] : []),
          ...(piperModel ? ["--piper-model", piperModel] : []),
          ...(kokoro ? ["--kokoro-model", kokoro.model, "--kokoro-voices", kokoro.voices] : []),
          ...(xttsModel ? ["--xtts-model", xttsModel] : []),
          ...(fs.existsSync(reference) ? ["--reference", reference] : []),
        ];
  const res = await run(
    PY,
    ttsArgs,
    {
      killAfterMs: items.length * 8000 + 10 * 60_000,
      onLine: (line) => {
        const mOk = /^OK (\d+)/.exec(line);
        const mFail = /^FAIL (\d+)/.exec(line);
        if (mOk) okIdx.add(Number(mOk[1]));
        if (mOk || mFail) {
          doneCount++;
          if (doneCount % 5 === 0 || doneCount === items.length) {
            void setProgress(job.id, "synthesize", 56 + (doneCount / items.length) * 24, `Synthesizing… ${doneCount}/${items.length}`);
          }
        }
      },
    },
  );
  if (res.code !== 0) throw new Error(`TTS worker crashed: ${res.stderr.slice(-300)}`);
  if (okIdx.size === 0)
    throw new Error(
      engine === "edge"
        ? "Edge TTS produced no audio (network blocked?)"
        : "The offline TTS engine produced no audio.",
    );

  // Per-segment duration probe + tempo alignment
  await addLog(job.id, `Synthesized ${okIdx.size}/${items.length} segments — aligning tempo…`);
  const okSegs = segs.filter((s) => okIdx.has(s.idx));
  await pMap(okSegs, 4, async (s) => {
    const mp3 = path.join(segDir, `seg_${s.idx}.mp3`);
    const wav = path.join(segDir, `seg_${s.idx}.wav`);
    let ttsMs = 0;
    try {
      ttsMs = Math.round((await probeDurationSec(mp3)) * 1000);
    } catch {
      await db.update(dubSegments).set({ status: "failed" }).where(eq(dubSegments.id, s.id));
      return;
    }
    const slotMs = Math.max(500, s.endMs - s.startMs);
    const ratio = ttsMs / slotMs;
    // The TTS worker already fits each line to its slot (native rate first, then
    // atempo), so only a small residual correction is applied here — stacking two
    // big atempo passes is what makes machine dubs sound sped-up.
    let tempo = 1;
    if (ratio > 1.1) tempo = Math.min(1.12, ratio);
    else if (ratio < 0.75 && ttsMs > 600) tempo = Math.max(0.9, ratio);

    const af = tempo !== 1 ? ["-af", `atempo=${tempo.toFixed(4)}`] : [];
    try {
      await runChecked(FFMPEG, ["-y", "-i", mp3, "-ac", "1", "-ar", "24000", ...af, wav], { killAfterMs: 120_000 });
      await db
        .update(dubSegments)
        .set({ audioPath: wav, status: "synthesized", ttsMs, tempo })
        .where(eq(dubSegments.id, s.id));
    } catch {
      await db.update(dubSegments).set({ status: "failed" }).where(eq(dubSegments.id, s.id));
    }
  });
  const failCount = segs.length - okIdx.size;
  if (failCount > 0) await addLog(job.id, `${failCount} line(s) fell back to silence (TTS retry budget exhausted).`);
  await setProgress(job.id, "synthesize", 82, "Tempo alignment complete");
}

/* ------------------------------------------------------------------ */
/* Stage 5 — Timeline sync, mix windows, watermark-free mux            */
/* ------------------------------------------------------------------ */

/**
 * Two-pass EBU R128 normalisation. A single loudnorm pass lands several LU off
 * target on speech with pauses; measuring first and then applying with the
 * measured values puts the track on -16 LUFS accurately.
 */
async function loudnormToWav(src: string, dest: string): Promise<number> {
  // Dialogue sits at -18 LUFS; speech peaks (plosives) are far above the average,
  // so a limiter is used instead of loudnorm's own gain riding — that keeps the
  // level on target without the pumping that makes a dub sound robotic.
  const TARGET_LUFS = -18;
  const LIMIT = 0.89; // ≈ -1 dBFS
  let af = `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11`;
  try {
    const probe = await run(FFMPEG, [
      "-y", "-i", src,
      "-af", "loudnorm=I=-18:TP=-1.5:LRA=11:print_format=json",
      "-f", "null", "-",
    ]);
    const open = probe.stderr.lastIndexOf("{");
    const close = probe.stderr.lastIndexOf("}");
    if (open < 0 || close <= open) throw new Error("no loudnorm measurements in stderr");
    const jsonText = probe.stderr.slice(open, close + 1);
    const m = JSON.parse(jsonText) as Record<string, string>;
    const inputI = Number(m.input_i);
    const inputTp = Number(m.input_tp);
    if (Number.isFinite(inputI) && Number.isFinite(inputTp)) {
      const gain = Math.max(-12, Math.min(20, TARGET_LUFS - inputI));
      af = `volume=${gain.toFixed(2)}dB,alimiter=limit=${LIMIT}:attack=5:release=100:level=disabled`;
    }
  } catch {
    /* keep the loudnorm fallback */
  }
  await runChecked(
    FFMPEG,
    ["-y", "-i", src, "-af", af, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", dest],
    { killAfterMs: 60 * 60_000 },
  );
  return 0;
}

async function stageMux(job: JobRow, dir: string) {
  await setProgress(job.id, "sync", 84, "Building the dubbed timeline…");
  const segs = (await getSegments(job.id)).filter(
    (s) => s.status === "synthesized" && s.audioPath && fs.existsSync(s.audioPath),
  );
  if (segs.length === 0) throw new Error("No synthesized segments to mux.");

  const durationMs = Math.round((job.durationSec ?? 0) * 1000);
  const windows: SegmentRow[][] = [];
  for (let i = 0; i < segs.length; i += MIX_WINDOW) windows.push(segs.slice(i, i + MIX_WINDOW));

  const winFiles: string[] = [];
  for (let w = 0; w < windows.length; w++) {
    const grp = windows[w];
    const winStart = grp[0].startMs;
    // Window length covers every clip (including tempo-adjusted tails) + tail room
    let winEnd = 0;
    for (const s of grp) {
      const clipMs = Math.round((s.ttsMs ?? 1000) / (s.tempo ?? 1));
      winEnd = Math.max(winEnd, s.startMs + clipMs);
    }
    winEnd = Math.min(Math.max(winEnd, grp[grp.length - 1].endMs) + 400, durationMs);
    const winDurSec = Math.max(0.5, (winEnd - winStart) / 1000);

    const inputs: string[] = [];
    const filterParts: string[] = [];
    grp.forEach((s, k) => {
      inputs.push("-i", s.audioPath!);
      const d = Math.max(0, s.startMs - winStart);
      // 12 ms fades on both edges: hard-cut TTS clips click when they are mixed
      // into a timeline, and clicks are the first thing people notice in a dub.
      const clipSec = Math.max(0.05, ((s.ttsMs ?? 1000) / (s.tempo ?? 1)) / 1000);
      const fadeOut = Math.max(0, clipSec - 0.012);
      filterParts.push(
        `[${k}:a]aresample=24000,asetpts=PTS-STARTPTS,` +
          `afade=t=in:st=0:d=0.012,afade=t=out:st=${fadeOut.toFixed(3)}:d=0.012,` +
          `adelay=${d}|${d}[s${k}]`,
      );
    });
    const mixIn = grp.map((_, k) => `[s${k}]`).join("");
    filterParts.push(
      `${mixIn}amix=inputs=${grp.length}:normalize=0:dropout_transition=0,apad=whole_dur=${winDurSec.toFixed(3)},atrim=duration=${winDurSec.toFixed(3)},asetpts=PTS-STARTPTS[wout]`,
    );

    const winPath = path.join(dir, `win_${w}.wav`);
    await runChecked(
      FFMPEG,
      [
        "-y", "-f", "lavfi", "-t", "0.1", "-i", "anullsrc=r=24000:cl=mono",
        ...inputs,
        "-filter_complex", filterParts.join(";"),
        "-map", "[wout]",
        "-c:a", "pcm_s16le",
        winPath,
      ],
      { killAfterMs: 60 * 60_000 },
    );
    winFiles.push(winPath);
    await setProgress(job.id, "sync", 84 + ((w + 1) / windows.length) * 8, `Mixing window ${w + 1}/${windows.length}`);
  }

  // Concatenate windows into the full dubbed track, then lift it to a
  // consistent broadcast level at 48 kHz (AAC from a 24 kHz source sounds dull).
  const joined = path.join(dir, "dub_joined.wav");
  if (winFiles.length === 1) {
    fs.copyFileSync(winFiles[0], joined);
  } else {
    const listPath = path.join(dir, "concat.txt");
    fs.writeFileSync(listPath, winFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    await runChecked(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:a", "copy", joined], { killAfterMs: 30 * 60_000 });
  }
  const dubWav = path.join(dir, "dub_track.wav");
  await loudnormToWav(joined, dubWav);

  // Final multiplex — video stream copied untouched, NO watermark, ever.
  await setProgress(job.id, "sync", 94, "Multiplexing final MP4…");
  const outputPath = path.join(dir, `dubbed_${job.targetLang}.mp4`);
  const mixArgs: string[] = ["-y", "-i", job.webPath!, "-i", dubWav];
  if (job.mixOriginal) {
    mixArgs.push("-i", job.audioPath!);
    mixArgs.push(
      "-filter_complex",
      "[1:a]aresample=24000[vo];[2:a]volume=0.10,aresample=24000[bg];[vo][bg]amix=inputs=2:normalize=0[aout]",
      "-map", "0:v:0", "-map", "[aout]",
    );
  } else {
    mixArgs.push("-map", "0:v:0", "-map", "1:a:0");
  }
  mixArgs.push(
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-t", String(job.durationSec ?? 0),
    "-movflags", "+faststart",
    outputPath,
  );
  await runChecked(FFMPEG, mixArgs, { killAfterMs: 2 * 60 * 60_000 });

  await setJob(job.id, { outputPath });
  await addLog(job.id, `Mux complete — ${(fs.statSync(outputPath).size / 1048576).toFixed(1)} MB, video stream untouched, zero watermarks.`);
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

export type JobMode = "full" | "transcribe" | "review" | "resume";

export async function runPipeline(jobId: string, opts: { mode?: JobMode } = {}) {
  const mode: JobMode = opts.mode ?? "full";
  const dir = jobDir(jobId);
  try {
    await setJob(jobId, { status: "running", error: null });
    let job = await getJob(jobId);

    if (mode === "full") {
      await addLog(jobId, `Job accepted — "${job.originalName}" (${((job.fileSize ?? 0) / 1048576).toFixed(1)} MB)`);
      await stageExtract(job, dir);
      job = await getJob(jobId);

      const asr = await stageTranscribe(job, dir);
      if (asr === "awaiting") return; // parked until the Studio supplies a transcript
      job = await getJob(jobId);

      await stageTranslate(job);
      job = await getJob(jobId);
      if (job.status === "awaiting_review") {
        if (job.reviewMode) await addLog(jobId, "Waiting for human review — edit any line, then press Synthesize.");
        return; // parked for browser translation / human review
      }

      if (job.reviewMode) {
        await setJob(jobId, { status: "awaiting_review", stage: "review", progress: 55 });
        await addLog(jobId, "Waiting for human review — edit any line, then press Synthesize.");
        return;
      }
    } else if (mode === "transcribe") {
      await addLog(jobId, "Speech recognition model is in place — transcribing now.");
      const asr = await stageTranscribe(job, dir);
      if (asr === "awaiting") return;
      job = await getJob(jobId);
      await stageTranslate(job);
      job = await getJob(jobId);
      if (job.status === "awaiting_review" || job.reviewMode) return;
    } else if (mode === "review") {
      await addLog(jobId, "Review approved — starting synthesis…");
    } else {
      await addLog(jobId, "Resuming with the transcript + translations supplied by the Studio…");
    }

    job = await getJob(jobId);
    await stageSynthesize(job, dir);
    job = await getJob(jobId);
    await stageMux(job, dir);
    await setJob(jobId, { status: "done", stage: "done", progress: 100, stageDetail: "Dub ready" });
    await addLog(jobId, "All done — your dubbed video is ready.");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await setJob(jobId, { status: "error", stage: "error", error: msg, stageDetail: msg });
      await addLog(jobId, `ERROR — ${msg}`);
    } catch (inner) {
      console.error("Failed to persist error state", inner);
    }
    console.error(`[pipeline ${jobId}]`, e);
  }
}
