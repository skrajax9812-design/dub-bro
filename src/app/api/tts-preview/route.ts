import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { run } from "@/lib/fftools";
import { voiceById } from "@/lib/voices";

export const runtime = "nodejs";
export const maxDuration = 60;

const SAMPLES: Record<string, string> = {
  hi: "नमस्ते! आपकी वीडियो अब किसी भी भाषा में, कितनी भी लंबी डब हो सकती है।",
  en: "Hey! Your video can now be dubbed in any language, no matter how long it is.",
  es: "¡Hola! Tu video ahora puede doblarse a cualquier idioma, sin límite de duración.",
  fr: "Salut ! Votre vidéo peut désormais être doublée dans n'importe quelle langue.",
  de: "Hallo! Dein Video kann jetzt in jede Sprache synchronisiert werden.",
  ja: "こんにちは！動画はどんな長さでも、どの言語にも吹き替えできます。",
  zh: "你好！你的视频现在可以配音成任何语言，不受时长限制。",
};

/** POST /api/tts-preview { voice, text?, rate?, pitch? } — quick voice sample */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    voice?: string;
    text?: string;
    rate?: number;
    pitch?: number;
  };
  const voice = voiceById(body.voice ?? "");
  if (!voice) return NextResponse.json({ error: "Unknown voice" }, { status: 400 });

  const text = (body.text?.trim() || SAMPLES[voice.lang] || SAMPLES.en).slice(0, 300);
  const out = path.join(os.tmpdir(), `preview_${randomUUID()}.mp3`);
  const r = Math.max(-50, Math.min(50, body.rate ?? 0));
  const p = Math.max(-40, Math.min(40, body.pitch ?? 0));

  const res = await run(
    process.env.PYTHON_BIN || "python3",
    [
      path.join(process.cwd(), "scripts", "tts_batch.py"),
      "--one", text,
      "--voice", voice.id,
      "--rate", `${r >= 0 ? "+" : ""}${r}%`,
      "--pitch", `${p >= 0 ? "+" : ""}${p}Hz`,
      "--out", out,
    ],
    { killAfterMs: 45_000 },
  );
  if (res.code !== 0 || !fs.existsSync(out)) {
    return NextResponse.json({ error: "Voice preview failed" }, { status: 502 });
  }
  const buf = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
