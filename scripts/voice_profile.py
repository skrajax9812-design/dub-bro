#!/usr/bin/env python3
"""
Offline speaker profiler — describes *who* is talking in a video so the dub can
copy that voice's pitch and tone. Pure numpy, no model downloads.

Emits JSON on stdout:
{
  "f0Median": 118.4, "f0P10": 96.2, "f0P90": 152.8,
  "bands": [-38.1, -33.4, ...],     # long-term average spectrum, 6 bands, dB
  "speechRatio": 0.62, "genderHint": "male"
}
"""
import argparse
import json
import os
import sys
import wave

import numpy as np

BANDS = [(80, 200), (200, 400), (400, 800), (800, 1600), (1600, 3200), (3200, 6400)]
TARGET_SR = 16000


def ensure_wav(path: str) -> str:
    """Anything that isn't 16-bit PCM wav gets decoded through ffmpeg first."""
    try:
        with open(path, "rb") as f:
            if f.read(4) == b"RIFF":
                return path
    except OSError:
        pass
    import subprocess
    import tempfile

    ffmpeg = os.environ.get("FFMPEG_PATH") or "ffmpeg"
    out = tempfile.mktemp(suffix=".wav")
    subprocess.run(
        [ffmpeg, "-y", "-v", "error", "-i", path, "-ac", "1", "-ar", str(TARGET_SR), "-f", "wav", out],
        check=True,
    )
    return out


def read_wav(path: str):
    path = ensure_wav(path)
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sw != 2:
        raise SystemExit("voice_profile: expects 16-bit PCM wav")
    a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    if sr != TARGET_SR:
        n = int(len(a) * TARGET_SR / sr)
        a = np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a).astype(np.float32)
        sr = TARGET_SR
    return a, sr


def frame_energy(a: np.ndarray, sr: int, frame_ms=40, hop_ms=20):
    frame, hop = int(frame_ms * sr / 1000), int(hop_ms * sr / 1000)
    for i in range(0, max(0, len(a) - frame), hop):
        yield i, frame, a[i : i + frame]


def median_f0(a: np.ndarray, sr: int, fmin=60.0, fmax=400.0):
    f0s = []
    total = 0
    for _, frame, seg in frame_energy(a, sr):
        total += 1
        if float(np.sqrt((seg**2).mean())) < 0.008:
            continue
        seg = seg - seg.mean()
        corr = np.correlate(seg, seg, mode="full")[frame - 1 :]
        lo = int(sr / fmax)
        hi = min(int(sr / fmin), len(corr) - 1)
        if hi <= lo:
            continue
        window = corr[lo:hi]
        peak = int(np.argmax(window)) + lo
        if corr[0] <= 0 or corr[peak] <= 0.3 * corr[0]:
            continue
        f0s.append(sr / peak)
    if not f0s:
        return None, None, None, 0.0
    return (
        float(np.median(f0s)),
        float(np.percentile(f0s, 10)),
        float(np.percentile(f0s, 90)),
        len(f0s) / max(1, total),
    )


def ltas_bands(a: np.ndarray, sr: int):
    size, hop = 2048, 1024
    win = np.hanning(size)
    acc = np.zeros(size // 2)
    n = 0
    for i in range(0, max(0, len(a) - size), hop):
        seg = a[i : i + size] * win
        if float(np.sqrt((seg**2).mean())) < 0.005:
            continue
        acc += np.abs(np.fft.rfft(seg))[: size // 2]
        n += 1
    if n == 0:
        return None
    acc /= n
    freqs = np.fft.rfftfreq(size, 1 / sr)[: size // 2]
    out = []
    for lo, hi in BANDS:
        m = (freqs >= lo) & (freqs < hi)
        out.append(float(20 * np.log10(float(acc[m].mean()) + 1e-9)))
    return out


def best_reference_window(a: np.ndarray, sr: int, seconds: float) -> tuple[int, int]:
    """
    Locate the cleanest `seconds` of continuous speech — the clip a voice-cloning
    engine should learn the speaker from. Picks the window with the most speech
    energy and the fewest internal silences.
    """
    win = int(seconds * sr)
    if len(a) <= win:
        return 0, len(a)
    hop = int(0.25 * sr)
    frame = int(0.02 * sr)
    # per-frame energy -> speech/silence
    energies = []
    for i in range(0, len(a) - frame, frame):
        seg = a[i : i + frame]
        energies.append(float(np.sqrt((seg**2).mean())))
    energies = np.asarray(energies)
    voiced = energies > max(0.006, float(np.percentile(energies, 60)))

    best = (0, win, -1.0)
    for start in range(0, len(a) - win, hop):
        lo, hi = start // frame, (start + win) // frame
        if hi > len(voiced):
            break
        chunk = voiced[lo:hi]
        if len(chunk) == 0:
            continue
        ratio = float(chunk.mean())
        # Longest unbroken speech run inside the window, in seconds.
        longest = run = 0
        for v in chunk:
            run = run + 1 if v else 0
            longest = max(longest, run)
        score = ratio * 0.6 + (longest * frame / sr) / seconds * 0.4
        if score > best[2]:
            best = (start, start + win, score)
    return best[0], best[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", default="")
    ap.add_argument("--reference", default="", help="write a clean speaker clip here (for voice cloning)")
    ap.add_argument("--ref-seconds", type=float, default=12.0)
    args = ap.parse_args()

    a, sr = read_wav(args.audio)

    if args.reference:
        lo, hi = best_reference_window(a, sr, args.ref_seconds)
        ref = a[lo:hi]
        # Cloning engines want a quiet, levelled clip: peak-normalise to -3 dBFS.
        peak = float(np.max(np.abs(ref))) if len(ref) else 0.0
        if peak > 0:
            ref = ref * (0.7 / peak)
        with wave.open(args.reference, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes((np.clip(ref, -1, 1) * 32767).astype("<i2").tobytes())
        print(f"REFERENCE {args.reference} {lo / sr:.1f}s-{hi / sr:.1f}s", file=sys.stderr, flush=True)
    f0, p10, p90, speech_ratio = median_f0(a, sr)
    bands = ltas_bands(a, sr)

    gender = "unknown"
    if f0 is not None:
        gender = "male" if f0 < 165 else "female"

    profile = {
        "f0Median": None if f0 is None else round(f0, 1),
        "f0P10": None if p10 is None else round(p10, 1),
        "f0P90": None if p90 is None else round(p90, 1),
        "bands": None if bands is None else [round(b, 2) for b in bands],
        "speechRatio": round(speech_ratio, 3),
        "genderHint": gender,
    }
    text = json.dumps(profile)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
    print(text)


if __name__ == "__main__":
    sys.exit(main())
