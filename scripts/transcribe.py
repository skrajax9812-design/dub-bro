#!/usr/bin/env python3
"""
Faster-Whisper ASR worker — runs locally on CPU in quantized INT8 format.
Reads a 16 kHz mono WAV (or any audio), emits a single JSON document on stdout:
{ "language": "en", "duration": 12.3, "segments": [{"start":..,"end":..,"text":..}, ...] }
"""
import argparse
import json
import sys


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model", default="base")
    ap.add_argument("--lang", default="auto")
    ap.add_argument("--beam", type=int, default=1)
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device="cpu", compute_type="int8")

    kwargs = dict(
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=400),
        beam_size=args.beam,
        temperature=0.0,
    )
    if args.lang and args.lang != "auto":
        kwargs["language"] = args.lang

    segments, info = model.transcribe(args.audio, **kwargs)

    out = {
        "language": info.language,
        "duration": round(float(info.duration or 0), 3),
        "segments": [
            {
                "start": round(float(s.start), 3),
                "end": round(float(s.end), 3),
                "text": s.text.strip(),
            }
            for s in segments
            if s.text and s.text.strip()
        ],
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
