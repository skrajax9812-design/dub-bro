export type JobStatus = "queued" | "running" | "awaiting_review" | "done" | "error";

export type JobStage =
  | "queued"
  | "extract"
  | "transcribe"
  | "translate"
  | "review"
  | "synthesize"
  | "sync"
  | "done"
  | "error";

export interface SegmentDto {
  id: string;
  idx: number;
  startMs: number;
  endMs: number;
  sourceText: string;
  translatedText: string | null;
  status: string;
  ttsMs: number | null;
  tempo: number | null;
}

export interface JobDto {
  id: string;
  createdAt: string;
  status: JobStatus;
  stage: JobStage;
  progress: number;
  stageDetail: string | null;
  originalName: string;
  fileSize: number | null;
  durationSec: number | null;
  sourceLang: string;
  detectedLang: string | null;
  targetLang: string;
  voiceId: string;
  ratePct: number;
  pitchHz: number;
  reviewMode: boolean;
  mixOriginal: boolean;
  segmentCount: number;
  error: string | null;
  log: { t: number; msg: string }[];
}

export const STAGE_META: { key: JobStage; label: string; blurb: string }[] = [
  { key: "extract", label: "Extract", blurb: "FFmpeg: 16 kHz mono audio + H.264 web remux" },
  { key: "transcribe", label: "Transcribe", blurb: "Faster-Whisper INT8 ASR with timestamps" },
  { key: "translate", label: "Translate", blurb: "Chunked neural translation, sentence-wise" },
  { key: "synthesize", label: "Synthesize", blurb: "Edge-TTS neural voice per segment" },
  { key: "sync", label: "Sync & Mux", blurb: "Tempo alignment + watermark-free multiplex" },
];

export const STAGE_ORDER: JobStage[] = [
  "extract",
  "transcribe",
  "translate",
  "synthesize",
  "sync",
  "done",
];
