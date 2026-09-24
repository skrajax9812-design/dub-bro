#!/usr/bin/env python3
"""
Offline neural-free TTS worker — espeak-ng (bundled with espeakng-loader) with an
optional Piper voice, plus *voice matching*: the synthesized line is pitch-shifted
and EQ-shaped so it lands in the same pitch range and tonal balance as the speaker
in the source video.

Manifest mode (same protocol as tts_batch.py):
  [{"i":0,"text":"...","lang":"hi","gender":"F","rate":"+0%","pitch":"+0Hz","out":"/path/seg_0.mp3"}]
Single-shot mode:
  --one "text" --lang hi --gender F --out /tmp/x.mp3
Prints: OK <i> | FAIL <i> | DONE ok=N fail=M
"""
import argparse
import ctypes
import json
import math
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

FFMPEG = os.environ.get("FFMPEG_PATH") or "ffmpeg"
ESPEAK_RATE = 22050
CALIBRATION_TEXT = "The quick brown fox jumps over the lazy dog every single morning."
BANDS = [(80, 200), (200, 400), (400, 800), (800, 1600), (1600, 3200), (3200, 6400)]
BAND_CENTERS = [140, 300, 600, 1200, 2400, 4800]

_lib = None
_cb_ref = None
_espeak_buffer = bytearray()


def espeak_lib():
    """Load the espeak-ng shared library that ships inside espeakng-loader."""
    global _lib, _cb_ref
    if _lib is not None:
        return _lib
    import espeakng_loader

    lib = ctypes.CDLL(espeakng_loader.get_library_path())
    cb_type = ctypes.CFUNCTYPE(
        ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.c_void_p
    )

    def _on_audio(wav, n, _events):
        if n > 0 and wav:
            _espeak_buffer.extend(ctypes.string_at(wav, n * 2))
        return 0

    _cb_ref = cb_type(_on_audio)
    lib.espeak_Initialize(ctypes.c_int(1), ctypes.c_int(0), espeakng_loader.get_data_path().encode(), ctypes.c_int(0))
    lib.espeak_SetSynthCallback(_cb_ref)
    _lib = lib
    return lib


def espeak_voice_name(lang: str, gender: str) -> str:
    base = (lang or "en").lower()
    if gender == "F":
        return f"{base}+f3"
    if gender == "M":
        return f"{base}+m3"
    return base


def synth_espeak(text: str, lang: str, gender: str, wpm: int, pitch: int) -> np.ndarray:
    """Return float32 mono samples at ESPEAK_RATE."""
    lib = espeak_lib()
    name = espeak_voice_name(lang, gender).encode()
    if lib.espeak_SetVoiceByName(ctypes.c_char_p(name)) != 0:
        lib.espeak_SetVoiceByName(ctypes.c_char_p((lang or "en").lower().encode()))
    lib.espeak_SetParameter(ctypes.c_int(1), ctypes.c_int(int(wpm)), ctypes.c_int(0))  # rate
    lib.espeak_SetParameter(ctypes.c_int(3), ctypes.c_int(int(pitch)), ctypes.c_int(0))  # pitch
    _espeak_buffer.clear()
    raw = text.encode("utf-8")
    lib.espeak_Synth(
        ctypes.c_char_p(raw),
        ctypes.c_size_t(len(raw)),
        ctypes.c_int(0),
        ctypes.c_int(0),
        ctypes.c_int(0),
        ctypes.c_int(1),
        ctypes.c_void_p(0),
        ctypes.c_void_p(0),
    )
    lib.espeak_Synchronize()
    if not _espeak_buffer:
        return np.zeros(0, dtype=np.float32)
    return np.frombuffer(bytes(_espeak_buffer), dtype="<i2").astype(np.float32) / 32768.0


def median_f0(a: np.ndarray, sr: int, fmin=60.0, fmax=400.0):
    frame, hop = int(0.04 * sr), int(0.02 * sr)
    f0s = []
    for i in range(0, max(0, len(a) - frame), hop):
        seg = a[i : i + frame]
        if float(np.sqrt((seg**2).mean())) < 0.008:
            continue
        seg = seg - seg.mean()
        corr = np.correlate(seg, seg, mode="full")[frame - 1 :]
        lo, hi = int(sr / fmax), min(int(sr / fmin), len(corr) - 1)
        if hi <= lo:
            continue
        peak = int(np.argmax(corr[lo:hi])) + lo
        if corr[0] <= 0 or corr[peak] <= 0.3 * corr[0]:
            continue
        f0s.append(sr / peak)
    return float(np.median(f0s)) if f0s else None


def band_levels(a: np.ndarray, sr: int):
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
        out.append(20 * math.log10(float(acc[m].mean()) + 1e-9))
    return out


class VoiceMatcher:
    """Works out the pitch ratio + EQ curve that turns the TTS voice into the speaker."""

    def __init__(self, profile_path: str, voice_key: str, lang: str, gender: str, calibrate=None):
        self.enabled = False
        self.ratio = 1.0
        self.gains = [0.0] * len(BANDS)
        try:
            with open(profile_path, encoding="utf-8") as f:
                prof = json.load(f)
        except Exception:
            return
        target_f0 = prof.get("f0Median")
        target_bands = prof.get("bands")
        if not target_f0 or not target_bands:
            return
        sample_rate = ESPEAK_RATE
        sample = None
        if calibrate is not None:
            rendered = calibrate(CALIBRATION_TEXT)
            if rendered:
                sample, sample_rate = rendered
        if sample is None:
            sample = synth_espeak(CALIBRATION_TEXT, lang, gender, 160, 50)
        if len(sample) < sample_rate // 2:
            return
        tts_f0 = median_f0(sample, sample_rate)
        tts_bands = band_levels(sample, sample_rate)
        if not tts_f0 or not tts_bands:
            return
        self.ratio = float(np.clip(target_f0 / tts_f0, 0.45, 1.8))
        # Normalise both curves to their own mean so we match *shape*, not loudness.
        t_off = float(np.mean(target_bands))
        s_off = float(np.mean(tts_bands))
        self.gains = [
            float(np.clip((target_bands[k] - t_off) - (tts_bands[k] - s_off), -8.0, 8.0))
            for k in range(len(BANDS))
        ]
        self.enabled = True
        print(
            f"VOICEMATCH {voice_key} ratio={self.ratio:.3f} "
            f"f0={target_f0:.0f}Hz gains={[round(g,1) for g in self.gains]}",
            file=sys.stderr,
            flush=True,
        )


def write_wav(path: str, a: np.ndarray, sr: int) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(a, -1, 1) * 32767).astype("<i2").tobytes())


def finalize(src_wav: str, out_path: str, matcher: VoiceMatcher | None, rate_pct: int, pitch_hz: int) -> None:
    """Pitch-match + tone-match + loudness-normalise, then encode to mp3."""
    chain = []
    if matcher and matcher.enabled:
        if abs(matcher.ratio - 1.0) > 0.02:
            chain.append(f"asetrate={int(ESPEAK_RATE * matcher.ratio)}")
            chain.append(f"aresample={ESPEAK_RATE}")
            chain.append(f"atempo={1.0 / matcher.ratio:.5f}")
        for center, gain in zip(BAND_CENTERS, matcher.gains):
            if abs(gain) > 0.75:
                chain.append(f"equalizer=f={center}:t=o:w=1:g={gain:.2f}")
    if pitch_hz:
        chain.append(f"rubberband=pitch={2 ** (pitch_hz / 1200):.4f}")
    chain.append("loudnorm=I=-18:TP=-2:LRA=11")
    args = [FFMPEG, "-y", "-v", "error", "-i", src_wav, "-ac", "1", "-ar", "24000"]
    if chain:
        args += ["-af", ",".join(chain)]
    args += ["-c:a", "libmp3lame", "-b:a", "128k", out_path]
    subprocess.run(args, check=True)


_piper_cache: dict[str, object] = {}


def synth_piper(text: str, model_path: str, wpm: int) -> tuple[np.ndarray, int] | None:
    """Neural Piper voice. Returns None when the voice/package is unavailable."""
    try:
        import wave as _wave

        from piper import PiperVoice, SynthesisConfig

        voice = _piper_cache.get(model_path)
        if voice is None:
            voice = PiperVoice.load(model_path)
            _piper_cache[model_path] = voice
        # Piper's natural pace is ~175 wpm; length_scale slows/speeds it.
        length_scale = float(np.clip(175.0 / max(80, wpm), 0.7, 1.6))
        cfg = SynthesisConfig(length_scale=length_scale)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            with _wave.open(tmp_path, "wb") as wav_file:
                voice.synthesize_wav(text, wav_file, syn_config=cfg)
            with _wave.open(tmp_path, "rb") as wav_file:
                sr = wav_file.getframerate()
                raw = wav_file.readframes(wav_file.getnframes())
            samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
            return samples, sr
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    except Exception as e:
        print(f"piper unavailable ({e}) — falling back to espeak-ng", file=sys.stderr, flush=True)
        return None


def wpm_from_rate(rate: str) -> int:
    pct = 0
    try:
        pct = int(str(rate).replace("%", "").replace("+", "") or 0)
    except ValueError:
        pct = 0
    return int(np.clip(160 * (1 + pct / 100.0), 80, 320))


def pitch_param(pitch: str) -> int:
    try:
        hz = int(str(pitch).replace("Hz", "").replace("+", "") or 0)
    except ValueError:
        hz = 0
    return int(np.clip(50 + hz / 2, 0, 99))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest")
    ap.add_argument("--one")
    ap.add_argument("--out")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--gender", default="F")
    ap.add_argument("--rate", default="+0%")
    ap.add_argument("--pitch", default="+0Hz")
    ap.add_argument("--profile", default="")
    ap.add_argument("--piper-model", default="")
    args = ap.parse_args()

    matchers: dict[str, VoiceMatcher] = {}

    def matcher_for(lang: str, gender: str) -> VoiceMatcher | None:
        if not args.profile or not os.path.exists(args.profile):
            return None
        key = f"{lang}:{gender}"
        if key not in matchers:
            # Calibrate against whichever engine actually renders the line, so the
            # pitch ratio is measured on the real voice, not on a stand-in.
            calibrate = None
            if args.piper_model and os.path.exists(args.piper_model):
                calibrate = lambda text: synth_piper(text, args.piper_model, 175)
            matchers[key] = VoiceMatcher(args.profile, key, lang, gender, calibrate=calibrate)
        m = matchers[key]
        return m if m.enabled else None

    def synth_item(item) -> bool:
        text = (item.get("text") or "").strip()
        out_path = item.get("out")
        if not text or not out_path:
            return False
        lang = item.get("lang") or args.lang
        gender = item.get("gender") or args.gender
        wpm = wpm_from_rate(item.get("rate") or args.rate)
        pitch = pitch_param(item.get("pitch") or args.pitch)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            rendered: tuple[np.ndarray, int] | None = None
            if args.piper_model and os.path.exists(args.piper_model):
                rendered = synth_piper(text, args.piper_model, wpm)
            if rendered is None:
                rendered = (synth_espeak(text, lang, gender, wpm, pitch), ESPEAK_RATE)
            samples, sample_rate = rendered
            if len(samples) == 0:
                return False
            write_wav(tmp_path, samples, sample_rate)
            finalize(tmp_path, out_path, matcher_for(lang, gender), 0, 0)
            return os.path.exists(out_path) and os.path.getsize(out_path) > 512
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    if args.one:
        ok = synth_item({"i": 0, "text": args.one, "out": args.out, "lang": args.lang, "gender": args.gender})
        print("OK 0" if ok else "FAIL 0", flush=True)
        return

    if not args.manifest:
        print("no manifest given", file=sys.stderr)
        sys.exit(2)
    with open(args.manifest, encoding="utf-8") as f:
        items = json.load(f)

    ok = fail = 0
    for item in items:
        try:
            good = synth_item(item)
        except Exception as e:  # never let one line kill the batch
            print(f"ERR {item.get('i')}: {e}", file=sys.stderr, flush=True)
            good = False
        if good:
            ok += 1
            print(f"OK {item.get('i')}", flush=True)
        else:
            fail += 1
            print(f"FAIL {item.get('i')}", flush=True)
    print(f"DONE ok={ok} fail={fail}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
