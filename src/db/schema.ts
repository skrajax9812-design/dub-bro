import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * A dub job = one uploaded video moving through the AI dubbing pipeline:
 * extract -> transcribe -> translate -> (review) -> synthesize -> sync/mux -> done
 */
export const dubJobs = pgTable(
  "dub_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    /** queued | running | awaiting_transcript | awaiting_review | done | error */
    status: text("status").notNull().default("queued"),
    /** queued | extract | transcribe | translate | review | synthesize | sync | done | error */
    stage: text("stage").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    stageDetail: text("stage_detail"),

    originalName: text("original_name").notNull(),
    mimeType: text("mime_type"),
    fileSize: integer("file_size"),

    srcPath: text("src_path").notNull(),
    webPath: text("web_path"),
    audioPath: text("audio_path"),
    outputPath: text("output_path"),

    durationSec: real("duration_sec"),
    sourceLang: text("source_lang").notNull().default("auto"),
    detectedLang: text("detected_lang"),
    targetLang: text("target_lang").notNull().default("hi"),
    voiceId: text("voice_id").notNull().default("hi-IN-SwaraNeural"),
    ratePct: integer("rate_pct").notNull().default(0),
    pitchHz: integer("pitch_hz").notNull().default(0),
    reviewMode: boolean("review_mode").notNull().default(false),
    mixOriginal: boolean("mix_original").notNull().default(false),
    /** Clone the source speaker: pitch + tone matching of every dubbed line. */
    voiceMatch: boolean("voice_match").notNull().default(true),

    segmentCount: integer("segment_count").notNull().default(0),
    error: text("error"),
    log: jsonb("log")
      .$type<{ t: number; msg: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (t) => [index("dub_jobs_created_idx").on(t.createdAt)],
);

/** One row per transcribed sentence/utterance, time-aligned to the source video. */
export const dubSegments = pgTable(
  "dub_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => dubJobs.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    sourceText: text("source_text").notNull(),
    translatedText: text("translated_text"),
    /** pending | translated | synthesized | failed */
    status: text("status").notNull().default("pending"),
    audioPath: text("audio_path"),
    ttsMs: integer("tts_ms"),
    tempo: real("tempo"),
  },
  (t) => [index("dub_segments_job_idx").on(t.jobId, t.idx)],
);
