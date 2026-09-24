import fs from "fs";
import path from "path";

let root: string | null = null;

/** Writable data root — prefers ./data inside the project, falls back to /tmp. */
export function dataRoot(): string {
  if (root) return root;
  const candidates = [
    process.env.DUB_DATA_DIR,
    path.join(process.cwd(), "data"),
    "/tmp/dubforge-data",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      fs.mkdirSync(c, { recursive: true });
      fs.accessSync(c, fs.constants.W_OK);
      root = c;
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error("No writable data directory found");
}

export function jobDir(jobId: string): string {
  const dir = path.join(dataRoot(), "jobs", jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function uploadsDir(): string {
  const dir = path.join(dataRoot(), "uploads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
