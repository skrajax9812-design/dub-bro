import { NextResponse } from "next/server";
import {
  MODEL_PRESETS,
  findLocalKokoro,
  findLocalPiperVoice,
  findLocalWhisperModel,
  kokoroVoiceFor,
  modelsRoot,
  presetStatus,
} from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/models — what the pipeline can use right now + per-file progress. */
export async function GET() {
  const whisperDir = findLocalWhisperModel();
  const piperHi = findLocalPiperVoice("hi", "M");
  const kokoro = findLocalKokoro();
  return NextResponse.json({
    root: modelsRoot(),
    presets: MODEL_PRESETS.map((p) => ({
      ...presetStatus(p),
      files: p.files.map((f, i) => ({ ...presetStatus(p).files[i], repo: f.repo, file: f.file, approx: f.bytes })),
    })),
    active: {
      whisper: whisperDir ? whisperDir.split("/").pop() : null,
      piper: piperHi ? piperHi.split("/").pop() : null,
      kokoro: kokoro ? "kokoro-v1.0" : null,
      // Which engine a job would use right now.
      engine: kokoro ? "kokoro" : piperHi ? "piper" : "espeak",
      kokoroVoices: { hi: [kokoroVoiceFor("hi", "F"), kokoroVoiceFor("hi", "M")] },
    },
  });
}
