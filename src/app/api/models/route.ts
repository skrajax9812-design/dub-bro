import { NextResponse } from "next/server";
import {
  MODEL_PRESETS,
  findLocalKokoro,
  findLocalPiperVoice,
  findLocalWhisperModel,
  findLocalXtts,
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
  const xtts = findLocalXtts();
  return NextResponse.json({
    root: modelsRoot(),
    presets: MODEL_PRESETS.map((p) => {
      const status = presetStatus(p);
      return {
        ...status,
        // Byte counts per file so the browser can resume an interrupted download.
        files: p.files.map((f, i) => ({
          dest: f.dest,
          repo: f.repo,
          file: f.file,
          haveBytes: status.files[i].bytes,
          totalBytes: f.bytes,
          complete: status.files[i].complete,
        })),
      };
    }),
    active: {
      whisper: whisperDir ? whisperDir.split("/").pop() : null,
      piper: piperHi ? piperHi.split("/").pop() : null,
      kokoro: kokoro ? "kokoro-v1.0" : null,
      clone: xtts ? "xtts-v2" : null,
      // Which engine a job would use right now.
      engine: xtts ? "xtts" : kokoro ? "kokoro" : piperHi ? "piper" : "espeak",
      kokoroVoices: { hi: [kokoroVoiceFor("hi", "F"), kokoroVoiceFor("hi", "M")] },
    },
  });
}
