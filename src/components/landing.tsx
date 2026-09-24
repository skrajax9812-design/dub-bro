"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import {
  ArrowRight,
  AudioLines,
  AudioWaveform,
  BadgeCheck,
  BrainCircuit,
  Clapperboard,
  Cpu,
  Gauge,
  Infinity as InfinityIcon,
  Languages,
  Play,
  Scissors,
  ShieldCheck,
  Speech,
  Timer,
  Zap,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Animated waveform canvas                                            */
/* ------------------------------------------------------------------ */

function WaveCanvas({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let t = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = canvas;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    };
    resize();
    window.addEventListener("resize", resize);

    const layers = [
      { amp: 0.32, freq: 0.010, speed: 0.016, color: "rgba(139,124,255,0.75)", width: 2.2 },
      { amp: 0.22, freq: 0.016, speed: -0.011, color: "rgba(66,232,255,0.55)", width: 1.6 },
      { amp: 0.42, freq: 0.006, speed: 0.008, color: "rgba(157,242,255,0.28)", width: 1.2 },
      { amp: 0.15, freq: 0.024, speed: 0.022, color: "rgba(139,124,255,0.35)", width: 1 },
    ];

    const draw = () => {
      const { width: w, height: h } = canvas;
      ctx.clearRect(0, 0, w, h);
      const mid = h * 0.52;
      for (const L of layers) {
        ctx.beginPath();
        for (let x = 0; x <= w; x += 3 * dpr) {
          const k = x / w;
          const env = Math.sin(k * Math.PI) ** 1.6; // fade at edges
          const y =
            mid +
            Math.sin(x * L.freq + t * L.speed * 60) *
              h *
              L.amp *
              env *
              (0.6 + 0.4 * Math.sin(t * 0.35 + k * 5)) +
            Math.sin(x * L.freq * 2.7 + t * L.speed * 90) * h * L.amp * 0.25 * env;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = L.color;
        ctx.lineWidth = L.width * dpr;
        ctx.shadowBlur = 18 * dpr;
        ctx.shadowColor = L.color;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
      t += 0.016;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={ref} className={className} />;
}

/* ------------------------------------------------------------------ */
/* Nav                                                                 */
/* ------------------------------------------------------------------ */

function Logo() {
  return (
    <Link href="/" className="group flex items-center gap-3">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-[#7c6cff] to-[#42b8ff] shadow-[0_6px_24px_-6px_rgba(124,108,255,0.8)] transition-transform duration-300 group-hover:scale-105 group-hover:rotate-3">
        <AudioWaveform className="h-5 w-5 text-white" strokeWidth={2.4} />
      </span>
      <span className="font-display text-lg font-bold tracking-tight">
        DUB<span className="text-gradient">FORGE</span>
      </span>
      <span className="hidden rounded-full border border-edge px-2 py-0.5 font-mono text-[9px] tracking-[0.18em] text-zinc-400 sm:block">
        NO CAPS
      </span>
    </Link>
  );
}

function Nav() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.06] bg-void/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
        <Logo />
        <nav className="hidden items-center gap-8 font-mono text-[11px] tracking-[0.16em] text-zinc-400 md:flex">
          <a href="#pipeline" className="transition hover:text-white">PIPELINE</a>
          <a href="#limits" className="transition hover:text-white">NO LIMITS</a>
          <a href="#features" className="transition hover:text-white">FEATURES</a>
        </nav>
        <Link
          href="/studio"
          className="btn-primary flex items-center gap-2 rounded-full px-5 py-2.5 text-[13px] font-semibold text-white"
        >
          Open Studio
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Hero                                                                */
/* ------------------------------------------------------------------ */

const FLOAT_CHIPS = [
  { label: "हिन्दी", x: "6%", y: "16%", d: "0s", rot: "-6deg" },
  { label: "日本語", x: "86%", y: "12%", d: "1.2s", rot: "5deg" },
  { label: "ESPAÑOL", x: "3%", y: "58%", d: "2.1s", rot: "4deg" },
  { label: "FRANÇAIS", x: "88%", y: "52%", d: "0.6s", rot: "-4deg" },
  { label: "العربية", x: "80%", y: "78%", d: "1.8s", rot: "6deg" },
  { label: "한국어", x: "12%", y: "82%", d: "0.9s", rot: "-5deg" },
];

function Hero() {
  return (
    <section className="relative flex min-h-[100svh] items-center overflow-hidden pt-16">
      <div className="grid-bg absolute inset-0" />
      <div className="absolute left-1/2 top-0 h-[50rem] w-[80rem] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(124,108,255,0.16),transparent_60%)] blur-3xl" />
      <WaveCanvas className="absolute inset-0 h-full w-full opacity-70" />

      {FLOAT_CHIPS.map((c) => (
        <div
          key={c.label}
          style={{ left: c.x, top: c.y, ["--fr" as string]: c.rot, animationDelay: c.d }}
          className="glass animate-float absolute hidden rounded-2xl px-4 py-2 font-mono text-[11px] tracking-[0.22em] text-zinc-300 lg:block"
        >
          {c.label}
        </div>
      ))}

      <div className="relative z-10 mx-auto w-full max-w-6xl px-5 py-24 text-center sm:px-8">
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7 }}
          className="mb-7 font-mono text-[11px] tracking-[0.32em] text-zinc-400"
        >
          [ THE UNLIMITED AI DUBBING ENGINE ]
        </motion.p>

        <motion.h1
          initial={{ opacity: 0, y: 28 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.08 }}
          className="font-display text-[13.5vw] font-bold leading-[0.94] tracking-[-0.03em] sm:text-7xl md:text-8xl"
        >
          DUB ANY VIDEO.
          <br />
          <span className="text-gradient">ANY LENGTH.</span>
          <br />
          ANY LANGUAGE.
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
          className="mx-auto mt-7 max-w-2xl text-balance text-base leading-relaxed text-zinc-400 sm:text-lg"
        >
          While others cap you at 30 seconds, DUBFORGE runs a full local
          pipeline — Whisper ASR, chunked neural translation and Edge neural
          voices — to dub <span className="text-white">hour-long videos</span>,
          sentence-perfect and watermark-free.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.32 }}
          className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row"
        >
          <Link
            href="/studio"
            className="btn-primary glow-conic flex items-center gap-2.5 rounded-full px-8 py-4 font-display text-[15px] font-semibold text-white"
          >
            <Play className="h-4 w-4 fill-white" />
            Start Dubbing — Free
          </Link>
          <a
            href="#pipeline"
            className="glass flex items-center gap-2.5 rounded-full px-8 py-4 font-display text-[15px] font-semibold text-zinc-200 transition hover:border-neon/40 hover:text-white"
          >
            See the pipeline
          </a>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1, delay: 0.55 }}
          className="mx-auto mt-16 grid max-w-3xl grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.06] sm:grid-cols-4"
        >
          {[
            { k: "∞", v: "MAX DURATION" },
            { k: "30+", v: "LANGUAGES" },
            { k: "60+", v: "NEURAL VOICES" },
            { k: "0", v: "WATERMARKS" },
          ].map((s) => (
            <div key={s.v} className="bg-panel/90 px-4 py-5 backdrop-blur">
              <div className="font-display text-2xl font-bold text-white sm:text-3xl">{s.k}</div>
              <div className="mt-1 font-mono text-[9px] tracking-[0.22em] text-zinc-500">{s.v}</div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Language marquee                                                    */
/* ------------------------------------------------------------------ */

const MARQUEE_LANGS = [
  "हिन्दी", "ENGLISH", "ESPAÑOL", "FRANÇAIS", "DEUTSCH", "日本語", "한국어", "中文",
  "العربية", "বাংলা", "தமிழ்", "తెలుగు", "मराठी", "ગુજરાતી", "ಕನ್ನಡ", "PORTUGUÊS",
  "РУССКИЙ", "TÜRKÇE", "ITALIANO", "TIẾNG VIỆT", "ไทย", "INDONESIA", "УКРАЇНСЬКА", "اردو",
];

function Marquee() {
  const items = [...MARQUEE_LANGS, ...MARQUEE_LANGS];
  return (
    <section className="relative border-y border-white/[0.07] bg-ink/60 py-5">
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-32 bg-gradient-to-r from-void to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-32 bg-gradient-to-l from-void to-transparent" />
      <div className="animate-marquee flex w-max items-center gap-10 whitespace-nowrap">
        {items.map((l, i) => (
          <span key={i} className="flex items-center gap-10">
            <span className="font-display text-sm font-semibold tracking-[0.3em] text-zinc-400 transition hover:text-white">
              {l}
            </span>
            <AudioLines className="h-3.5 w-3.5 text-neon/60" />
          </span>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 30-second cap kill-switch                                           */
/* ------------------------------------------------------------------ */

function KillSwitch() {
  return (
    <section id="limits" className="relative overflow-hidden py-28 sm:py-36">
      <div className="absolute right-[-10%] top-1/2 h-[36rem] w-[36rem] -translate-y-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(66,232,255,0.09),transparent_65%)] blur-3xl" />
      <div className="mx-auto max-w-6xl px-5 text-center sm:px-8">
        <p className="font-mono text-[11px] tracking-[0.32em] text-zinc-500">[ THE 30-SECOND ERA IS OVER ]</p>
        <div className="mt-8 flex flex-col items-center justify-center gap-6 font-display font-bold leading-none sm:flex-row sm:gap-12">
          <motion.div
            initial={{ opacity: 0, x: -24 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.7 }}
            className="text-center"
          >
            <div className="strike-30 font-mono text-7xl text-zinc-600 sm:text-8xl">00:30</div>
            <div className="mt-3 font-mono text-[10px] tracking-[0.28em] text-red-400/80">THEIR LIMIT</div>
          </motion.div>
          <Zap className="hidden h-8 w-8 text-neon sm:block" strokeWidth={2.2} />
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.7 }}
            className="text-center"
          >
            <div className="text-gradient font-display text-[9rem] leading-[0.8] sm:text-[11rem]">∞</div>
            <div className="mt-3 font-mono text-[10px] tracking-[0.28em] text-mint">OURS — UNLIMITED</div>
          </motion.div>
        </div>
        <p className="mx-auto mt-10 max-w-xl text-balance text-zinc-400">
          Feature films, two-hour lectures, full podcasts — if your video has
          speech, we dub it end to end. No clipping, no hidden caps, no
          watermarks on export.
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

const PIPELINE = [
  {
    icon: Scissors,
    title: "Audio Extraction & Web Remuxing",
    blurb:
      "FFmpeg lifts a normalized 16 kHz mono track for ASR and remuxes your video into a web-native H.264 stream — visually lossless, zero re-encode when possible.",
    tags: ["FFMPEG", "16KHZ MONO", "H.264 MP4"],
  },
  {
    icon: AudioLines,
    title: "Faster-Whisper Speech Recognition",
    blurb:
      "Local CPU inference in quantized INT8 transcribes every sentence with exact timestamps. Audio is split into rolling chunks, so duration never matters.",
    tags: ["INT8 CPU", "TIMESTAMPS", "VAD CHUNKING"],
  },
  {
    icon: Languages,
    title: "Chunked Neural AI Translation",
    blurb:
      "Speech is translated sentence-by-sentence in rolling batches to prevent API overflow while preserving conversational context across lines.",
    tags: ["SENTENCE-WISE", "CONTEXT-AWARE", "NO OVERFLOW"],
  },
  {
    icon: Speech,
    title: "Edge-TTS Neural Voices",
    blurb:
      "Microsoft's natural neural voices across 30+ languages, synthesized per sentence with independent pitch and tempo control — preview any voice live.",
    tags: ["60+ VOICES", "PITCH ±40HZ", "TEMPO ±50%"],
  },
  {
    icon: Clapperboard,
    title: "Dynamic Tempo & Video Synchronization",
    blurb:
      "Every synthesized line is stretched or compressed to fit its original slot, laid onto the master timeline, and multiplexed back — no watermark, ever.",
    tags: ["ATEMPO FIT", "WORD-TIMELINE", "ZERO WATERMARK"],
  },
];

function PipelineSection() {
  return (
    <section id="pipeline" className="relative py-28 sm:py-36">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <div className="mb-16 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="font-mono text-[11px] tracking-[0.32em] text-zinc-500">[ THE ENGINE ]</p>
            <h2 className="mt-4 max-w-xl font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
              Five stages.
              <br />
              <span className="text-gradient">Zero shortcuts.</span>
            </h2>
          </div>
          <p className="max-w-sm text-sm leading-relaxed text-zinc-400">
            The same architecture the pros use — except ours never stops at 30
            seconds. Watch every stage run live in the studio.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {PIPELINE.map((s, i) => (
            <motion.div
              key={s.title}
              initial={{ opacity: 0, y: 26 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.6, delay: i * 0.07 }}
              className="glass card-hover group relative flex flex-col rounded-3xl p-6 xl:min-h-[21rem]"
            >
              <div className="mb-6 flex items-center justify-between">
                <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-[#7c6cff]/25 to-[#42e8ff]/15 ring-1 ring-neon/30 transition group-hover:ring-neon/60">
                  <s.icon className="h-5 w-5 text-neon" strokeWidth={2} />
                </span>
                <span className="font-mono text-xs text-zinc-600">0{i + 1}</span>
              </div>
              <h3 className="font-display text-lg font-semibold leading-snug text-white">
                {s.title}
              </h3>
              <p className="mt-3 flex-1 text-[13px] leading-relaxed text-zinc-400">{s.blurb}</p>
              <div className="mt-5 flex flex-wrap gap-1.5">
                {s.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full border border-edge px-2.5 py-1 font-mono text-[8.5px] tracking-[0.14em] text-zinc-400"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Features                                                            */
/* ------------------------------------------------------------------ */

const FEATURES = [
  {
    icon: InfinityIcon,
    title: "Truly unlimited length",
    blurb: "Rolling 10-minute ASR windows and batched synthesis — a 3-hour lecture dubs just like a 30-second reel.",
  },
  {
    icon: Timer,
    title: "Sentence-level sync",
    blurb: "Every line lands on its original timestamp. Duration drift is absorbed by dynamic atempo fitting.",
  },
  {
    icon: BrainCircuit,
    title: "Context-aware translation",
    blurb: "Lines travel in conversational batches, so pronouns and tone survive across sentence boundaries.",
  },
  {
    icon: Gauge,
    title: "Voice tuning controls",
    blurb: "Dial neural pitch ±40 Hz and tempo ±50% per job. Preview voices before committing.",
  },
  {
    icon: Cpu,
    title: "Private, local ASR",
    blurb: "Faster-Whisper runs quantized INT8 on CPU — your audio never leaves the machine for transcription.",
  },
  {
    icon: ShieldCheck,
    title: "No watermark, ever",
    blurb: "The video stream is copied bit-for-bit into the export. Your footage is never re-compressed or stamped.",
  },
];

function Features() {
  return (
    <section id="features" className="relative py-28 sm:py-36">
      <div className="absolute left-[-12%] top-1/3 h-[32rem] w-[32rem] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(139,124,255,0.1),transparent_65%)] blur-3xl" />
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <p className="font-mono text-[11px] tracking-[0.32em] text-zinc-500">[ WHY DUBFORGE ]</p>
        <h2 className="mt-4 max-w-2xl font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
          Built like a studio,
          <br />
          <span className="text-gradient">priced like nothing.</span>
        </h2>

        <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 22 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.55, delay: (i % 3) * 0.08 }}
              className="glass card-hover rounded-3xl p-7"
            >
              <f.icon className="h-6 w-6 text-ice" strokeWidth={1.9} />
              <h3 className="mt-5 font-display text-lg font-semibold text-white">{f.title}</h3>
              <p className="mt-2.5 text-[13.5px] leading-relaxed text-zinc-400">{f.blurb}</p>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 22 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="glass mt-4 flex flex-col items-center justify-between gap-5 rounded-3xl p-7 sm:flex-row"
        >
          <div className="flex items-center gap-4">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-mint/10 ring-1 ring-mint/30">
              <BadgeCheck className="h-5 w-5 text-mint" />
            </span>
            <div>
              <div className="font-display font-semibold text-white">Human-in-the-loop review mode</div>
              <div className="text-[13px] text-zinc-400">
                Pause after translation, edit any line, then synthesize. Broadcast-grade control.
              </div>
            </div>
          </div>
          <Link
            href="/studio"
            className="flex items-center gap-2 rounded-full border border-neon/35 px-6 py-3 font-display text-sm font-semibold text-white transition hover:bg-neon/10"
          >
            Try it in the Studio <ArrowRight className="h-4 w-4" />
          </Link>
        </motion.div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* CTA + Footer                                                        */
/* ------------------------------------------------------------------ */

function CtaFooter() {
  return (
    <footer className="relative overflow-hidden">
      <section className="relative py-28 text-center sm:py-36">
        <div className="absolute inset-x-0 bottom-0 h-[30rem] bg-[radial-gradient(ellipse_60%_60%_at_50%_100%,rgba(124,108,255,0.22),transparent_70%)]" />
        <WaveCanvas className="absolute inset-0 h-full w-full opacity-40" />
        <div className="relative z-10 mx-auto max-w-4xl px-5">
          <h2 className="font-display text-5xl font-bold leading-[1.02] tracking-tight sm:text-7xl">
            Your video speaks
            <br />
            <span className="text-gradient">every language.</span>
          </h2>
          <p className="mx-auto mt-6 max-w-md text-zinc-400">
            Drop a file, pick a voice, press dub. The first render usually
            finishes before your chai gets cold.
          </p>
          <Link
            href="/studio"
            className="btn-primary glow-conic mt-10 inline-flex items-center gap-2.5 rounded-full px-10 py-4.5 font-display text-base font-semibold text-white"
          >
            Open the Studio
            <ArrowRight className="h-5 w-5" />
          </Link>
        </div>
      </section>
      <div className="border-t border-white/[0.06] py-8">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-5 font-mono text-[10px] tracking-[0.2em] text-zinc-600 sm:flex-row sm:px-8">
          <span>DUBFORGE — UNLIMITED AI DUBBING ENGINE</span>
          <span className="flex items-center gap-2">
            <Cpu className="h-3.5 w-3.5" /> FFMPEG · FASTER-WHISPER INT8 · EDGE NEURAL TTS
          </span>
        </div>
      </div>
    </footer>
  );
}

export function Landing() {
  return (
    <main className="relative">
      <Nav />
      <Hero />
      <Marquee />
      <KillSwitch />
      <PipelineSection />
      <Features />
      <CtaFooter />
    </main>
  );
}
