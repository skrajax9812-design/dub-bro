import fs from "fs";
import path from "path";
import { and, asc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { dubJobs, dubSegments } from "@/db/schema";
import { jobToDto, segToDto } from "@/lib/dto";
import { enqueueJob } from "@/lib/pipeline/queue";
import { jobDir } from "@/lib/storage";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/jobs/:id — full job state incl. transcript segments + live log */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const [job] = await db.select().from(dubJobs).where(eq(dubJobs.id, id)).limit(1);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const segments = await db
    .select()
    .from(dubSegments)
    .where(eq(dubSegments.jobId, id))
    .orderBy(asc(dubSegments.idx))
    .limit(5000);

  return NextResponse.json({
    job: jobToDto(job),
    segments: segments.map(segToDto),
  });
}

/**
 * PATCH /api/jobs/:id
 *  { segments: [{id, translatedText}] }   -> save review edits
 *  { action: "continue" }                 -> leave review, synthesize
 *  { action: "retry" }                    -> rerun whole pipeline after error
 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const [job] = await db.select().from(dubJobs).where(eq(dubJobs.id, id)).limit(1);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    segments?: { id: string; translatedText?: string }[];
  };

  if (Array.isArray(body.segments)) {
    for (const s of body.segments.slice(0, 5000)) {
      if (typeof s.translatedText !== "string") continue;
      await db
        .update(dubSegments)
        .set({ translatedText: s.translatedText.slice(0, 2000) })
        .where(and(eq(dubSegments.id, s.id), eq(dubSegments.jobId, id)));
    }
  }

  if (body.action === "continue") {
    if (job.status !== "awaiting_review") {
      return NextResponse.json({ error: "Job is not waiting for review" }, { status: 409 });
    }
    await db
      .update(dubJobs)
      .set({ status: "queued", stage: "synthesize", updatedAt: new Date() })
      .where(eq(dubJobs.id, id));
    enqueueJob(id, true);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "retry") {
    if (job.status !== "error") {
      return NextResponse.json({ error: "Only failed jobs can be retried" }, { status: 409 });
    }
    await db
      .update(dubJobs)
      .set({
        status: "queued",
        stage: "queued",
        progress: 0,
        error: null,
        stageDetail: "Retry queued",
        updatedAt: new Date(),
      })
      .where(eq(dubJobs.id, id));
    enqueueJob(id, false);
    return NextResponse.json({ ok: true });
  }

  const [fresh] = await db.select().from(dubJobs).where(eq(dubJobs.id, id)).limit(1);
  return NextResponse.json({ ok: true, job: fresh ? jobToDto(fresh) : null });
}

/** DELETE /api/jobs/:id — remove job, transcript, and files */
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const [job] = await db.select().from(dubJobs).where(eq(dubJobs.id, id)).limit(1);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  await db.delete(dubJobs).where(eq(dubJobs.id, id));
  try {
    if (job.srcPath && fs.existsSync(job.srcPath)) fs.rmSync(job.srcPath, { force: true });
    const dir = jobDir(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    const parent = path.dirname(job.srcPath ?? "");
    if (parent.includes("uploads")) {
      // cleaned above
    }
  } catch {
    /* best-effort cleanup */
  }
  return NextResponse.json({ ok: true });
}
