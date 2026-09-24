import type { dubJobs, dubSegments } from "@/db/schema";
import type { JobDto, SegmentDto } from "./types";

type JobRow = typeof dubJobs.$inferSelect;
type SegRow = typeof dubSegments.$inferSelect;

export function jobToDto(row: JobRow, opts: { withLog?: boolean } = {}): JobDto {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    status: row.status as JobDto["status"],
    stage: row.stage as JobDto["stage"],
    progress: row.progress,
    stageDetail: row.stageDetail,
    originalName: row.originalName,
    fileSize: row.fileSize,
    durationSec: row.durationSec,
    sourceLang: row.sourceLang,
    detectedLang: row.detectedLang,
    targetLang: row.targetLang,
    voiceId: row.voiceId,
    ratePct: row.ratePct,
    pitchHz: row.pitchHz,
    reviewMode: row.reviewMode,
    mixOriginal: row.mixOriginal,
    voiceMatch: row.voiceMatch,
    segmentCount: row.segmentCount,
    error: row.error,
    log: opts.withLog === false ? [] : (row.log ?? []),
  };
}

export function segToDto(row: SegRow): SegmentDto {
  return {
    id: row.id,
    idx: row.idx,
    startMs: row.startMs,
    endMs: row.endMs,
    sourceText: row.sourceText,
    translatedText: row.translatedText,
    status: row.status,
    ttsMs: row.ttsMs,
    tempo: row.tempo,
  };
}
