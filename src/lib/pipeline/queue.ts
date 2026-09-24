import { runPipeline } from "./dub";

interface QItem {
  jobId: string;
  fromReview: boolean;
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
        await runPipeline(item.jobId, { fromReview: item.fromReview });
      } catch (e) {
        console.error(`[queue] pipeline crashed for ${item.jobId}`, e);
      }
    }
  } finally {
    store.running = false;
  }
}

export function enqueueJob(jobId: string, fromReview = false) {
  // Avoid duplicates for the same job already waiting/running identical stage
  const exists = store.items.some((i) => i.jobId === jobId && i.fromReview === fromReview);
  if (!exists) store.items.push({ jobId, fromReview });
  void pump();
}

export function queueSize(): number {
  return store.items.length + (store.running ? 1 : 0);
}
