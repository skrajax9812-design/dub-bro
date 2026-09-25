import fs from "fs";
import { execFileSync } from "child_process";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { dataRoot } from "@/lib/storage";
import { findLocalKokoro, findLocalPiperVoice, findLocalWhisperModel, findLocalXtts } from "@/lib/models";
import path from "path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function binVersion(bin: string): string | null {
  try {
    return execFileSync(bin, ["-version"], { timeout: 5000, encoding: "utf8" }).split("\n")[0].slice(0, 60);
  } catch {
    return null;
  }
}

/**
 * GET /api/health — one request that answers "is this machine ready?".
 * The Studio shows the result of this file when something looks broken, so it
 * deliberately includes paths and versions instead of a bare {ok:true}.
 */
export async function GET() {
  let dbOk = true;
  let dbError: string | null = null;
  try {
    await db.execute(sql`select 1`);
  } catch (e) {
    dbOk = false;
    dbError = e instanceof Error ? e.message : String(e);
  }

  const py = process.env.PYTHON_BIN || "python3";
  let python: string | null = null;
  try {
    python = execFileSync(py, ["-c", "import sys;print(sys.version.split()[0])"], {
      timeout: 8000,
      encoding: "utf8",
    }).trim();
  } catch {
    python = null;
  }

  const ffmpeg = binVersion(process.env.FFMPEG_PATH || "ffmpeg");
  const ffprobe = binVersion(process.env.FFPROBE_PATH || "ffprobe");
  const whisper = findLocalWhisperModel();
  const xtts = findLocalXtts();
  const kokoro = findLocalKokoro();
  const piper = findLocalPiperVoice("hi", "M");

  return Response.json(
    {
      ok: dbOk,
      db: { ok: dbOk, error: dbError },
      dataDir: {
        path: dataRoot(),
        writable: (() => {
          try {
            fs.accessSync(dataRoot(), fs.constants.W_OK);
            return true;
          } catch {
            return false;
          }
        })(),
        outsideWorkspace: !dataRoot().startsWith("/home/user/"),
      },
      ffmpeg,
      ffprobe,
      python: { bin: py, version: python },
      models: {
        whisper: whisper ? path.basename(whisper) : null,
        xtts: Boolean(xtts),
        kokoro: Boolean(kokoro),
        piper: piper ? path.basename(piper) : null,
        engine: xtts ? "xtts" : kokoro ? "kokoro" : piper ? "piper" : "espeak",
      },
      env: { TTS_ENGINE: process.env.TTS_ENGINE ?? "auto", WHISPER_MODEL: process.env.WHISPER_MODEL ?? "base" },
    },
    { status: dbOk ? 200 : 500 },
  );
}
