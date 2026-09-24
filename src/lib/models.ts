import fs from "fs";
import path from "path";
import { dataRoot } from "./storage";

/**
 * Model registry.
 *
 * The sandbox this app runs in can only reach the npm and PyPI registries, so
 * the neural models the pipeline wants (Whisper for ASR, Piper for neural TTS)
 * cannot be fetched from the server. They are fetched **in the visitor's
 * browser** — which does have internet — and streamed into this directory in
 * chunks. Everything after that runs offline.
 */

export interface ModelFile {
  /** Hugging Face repo, e.g. "Systran/faster-whisper-base" */
  repo: string;
  /** Path of the file inside that repo */
  file: string;
  /** Where it lands under data/models */
  dest: string;
  /** Rough download size, for the UI */
  bytes: number;
}

export interface ModelPreset {
  id: string;
  kind: "asr" | "tts";
  label: string;
  note: string;
  files: ModelFile[];
}

const hf = (repo: string, file: string, dest: string, bytes: number): ModelFile => ({
  repo,
  file,
  dest,
  bytes,
});

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "whisper-tiny",
    kind: "asr",
    label: "Whisper Tiny (ASR, ~75 MB)",
    note: "Fastest speech recognition. Good for clear speech and quick tests.",
    files: [
      hf("Systran/faster-whisper-tiny", "config.json", "asr/whisper-tiny/config.json", 2_000),
      hf("Systran/faster-whisper-tiny", "model.bin", "asr/whisper-tiny/model.bin", 75_000_000),
      hf("Systran/faster-whisper-tiny", "tokenizer.json", "asr/whisper-tiny/tokenizer.json", 2_200_000),
      hf("Systran/faster-whisper-tiny", "vocabulary.txt", "asr/whisper-tiny/vocabulary.txt", 400_000),
    ],
  },
  {
    id: "whisper-base",
    kind: "asr",
    label: "Whisper Base (ASR, ~145 MB)",
    note: "Recommended balance of accuracy and speed, understands Hindi, English and 90+ languages.",
    files: [
      hf("Systran/faster-whisper-base", "config.json", "asr/whisper-base/config.json", 2_000),
      hf("Systran/faster-whisper-base", "model.bin", "asr/whisper-base/model.bin", 145_000_000),
      hf("Systran/faster-whisper-base", "tokenizer.json", "asr/whisper-base/tokenizer.json", 2_200_000),
      hf("Systran/faster-whisper-base", "vocabulary.txt", "asr/whisper-base/vocabulary.txt", 800_000),
    ],
  },
  {
    id: "whisper-small",
    kind: "asr",
    label: "Whisper Small (ASR, ~490 MB)",
    note: "Best accuracy of the three. Slower on CPU, worth it for accents and noisy video.",
    files: [
      hf("Systran/faster-whisper-small", "config.json", "asr/whisper-small/config.json", 2_000),
      hf("Systran/faster-whisper-small", "model.bin", "asr/whisper-small/model.bin", 490_000_000),
      hf("Systran/faster-whisper-small", "tokenizer.json", "asr/whisper-small/tokenizer.json", 2_200_000),
      hf("Systran/faster-whisper-small", "vocabulary.txt", "asr/whisper-small/vocabulary.txt", 1_200_000),
    ],
  },
  {
    id: "whisper-medium",
    kind: "asr",
    label: "Whisper Medium (ASR, ~1.5 GB)",
    note: "Best accuracy for Indic languages and strong accents. Slower on CPU.",
    files: [
      hf("Systran/faster-whisper-medium", "config.json", "asr/whisper-medium/config.json", 2_000),
      hf("Systran/faster-whisper-medium", "model.bin", "asr/whisper-medium/model.bin", 1_530_000_000),
      hf("Systran/faster-whisper-medium", "tokenizer.json", "asr/whisper-medium/tokenizer.json", 2_200_000),
      hf("Systran/faster-whisper-medium", "vocabulary.txt", "asr/whisper-medium/vocabulary.txt", 1_400_000),
    ],
  },
  {
    id: "kokoro-hi",
    kind: "tts",
    label: "Kokoro-82M — Hindi voices (best quality, ~340 MB)",
    note: "Top-tier neural voice, Hindi female (hf_alpha) and male (hm_omega). The most natural option here.",
    files: [
      hf("thewh1teagle/kokoro-onnx", "kokoro-v1.0.onnx", "tts/kokoro/kokoro-v1.0.onnx", 310_000_000),
      hf("thewh1teagle/kokoro-onnx", "voices-v1.0.bin", "tts/kokoro/voices-v1.0.bin", 27_000_000),
    ],
  },
  {
    id: "piper-hi-male",
    kind: "tts",
    label: "Piper Hindi — Pratham (male, ~63 MB)",
    note: "Neural Hindi voice. Much more natural than the built-in offline engine.",
    files: [
      hf(
        "rhasspy/piper-voices",
        "hi/hi_IN/pratham/medium/hi_IN-pratham-medium.onnx",
        "tts/hi_IN-pratham-medium.onnx",
        63_000_000,
      ),
      hf(
        "rhasspy/piper-voices",
        "hi/hi_IN/pratham/medium/hi_IN-pratham-medium.onnx.json",
        "tts/hi_IN-pratham-medium.onnx.json",
        5_000,
      ),
    ],
  },
  {
    id: "piper-hi-female",
    kind: "tts",
    label: "Piper Hindi — Priyamvada (female, ~63 MB)",
    note: "Neural Hindi voice with a female timbre.",
    files: [
      hf(
        "rhasspy/piper-voices",
        "hi/hi_IN/priyamvada/medium/hi_IN-priyamvada-medium.onnx",
        "tts/hi_IN-priyamvada-medium.onnx",
        63_000_000,
      ),
      hf(
        "rhasspy/piper-voices",
        "hi/hi_IN/priyamvada/medium/hi_IN-priyamvada-medium.onnx.json",
        "tts/hi_IN-priyamvada-medium.onnx.json",
        5_000,
      ),
    ],
  },
];

export function modelsRoot(): string {
  const dir = path.join(dataRoot(), "models");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve a registry-relative path, refusing anything that escapes data/models. */
export function safeModelPath(relPath: string): string {
  const root = modelsRoot();
  const abs = path.resolve(root, relPath);
  if (!abs.startsWith(root + path.sep)) throw new Error("Invalid model path");
  return abs;
}

export function modelFileStatus(f: ModelFile): { dest: string; bytes: number; complete: boolean } {
  const abs = safeModelPath(f.dest);
  try {
    const st = fs.statSync(abs);
    // LFS-ish tolerance: consider it complete once we have ~90% of the expected size.
    return { dest: f.dest, bytes: st.size, complete: st.size >= f.bytes * 0.9 };
  } catch {
    return { dest: f.dest, bytes: 0, complete: false };
  }
}

export function presetStatus(p: ModelPreset) {
  const files = p.files.map(modelFileStatus);
  return {
    id: p.id,
    kind: p.kind,
    label: p.label,
    note: p.note,
    installed: files.every((f) => f.complete),
    bytes: files.reduce((s, f) => s + f.bytes, 0),
    files,
  };
}

/** Directory of the best local Whisper model, or null when none is installed. */
export function findLocalWhisperModel(): string | null {
  const dir = path.join(modelsRoot(), "asr");
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const rank = ["whisper-medium", "whisper-small", "whisper-base", "whisper-tiny"];
  const found = entries
    .filter((e) => fs.existsSync(path.join(dir, e, "model.bin")))
    .sort((a, b) => rank.indexOf(a) - rank.indexOf(b));
  return found.length > 0 ? path.join(dir, found[0]) : null;
}


/* ------------------------------------------------------------------ */
/* Engine resolution                                                   */
/* ------------------------------------------------------------------ */

export interface KokoroFiles {
  model: string;
  voices: string;
}

/** Local Kokoro-82M ONNX model + voice bank, when both are installed. */
export function findLocalKokoro(): KokoroFiles | null {
  const model = path.join(modelsRoot(), "tts", "kokoro", "kokoro-v1.0.onnx");
  const voices = path.join(modelsRoot(), "tts", "kokoro", "voices-v1.0.bin");
  if (fs.existsSync(model) && fs.existsSync(voices)) return { model, voices };
  return null;
}

/**
 * Kokoro voice ids by language + gender. Kokoro prefixes voices with their
 * language (h* = Hindi, a* = American English, b* = British English).
 */
export function kokoroVoiceFor(lang: string, gender: string): string {
  const table: Record<string, { F: string; M: string }> = {
    hi: { F: "hf_alpha", M: "hm_omega" },
    en: { F: "af_heart", M: "am_michael" },
  };
  const row = table[lang] ?? table.en;
  return gender === "F" ? row.F : row.M;
}

/** Piper voices may live in data/models/tts directly or in a subfolder. */
export function findLocalPiperVoice(lang: string, gender: string): string | null {
  const roots = [path.join(modelsRoot(), "tts"), path.join(modelsRoot(), "tts", "piper")];
  const onnx: string[] = [];
  for (const dir of roots) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(".onnx")) onnx.push(path.join(dir, f));
      }
    } catch {
      /* directory missing */
    }
  }
  // Only voices that ship the matching .onnx.json config can be used.
  const usable = onnx.filter((p) => fs.existsSync(p + ".json"));
  if (usable.length === 0) return null;
  const langMatch = usable.filter((p) =>
    path.basename(p).toLowerCase().startsWith(`${lang.toLowerCase()}_`),
  );
  const pool = langMatch.length > 0 ? langMatch : usable.filter((p) => path.basename(p).startsWith("hi_"));
  if (pool.length === 0) return null;
  const preferred = pool.find((p) =>
    gender === "F" ? /priyamvada|female/i.test(p) : /pratham|male/i.test(p),
  );
  return preferred ?? pool[0];
}
