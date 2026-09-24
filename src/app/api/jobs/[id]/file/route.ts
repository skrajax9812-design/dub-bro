import fs from "fs";
import { Readable } from "stream";
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { dubJobs } from "@/db/schema";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/jobs/:id/file?kind=source|web|output[&download=1]
 * HTTP Range-aware streaming so <video> seeking works.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const kind = req.nextUrl.searchParams.get("kind") ?? "output";
  const [job] = await db.select().from(dubJobs).where(eq(dubJobs.id, id)).limit(1);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  let filePath: string | null = null;
  let contentType = "video/mp4";
  if (kind === "source") {
    filePath = job.srcPath;
    contentType = job.mimeType?.startsWith("video/") ? job.mimeType : "video/mp4";
  } else if (kind === "web") {
    filePath = job.webPath ?? job.srcPath;
  } else {
    filePath = job.outputPath;
  }
  if (!filePath || !fs.existsSync(filePath)) {
    return NextResponse.json({ error: "File not available yet" }, { status: 404 });
  }

  const stat = fs.statSync(filePath);
  const total = stat.size;
  const download = req.nextUrl.searchParams.get("download") === "1";
  const baseName =
    kind === "output"
      ? job.originalName.replace(/\.[^.]+$/, "") + `.dubbed-${job.targetLang}.mp4`
      : job.originalName;

  const headers: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Content-Type": contentType,
    "Cache-Control": "private, max-age=3600",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(baseName)}`,
  };

  const range = req.headers.get("range");
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (m[1] === "" && m[2]) {
        // suffix range: last N bytes
        start = Math.max(0, total - parseInt(m[2], 10));
        end = total - 1;
      }
      end = Math.min(end, total - 1);
      start = Math.min(start, end);
      const chunkSize = end - start + 1;
      const stream = fs.createReadStream(filePath, { start, end });
      return new Response(
        Readable.toWeb(stream) as unknown as ReadableStream,
        {
          status: 206,
          headers: {
            ...headers,
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Content-Length": String(chunkSize),
          },
        },
      );
    }
  }

  const stream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
    status: 200,
    headers: { ...headers, "Content-Length": String(total) },
  });
}
