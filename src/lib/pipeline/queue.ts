import { runPipeline, type JobMode } from "./dub";

interface QItem {
  jobId: string;
  mode: JobMode;
}

interface QStore {
  items: QItem[];
  running: boolean;
}

const g = globalThis as typeof globalThis & { __dubQueue?: QStore };
if (!g.__dubQueue) {
  g.__dubQueue = { items: [], running: false };
}
const store: QStore = g.__dubQueue;

/** Serial worker — one pipeline at a time keeps CPU/IO sane on small boxes. */
async function pump() {
  if (store.running) return;
  store.running = true;
  try {
    while (store.items.length > 0) {
      const item = store.items.shift()!;
      try {
        await runPipeline(item.jobId, { mode: item.mode });
      } catch (e) {
        console.error(`[queue] pipeline crashed for ${item.jobId}`, e);
      }
    }
  } finally {
    store.running = false;
  }
}

/**
 * mode:
 *   full   — extract → transcribe → translate → synthesize → mux
 *   review — the transcript was approved in the Studio, continue at synthesis
 *   resume — the Studio supplied transcript/translations, continue at synthesis
 */
export function enqueueJob(jobId: string, mode: JobMode = "full") {
  const exists = store.items.some((i) => i.jobId === jobId && i.mode === mode);
  if (!exists) store.items.push({ jobId, mode });
  void pump();
}

export function queueSize(): number {
  return store.items.length + (store.running ? 1 : 0);
}
