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
  bytes: number;
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
  const res = await fetch(hfUrl(f.repo, f.file), { signal, mode: "cors", redirect: "follow" });
  if (!res.ok) throw new Error(`${f.repo}/${f.file} → HTTP ${res.status}`);
  if (!res.body) throw new Error("This browser cannot stream downloads.");

  const total = Number(res.headers.get("content-length") ?? f.bytes) || f.bytes;
  const reader = res.body.getReader();
  let offset = 0;
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

/** Install a whole preset (all of its files). */
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
