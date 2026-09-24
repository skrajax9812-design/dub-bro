"use client";

/**
 * Browser-side assistance.
 *
 * The container this app runs in can only reach the npm + PyPI registries:
 * huggingface.co and translation APIs are unreachable *from the server*. The
 * visitor's browser is not restricted that way, so it fetches the neural models
 * (streamed into the server in chunks) and, when needed, runs the translation
 * over a CORS-enabled API.
 */

export interface ModelFileInfo {
  dest: string;
  repo: string;
  file: string;
  /** Bytes already streamed into the sandbox (used to resume). */
  haveBytes: number;
  /** Expected size of the finished file. */
  totalBytes: number;
  complete: boolean;
}

export interface ModelPresetInfo {
  id: string;
  kind: "asr" | "tts";
  label: string;
  note: string;
  installed: boolean;
  bytes: number;
  files: ModelFileInfo[];
}

export interface PresetProgress {
  presetId: string;
  fileIndex: number;
  fileLabel: string;
  received: number;
  total: number;
}

const CHUNK_BYTES = 8 * 1024 * 1024;

const hfUrl = (repo: string, file: string, rev = "main") =>
  `https://huggingface.co/${repo}/resolve/${rev}/${file}`;

/** Download one model file in the browser and stream it into the app in chunks. */
async function installFile(
  f: ModelFileInfo,
  presetId: string,
  fileIndex: number,
  onProgress: (p: PresetProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  // Resume an interrupted transfer instead of starting over.
  const resumeAt = !f.complete && f.haveBytes > 0 && f.haveBytes < f.totalBytes ? f.haveBytes : 0;
  const res = await fetch(hfUrl(f.repo, f.file), {
    signal,
    mode: "cors",
    redirect: "follow",
    headers: resumeAt > 0 ? { Range: `bytes=${resumeAt}-` } : undefined,
  });
  // A server that ignores Range answers 200 with the whole file: start over.
  const resumed = res.status === 206 && resumeAt > 0;
  if (!res.ok && res.status !== 206) throw new Error(`${f.repo}/${f.file} → HTTP ${res.status}`);
  if (!res.body) throw new Error("This browser cannot stream downloads.");

  const remaining = Number(res.headers.get("content-length") ?? 0);
  const total = resumed && remaining > 0 ? resumeAt + remaining : remaining || f.totalBytes;
  const reader = res.body.getReader();
  let offset = resumed ? resumeAt : 0;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;

  const flush = async () => {
    if (pendingBytes === 0) return;
    const chunk = new Uint8Array(pendingBytes);
    let at = 0;
    for (const p of pending) {
      chunk.set(p, at);
      at += p.length;
    }
    pending = [];
    pendingBytes = 0;
    const up = await fetch("/api/models/upload", {
      method: "POST",
      headers: { "x-rel-path": f.dest, "x-offset": String(offset), "content-type": "application/octet-stream" },
      body: chunk,
      signal,
    });
    if (!up.ok) throw new Error(`Upload failed: ${(await up.json().catch(() => ({}))).error ?? up.status}`);
    offset += chunk.length;
    onProgress({ presetId, fileIndex, fileLabel: f.file, received: offset, total });
  };

  onProgress({ presetId, fileIndex, fileLabel: f.file, received: offset, total });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      pending.push(value);
      pendingBytes += value.length;
      onProgress({ presetId, fileIndex, fileLabel: f.file, received: offset + pendingBytes, total });
      if (pendingBytes >= CHUNK_BYTES) await flush();
    }
  }
  await flush();
}

/** Install a whole preset (all of its files), resuming anything half-done. */
export async function installPreset(
  preset: ModelPresetInfo,
  onProgress: (p: PresetProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  for (let i = 0; i < preset.files.length; i++) {
    const f = preset.files[i];
    if (f.complete) continue;
    await installFile(f, preset.id, i, onProgress, signal);
  }
}

/** Bytes still to fetch for a preset. */
export function presetRemainingBytes(p: ModelPresetInfo): number {
  return p.files.reduce((sum, f) => sum + Math.max(0, f.totalBytes - f.haveBytes), 0);
}

/* ------------------------------------------------------------------ */
/* Translation (runs in the visitor's browser)                         */
/* ------------------------------------------------------------------ */

const MYMEMORY = "https://api.mymemory.translated.net/get";

async function translateOne(text: string, src: string, tgt: string): Promise<string | null> {
  const q = text.slice(0, 480);
  try {
    const r = await fetch(`${MYMEMORY}?q=${encodeURIComponent(q)}&langpair=${src}|${tgt}`);
    if (!r.ok) return null;
    const d = (await r.json()) as { responseData?: { translatedText?: string } };
    const out = d.responseData?.translatedText?.trim();
    if (!out || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) return null;
    return out;
  } catch {
    return null;
  }
}

/**
 * Translate subtitle lines using a CORS-enabled public MT API, in small
 * concurrent batches. Returns a map of segment id -> translated text.
 */
export async function translateSegmentsInBrowser(
  segments: { id: string; sourceText: string }[],
  src: string,
  tgt: string,
  onProgress: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const queue = [...segments];
  const total = queue.length;
  let done = 0;

  const worker = async () => {
    for (;;) {
      const seg = queue.shift();
      if (!seg) return;
      const translated = await translateOne(seg.sourceText, src, tgt);
      if (translated && translated.toLowerCase() !== seg.sourceText.toLowerCase()) {
        out.set(seg.id, translated);
      }
      done++;
      onProgress(done, total);
    }
  };

  await Promise.all(new Array(Math.min(4, total)).fill(0).map(worker));
  return out;
}

/* ------------------------------------------------------------------ */
/* AI translation (visitor's own API key, called from the browser)      */
/* ------------------------------------------------------------------ */

export type Provider = "groq" | "openai";

export interface ProviderInfo {
  id: Provider;
  label: string;
  keyHint: string;
  url: string;
  model: string;
  keyUrl: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "groq",
    label: "Groq (fast + free tier)",
    keyHint: "gsk_…",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "openai",
    label: "OpenAI",
    keyHint: "sk-…",
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    keyUrl: "https://platform.openai.com/api-keys",
  },
];

const LANG_NAMES: Record<string, string> = {
  hi: "Hindi", en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
  pt: "Portuguese", ru: "Russian", ja: "Japanese", ko: "Korean", zh: "Chinese", ar: "Arabic",
  bn: "Bengali", ta: "Tamil", te: "Telugu", mr: "Marathi", gu: "Gujarati", kn: "Kannada",
  ml: "Malayalam", pa: "Punjabi", ur: "Urdu",
};

export interface AiLine {
  id: string;
  sourceText: string;
  slotMs: number;
}

/**
 * Context-aware dubbing translation: the whole transcript goes to the model in
 * one request so it keeps pronouns, names and tone consistent, and every line is
 * asked to stay close to its spoken length (= the time slot it must fit into).
 */
export async function translateWithAi(
  lines: AiLine[],
  src: string,
  tgt: string,
  provider: ProviderInfo,
  apiKey: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (lines.length === 0) return out;

  const srcName = LANG_NAMES[src] ?? src;
  const tgtName = LANG_NAMES[tgt] ?? tgt;
  const BATCH = 40;

  for (let start = 0; start < lines.length; start += BATCH) {
    const batch = lines.slice(start, start + BATCH);
    const payload = batch.map((l) => ({
      id: l.id,
      text: l.sourceText,
      max_chars: Math.max(24, Math.round((l.slotMs / 1000) * 13.5)),
    }));

    const prompt = [
      `You are a professional dubbing translator. Translate every line from ${srcName} to ${tgtName}.`,
      `This is spoken dialogue for a video dub, so it must sound natural when read aloud.`,
      `Rules:`,
      `1. Keep the meaning, tone and names exactly; never add or drop information.`,
      `2. Each line must fit its time slot: stay at or under max_chars characters, because the`,
      `   line is read aloud in that many milliseconds. Shorten wording rather than dropping meaning.`,
      `3. Keep line count and ids identical, in order.`,
      `4. Output ONLY a JSON object: {"<id>": "<translation>", ...}. No markdown, no notes.`,
      JSON.stringify(payload),
    ].join("\n");

    const res = await fetch(provider.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 4000,
        response_format: { type: "json_object" },
      }),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${provider.label} → HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content ?? "{}";
    let parsed: Record<string, string> = {};
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()) as Record<string, string>;
    } catch {
      parsed = {};
    }
    for (const l of batch) {
      const value = parsed[l.id];
      if (typeof value === "string" && value.trim()) out.set(l.id, value.trim());
    }
  }
  return out;
}
