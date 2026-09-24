"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Wand2,
  ArrowRight,
  AudioWaveform,
  CheckCircle2,
  Clock3,
  Download,
  Film,
  Languages,
  Layers,
  Loader2,
  RefreshCcw,
  Rocket,
  Trash2,
} from "lucide-react";
import type { JobDto, JobStatus, SegmentDto } from "@/lib/types";
import { langName } from "@/lib/voices";
import {
  Dropzone,
  fmtBytes,
  fmtTC,
  Kicker,
  LogPanel,
  ReviewEditor,
  ModelSetup,
  SettingsPanel,
  StageTracker,
  TranscriptPreview,
  type DubSettings,
} from "./panels";
import {
  installPreset,
  presetRemainingBytes,
  PROVIDERS,
  translateSegmentsInBrowser,
  translateWithAi,
  type ModelPresetInfo,
  type PresetProgress,
  type Provider,
} from "@/lib/browserAssist";

/* ------------------------------------------------------------------ */

type Phase = "idle" | "ready" | "uploading" | "processing" | "setup" | "review" | "done" | "error";

function phaseOf(job: JobDto | null, file: File | null, uploading: boolean): Phase {
  if (uploading) return "uploading";
  if (!job) return file ? "ready" : "idle";
  if (job.status === "done") return "done";
  if (job.status === "error") return "error";
  if (job.status === "awaiting_transcript") return "setup";
  if (job.status === "awaiting_review") return "review";
  return "processing";
}

function StatusChip({ status }: { status: JobStatus }) {
  const map: Record<JobStatus, { cls: string; label: string }> = {
    queued: { cls: "border-white/15 text-zinc-300 bg-white/5", label: "QUEUED" },
    running: { cls: "border-neon/40 text-neon bg-neon/10", label: "RUNNING" },
    awaiting_transcript: { cls: "border-warm/40 text-warm bg-warm/10", label: "NEEDS MODEL" },
    awaiting_review: { cls: "border-warm/40 text-warm bg-warm/10", label: "REVIEW" },
    done: { cls: "border-mint/40 text-mint bg-mint/10", label: "COMPLETE" },
    error: { cls: "border-red-400/40 text-red-300 bg-red-400/10", label: "FAILED" },
  };
  const m = map[status];
  return (
    <span className={`rounded-full border px-3 py-1 font-mono text-[9px] tracking-[0.22em] ${m.cls}`}>
      {m.label}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass flex-1 rounded-2xl px-4 py-3">
      <div className="font-display text-base font-bold text-white">{value}</div>
      <div className="mt-0.5 font-mono text-[8.5px] tracking-[0.2em] text-zinc-500">{label}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function Studio() {
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [fileDur, setFileDur] = useState<number | null>(null);
  const [settings, setSettings] = useState<DubSettings>({
    sourceLang: "auto",
    targetLang: "hi",
    voiceId: "hi-IN-SwaraNeural",
    rate: 0,
    pitch: 0,
    reviewMode: false,
    mixOriginal: false,
    voiceMatch: true,
  });
  const [job, setJob] = useState<JobDto | null>(null);
  const [segments, setSegments] = useState<SegmentDto[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uiError, setUiError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [recents, setRecents] = useState<JobDto[]>([]);
  const [dirty, setDirty] = useState<Map<string, string>>(new Map());
  const [continuing, setContinuing] = useState(false);
  const [presets, setPresets] = useState<ModelPresetInfo[]>([]);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installLabel, setInstallLabel] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [activeEngine, setActiveEngine] = useState<string | null>(null);
  const [testing, setTesting] = useState<"tts" | "asr" | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testAudioUrl, setTestAudioUrl] = useState<string | null>(null);
  const [aiProvider, setAiProvider] = useState<Provider>("groq");
  const [aiKey, setAiKey] = useState("");
  /** "You install it for me": models download themselves, jobs resume themselves. */
  const [autoPilot, setAutoPilot] = useState(true);
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const installingRef = useRef<string | null>(null);
  const autoTranslatedRef = useRef<Set<string>>(new Set());
  const declinedRef = useRef<Set<string>>(new Set());
  const reDubRef = useRef<Set<string>>(new Set());
  const [askingTranscribe, setAskingTranscribe] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [transLabel, setTransLabel] = useState<string | null>(null);
  const reviewVideoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const phase = phaseOf(job, file, uploading);

  /* recent jobs */
  const loadRecents = useCallback(async () => {
    try {
      const r = await fetch("/api/jobs");
      const d = await r.json();
      setRecents(d.jobs ?? []);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    if (!job) void loadRecents();
  }, [job, loadRecents]);

  /* file preview url */
  useEffect(() => {
    if (!file) {
      setFileUrl(null);
      setFileDur(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.src = url;
    v.onloadedmetadata = () => setFileDur(v.duration || null);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  /* polling */
  const fetchJob = useCallback(async (id: string) => {
    const r = await fetch(`/api/jobs/${id}`);
    if (!r.ok) return;
    const d = await r.json();
    setJob(d.job);
    setSegments(d.segments ?? []);
  }, []);

  useEffect(() => {
    if (!job) return;
    if (job.status === "done" || job.status === "error") return;
    const t = setInterval(() => void fetchJob(job.id), 1200);
    return () => clearInterval(t);
  }, [job, fetchJob]);

  /* ---------------- browser-assisted setup & translation ---------------- */

  const loadModels = useCallback(async () => {
    try {
      const r = await fetch("/api/models");
      const d = await r.json();
      setPresets(d.presets ?? []);
      setActiveEngine(d.active?.engine ?? null);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (job?.status === "awaiting_transcript" || !job) void loadModels();
  }, [job?.status, job, loadModels]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("dubforge.aiKey");
      if (saved) setAiKey(saved);
    } catch {
      /* ignore */
    }
  }, []);

  async function installModel(preset: ModelPresetInfo, silent = false) {
    if (installingRef.current === preset.id) return;
    installingRef.current = preset.id;
    setInstallingId(preset.id);
    setModelsError(null);
    try {
      await installPreset(preset, (p: PresetProgress) => {
        const mb = (n: number) => (n / 1048576).toFixed(1);
        const pct = p.total > 0 ? Math.round((p.received / p.total) * 100) : 0;
        setInstallLabel(`${p.fileLabel} — ${mb(p.received)} / ${mb(p.total)} MB (${pct}%)`);
      });
      await loadModels();
    } catch (e) {
      // An interrupted download is fine — the next tick resumes it where it stopped.
      const msg = e instanceof Error ? e.message : String(e);
      if (!silent || !/abort|network|Failed to fetch/i.test(msg)) setModelsError(msg);
    } finally {
      installingRef.current = null;
      setInstallingId(null);
      setInstallLabel(null);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Auto-pilot: fetch the models itself, then let the job run to the end */
  /* ------------------------------------------------------------------ */

  const AUTO_ORDER = ["whisper-base", "xtts-v2", "whisper-small", "kokoro-hi", "piper-hi-male"];

  useEffect(() => {
    if (!autoPilot || installingId || presets.length === 0) return;
    const missing = presets
      .filter((p) => !p.installed && AUTO_ORDER.includes(p.id) && !declinedRef.current.has(p.id))
      .sort((a, b) => AUTO_ORDER.indexOf(a.id) - AUTO_ORDER.indexOf(b.id));
    const next = missing[0];
    if (!next) return;
    // A 1.9 GB pull behind someone's back would be rude on a metered link.
    const gb = presetRemainingBytes(next) / 1024 ** 3;
    if (gb > 0.5) {
      const ok =
        typeof window !== "undefined" &&
        window.confirm(
          `${next.label}\n\nOne-time download of about ${gb.toFixed(1)} GB, fetched by your browser ` +
            `into this machine. After that every dub runs offline. Continue?`,
        );
      if (!ok) {
        declinedRef.current.add(next.id);
        setAutoNote(`${next.label} skipped — install it from the engine screen if you want it.`);
        return;
      }
    }
    void installModel(next, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPilot, presets, installingId]);

  // The moment a transcript model exists, unpark the job that is waiting for it.
  useEffect(() => {
    if (!autoPilot || installingId || !job || askingTranscribe) return;
    if (job.status !== "awaiting_transcript") return;
    if (!presets.some((p) => p.kind === "asr" && p.installed)) return;
    void resumeTranscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPilot, presets, job?.status, installingId]);

  // Translate as soon as the job reaches the review gate.
  useEffect(() => {
    if (!autoPilot || !job || translating) return;
    if (job.status !== "awaiting_review") return;
    if (autoTranslatedRef.current.has(job.id)) return;
    const untranslated = segments.filter(
      (s) => !s.translatedText || s.translatedText.trim() === s.sourceText.trim(),
    );
    if (untranslated.length === 0) return;
    autoTranslatedRef.current.add(job.id);
    setAutoNote(
      aiKey.trim()
        ? "Translating every line with your AI key…"
        : "Translating every line (free MyMemory)…",
    );
    void (async () => {
      try {
        if (aiKey.trim()) await translateWithKey();
        else await translateInBrowser();
        setAutoNote("Translation done — starting the voice work automatically.");
      } catch (e) {
        setAutoNote(
          `Auto-translate hit a problem (${e instanceof Error ? e.message : String(e)}). ` +
            "Press Translate in the review panel — nothing is lost.",
        );
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPilot, job?.status, segments.length, translating]);

  // Then approve, so synthesis starts without anyone pressing a button.
  useEffect(() => {
    if (!autoPilot || !job || continuing || translating) return;
    if (job.status !== "awaiting_review" || job.reviewMode) return;
    if (!autoTranslatedRef.current.has(job.id) || segments.length === 0) return;
    const stillUntranslated = segments.some(
      (s) => !s.translatedText || s.translatedText.trim() === s.sourceText.trim(),
    );
    if (stillUntranslated) return;
    void saveAndContinue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPilot, job?.status, segments, translating, continuing]);

  // If the dub finished before the 1.9 GB clone arrived, re-render it with the clone.
  useEffect(() => {
    if (!autoPilot || !job) return;
    if (job.status !== "done") return;
    if (installingId) return;
    if (!presets.some((p) => p.id === "xtts-v2" && p.installed)) return;
    if (reDubRef.current.has(job.id)) return;
    const usedClone = job.log.some((l) => /TTS engine — XTTS/i.test(l.msg));
    const past = reDubRef.current.has(`checked:${job.id}`);
    if (usedClone) {
      reDubRef.current.add(`checked:${job.id}`);
      return;
    }
    if (past) return;
    reDubRef.current.add(`checked:${job.id}`);
    reDubRef.current.add(job.id);
    setAutoNote("Clone voice is ready — re-rendering this dub with your cloned voice…");
    void redubWithClone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPilot, job?.status, job?.log.length, presets, installingId]);

  async function runSelfTest(kind: "tts" | "asr") {
    setTesting(kind);
    setTestResult(null);
    setTestAudioUrl(null);
    try {
      const r = await fetch("/api/models/selftest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          lang: job?.targetLang ?? "hi",
          gender: (job?.voiceId ?? "").includes("Swara") || /Neural$/.test(job?.voiceId ?? "") ? "F" : "M",
        }),
      });
      if (kind === "tts") {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Voice test failed");
        const engine = r.headers.get("x-engine") ?? "engine";
        const blob = await r.blob();
        setTestAudioUrl(URL.createObjectURL(blob));
        setTestResult(`Voice test passed — rendered by ${engine}. Listen above; if it sounds right, your dub will too.`);
      } else {
        const d = await r.json();
        if (!d.ok) throw new Error(d.error ?? "Transcription test failed");
        setTestResult(`Transcription test passed with ${d.model} (${d.language ?? "?"}). Whisper heard: “${d.text}”`);
      }
    } catch (e) {
      setTestResult(`Test failed — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(null);
    }
  }

  async function resumeTranscribe() {
    if (!job) return;
    setAskingTranscribe(true);
    setModelsError(null);
    try {
      const r = await fetch(`/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "transcribe" }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "Could not start transcription");
      await fetchJob(job.id);
    } catch (e) {
      setModelsError(e instanceof Error ? e.message : String(e));
    } finally {
      setAskingTranscribe(false);
    }
  }

  const needsTranslation =
    segments.length > 0 &&
    (job?.sourceLang ?? "auto") !== job?.targetLang &&
    segments.some((s) => !s.translatedText || s.translatedText.trim() === s.sourceText.trim());

  async function translateWithKey() {
    if (!job) return;
    const provider = PROVIDERS.find((p) => p.id === aiProvider);
    if (!provider) return;
    if (!aiKey.trim()) {
      setUiError("Paste an API key first — it stays in your browser and is sent only to the provider.");
      return;
    }
    setTranslating(true);
    setUiError(null);
    try {
      window.localStorage.setItem("dubforge.aiKey", aiKey.trim());
      const src = (job.detectedLang || job.sourceLang || "en").slice(0, 2);
      setTransLabel("TRANSLATING WITH AI…");
      const map = await translateWithAi(
        segments.map((s) => ({ id: s.id, sourceText: s.sourceText, slotMs: Math.max(0, s.endMs - s.startMs) })),
        src,
        job.targetLang,
        provider,
        aiKey.trim(),
      );
      if (map.size > 0) {
        await fetch(`/api/jobs/${job.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            segments: [...map].map(([id, translatedText]) => ({ id, translatedText })),
          }),
        });
        setTransLabel(`TRANSLATED ${map.size}/${segments.length}`);
      } else {
        setUiError("The AI provider returned no usable lines.");
      }
      await fetchJob(job.id);
    } catch (e) {
      setUiError(e instanceof Error ? e.message : String(e));
    } finally {
      setTranslating(false);
      setTimeout(() => setTransLabel(null), 2500);
    }
  }

  async function translateInBrowser() {
    if (!job) return;
    setTranslating(true);
    setUiError(null);
    try {
      const src = (job.detectedLang || job.sourceLang || "en").slice(0, 2);
      const map = await translateSegmentsInBrowser(
        segments.map((s) => ({ id: s.id, sourceText: s.sourceText })),
        src,
        job.targetLang,
        (done, total) => setTransLabel(`TRANSLATING ${done}/${total}`),
      );
      if (map.size > 0) {
        await fetch(`/api/jobs/${job.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            segments: [...map].map(([id, translatedText]) => ({ id, translatedText })),
          }),
        });
      } else {
        setUiError("The translation service could not be reached from your browser either.");
      }
      await fetchJob(job.id);
    } catch (e) {
      setUiError(e instanceof Error ? e.message : String(e));
    } finally {
      setTranslating(false);
      setTransLabel(null);
    }
  }

  /* actions */
  async function startDub() {
    if (!file) return;
    setUiError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("targetLang", settings.targetLang);
      fd.append("sourceLang", settings.sourceLang);
      fd.append("voiceId", settings.voiceId);
      fd.append("ratePct", String(settings.rate));
      fd.append("pitchHz", String(settings.pitch));
      fd.append("reviewMode", settings.reviewMode ? "1" : "0");
      fd.append("mixOriginal", settings.mixOriginal ? "1" : "0");
      fd.append("voiceMatch", settings.voiceMatch ? "1" : "0");
      fd.append("file", file, file.name); // file last for busboy ordering

      const r = await fetch("/api/jobs", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Upload failed");
      setJob(d.job);
      setDirty(new Map());
      await fetchJob(d.job.id);
    } catch (e) {
      setUiError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  async function previewVoice() {
    setPreviewing(true);
    try {
      audioRef.current?.pause();
      const r = await fetch("/api/tts-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice: settings.voiceId, rate: settings.rate, pitch: settings.pitch }),
      });
      if (!r.ok) throw new Error("preview failed");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      audioRef.current = a;
      await a.play();
    } catch {
      /* ignore */
    } finally {
      setPreviewing(false);
    }
  }

  async function saveAndContinue() {
    if (!job) return;
    setContinuing(true);
    try {
      if (dirty.size > 0) {
        await fetch(`/api/jobs/${job.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            segments: [...dirty.entries()].map(([id, translatedText]) => ({ id, translatedText })),
          }),
        });
      }
      await fetch(`/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "continue" }),
      });
      setDirty(new Map());
      await fetchJob(job.id);
    } finally {
      setContinuing(false);
    }
  }

  /** Re-run synthesis on a finished dub — used when the voice clone lands late. */
  async function redubWithClone() {
    if (!job) return;
    await fetch(`/api/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "redub" }),
    });
    await fetchJob(job.id);
  }

  async function retryJob() {
    if (!job) return;
    await fetch(`/api/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry" }),
    });
    await fetchJob(job.id);
  }

  async function deleteJob(id: string) {
    await fetch(`/api/jobs/${id}`, { method: "DELETE" });
    void loadRecents();
  }

  function resetAll() {
    setAutoNote(null);
    setJob(null);
    setSegments([]);
    setFile(null);
    setDirty(new Map());
    setUiError(null);
  }

  function onEditSegment(id: string, text: string) {
    const orig = segments.find((s) => s.id === id);
    setDirty((prev) => {
      const next = new Map(prev);
      if ((orig?.translatedText ?? "") === text) next.delete(id);
      else next.set(id, text);
      return next;
    });
  }

  const avgTempo =
    segments.length > 0
      ? (
          segments.filter((s) => s.tempo).reduce((a, s) => a + (s.tempo ?? 1), 0) /
          Math.max(1, segments.filter((s) => s.tempo).length)
        ).toFixed(2)
      : "—";

  /* ------------------------------------------------------------------ */

  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="grid-bg pointer-events-none fixed inset-0" />

      {/* header */}
      <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-void/75 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="grid h-9 w-9 place-items-center rounded-xl border border-edge text-zinc-400 transition hover:border-neon/40 hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex items-center gap-2.5">
              <AudioWaveform className="h-4.5 w-4.5 text-neon" />
              <span className="font-display text-sm font-bold tracking-[0.14em]">
                DUB<span className="text-gradient">FORGE</span> STUDIO
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setAutoPilot((v) => !v)}
              title="Download the speech models automatically and let the dub continue on its own"
              className={`flex items-center gap-2 rounded-full border px-3.5 py-1.5 font-mono text-[9px] tracking-[0.18em] transition ${
                autoPilot
                  ? "border-mint/40 bg-mint/10 text-mint"
                  : "border-white/15 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Wand2 className="h-3 w-3" />
              AUTO-PILOT {autoPilot ? "ON" : "OFF"}
            </button>
            {job && <StatusChip status={job.status} />}
            {(phase === "done" || phase === "error") && (
              <button
                onClick={resetAll}
                className="btn-primary flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold text-white"
              >
                <RefreshCcw className="h-3.5 w-3.5" /> New dub
              </button>
            )}
          </div>
        </div>
      </header>

      {(installingId || autoNote) && (
        <div className="relative z-10 border-b border-white/[0.06] bg-neon/[0.05]">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-5 py-2.5 sm:px-8">
            {installingId ? (
              <>
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-neon" />
                <span className="font-mono text-[10px] tracking-[0.16em] text-neon">
                  AUTO-INSTALLING {(presets.find((p) => p.id === installingId)?.label ?? "").toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-400">
                  {installLabel ?? "starting…"}
                </span>
                <span className="hidden font-mono text-[9px] tracking-[0.14em] text-zinc-500 sm:inline">
                  FETCHED BY YOUR BROWSER · KEEP THIS TAB OPEN
                </span>
              </>
            ) : (
              <span className="font-mono text-[10px] tracking-[0.14em] text-warm">{autoNote}</span>
            )}
          </div>
        </div>
      )}

      <main className="relative z-10 mx-auto w-full max-w-7xl flex-1 px-5 py-10 sm:px-8">
        {/* ------------------------- IDLE / READY ------------------------- */}
        {(phase === "idle" || phase === "ready" || phase === "uploading") && (
          <div className="grid gap-6 lg:grid-cols-[1fr_23rem]">
            <div className="flex flex-col gap-6">
              <div>
                <Kicker>[ NEW DUB JOB ]</Kicker>
                <h1 className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl">
                  Forge a <span className="text-gradient">dub</span>.
                </h1>
              </div>

              <Dropzone file={file} onFile={setFile} disabled={uploading} />

              {file && fileUrl && (
                <div className="glass overflow-hidden rounded-3xl">
                  <video src={fileUrl} controls className="max-h-72 w-full bg-black object-contain" />
                  <div className="flex items-center justify-between px-5 py-3 font-mono text-[10px] tracking-[0.16em] text-zinc-500">
                    <span className="flex items-center gap-2">
                      <Film className="h-3.5 w-3.5" /> SOURCE PREVIEW
                    </span>
                    <span>
                      {fileDur ? fmtTC(fileDur * 1000) : "—"} · {fmtBytes(file.size)}
                    </span>
                  </div>
                </div>
              )}

              {uiError && (
                <div className="flex items-start gap-3 rounded-2xl border border-red-400/30 bg-red-400/[0.07] px-5 py-4 text-sm text-red-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  {uiError}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-5">
              <SettingsPanel
                settings={settings}
                onChange={setSettings}
                onPreview={previewVoice}
                previewing={previewing}
                voiceEngine={activeEngine}
              />
              <button
                onClick={startDub}
                disabled={!file || uploading}
                className="btn-primary glow-conic flex items-center justify-center gap-2.5 rounded-2xl px-6 py-4 font-display text-base font-semibold text-white"
              >
                {uploading ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" /> Uploading video…
                  </>
                ) : (
                  <>
                    <Rocket className="h-5 w-5" /> Start dubbing to {langName(settings.targetLang)}
                  </>
                )}
              </button>
              <p className="text-center font-mono text-[9px] tracking-[0.18em] text-zinc-600">
                NO LENGTH LIMIT · NO WATERMARK · VIDEO STREAM NEVER RE-ENCODED
              </p>
            </div>
          </div>
        )}

        {/* ------------------------- RECENTS ------------------------- */}
        {phase === "idle" && recents.length > 0 && (
          <div className="mt-12">
            <Kicker>[ RECENT DUBS ]</Kicker>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {recents.map((r) => (
                <div
                  key={r.id}
                  className="glass card-hover group flex cursor-pointer items-center gap-4 rounded-2xl p-4"
                  onClick={() => setJob(r)}
                >
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/5">
                    <Layers className="h-5 w-5 text-neon" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-display text-sm font-semibold text-white">
                      {r.originalName}
                    </div>
                    <div className="mt-1 flex items-center gap-2 font-mono text-[9px] tracking-[0.14em] text-zinc-500">
                      <span>{r.durationSec ? fmtTC(r.durationSec * 1000) : "…"}</span>
                      <span>→ {langName(r.targetLang).toUpperCase()}</span>
                      <StatusChip status={r.status} />
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteJob(r.id);
                    }}
                    className="rounded-lg p-2 text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:bg-red-400/10 hover:text-red-300"
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ------------------------- ENGINE SETUP ------------------------- */}
        {phase === "setup" && job && (
          <div>
            <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
              <div>
                <Kicker>[ ENGINE SETUP — {job.originalName.toUpperCase()} ]</Kicker>
                <h1 className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl">
                  One model, then it <span className="text-gradient">dubs</span>.
                </h1>
                <p className="mt-4 max-w-2xl text-[13.5px] leading-relaxed text-zinc-400">
                  The audio is extracted and the voice profile is ready. Speech recognition needs a
                  Whisper model, and this machine cannot download it — your browser can. Pick a size,
                  install it once, and every future dub runs fully offline.
                </p>
              </div>
              <div className="flex items-center gap-3 font-mono text-[10px] tracking-[0.18em] text-zinc-500">
                <Clock3 className="h-3.5 w-3.5" />
                {job.durationSec ? fmtTC(job.durationSec * 1000) : "PROBING…"} ·{" "}
                {langName(job.targetLang).toUpperCase()}
              </div>
            </div>

            <div className="grid items-start gap-6 lg:grid-cols-[1fr_22rem]">
              <ModelSetup
                presets={presets}
                installedAsr={presets.find((p) => p.kind === "asr" && p.installed)?.id ?? null}
                installing={installingId}
                progressLabel={installLabel}
                onInstall={(p) => void installModel(p)}
                onContinue={() => void resumeTranscribe()}
                busy={askingTranscribe || installingId !== null}
                error={modelsError}
                activeEngine={activeEngine}
                onTest={(k) => void runSelfTest(k)}
                testing={testing}
                testResult={testResult}
                testAudioUrl={testAudioUrl}
              />
              <div className="flex flex-col gap-5">
                <StageTracker job={job} />
                <LogPanel logs={job.log} />
              </div>
            </div>
          </div>
        )}

        {/* ------------------------- PROCESSING ------------------------- */}
        {phase === "processing" && job && (
          <div>
            <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
              <div>
                <Kicker>[ FORGING DUB — {job.originalName.toUpperCase()} ]</Kicker>
                <h1 className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl">
                  {job.status === "queued" ? "In the queue…" : (
                    <span className="text-gradient">{job.progress}%</span>
                  )}
                </h1>
              </div>
              <div className="flex items-center gap-3 font-mono text-[10px] tracking-[0.18em] text-zinc-500">
                <Clock3 className="h-3.5 w-3.5" />
                {job.durationSec ? fmtTC(job.durationSec * 1000) : "PROBING…"} ·{" "}
                {langName(job.targetLang).toUpperCase()}
              </div>
            </div>

            <div className="mb-6 h-2.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="progress-shimmer h-full rounded-full bg-gradient-to-r from-[#7c6cff] via-[#42b8ff] to-[#42e8ff] transition-all duration-700"
                style={{ width: `${Math.max(2, job.progress)}%` }}
              />
            </div>

            <div className="grid gap-6 lg:grid-cols-[23rem_1fr]">
              <div className="flex flex-col gap-5">
                <StageTracker job={job} />
                <div className="flex gap-3">
                  <Stat label="UTTERANCES" value={String(job.segmentCount || "—")} />
                  <Stat label="DETECTED" value={job.detectedLang ? langName(job.detectedLang).slice(0, 3).toUpperCase() : "…"} />
                  <Stat label="TARGET" value={langName(job.targetLang).slice(0, 3).toUpperCase()} />
                </div>
              </div>
              <div className="flex min-w-0 flex-col gap-5">
                <LogPanel logs={job.log} />
                {segments.length > 0 && (
                  <TranscriptPreview segments={segments} langLabel={langName(job.targetLang).toUpperCase()} />
                )}
              </div>
            </div>
          </div>
        )}

        {/* ------------------------- REVIEW ------------------------- */}
        {phase === "review" && job && (
          <div>
            <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
              <div>
                <Kicker>[ HUMAN REVIEW GATE ]</Kicker>
                <h1 className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl">
                  Polish every <span className="text-gradient">line</span>.
                </h1>
              </div>
              <button
                onClick={saveAndContinue}
                disabled={continuing}
                className="btn-primary glow-conic flex items-center gap-2.5 rounded-2xl px-7 py-3.5 font-display text-[15px] font-semibold text-white"
              >
                {continuing ? (
                  <Loader2 className="h-4.5 w-4.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4.5 w-4.5" />
                )}
                Approve & synthesize
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>

            {needsTranslation && (
              <div className="mb-6 flex flex-col gap-4 rounded-2xl border border-warm/30 bg-warm/[0.06] px-5 py-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Languages className="h-5 w-5 shrink-0 text-warm" />
                  <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-zinc-300">
                    These lines are still in the source language. For a broadcast-quality dub, use an
                    AI translator — it keeps context across lines and keeps every line short enough to
                    fit its time slot.
                  </div>
                  <button
                    onClick={() => void translateInBrowser()}
                    disabled={translating}
                    className="flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.06] px-4 py-2 text-[12.5px] font-semibold text-zinc-200 transition hover:bg-white/[0.12] disabled:opacity-40"
                  >
                    Free (machine)
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-3 border-t border-white/[0.07] pt-4">
                  <select
                    value={aiProvider}
                    onChange={(e) => setAiProvider(e.target.value as Provider)}
                    className="rounded-xl border border-edge bg-ink/80 px-3 py-2 text-[12.5px] text-zinc-200"
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                  <input
                    type="password"
                    value={aiKey}
                    onChange={(e) => setAiKey(e.target.value)}
                    placeholder={`API key (${PROVIDERS.find((p) => p.id === aiProvider)?.keyHint ?? "sk-…"})`}
                    className="min-w-[16rem] flex-1 rounded-xl border border-edge bg-ink/80 px-3 py-2 text-[12.5px] text-zinc-200 placeholder:text-zinc-600"
                  />
                  <button
                    onClick={() => void translateWithKey()}
                    disabled={translating}
                    className="flex items-center gap-2 rounded-xl border border-warm/40 bg-warm/[0.12] px-4 py-2 text-[12.5px] font-semibold text-warm transition hover:bg-warm/[0.2] disabled:opacity-40"
                  >
                    {translating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                    {transLabel ?? "Translate with AI"}
                  </button>
                </div>
                <p className="font-mono text-[9px] tracking-[0.14em] text-zinc-600">
                  KEY STAYS IN YOUR BROWSER (LOCALSTORAGE) · SENT ONLY TO THE PROVIDER YOU PICK ·
                  GET ONE AT {PROVIDERS.find((p) => p.id === aiProvider)?.keyUrl.toUpperCase()}
                </p>
              </div>
            )}

            <div className="grid items-start gap-6 lg:grid-cols-[22rem_1fr]">
              <div className="glass sticky top-24 overflow-hidden rounded-3xl">
                <video
                  ref={reviewVideoRef}
                  src={`/api/jobs/${job.id}/file?kind=web`}
                  controls
                  className="aspect-video w-full bg-black object-contain"
                />
                <div className="px-5 py-3 font-mono text-[9px] tracking-[0.18em] text-zinc-500">
                  CLICK A TIMECODE TO AUDITION THAT MOMENT
                </div>
              </div>
              <ReviewEditor
                segments={segments}
                dirty={dirty}
                onEdit={onEditSegment}
                onSeek={(ms) => {
                  const v = reviewVideoRef.current;
                  if (v) {
                    v.currentTime = ms / 1000;
                    void v.play().catch(() => undefined);
                  }
                }}
              />
            </div>
          </div>
        )}

        {/* ------------------------- DONE ------------------------- */}
        {phase === "done" && job && (
          <div>
            <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
              <div>
                <Kicker>[ DUB COMPLETE ]</Kicker>
                <h1 className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl">
                  It speaks <span className="text-gradient">{langName(job.targetLang)}</span> now.
                </h1>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {presets.some((p) => p.id === "xtts-v2" && p.installed) &&
                  !job.log.some((l) => /TTS engine — XTTS/i.test(l.msg)) && (
                    <button
                      onClick={() => void redubWithClone()}
                      className="flex items-center gap-2 rounded-2xl border border-mint/35 bg-mint/10 px-5 py-3 font-display text-[13px] font-semibold text-mint transition hover:bg-mint/20"
                    >
                      <Wand2 className="h-4 w-4" /> Re-dub with my cloned voice
                    </button>
                  )}
                <a
                  href={`/api/jobs/${job.id}/file?kind=output&download=1`}
                  className="btn-primary glow-conic flex items-center gap-2.5 rounded-2xl px-7 py-3.5 font-display text-[15px] font-semibold text-white"
                >
                  <Download className="h-4.5 w-4.5" /> Download MP4
                </a>
              </div>
            </div>

            <div className="mb-6 flex gap-3">
              <Stat label="LINES DUBBED" value={String(job.segmentCount)} />
              <Stat label="RUNTIME" value={job.durationSec ? fmtTC(job.durationSec * 1000) : "—"} />
              <Stat label="AVG TEMPO FIT" value={`${avgTempo}×`} />
              <Stat label="WATERMARK" value="NONE" />
            </div>

            <div className="grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
              <div className="glass glow-conic overflow-hidden rounded-3xl">
                <video
                  src={`/api/jobs/${job.id}/file?kind=output`}
                  controls
                  autoPlay
                  muted={false}
                  className="max-h-[32rem] w-full bg-black object-contain"
                />
                <div className="flex items-center justify-between px-5 py-3 font-mono text-[9px] tracking-[0.18em] text-zinc-500">
                  <span>DUBBED — {job.voiceId}</span>
                  <span className="flex items-center gap-1.5 text-mint">
                    <Languages className="h-3 w-3" /> {(job.detectedLang ?? job.sourceLang).toUpperCase()} → {job.targetLang.toUpperCase()}
                  </span>
                </div>
              </div>
              <div className="glass overflow-hidden rounded-3xl">
                <video
                  src={`/api/jobs/${job.id}/file?kind=web`}
                  controls
                  muted
                  className="aspect-video w-full bg-black object-contain"
                />
                <div className="px-5 py-3 font-mono text-[9px] tracking-[0.18em] text-zinc-500">
                  ORIGINAL — MUTED REFERENCE
                </div>
              </div>
            </div>

            {segments.length > 0 && (
              <div className="mt-6">
                <TranscriptPreview segments={segments} langLabel={langName(job.targetLang).toUpperCase()} />
              </div>
            )}
          </div>
        )}

        {/* ------------------------- ERROR ------------------------- */}
        {phase === "error" && job && (
          <div className="grid gap-6 lg:grid-cols-[23rem_1fr]">
            <div className="flex flex-col gap-5">
              <div className="glass rounded-3xl border-red-400/25 p-7">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-red-400/10 ring-1 ring-red-400/30">
                  <AlertTriangle className="h-6 w-6 text-red-300" />
                </span>
                <h1 className="mt-5 font-display text-2xl font-bold text-white">The forge hit a snag</h1>
                <p className="mt-2 text-sm leading-relaxed text-red-200/80">{job.error}</p>
                <div className="mt-6 flex gap-3">
                  <button
                    onClick={retryJob}
                    className="btn-primary flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-white"
                  >
                    <RefreshCcw className="h-4 w-4" /> Retry pipeline
                  </button>
                  <button
                    onClick={resetAll}
                    className="rounded-xl border border-edge px-5 py-3 text-sm font-semibold text-zinc-300 transition hover:border-white/25"
                  >
                    Start over
                  </button>
                </div>
              </div>
            </div>
            <LogPanel logs={job.log} />
          </div>
        )}
      </main>
    </div>
  );
}
