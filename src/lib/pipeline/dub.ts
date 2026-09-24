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
import { translateAll } from "./translate";

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
}

/* ------------------------------------------------------------------ */
/* Stage 2 — Faster-Whisper ASR (INT8, CPU), chunked for any length    */
/* ------------------------------------------------------------------ */

async function stageTranscribe(job: JobRow, dir: string) {
  await setProgress(job.id, "transcribe", 8, "Splitting audio into ASR chunks…");
  // Clean retry residue
  await db.delete(dubSegments).where(eq(dubSegments.jobId, job.id));

  const duration = job.durationSec ?? (await probeDurationSec(job.audioPath!));
  const chunkCount = Math.max(1, Math.ceil(duration / CHUNK_SEC));
  await addLog(job.id, `Faster-Whisper (${WHISPER_MODEL}, INT8, CPU) · ${chunkCount} chunk(s) of ${CHUNK_SEC / 60} min`);

  type RawSeg = { start: number; end: number; text: string };
  const all: RawSeg[] = [];
  let detected: string | null = null;

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
        "--model", WHISPER_MODEL,
        "--lang", job.sourceLang || "auto",
      ],
      { killAfterMs: 4 * 60 * 60_000 },
    );
    if (res.code !== 0) {
      await addLog(job.id, `ASR chunk ${c + 1} failed (${res.stderr.slice(-160)}) — skipping`);
      continue;
    }
    let parsed: { language?: string; segments?: RawSeg[] };
    try {
      parsed = JSON.parse(res.stdout.trim());
    } catch {
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

  const texts = segs.map((s) => s.sourceText);
  const { viaLLM } = await translateAll(
    texts,
    src,
    tgt,
    async (i, translated) => {
      await db
        .update(dubSegments)
        .set({ translatedText: translated, status: "translated" })
        .where(eq(dubSegments.id, segs[i].id));
    },
    (done, total) => {
      const pct = 38 + (done / Math.max(1, total)) * 17;
      void setProgress(job.id, "translate", pct, `Translating… ${done}/${total}`);
    },
  );
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
  const rate = fmtSigned(job.ratePct, "%");
  const pitch = fmtSigned(job.pitchHz, "Hz");
  await setProgress(job.id, "synthesize", 56, `Neural TTS: ${voiceId} (${segs.length} lines)`);
  await addLog(job.id, `Edge-TTS voice ${voiceId} · rate ${rate} · pitch ${pitch}`);

  const items = segs
    .map((s) => ({
      i: s.idx,
      text: (s.translatedText ?? s.sourceText).trim(),
      voice: voiceId,
      rate,
      pitch,
      out: path.join(segDir, `seg_${s.idx}.mp3`),
    }))
    .filter((it) => it.text.length > 0);

  const manifest = path.join(dir, "tts_manifest.json");
  fs.writeFileSync(manifest, JSON.stringify(items));

  let doneCount = 0;
  const okIdx = new Set<number>();
  const res = await run(
    PY,
    [
      path.join(SCRIPTS, "tts_batch.py"),
      "--manifest", manifest,
      "--concurrency", "5",
    ],
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
  if (okIdx.size === 0) throw new Error("Neural TTS produced no audio (network blocked?)");

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
    // Dynamic tempo: compress if the reading overflows, mildly stretch if too short
    let tempo = 1;
    if (ratio > 1.05) tempo = Math.min(1.45, ratio);
    else if (ratio < 0.8 && ttsMs > 600) tempo = Math.max(0.85, ratio);

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
      filterParts.push(`[${k}:a]aresample=24000,asetpts=PTS-STARTPTS,adelay=${d}|${d}[s${k}]`);
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

  // Concatenate windows into the full dubbed track
  const dubWav = path.join(dir, "dub_track.wav");
  if (winFiles.length === 1) {
    fs.copyFileSync(winFiles[0], dubWav);
  } else {
    const listPath = path.join(dir, "concat.txt");
    fs.writeFileSync(listPath, winFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    await runChecked(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:a", "copy", dubWav], { killAfterMs: 30 * 60_000 });
  }

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
    "-c:a", "aac", "-b:a", "160k",
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

export async function runPipeline(jobId: string, opts: { fromReview?: boolean } = {}) {
  const dir = jobDir(jobId);
  try {
    await setJob(jobId, { status: "running", error: null });
    let job = await getJob(jobId);

    if (!opts.fromReview) {
      await addLog(jobId, `Job accepted — "${job.originalName}" (${((job.fileSize ?? 0) / 1048576).toFixed(1)} MB)`);
      await stageExtract(job, dir);
      job = await getJob(jobId);
      await stageTranscribe(job, dir);
      job = await getJob(jobId);
      await stageTranslate(job);

      if (job.reviewMode) {
        await setJob(jobId, { status: "awaiting_review", stage: "review", progress: 55 });
        await addLog(jobId, "Waiting for human review — edit any line, then press Synthesize.");
        return;
      }
    } else {
      await addLog(jobId, "Review approved — starting neural synthesis…");
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
