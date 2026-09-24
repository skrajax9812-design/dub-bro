import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { FFMPEG, run } from "@/lib/fftools";
import {
  findLocalKokoro,
  findLocalPiperVoice,
  findLocalWhisperModel,
  findLocalXtts,
  kokoroVoiceFor,
} from "@/lib/models";

export const runtime = "nodejs";
export const maxDuration = 300;

const SAMPLE: Record<string, string> = {
  hi: "नमस्ते दोस्तों, यह आवाज़ का परीक्षण है। उम्मीद है आपको पसंद आएगा।",
  en: "Hello friends, this is a voice test. Let us see how natural it sounds.",
};

/**
 * POST /api/models/selftest { kind: "tts" | "asr", lang?, gender? }
 *
 * After the browser drops a model into the sandbox this proves the engine really
 * runs — synthesizing a sample sentence (returned as audio) or transcribing a
 * short generated clip. A broken download shows up here instead of mid-dub.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    kind?: string;
    lang?: string;
    gender?: string;
  };
  const kind = body.kind ?? "tts";
  const lang = body.lang ?? "hi";
  const gender = body.gender ?? "F";
  const PY = process.env.PYTHON_BIN || "python3";
  const scripts = path.join(process.cwd(), "scripts");
  const tmp = path.join(os.tmpdir(), `selftest_${randomUUID()}`);

  if (kind === "tts") {
    const kokoro = findLocalKokoro();
    const piper = findLocalPiperVoice(lang, gender);
    const xtts = findLocalXtts();
    // Prefer the cloning engine so the test proves the clone actually speaks.
    const engine = xtts ? "xtts" : kokoro ? "kokoro" : piper ? "piper" : "espeak";
    const out = `${tmp}.mp3`;
    const args = [
      path.join(scripts, "offline_tts.py"),
      "--one", SAMPLE[lang] ?? SAMPLE.en,
      "--lang", lang,
      "--gender", gender,
      "--voice", xtts ? "Ana Florence" : kokoro ? kokoroVoiceFor(lang, gender) : "",
      "--engine", engine,
      "--out", out,
      ...(piper ? ["--piper-model", piper] : []),
      ...(kokoro ? ["--kokoro-model", kokoro.model, "--kokoro-voices", kokoro.voices] : []),
      ...(xtts ? ["--xtts-model", xtts] : []),
    ];
    const res = await run(PY, args, { killAfterMs: 300_000 });
    if (res.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size < 512) {
      return NextResponse.json(
        { ok: false, engine, error: res.stderr.slice(-500) || "no audio produced" },
        { status: 502 },
      );
    }
    const buf = fs.readFileSync(out);
    fs.rmSync(out, { force: true });
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "content-type": "audio/mpeg",
        "x-engine": engine,
        "x-log": encodeURIComponent(res.stderr.slice(-400)),
      },
    });
  }

  if (kind === "asr") {
    const model = findLocalWhisperModel();
    if (!model) {
      return NextResponse.json({ ok: false, error: "No Whisper model installed" }, { status: 400 });
    }
    // Speak a known sentence with the offline voice, then transcribe it back.
    const mp3 = `${tmp}.mp3`;
    const wav = `${tmp}.wav`;
    const spoken = await run(PY, [
      path.join(scripts, "offline_tts.py"), "--one", SAMPLE.en,
      "--lang", "en", "--gender", "F", "--engine", "espeak", "--out", mp3,
    ]);
    if (spoken.code !== 0) {
      return NextResponse.json({ ok: false, error: "Could not generate the test audio" }, { status: 500 });
    }
    const conv = await run(FFMPEG, ["-y", "-v", "error", "-i", mp3, "-ac", "1", "-ar", "16000", wav]);
    if (conv.code !== 0) {
      return NextResponse.json({ ok: false, error: "Could not convert the test audio" }, { status: 500 });
    }
    const res = await run(
      PY,
      [path.join(scripts, "transcribe.py"), "--audio", wav, "--model", model, "--lang", "en"],
      { killAfterMs: 280_000 },
    );
    fs.rmSync(mp3, { force: true });
    fs.rmSync(wav, { force: true });
    if (res.code !== 0) {
      return NextResponse.json({ ok: false, error: res.stderr.slice(-500) }, { status: 502 });
    }
    try {
      const parsed = JSON.parse(res.stdout.trim()) as {
        language?: string;
        segments?: { text: string }[];
      };
      return NextResponse.json({
        ok: true,
        model: path.basename(model),
        language: parsed.language,
        text: (parsed.segments ?? []).map((s) => s.text).join(" ").trim(),
      });
    } catch {
      return NextResponse.json({ ok: false, error: "Model loaded but produced no transcript" }, { status: 502 });
    }
  }

  return NextResponse.json({ error: "Unknown self-test kind" }, { status: 400 });
}
