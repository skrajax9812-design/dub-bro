#!/usr/bin/env python3
"""
Edge-TTS batch synthesizer — natural neural voices with pitch & tempo control.
Reads a JSON manifest: [{"i":0,"text":"...","voice":"hi-IN-SwaraNeural","rate":"+0%","pitch":"+0Hz","out":"/path/seg_0.mp3"}, ...]
Synthesizes concurrently, streaming progress as lines on stdout:
  OK <i>   |   FAIL <i>   |   DONE ok=N fail=M
Also supports single-shot mode: --one "text" --voice X --out file.mp3
"""
import argparse
import asyncio
import json
import sys


async def synth_one(item, sem):
    import edge_tts

    text = (item.get("text") or "").strip()
    if not text:
        print(f"FAIL {item['i']}", flush=True)
        return False
    async with sem:
        for attempt in range(3):
            try:
                comm = edge_tts.Communicate(
                    text[:2500],
                    item["voice"],
                    rate=item.get("rate", "+0%"),
                    pitch=item.get("pitch", "+0Hz"),
                )
                await comm.save(item["out"])
                print(f"OK {item['i']}", flush=True)
                return True
            except Exception:
                await asyncio.sleep(1.0 + attempt * 1.5)
        print(f"FAIL {item['i']}", flush=True)
        return False


async def run_manifest(path: str, concurrency: int) -> None:
    with open(path, "r", encoding="utf-8") as fh:
        items = json.load(fh)
    sem = asyncio.Semaphore(concurrency)
    results = await asyncio.gather(*[synth_one(it, sem) for it in items])
    ok = sum(1 for r in results if r)
    print(f"DONE ok={ok} fail={len(results) - ok}", flush=True)


async def run_single(text: str, voice: str, rate: str, pitch: str, out: str) -> None:
    import edge_tts

    comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    await comm.save(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest")
    ap.add_argument("--concurrency", type=int, default=5)
    ap.add_argument("--one")
    ap.add_argument("--voice", default="en-US-AvaMultilingualNeural")
    ap.add_argument("--rate", default="+0%")
    ap.add_argument("--pitch", default="+0Hz")
    ap.add_argument("--out", default="/tmp/tts_one.mp3")
    args = ap.parse_args()

    if args.one is not None:
        asyncio.run(run_single(args.one, args.voice, args.rate, args.pitch, args.out))
    elif args.manifest:
        asyncio.run(run_manifest(args.manifest, args.concurrency))
    else:
        sys.stderr.write("either --manifest or --one is required\n")
        sys.exit(2)


if __name__ == "__main__":
    main()
