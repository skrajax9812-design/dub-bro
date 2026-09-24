/**
 * Chunked neural translation engine.
 * Strategy chain per chunk:
 *   1. GROQ_API_KEY   -> llama-3.3-70b JSON batch (context-aware, best quality)
 *   2. OPENAI_API_KEY -> gpt-4o-mini JSON batch
 *   3. MyMemory free neural MT API (no key required)
 *   4. Graceful: keep source text so the pipeline never hard-fails
 */

async function llmBatch(
  texts: string[],
  src: string,
  tgt: string,
): Promise<string[] | null> {
  const groqKey = process.env.GROQ_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!groqKey && !openaiKey) return null;

  const url = groqKey
    ? "https://api.groq.com/openai/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions";
  const model = groqKey ? "llama-3.3-70b-versatile" : "gpt-4o-mini";
  const key = (groqKey || openaiKey)!;

  const prompt = [
    `You are a professional dubbing translator. Translate each line from ${src} to ${tgt}.`,
    `Rules: natural spoken dialogue, keep meaning and tone, keep translations compact (similar length to source),`,
    `preserve line count and order exactly. Output ONLY a JSON array of strings, no markdown, no commentary.`,
    `Input JSON array:`,
    JSON.stringify(texts),
  ].join("\n");

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 4000,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr) && arr.length === texts.length) {
      return arr.map((s) => String(s ?? "").trim());
    }
    return null;
  } catch {
    return null;
  }
}

async function myMemoryOne(
  text: string,
  src: string,
  tgt: string,
  retries = 3,
): Promise<string> {
  const url =
    "https://api.mymemory.translated.net/get?q=" +
    encodeURIComponent(text.slice(0, 900)) +
    `&langpair=${encodeURIComponent(src)}|${encodeURIComponent(tgt)}`;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "dubforge/1.0" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        responseData?: { translatedText?: string };
        responseStatus?: number | string;
        quotaFinished?: boolean;
      };
      const t = data.responseData?.translatedText;
      if (data.quotaFinished) throw new Error("quota");
      if (t && Number(data.responseStatus) === 200) {
        // MyMemory sometimes echoes ALL-CAPS errors inside translatedText
        if (/QUERY LENGTH LIMIT|INVALID LANGUAGE/i.test(t)) throw new Error(t);
        return t.trim();
      }
      throw new Error(`status ${data.responseStatus}`);
    } catch {
      if (attempt < retries - 1)
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  return text; // graceful fallback: keep source line
}

async function pMap<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, i: number) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = new Array(Math.min(concurrency, items.length))
    .fill(0)
    .map(async () => {
      while (i < items.length) {
        const cur = i++;
        await fn(items[cur], cur);
      }
    });
  await Promise.all(workers);
}

/**
 * Translate an ordered list of utterances. Calls `each(i, translated)` as
 * results land (per segment), and reports coarse progress via `onProgress`.
 */
export async function translateAll(
  texts: string[],
  src: string,
  tgt: string,
  each: (i: number, translated: string) => Promise<void>,
  onProgress?: (done: number, total: number) => void,
): Promise<{ viaLLM: boolean }> {
  const total = texts.length;
  let viaLLM = Boolean(process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY);

  if (viaLLM) {
    // Chunk into batches (~1300 chars, max 18 lines) to prevent API overflow
    const batches: { start: number; group: string[] }[] = [];
    let cur: string[] = [];
    let curLen = 0;
    let start = 0;
    texts.forEach((t, i) => {
      if (curLen + t.length > 1300 || cur.length >= 18) {
        batches.push({ start, group: cur });
        cur = [];
        curLen = 0;
        start = i;
      }
      cur.push(t);
      curLen += t.length;
    });
    if (cur.length) batches.push({ start, group: cur });

    let done = 0;
    let llmFailed = false;
    for (const b of batches) {
      if (llmFailed) break;
      const out = await llmBatch(b.group, src, tgt);
      if (!out) {
        llmFailed = true;
        viaLLM = false;
        break;
      }
      for (let k = 0; k < out.length; k++) {
        const gi = b.start + k;
        const t = out[k] || b.group[k];
        await each(gi, t);
        done++;
        onProgress?.(done, total);
      }
    }
    if (!llmFailed) return { viaLLM: true };
    // else fall through: translate remaining via MyMemory
  }

  let done = 0;
  // Recompute progress baseline via a callback shim — counts handled by caller order
  await pMap(texts, 3, async (t, i) => {
    const translated = src === tgt ? t : await myMemoryOne(t, src, tgt);
    await each(i, translated);
    done++;
    onProgress?.(i + 1, total);
  });
  return { viaLLM: false };
}
