import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { MODEL_PRESETS, markFileInstalled, safeModelPath } from "@/lib/models";

export const runtime = "nodejs";
export const maxDuration = 600;

/**
 * POST /api/models/upload
 *   headers: x-rel-path: "<dest from the model registry>", x-offset: "<byte offset>"
 *   body:    raw chunk bytes
 *
 * The visitor's browser is the only party that can reach huggingface.co, so it
 * downloads the model file and streams it here in chunks. Writes are positional,
 * which makes the transfer resumable.
 */
export async function POST(req: NextRequest) {
  const relPath = req.headers.get("x-rel-path") ?? "";
  const offset = Number(req.headers.get("x-offset") ?? "-1");
  const reset = req.headers.get("x-reset") === "1";

  const allowed = new Set(MODEL_PRESETS.flatMap((p) => p.files.map((f) => f.dest)));
  if (!allowed.has(relPath)) {
    return NextResponse.json({ error: "Unknown model path" }, { status: 400 });
  }
  if (!reset && (!Number.isFinite(offset) || offset < 0)) {
    return NextResponse.json({ error: "Missing x-offset" }, { status: 400 });
  }

  const abs = safeModelPath(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  // "Start this file over" — used when a stale partial download would corrupt it.
  if (reset) {
    fs.writeFileSync(abs, Buffer.alloc(0));
    return NextResponse.json({ ok: true, path: relPath, bytes: 0 });
  }

  const body = Buffer.from(await req.arrayBuffer());
  if (body.length === 0) return NextResponse.json({ error: "Empty chunk" }, { status: 400 });

  // A resumed chunk may arrive for a file that no longer exists (or never did).
  const fd =
    offset > 0 && fs.existsSync(abs)
      ? fs.openSync(abs, "r+")
      : fs.openSync(abs, "w");
  try {
    // Writing past the current end (gap left by a killed transfer) is legal on
    // POSIX — the hole reads back as zeroes, and the next chunk fills it.
    if (offset > 0 && fs.fstatSync(fd).size < offset) fs.writeSync(fd, Buffer.from([0]), 0, 1, offset - 1);
    fs.writeSync(fd, body, 0, body.length, offset);
  } finally {
    fs.closeSync(fd);
  }

  const size = fs.statSync(abs).size;
  // "This was the last chunk": remember the real length of the finished file.
  if (req.headers.get("x-complete") === "1") markFileInstalled(relPath, size);
  return NextResponse.json({ ok: true, path: relPath, bytes: size, complete: size });
}
