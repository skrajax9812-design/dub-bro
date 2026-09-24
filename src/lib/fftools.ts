import { spawn } from "child_process";
import { createRequire } from "module";
import path from "path";
import fs from "fs";

const req = createRequire(path.join(process.cwd(), "noop.js"));

function resolveBin(pkg: string, relFallback: string, envVar: string): string {
  // 1. Explicit override (e.g. a system ffmpeg installed outside node_modules)
  const override = process.env[envVar];
  if (override && fs.existsSync(override)) return override;
  // 2. The npm package (works when its postinstall download succeeded)
  try {
    const p = req(pkg);
    const bin = typeof p === "string" ? p : (p as { path?: string }).path;
    if (bin && fs.existsSync(bin)) return bin;
  } catch {
    /* fall through */
  }
  // 3. Manual drop-in inside the package folder
  const manual = path.join(process.cwd(), "node_modules", pkg, relFallback);
  if (fs.existsSync(manual)) return manual;
  return pkg; // hope it is on PATH
}

export const FFMPEG = resolveBin("ffmpeg-static", "ffmpeg", "FFMPEG_PATH");
export const FFPROBE = resolveBin("ffprobe-static", "ffprobe", "FFPROBE_PATH");

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn a process, capture output, stream log lines to an optional sink. */
export function run(
  cmd: string,
  args: string[],
  opts: { onLine?: (line: string) => void; killAfterMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outBuf = "";
    let errBuf = "";
    const timer = opts.killAfterMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${cmd} timed out after ${opts.killAfterMs}ms`));
        }, opts.killAfterMs)
      : null;

    const feedLines = (s: string, which: "out" | "err") => {
      if (!opts.onLine) return;
      if (which === "out") outBuf += s;
      else errBuf += s;
      const buf = which === "out" ? outBuf : errBuf;
      const lines = buf.split(/\r?\n/);
      const rest = lines.pop() ?? "";
      if (which === "out") outBuf = rest;
      else errBuf = rest;
      for (const line of lines) line.trim() && opts.onLine!(line.trim());
    };

    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      feedLines(s, "out");
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      feedLines(s, "err");
    });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Failed to start ${cmd}: ${e.message}`));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr: stderr.slice(-4000) });
    });
  });
}

export async function runChecked(
  cmd: string,
  args: string[],
  opts: { onLine?: (line: string) => void; killAfterMs?: number } = {},
): Promise<RunResult> {
  const res = await run(cmd, args, opts);
  if (res.code !== 0) {
    throw new Error(
      `${path.basename(cmd)} exited ${res.code}: ${res.stderr.slice(-600)}`,
    );
  }
  return res;
}

/** ffprobe helpers */
export async function probeDurationSec(file: string): Promise<number> {
  const res = await runChecked(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    file,
  ]);
  const parsed = JSON.parse(res.stdout || "{}");
  const d = parseFloat(parsed?.format?.duration ?? "0");
  if (!isFinite(d) || d <= 0) throw new Error(`Could not probe duration of ${file}`);
  return d;
}

export async function probeStreams(
  file: string,
): Promise<{ codec: string; type: string; width?: number; height?: number }[]> {
  const res = await runChecked(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_name,codec_type,width,height",
    "-of",
    "json",
    file,
  ]);
  const parsed = JSON.parse(res.stdout || "{}");
  return (parsed.streams ?? []).map(
    (s: { codec_name: string; codec_type: string; width?: number; height?: number }) => ({
      codec: s.codec_name,
      type: s.codec_type,
      width: s.width,
      height: s.height,
    }),
  );
}

/** Format seconds like 01:23:45.6 for UI / filters */
export function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = s.toFixed(1).padStart(4, "0");
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${ss}`
    : `${String(m).padStart(2, "0")}:${ss}`;
}
