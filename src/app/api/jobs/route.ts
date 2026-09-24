import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { once } from "events";
import Busboy from "busboy";
import { randomUUID } from "crypto";
import { desc } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { dubJobs } from "@/db/schema";
import { jobToDto } from "@/lib/dto";
import { enqueueJob } from "@/lib/pipeline/queue";
import { uploadsDir } from "@/lib/storage";
import { LANGUAGES, voiceById } from "@/lib/voices";
import { probeDurationSec } from "@/lib/fftools";

export const runtime = "nodejs";
export const maxDuration = 3600;

const MAX_FILE_BYTES = 3 * 1024 * 1024 * 1024; // 3 GB — hours of footage
const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|mpg|mpeg|ts|m2ts|flv|wmv|3gp|mxf)$/i;

/** GET /api/jobs — recent jobs (log stripped) */
export async function GET() {
  const rows = await db
    .select()
    .from(dubJobs)
    .orderBy(desc(dubJobs.createdAt))
    .limit(10);
  return NextResponse.json({ jobs: rows.map((r) => jobToDto(r, { withLog: false })) });
}

/**
 * POST /api/jobs — multipart upload (file last). Streams to disk via busboy,
 * so hour-long videos don't blow up memory.
 */
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data") || !req.body) {
    return NextResponse.json({ error: "Expected multipart/form-data with a video file." }, { status: 400 });
  }

  const jobId = randomUUID();
  const fields: Record<string, string> = {};
  let savedPath: string | null = null;
  let originalName = "video.mp4";
  let mime = "video/mp4";
  let savedSize = 0;
  let truncated = false;

  try {
    const bb = Busboy({
      headers: { "content-type": contentType },
      limits: { fileSize: MAX_FILE_BYTES, files: 1 },
    });

    const nodeBody = Readable.fromWeb(
      req.body as unknown as import("stream/web").ReadableStream,
    );

    bb.on("field", (name: string, value: string) => {
      fields[name] = value;
    });

    const savePromises: Promise<void>[] = [];
    bb.on(
      "file",
      (
        _name: string,
        file: NodeJS.ReadableStream & { truncated?: boolean },
        info: { filename: string; mimeType: string },
      ) => {
        originalName = info.filename || originalName;
        mime = info.mimeType || mime;
        const okType = mime.startsWith("video/") || VIDEO_EXT.test(originalName);
        if (!okType) {
          file.resume();
          return;
        }
        const ext = (path.extname(originalName) || ".mp4").slice(0, 10);
        savedPath = path.join(uploadsDir(), `${jobId}${ext}`);
        const ws = fs.createWriteStream(savedPath);
        file.on("data", (chunk: Buffer) => {
          savedSize += chunk.length;
        });
        file.on("limit", () => {
          truncated = true;
        });
        savePromises.push(
          (async () => {
            file.pipe(ws);
            await once(ws, "finish");
          })(),
        );
      },
    );

    const done = once(bb, "finish");
    nodeBody.pipe(bb);
    await done.catch(() => undefined);
    await Promise.allSettled(savePromises);
  } catch (e) {
    return NextResponse.json(
      { error: `Upload failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    );
  }

  if (truncated) {
    if (savedPath) fs.rmSync(savedPath, { force: true });
    return NextResponse.json({ error: "File exceeds the 3 GB limit." }, { status: 413 });
  }
  if (!savedPath || savedSize < 1000 || !fs.existsSync(savedPath)) {
    return NextResponse.json({ error: "No valid video file received." }, { status: 400 });
  }

  // Fast sanity probe — reject non-video garbage before queueing
  try {
    await probeDurationSec(savedPath);
  } catch {
    fs.rmSync(savedPath, { force: true });
    return NextResponse.json({ error: "Could not read this file as a video (probe failed)." }, { status: 400 });
  }

  const targetLang = LANGUAGES.some((l) => l.code === fields.targetLang)
    ? fields.targetLang
    : "hi";
  const voiceId = voiceById(fields.voiceId ?? "") ? fields.voiceId! : "";
  const clamp = (v: string | undefined, min: number, max: number) => {
    const n = Number.parseInt(v ?? "0", 10);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0;
  };

  const [job] = await db
    .insert(dubJobs)
    .values({
      id: jobId,
      status: "queued",
      stage: "queued",
      progress: 0,
      originalName,
      mimeType: mime,
      fileSize: savedSize,
      srcPath: savedPath,
      targetLang,
      voiceId: voiceId || "auto",
      ratePct: clamp(fields.ratePct, -50, 50),
      pitchHz: clamp(fields.pitchHz, -40, 40),
      sourceLang: LANGUAGES.some((l) => l.code === fields.sourceLang)
        ? fields.sourceLang
        : "auto",
      reviewMode: fields.reviewMode === "1",
      mixOriginal: fields.mixOriginal === "1",
    })
    .returning();

  enqueueJob(jobId);
  return NextResponse.json({ job: jobToDto(job) }, { status: 201 });
}
