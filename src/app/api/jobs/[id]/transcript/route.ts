import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { dubJobs, dubSegments } from "@/db/schema";
import { jobToDto } from "@/lib/dto";
import { enqueueJob } from "@/lib/pipeline/queue";
import { translateAll } from "@/lib/pipeline/translate";

export const runtime = "nodejs";
export const maxDuration = 600;

interface InSeg {
  start: number;
  end: number;
  text: string;
  translatedText?: string;
}

/**
 * POST /api/jobs/:id/transcript
 *
 * The Studio runs speech recognition (and usually translation) inside the
 * visitor's browser, because the visitor has internet and the server does not.
 * This endpoint hands those lines to the server-side pipeline, which then does
 * synthesis + muxing locally.
 *
 * body: { language?: "en", segments: [{ start: seconds, end: seconds, text, translatedText? }] }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [job] = await db.select().from(dubJobs).where(eq(dubJobs.id, id)).limit(1);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { language?: string; segments?: InSeg[] };
  const incoming = (body.segments ?? [])
    .filter((s) => s && typeof s.text === "string" && s.text.trim().length > 0)
    .map((s) => ({
      start: Math.max(0, Number(s.start) || 0),
      end: Math.max(0, Number(s.end) || 0),
      text: s.text.trim().slice(0, 2000),
      translatedText: typeof s.translatedText === "string" ? s.translatedText.trim().slice(0, 2000) : "",
    }))
    .filter((s) => s.end > s.start)
    .slice(0, 5000);

  if (incoming.length === 0) {
    return NextResponse.json({ error: "No usable segments supplied" }, { status: 400 });
  }

  const src = body.language || job.detectedLang || job.sourceLang || "en";
  const tgt = job.targetLang;

  // Translations the browser already produced win; anything missing is attempted
  // server-side (works whenever this process has network, e.g. outside a sandbox).
  if (src !== tgt && incoming.some((s) => !s.translatedText)) {
    try {
      const idxs = incoming.map((s, i) => (s.translatedText ? -1 : i)).filter((i) => i >= 0);
      await translateAll(idxs.map((i) => incoming[i].text), src, tgt, async (k, translated) => {
        incoming[idxs[k]].translatedText = translated;
      }).catch(() => null);
    } catch {
      /* keep the source text — the dub is still produced */
    }
  }

  await db.delete(dubSegments).where(eq(dubSegments.jobId, id));
  const CH = 200;
  for (let i = 0; i < incoming.length; i += CH) {
    const batch = incoming.slice(i, i + CH);
    await db.insert(dubSegments).values(
      batch.map((s, k) => ({
        jobId: id,
        idx: i + k,
        startMs: Math.round(s.start * 1000),
        endMs: Math.round(s.end * 1000),
        sourceText: s.text,
        translatedText: s.translatedText || null,
        status: s.translatedText ? "translated" : "pending",
      })),
    );
  }

  await db
    .update(dubJobs)
    .set({
      segmentCount: incoming.length,
      detectedLang: src,
      sourceLang: job.sourceLang === "auto" ? src : job.sourceLang,
      status: "queued",
      stage: "synthesize",
      progress: 50,
      stageDetail: `Transcript from the Studio — ${incoming.length} lines`,
      error: null,
      updatedAt: new Date(),
    })
    .where(and(eq(dubJobs.id, id)));

  enqueueJob(id, "resume");

  const [fresh] = await db.select().from(dubJobs).where(eq(dubJobs.id, id)).limit(1);
  return NextResponse.json({
    ok: true,
    segments: incoming.length,
    translated: incoming.filter((s) => s.translatedText).length,
    job: fresh ? jobToDto(fresh) : null,
  });
}
