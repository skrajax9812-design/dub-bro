"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  Check,
  Cpu,
  Download,
  Mic,
  Wand2,
  FileVideo,
  Gauge,
  Globe2,
  Languages,
  Loader2,
  PencilRuler,
  Play,
  ScanFace,
  SlidersHorizontal,
  Sparkles,
  UploadCloud,
  User,
  Volume2,
  X,
} from "lucide-react";
import type { JobDto, SegmentDto } from "@/lib/types";
import { STAGE_META } from "@/lib/types";
import { LANGUAGES, VOICES, voicesForLanguage, type DubVoice } from "@/lib/voices";
import type { ModelPresetInfo } from "@/lib/browserAssist";

/** Mirrors the extension allow-list enforced by /api/jobs. */
const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|mpg|mpeg|ts|m2ts|flv|wmv|3gp|mxf)$/i;

/* ------------------------------- bits ------------------------------- */

export function Kicker({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[10px] tracking-[0.3em] text-zinc-500">
      {children}
    </p>
  );
}

export function fmtTC(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const sec = (s % 60).toFixed(1).padStart(4, "0");
  if (h > 0) return `${h}:${String(m % 60).padStart(2, "0")}:${sec}`;
  return `${String(m).padStart(2, "0")}:${sec}`;
}

export function fmtBytes(n: number | null): string {
  if (!n) return "—";
  if (n > 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/* ------------------------------ dropzone ---------------------------- */

export function Dropzone({
  file,
  onFile,
  disabled,
}: {
  file: File | null;
  onFile: (f: File | null) => void;
  disabled?: boolean;
}) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (disabled) return;
        const f = e.dataTransfer.files?.[0];
        // Browsers often report an empty MIME type for .mkv/.ts/.avi, so fall
        // back to the extension before rejecting the drop.
        const looksLikeVideo =
          f && (f.type.startsWith("video/") || VIDEO_EXT.test(f.name));
        if (f && looksLikeVideo) onFile(f);
      }}
      onClick={() => !disabled && inputRef.current?.click()}
      className={`group relative flex min-h-[19rem] cursor-pointer flex-col items-center justify-center gap-5 rounded-3xl border-2 border-dashed p-8 text-center transition-all duration-300 ${
        drag
          ? "border-neon/70 bg-neon/[0.07] scale-[1.01]"
          : "border-white/[0.12] bg-panel/60 hover:border-neon/40 hover:bg-panel"
      } ${disabled ? "pointer-events-none opacity-50" : ""}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*,.mkv,.ts,.m2ts,.mxf"
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
      />
      {file ? (
        <>
          <span className="glass grid h-16 w-16 place-items-center rounded-2xl">
            <FileVideo className="h-8 w-8 text-neon" strokeWidth={1.8} />
          </span>
          <div>
            <div className="max-w-md truncate font-display text-lg font-semibold text-white">
              {file.name}
            </div>
            <div className="mt-1 font-mono text-[11px] tracking-[0.14em] text-zinc-500">
              {fmtBytes(file.size)} — READY TO DUB
            </div>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onFile(null);
            }}
            className="glass flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium text-zinc-300 transition hover:border-red-400/40 hover:text-red-300"
          >
            <X className="h-3.5 w-3.5" /> Remove
          </button>
        </>
      ) : (
        <>
          <span className="glass grid h-20 w-20 place-items-center rounded-3xl transition-transform duration-500 group-hover:scale-110 group-hover:rotate-3">
            <UploadCloud className="h-9 w-9 text-neon" strokeWidth={1.6} />
          </span>
          <div>
            <div className="font-display text-xl font-semibold text-white">
              Drop your video here
            </div>
            <div className="mt-2 text-sm text-zinc-500">
              or <span className="text-gradient font-semibold">browse files</span> —
              MP4, MKV, MOV, WebM… any codec
            </div>
          </div>
          <div className="flex flex-wrap justify-center gap-2 font-mono text-[9px] tracking-[0.18em] text-zinc-600">
            <span className="rounded-full border border-edge px-3 py-1">NO DURATION CAP</span>
            <span className="rounded-full border border-edge px-3 py-1">UP TO 3 GB</span>
            <span className="rounded-full border border-edge px-3 py-1">NO WATERMARK</span>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------- settings ------------------------------ */

export interface DubSettings {
  sourceLang: string;
  targetLang: string;
  voiceId: string;
  rate: number;
  pitch: number;
  reviewMode: boolean;
  mixOriginal: boolean;
  voiceMatch: boolean;
}

function Field({ label, icon: Icon, children }: { label: string; icon: React.ElementType; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 font-mono text-[9px] tracking-[0.25em] text-zinc-500">
        <Icon className="h-3 w-3" /> {label}
      </div>
      {children}
    </div>
  );
}

const selectCls =
  "w-full appearance-none rounded-xl border border-edge bg-ink/80 px-4 py-3 text-sm text-zinc-200 transition";

export function SettingsPanel({
  settings,
  onChange,
  onPreview,
  previewing,
  voiceEngine,
}: {
  settings: DubSettings;
  onChange: (s: DubSettings) => void;
  onPreview: () => void;
  previewing: boolean;
  voiceEngine?: string | null;
}) {
  const voices = voicesForLanguage(settings.targetLang);
  const set = (patch: Partial<DubSettings>) => onChange({ ...settings, ...patch });

  return (
    <div className="glass flex flex-col gap-5 rounded-3xl p-6">
      <div className="flex items-center justify-between">
        <Kicker>[ DUB CONFIGURATION ]</Kicker>
        <SlidersHorizontal className="h-4 w-4 text-zinc-500" />
      </div>

      {voiceEngine && (
        <div
          className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 ${
            voiceEngine === "xtts"
              ? "border-mint/40 bg-mint/[0.07]"
              : "border-edge bg-ink/50"
          }`}
        >
          <Mic className={`h-4 w-4 shrink-0 ${voiceEngine === "xtts" ? "text-mint" : "text-zinc-500"}`} />
          <div className="min-w-0">
            <div className="font-mono text-[9px] tracking-[0.2em] text-zinc-500">VOICE ENGINE</div>
            <div className="truncate text-[12.5px] font-semibold text-white">
              {voiceEngine === "xtts"
                ? "XTTS-v2 clone — speaks as the person in your video"
                : voiceEngine === "kokoro"
                  ? "Kokoro-82M neural voice"
                  : voiceEngine === "piper"
                    ? "Piper neural voice"
                    : voiceEngine === "edge"
                      ? "Edge neural voice"
                      : "Built-in offline voice (robotic — install a neural voice)"}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <Field label="SOURCE" icon={Globe2}>
          <select
            className={selectCls}
            value={settings.sourceLang}
            onChange={(e) => set({ sourceLang: e.target.value })}
          >
            <option value="auto">Auto-detect</option>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="TARGET" icon={Languages}>
          <select
            className={selectCls}
            value={settings.targetLang}
            onChange={(e) => {
              const targetLang = e.target.value;
              const vs = voicesForLanguage(targetLang);
              set({ targetLang, voiceId: vs[0]?.id ?? settings.voiceId });
            }}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name} — {l.native}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label={`NEURAL VOICE · ${voices.length} AVAILABLE`} icon={User}>
        <div className="flex gap-2">
          <select
            className={selectCls}
            value={settings.voiceId}
            onChange={(e) => set({ voiceId: e.target.value })}
          >
            {voices.map((v: DubVoice) => (
              <option key={v.id} value={v.id}>
                {v.label} · {v.gender === "F" ? "Female" : "Male"}
              </option>
            ))}
            {!voices.some((v) => v.id === settings.voiceId) && (
              <option value={settings.voiceId}>{settings.voiceId}</option>
            )}
          </select>
          <button
            onClick={onPreview}
            disabled={previewing}
            title="Preview voice"
            className="btn-primary grid w-12 shrink-0 place-items-center rounded-xl text-white"
          >
            {previewing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Volume2 className="h-4 w-4" />
            )}
          </button>
        </div>
      </Field>

      <Field label={`TEMPO ${settings.rate >= 0 ? "+" : ""}${settings.rate}%`} icon={Gauge}>
        <input
          type="range"
          min={-50}
          max={50}
          value={settings.rate}
          onChange={(e) => set({ rate: Number(e.target.value) })}
          style={{ ["--fill" as string]: `${((settings.rate + 50) / 100) * 100}%` }}
        />
      </Field>

      <Field label={`PITCH ${settings.pitch >= 0 ? "+" : ""}${settings.pitch} Hz`} icon={AudioWaveIcon}>
        <input
          type="range"
          min={-40}
          max={40}
          value={settings.pitch}
          onChange={(e) => set({ pitch: Number(e.target.value) })}
          style={{ ["--fill" as string]: `${((settings.pitch + 40) / 80) * 100}%` }}
        />
      </Field>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <Toggle
          checked={settings.reviewMode}
          onChange={(v) => set({ reviewMode: v })}
          icon={PencilRuler}
          title="Review mode"
          hint="Edit lines before TTS"
        />
        <Toggle
          checked={settings.mixOriginal}
          onChange={(v) => set({ mixOriginal: v })}
          icon={Sparkles}
          title="Ambient mix"
          hint="Keep 10% original audio"
        />
        <Toggle
          checked={settings.voiceMatch}
          onChange={(v) => set({ voiceMatch: v })}
          icon={ScanFace}
          title="Voice match"
          hint="Clone the speaker's pitch + tone"
        />
      </div>
    </div>
  );
}

function AudioWaveIcon(props: { className?: string }) {
  return <Volume2 className={props.className} />;
}

function Toggle({
  checked,
  onChange,
  icon: Icon,
  title,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  icon: React.ElementType;
  title: string;
  hint: string;
}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`flex items-center gap-3 rounded-xl border p-3 text-left transition ${
        checked ? "border-neon/50 bg-neon/[0.08]" : "border-edge bg-ink/50 hover:border-white/20"
      }`}
    >
      <Icon className={`h-4 w-4 shrink-0 ${checked ? "text-neon" : "text-zinc-500"}`} />
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] font-semibold text-white">{title}</span>
        <span className="block truncate text-[10.5px] text-zinc-500">{hint}</span>
      </span>
      <span
        className={`relative ml-auto h-5 w-9 shrink-0 rounded-full transition ${
          checked ? "bg-gradient-to-r from-[#7c6cff] to-[#42b8ff]" : "bg-white/10"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
            checked ? "left-[18px]" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

/* --------------------------- stage tracker -------------------------- */

export function StageTracker({ job }: { job: JobDto }) {
  const stageIdx = (stage: string): number => {
    if (stage === "extract") return 0;
    if (stage === "transcribe") return 1;
    if (stage === "translate") return 2;
    if (stage === "review") return 2.5;
    if (stage === "synthesize") return 3;
    if (stage === "sync") return 4;
    if (stage === "done") return 5;
    return -1; // queued
  };
  const cur = stageIdx(job.stage);

  return (
    <div className="flex flex-col gap-1">
      {STAGE_META.map((s, i) => {
        const done = cur > i;
        const active = !done && Math.floor(cur) === i && (job.status === "running" || job.status === "awaiting_review");
        const pending = !done && !active;
        return (
          <div
            key={s.key}
            className={`flex items-center gap-4 rounded-2xl border px-4 py-3.5 transition-all duration-500 ${
              active
                ? "border-neon/45 bg-neon/[0.07]"
                : done
                  ? "border-mint/20 bg-mint/[0.04]"
                  : "border-edge/60 bg-ink/40 opacity-50"
            }`}
          >
            <span
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl font-mono text-[11px] font-bold ${
                done
                  ? "bg-mint/15 text-mint"
                  : active
                    ? "bg-gradient-to-br from-[#7c6cff] to-[#42b8ff] text-white"
                    : "bg-white/5 text-zinc-500"
              }`}
            >
              {done ? <Check className="h-4 w-4" /> : active ? <Loader2 className="h-4 w-4 animate-spin" /> : `0${i + 1}`}
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block font-display text-[14.5px] font-semibold ${active ? "text-white" : done ? "text-mint/90" : "text-zinc-400"}`}>
                {s.label}
              </span>
              <span className="block truncate font-mono text-[9px] tracking-[0.12em] text-zinc-500">
                {active && job.stageDetail ? job.stageDetail : s.blurb}
              </span>
            </span>
            {pending && <span className="font-mono text-[9px] tracking-[0.2em] text-zinc-600">QUEUED</span>}
            {done && <span className="font-mono text-[9px] tracking-[0.2em] text-mint/70">DONE</span>}
            {active && <span className="animate-pulse-soft font-mono text-[9px] tracking-[0.2em] text-neon">LIVE</span>}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------ log panel --------------------------- */

export function LogPanel({ logs }: { logs: { t: number; msg: string }[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  return (
    <div className="glass flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl">
      <div className="flex items-center justify-between border-b border-edge/60 px-5 py-3">
        <Kicker>[ ENGINE CONSOLE ]</Kicker>
        <span className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-400/50" />
          <span className="h-2.5 w-2.5 rounded-full bg-yellow-400/50" />
          <span className="h-2.5 w-2.5 rounded-full bg-mint/50" />
        </span>
      </div>
      <div ref={boxRef} className="max-h-72 min-h-44 flex-1 overflow-y-auto px-5 py-4 font-mono text-[11px] leading-[1.9] text-zinc-400">
        {logs.length === 0 && <div className="text-zinc-600">// waiting for engine output…</div>}
        {logs.map((l, i) => (
          <div key={i} className="flex gap-3">
            <span className="shrink-0 text-zinc-600">{new Date(l.t).toLocaleTimeString([], { hour12: false })}</span>
            <span className={/ERROR/i.test(l.msg) ? "text-red-300" : /complete|ready|done/i.test(l.msg) ? "text-mint" : ""}>
              {l.msg}
            </span>
          </div>
        ))}
        <span className="animate-blink text-neon">▍</span>
      </div>
    </div>
  );
}

/* ---------------------------- review editor ------------------------- */

export function ReviewEditor({
  segments,
  dirty,
  onEdit,
  onSeek,
}: {
  segments: SegmentDto[];
  dirty: Map<string, string>;
  onEdit: (id: string, text: string) => void;
  onSeek: (ms: number) => void;
}) {
  return (
    <div className="glass overflow-hidden rounded-3xl">
      <div className="flex items-center justify-between border-b border-edge/60 px-5 py-3.5">
        <Kicker>[ TRANSCRIPT REVIEW — {segments.length} LINES ]</Kicker>
        {dirty.size > 0 && (
          <span className="rounded-full bg-neon/15 px-3 py-1 font-mono text-[9px] tracking-[0.18em] text-neon">
            {dirty.size} EDITED
          </span>
        )}
      </div>
      <div className="max-h-[26rem] overflow-y-auto">
        {segments.map((s) => (
          <div
            key={s.id}
            className={`grid gap-3 border-b border-white/[0.04] px-5 py-4 transition sm:grid-cols-[7.5rem_1fr_1fr] ${
              dirty.has(s.id) ? "bg-neon/[0.05]" : "hover:bg-white/[0.02]"
            }`}
          >
            <button
              onClick={() => onSeek(s.startMs)}
              className="flex h-fit items-center gap-1.5 font-mono text-[10px] text-zinc-500 transition hover:text-neon"
            >
              <Play className="h-3 w-3" />
              {fmtTC(s.startMs)} → {fmtTC(s.endMs)}
            </button>
            <p className="text-[13px] leading-relaxed text-zinc-400">{s.sourceText}</p>
            <textarea
              rows={2}
              value={dirty.get(s.id) ?? s.translatedText ?? ""}
              onChange={(e) => onEdit(s.id, e.target.value)}
              className="w-full resize-y rounded-xl border border-edge bg-ink/70 px-3 py-2 text-[13px] leading-relaxed text-zinc-100 transition"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------- transcript ---------------------------- */

export function TranscriptPreview({ segments, langLabel }: { segments: SegmentDto[]; langLabel: string }) {
  const done = segments.filter((s) => s.status === "synthesized").length;
  return (
    <div className="glass overflow-hidden rounded-3xl">
      <div className="flex items-center justify-between border-b border-edge/60 px-5 py-3.5">
        <Kicker>[ TIMELINE — {langLabel} ]</Kicker>
        <span className="font-mono text-[9px] tracking-[0.18em] text-zinc-500">
          {done}/{segments.length} VOICED
        </span>
      </div>
      <div className="max-h-72 space-y-1 overflow-y-auto p-3">
        {segments.map((s) => (
          <div key={s.id} className="flex items-start gap-3 rounded-xl px-3 py-2 transition hover:bg-white/[0.03]">
            <span className="mt-0.5 shrink-0 font-mono text-[9.5px] text-zinc-600">{fmtTC(s.startMs)}</span>
            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${s.status === "synthesized" ? "bg-mint" : s.status === "failed" ? "bg-red-400" : "bg-white/20"}`} />
            <div className="min-w-0">
              <p className="truncate text-[12.5px] text-zinc-400">{s.sourceText}</p>
              {s.translatedText && (
                <p className="truncate text-[12.5px] font-medium text-white/85">{s.translatedText}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* Model setup — the browser installs the neural models               */
/* ------------------------------------------------------------------ */

export function ModelSetup({
  presets,
  installedAsr,
  installing,
  progressLabel,
  onInstall,
  onContinue,
  busy,
  error,
  activeEngine,
  onTest,
  testing,
  testResult,
  testAudioUrl,
}: {
  presets: ModelPresetInfo[];
  installedAsr: string | null;
  installing: string | null;
  progressLabel: string | null;
  onInstall: (preset: ModelPresetInfo) => void;
  onContinue: () => void;
  busy: boolean;
  error: string | null;
  activeEngine: string | null;
  onTest: (kind: "tts" | "asr") => void;
  testing: "tts" | "asr" | null;
  testResult: string | null;
  testAudioUrl: string | null;
}) {
  const asr = presets.filter((p) => p.kind === "asr");
  const tts = presets.filter((p) => p.kind === "tts");
  const row = (p: ModelPresetInfo) => (
    <div
      key={p.id}
      className={`flex flex-wrap items-center gap-3 rounded-2xl border p-4 transition ${
        p.installed ? "border-mint/40 bg-mint/[0.06]" : "border-edge bg-ink/50"
      }`}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/5">
        {p.kind === "asr" ? <Mic className="h-4 w-4 text-neon" /> : <Volume2 className="h-4 w-4 text-warm" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-display text-[13.5px] font-semibold text-white">{p.label}</div>
        <div className="mt-0.5 text-[11.5px] leading-snug text-zinc-500">{p.note}</div>
        {installing === p.id && progressLabel && (
          <div className="mt-2 font-mono text-[10px] tracking-[0.14em] text-neon">{progressLabel}</div>
        )}
      </div>
      {p.installed ? (
        <span className="flex items-center gap-1.5 rounded-full border border-mint/40 bg-mint/10 px-3 py-1 font-mono text-[9px] tracking-[0.18em] text-mint">
          <Check className="h-3 w-3" /> INSTALLED
        </span>
      ) : (
        <button
          onClick={() => onInstall(p)}
          disabled={busy}
          className="flex items-center gap-2 rounded-xl border border-neon/40 bg-neon/[0.08] px-4 py-2 text-[12.5px] font-semibold text-neon transition hover:bg-neon/[0.16] disabled:opacity-40"
        >
          {installing === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Install via browser
        </button>
      )}
    </div>
  );

  return (
    <div className="glass flex flex-col gap-5 rounded-3xl p-6">
      <div className="flex items-center justify-between">
        <Kicker>[ ENGINE SETUP ]</Kicker>
        <Cpu className="h-4 w-4 text-zinc-500" />
      </div>
      <p className="text-[13px] leading-relaxed text-zinc-400">
        This machine can only reach the npm and PyPI registries, so it cannot download speech
        models itself. <span className="text-zinc-200">Your browser can</span> — it fetches the
        files below straight from Hugging Face and streams them into the studio, after which
        everything runs locally, offline and watermark-free.
      </p>
      <div className="flex flex-col gap-2.5">
        <div className="font-mono text-[9px] tracking-[0.25em] text-zinc-500">SPEECH RECOGNITION</div>
        {asr.map(row)}
      </div>
      <div className="flex flex-col gap-2.5">
        <div className="font-mono text-[9px] tracking-[0.25em] text-zinc-500">
          NEURAL VOICE — QUALITY LADDER (KOKORO &gt; PIPER &gt; BUILT-IN)
        </div>
        {tts.map(row)}
      </div>

      <div className="rounded-2xl border border-edge bg-ink/40 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[9px] tracking-[0.22em] text-zinc-500">ACTIVE ENGINE</div>
            <div className="mt-1 font-display text-[13.5px] font-semibold text-white">
              {activeEngine ? activeEngine.toUpperCase() : "DETECTING…"}
            </div>
          </div>
          <button
            onClick={() => onTest("tts")}
            disabled={testing !== null}
            className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.06] px-3.5 py-2 text-[12px] font-semibold text-zinc-200 transition hover:bg-white/[0.12] disabled:opacity-40"
          >
            {testing === "tts" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            Test voice
          </button>
          <button
            onClick={() => onTest("asr")}
            disabled={testing !== null || !installedAsr}
            className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.06] px-3.5 py-2 text-[12px] font-semibold text-zinc-200 transition hover:bg-white/[0.12] disabled:opacity-40"
          >
            {testing === "asr" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mic className="h-3.5 w-3.5" />}
            Test transcription
          </button>
        </div>
        {testResult && (
          <div className="mt-3 text-[11.5px] leading-relaxed text-zinc-400">{testResult}</div>
        )}
        {testAudioUrl && (
          <audio className="mt-3 w-full" controls src={testAudioUrl} />
        )}
      </div>
      {error && (
        <div className="flex items-start gap-3 rounded-2xl border border-red-400/30 bg-red-400/[0.07] px-4 py-3 text-[12.5px] text-red-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}
      <button
        onClick={onContinue}
        disabled={!installedAsr || busy}
        className="btn-primary glow-conic flex items-center justify-center gap-2.5 rounded-2xl px-6 py-3.5 font-display text-[15px] font-semibold text-white disabled:opacity-40"
      >
        {busy ? <Loader2 className="h-4.5 w-4.5 animate-spin" /> : <Wand2 className="h-4.5 w-4.5" />}
        Transcribe &amp; continue
      </button>
      <p className="text-center font-mono text-[9px] tracking-[0.16em] text-zinc-600">
        DOWNLOAD HAPPENS IN YOUR BROWSER · NOTHING LEAVES THIS MACHINE AFTERWARDS
      </p>
    </div>
  );
}
