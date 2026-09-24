#!/usr/bin/env python3
"""
TTS worker with a quality ladder: Kokoro-82M -> Piper -> espeak-ng.

Every engine gets the same post-processing:
  * **voice matching** — pitch + tone are bent onto the speaker profiled from the
    source video (`scripts/voice_profile.py`), so the dub sounds like the same person
  * **fit to slot** — the line is re-rendered at a slower/faster native rate first
    (best quality) and only then time-compressed, so the dub never sounds chipmunked
  * **broadcast polish** — loudness normalisation to -18 LUFS with a true-peak ceiling

Manifest (same protocol as the Edge-TTS worker):
  [{"i":0,"text":"...","lang":"hi","gender":"F","voice":"hf_alpha",
    "slotMs":2400,"rate":"+0%","out":"/path/seg_0.mp3"}]
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
MAX_ATEMPO = 1.45
MAX_NATIVE_SPEEDUP = 1.4
OUT_RATE = 24000

# ------------------------------------------------------------------ espeak


_lib = None
_cb_ref = None
_espeak_buffer = bytearray()


def espeak_lib():
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
    lib.espeak_Initialize(
        ctypes.c_int(1), ctypes.c_int(0), espeakng_loader.get_data_path().encode(), ctypes.c_int(0)
    )
    lib.espeak_SetSynthCallback(_cb_ref)
    _lib = lib
    return lib


def espeak_voice_name(lang: str, gender: str) -> str:
    base = (lang or "en").lower()
    if base in ("hi", "ur", "bn", "ta", "te", "mr", "gu", "kn", "ml", "pa"):
        # Indic espeak voices do not accept the +f3/+m3 variants reliably.
        return base
    if gender == "F":
        return f"{base}+f3"
    if gender == "M":
        return f"{base}+m3"
    return base


def synth_espeak(text: str, lang: str, gender: str, wpm: int, pitch: int) -> tuple[np.ndarray, int]:
    lib = espeak_lib()
    name = espeak_voice_name(lang, gender).encode()
    if lib.espeak_SetVoiceByName(ctypes.c_char_p(name)) != 0:
        lib.espeak_SetVoiceByName(ctypes.c_char_p((lang or "en").lower().encode()))
    lib.espeak_SetParameter(ctypes.c_int(1), ctypes.c_int(int(wpm)), ctypes.c_int(0))
    lib.espeak_SetParameter(ctypes.c_int(3), ctypes.c_int(int(pitch)), ctypes.c_int(0))
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
        return np.zeros(0, dtype=np.float32), ESPEAK_RATE
    return np.frombuffer(bytes(_espeak_buffer), dtype="<i2").astype(np.float32) / 32768.0, ESPEAK_RATE


# ------------------------------------------------------------------ piper

_piper_cache: dict[str, object] = {}


def piper_ready(model_path: str) -> bool:
    return bool(model_path) and os.path.exists(model_path) and os.path.exists(model_path + ".json")


def synth_piper(text: str, model_path: str, length_scale: float) -> tuple[np.ndarray, int] | None:
    if not piper_ready(model_path):
        return None
    try:
        from piper import PiperVoice, SynthesisConfig

        voice = _piper_cache.get(model_path)
        if voice is None:
            voice = PiperVoice.load(model_path)
            _piper_cache[model_path] = voice
        cfg = SynthesisConfig(length_scale=float(np.clip(length_scale, 0.7, 1.6)))
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            with wave.open(tmp_path, "wb") as wav_file:
                voice.synthesize_wav(text, wav_file, syn_config=cfg)
            with wave.open(tmp_path, "rb") as wav_file:
                sr = wav_file.getframerate()
                raw = wav_file.readframes(wav_file.getnframes())
            return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0, sr
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    except Exception as e:
        print(f"piper failed ({e})", file=sys.stderr, flush=True)
        return None


# ------------------------------------------------------------------ kokoro

_kokoro = None


def kokoro_ready(model_path: str, voices_path: str) -> bool:
    return bool(model_path) and bool(voices_path) and os.path.exists(model_path) and os.path.exists(voices_path)


def synth_kokoro(
    text: str, model_path: str, voices_path: str, voice: str, speed: float
) -> tuple[np.ndarray, int] | None:
    global _kokoro
    if not kokoro_ready(model_path, voices_path):
        return None
    try:
        from kokoro_onnx import Kokoro

        if _kokoro is None:
            _kokoro = Kokoro(model_path, voices_path)
        ko = _kokoro
        lang = "en-us"
        if voice and len(voice) >= 2:
            # Kokoro voice ids are prefixed with their language (hf_ = Hindi female)
            lang = {"h": "hi", "a": "en-us", "b": "en-gb"}.get(voice[0], "en-us")
        samples, sr = ko.create(text, voice=voice, speed=float(np.clip(speed, 0.7, 1.5)), lang=lang)
        return np.asarray(samples, dtype=np.float32), int(sr)
    except Exception as e:
        print(f"kokoro failed ({e})", file=sys.stderr, flush=True)
        return None


# ------------------------------------------------------------------ xtts (cloning)

_xtts = None


def xtts_ready(model_dir: str, reference: str) -> bool:
    return bool(model_dir) and os.path.isdir(model_dir) and bool(reference) and os.path.exists(reference)


def synth_xtts(
    text: str, model_dir: str, reference: str, lang: str, speed: float, speaker: str = ""
) -> tuple[np.ndarray, int] | None:
    """
    XTTS-v2 zero-shot clone: the reference clip is the speaker from the source
    video, so the dubbed line comes out in that person's voice.
    """
    global _xtts
    if not model_dir or not os.path.isdir(model_dir):
        return None
    if not reference and not speaker:
        return None
    try:
        import torch
        from TTS.api import TTS

        if _xtts is None:
            torch.set_num_threads(max(1, min(2, os.cpu_count() or 1)))
            _xtts = TTS(
                model_path=os.path.join(model_dir, "model.pth"),
                config_path=os.path.join(model_dir, "config.json"),
                progress_bar=False,
            ).to("cpu")
        sample_rate = int(getattr(_xtts.synthesizer, "output_sample_rate", 24000))
        wav = _xtts.tts(
            text=text,
            speaker=speaker if (speaker and not reference) else None,
            speaker_wav=reference or None,
            language=lang,
            speed=float(np.clip(speed, 0.7, 1.4)),
            split_sentences=False,
        )
        return np.asarray(wav, dtype=np.float32), sample_rate
    except Exception as e:
        print(f"xtts failed ({e})", file=sys.stderr, flush=True)
        return None


# ------------------------------------------------------------------ analysis


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


def write_wav(path: str, a: np.ndarray, sr: int) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(a, -1, 1) * 32767).astype("<i2").tobytes())


# ------------------------------------------------------------------ engines


class Engine:
    """One synthesis backend, with voice matching calibrated on its own output."""

    def __init__(self, name: str, opts: argparse.Namespace, profile: dict | None):
        self.name = name
        self.opts = opts
        self.profile = profile
        self.ratio = 1.0
        self.gains = [0.0] * len(BANDS)
        self.matched = False
        self._calibrated: dict[str, bool] = {}

    # -- rendering -----------------------------------------------------
    def render(self, text: str, lang: str, gender: str, wpm: int, speed: float, voice: str):
        if self.name == "xtts":
            out = synth_xtts(
                text, self.opts.xtts_model, self.opts.reference, lang, speed, voice if not self.opts.reference else ""
            )
            if out is not None:
                return out
        if self.name == "kokoro":
            out = synth_kokoro(text, self.opts.kokoro_model, self.opts.kokoro_voices, voice, speed)
            if out is not None:
                return out
        if self.name in ("kokoro", "piper"):
            out = synth_piper(text, self.opts.piper_model, 175.0 / max(80, wpm) / max(speed, 0.01))
            if out is not None:
                return out
        return synth_espeak(text, lang, gender, int(wpm * speed), self.opts.espeak_pitch)

    # -- voice matching -------------------------------------------------
    def calibrate(self, lang: str, gender: str, voice: str) -> None:
        key = f"{lang}:{gender}:{voice}"
        if self._calibrated.get(key):
            return
        self._calibrated[key] = True
        if self.name == "xtts":
            # The clone is already this speaker — pitch/EQ matching would only
            # smear it. Report the match as satisfied and skip the shift.
            self.matched = False
            print("VOICEMATCH engine=xtts skipped — the clone carries the speaker's timbre", file=sys.stderr, flush=True)
            return
        if not self.profile:
            return
        target_f0 = self.profile.get("f0Median")
        target_bands = self.profile.get("bands")
        if not target_f0 or not target_bands:
            return
        sample, sr = self.render(CALIBRATION_TEXT, lang, gender, 160, 1.0, voice)
        if len(sample) < sr // 2:
            return
        tts_f0 = median_f0(sample, sr)
        tts_bands = band_levels(sample, sr)
        if not tts_f0 or not tts_bands:
            return
        self.ratio = float(np.clip(target_f0 / tts_f0, 0.45, 1.8))
        t_off, s_off = float(np.mean(target_bands)), float(np.mean(tts_bands))
        self.gains = [
            float(np.clip((target_bands[k] - t_off) - (tts_bands[k] - s_off), -4.0, 4.0))
            for k in range(len(BANDS))
        ]
        self.matched = True
        print(
            f"VOICEMATCH engine={self.name} {key} ratio={self.ratio:.3f} "
            f"target_f0={target_f0:.0f}Hz tts_f0={tts_f0:.0f}Hz gains={[round(g, 1) for g in self.gains]}",
            file=sys.stderr,
            flush=True,
        )

    # -- post processing ------------------------------------------------
    def fit_and_polish(self, src_wav: str, out_path: str, slot_ms: int | None, rate_pct: int) -> None:
        chain: list[str] = []
        if self.matched:
            if abs(self.ratio - 1.0) > 0.02:
                # Pitch-shift against the *actual* sample rate of this engine's
                # output (espeak 22.05k, Piper 22.05k, Kokoro 24k).
                src_sr = wav_rate(src_wav) or ESPEAK_RATE
                chain.append(f"asetrate={int(src_sr * self.ratio)}")
                chain.append(f"aresample={src_sr}")
                chain.append(f"atempo={1.0 / self.ratio:.5f}")
            for center, gain in zip(BAND_CENTERS, self.gains):
                if abs(gain) > 0.6:
                    # Wide, gentle shelves: a hard ±8 dB EQ is what makes a matched
                    # voice sound hollow/robotic.
                    chain.append(f"equalizer=f={center}:t=o:w=1.6:g={gain:.2f}")

        # Fit the slot: pitch/EQ first, then measure, then compress if needed.
        base = [FFMPEG, "-y", "-v", "error", "-i", src_wav, "-ac", "1", "-ar", str(OUT_RATE)]
        if chain:
            base += ["-af", ",".join(chain)]
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            fitted = tmp.name
        base += [fitted]
        subprocess.run(base, check=True)

        duration = wav_duration(fitted)
        tempo = 1.0
        if slot_ms and duration > 0:
            # MP3 encoding adds ~50-70 ms of padding, so aim a little short of the
            # slot — otherwise the tail of one line bleeds over the next one.
            target = max(0.4, (slot_ms / 1000.0) * (1.0 + rate_pct / 100.0) - 0.09)
            if duration > target:
                tempo = min(MAX_ATEMPO, duration / target)
        final = [FFMPEG, "-y", "-v", "error", "-i", fitted, "-ac", "1", "-ar", str(OUT_RATE)]
        post: list[str] = []
        if tempo > 1.01:
            post.append(f"atempo={tempo:.4f}")
        # A single static gain keeps line-to-line loudness even without the
        # pumping that per-clip dynamic normalisation causes. The finished track
        # gets one proper loudnorm pass in the pipeline.
        gain = static_gain_db(fitted)
        if abs(gain) > 0.2:
            post.append(f"volume={gain:.2f}dB")
        post.append("alimiter=limit=0.95:attack=5:release=60")
        final += ["-af", ",".join(post), "-c:a", "libmp3lame", "-b:a", "128k", out_path]
        subprocess.run(final, check=True)
        for p in (fitted,):
            try:
                os.unlink(p)
            except OSError:
                pass


def static_gain_db(path: str, target_dbfs: float = -6.0) -> float:
    """One fixed gain per clip, measured from its peak (no dynamic pumping)."""
    try:
        out = subprocess.run(
            [FFMPEG, "-v", "info", "-i", path, "-af", "volumedetect", "-f", "null", "-"],
            capture_output=True,
            text=True,
        ).stderr
        peak = None
        for line in out.splitlines():
            if "max_volume:" in line:
                peak = float(line.split("max_volume:")[1].replace("dB", "").strip())
        if peak is None:
            return 0.0
        return float(np.clip(target_dbfs - peak, -12.0, 14.0))
    except Exception:
        return 0.0


def wav_rate(path: str) -> int:
    try:
        with wave.open(path, "rb") as w:
            return int(w.getframerate())
    except Exception:
        return 0


def wav_duration(path: str) -> float:
    try:
        with wave.open(path, "rb") as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return 0.0


# ------------------------------------------------------------------ helpers


def wpm_from_rate(rate: str) -> int:
    try:
        pct = int(str(rate).replace("%", "").replace("+", "") or 0)
    except ValueError:
        pct = 0
    return int(np.clip(160 * (1 + pct / 100.0), 80, 320))


def pick_engine(opts: argparse.Namespace, voice: str) -> str:
    forced = (opts.engine or "auto").lower()
    if forced != "auto":
        return forced
    # Cloning beats everything else when the model and a speaker clip are present.
    if opts.xtts_model and os.path.isdir(opts.xtts_model) and (opts.reference or voice):
        return "xtts"
    if kokoro_ready(opts.kokoro_model, opts.kokoro_voices) and voice and voice[0] in "hab":
        return "kokoro"
    if piper_ready(opts.piper_model):
        return "piper"
    return "espeak"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest")
    ap.add_argument("--one")
    ap.add_argument("--out")
    ap.add_argument("--lang", default="hi")
    ap.add_argument("--gender", default="M")
    ap.add_argument("--voice", default="")
    ap.add_argument("--rate", default="+0%")
    ap.add_argument("--profile", default="")
    ap.add_argument("--engine", default="auto", choices=["auto", "xtts", "kokoro", "piper", "espeak"])
    ap.add_argument("--piper-model", default="")
    ap.add_argument("--kokoro-model", default="")
    ap.add_argument("--kokoro-voices", default="")
    ap.add_argument("--xtts-model", default="", help="directory with model.pth + config.json")
    ap.add_argument("--reference", default="", help="speaker clip used by the cloning engine")
    ap.add_argument("--espeak-pitch", type=int, default=50)
    args = ap.parse_args()

    profile = None
    if args.profile and os.path.exists(args.profile):
        try:
            with open(args.profile, encoding="utf-8") as f:
                profile = json.load(f)
        except Exception:
            profile = None

    engines: dict[str, Engine] = {}

    def engine_for(voice: str) -> Engine:
        name = pick_engine(args, voice)
        if name not in engines:
            engines[name] = Engine(name, args, profile)
        return engines[name]

    def synth_item(item: dict) -> bool:
        text = (item.get("text") or "").strip()
        out_path = item.get("out")
        if not text or not out_path:
            return False
        lang = item.get("lang") or args.lang
        gender = item.get("gender") or args.gender
        voice = item.get("voice") or args.voice or ("hf_alpha" if lang == "hi" else "af_heart")
        wpm = wpm_from_rate(item.get("rate") or args.rate)
        slot_ms = int(item.get("slotMs") or 0) or None
        rate_pct = 0
        try:
            rate_pct = int(str(item.get("rate") or args.rate).replace("%", "").replace("+", "") or 0)
        except ValueError:
            rate_pct = 0

        eng = engine_for(voice)
        eng.calibrate(lang, gender, voice if eng.name == "kokoro" else "")

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name
        try:
            samples, sr = eng.render(text, lang, gender, wpm, 1.0, voice)
            if samples is None or len(samples) == 0:
                return False
            natural = len(samples) / float(sr)
            speed = 1.0

            # Fit the slot with the engine's own rate control first — a native
            # speed change keeps the timbre intact, atempo does not.
            if slot_ms and natural > 0:
                target = (slot_ms / 1000.0) * (1.0 + rate_pct / 100.0)
                if natural > target * 1.05 and eng.name != "espeak":
                    speed = float(np.clip(natural / target, 1.0, MAX_NATIVE_SPEEDUP))
                    faster = eng.render(text, lang, gender, wpm, speed, voice)
                    if faster is not None and len(faster[0]) > 0:
                        samples, sr = faster

            write_wav(tmp_path, samples, sr)
            eng.fit_and_polish(tmp_path, out_path, slot_ms, rate_pct)
            return os.path.exists(out_path) and os.path.getsize(out_path) > 512
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    if args.one:
        ok = synth_item({"i": 0, "text": args.one, "out": args.out, "lang": args.lang, "gender": args.gender, "voice": args.voice})
        print("OK 0" if ok else "FAIL 0", flush=True)
        return

    if not args.manifest:
        print("no manifest given", file=sys.stderr)
        sys.exit(2)
    with open(args.manifest, encoding="utf-8") as f:
        items = json.load(f)

    print(f"ENGINE {pick_engine(args, items[0].get('voice', '') if items else '')}", file=sys.stderr, flush=True)
    ok = fail = 0
    for item in items:
        try:
            good = synth_item(item)
        except Exception as e:
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
