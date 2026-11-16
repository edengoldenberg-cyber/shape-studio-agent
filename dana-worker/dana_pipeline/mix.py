"""The audio mix of a finished cut: the original sound, an uploaded narration and an uploaded music track.

The structure is the locked one (CLAUDE.md, section G):
    1. speech (the original sound and / or the narration) at its own level
    2. music -> volume, start point, fade in / out
    3. music ducked under the speech with a side-chain compressor
    4. speech + music -> loudness normalisation to the target
The picture is copied, never encoded again. Every parameter that was used is returned and stored with the version, and
the result is MEASURED: loudness, true peak, clipped samples, and how far the music really sits under the speech.
Nobody listens here: "how it sounds" is not checked and is said so.
"""
import json
import re
import wave
from pathlib import Path

import numpy as np

from .core import PipelineError, run, tool

SC = {"threshold": 0.05, "ratio": 4.0, "attack": 15, "release": 350}       # side-chain defaults; overridden by cfg["audio"]["sidechain"]
# The level of the music is set AGAINST THE SPEECH, not as a gain on the file: "volume_db" = how far under the speech the
# music sits while somebody speaks. Tracks differ by 20 dB and more in how loud they were mastered, so a fixed gain put
# the music 23-30 dB under the speech (owner, 2026-11-16: "I heard no music in any video").
MUSIC_UNDER_SPEECH = {"default": -14.0, "loudest": -6.0, "quietest": -20.0}
MUSIC_INAUDIBLE_DB = 22.0          # music further than this under the speech is reported as probably not heard
_GAIN = "@@MUSIC_GAIN@@"


def music_under_speech(music):
    """The owner's setting, inside the range in which music is neither covering the speech nor lost under it."""
    v = float((music or {}).get("volume_db", MUSIC_UNDER_SPEECH["default"]))
    return max(MUSIC_UNDER_SPEECH["quietest"], min(MUSIC_UNDER_SPEECH["loudest"], v))


def speech_gaps(speech_spans, dur):
    """-> (spans with speech, gaps between them): where the music is measured under the speech and free of it."""
    spans = [(a, b) for a, b in speech_spans or [] if b - a >= 0.15]
    gaps, t = [], 0.0
    for a, b in sorted(spans):
        if a - t >= 0.6:
            gaps.append((t + 0.2, a - 0.2))
        t = max(t, b)
    if dur - t >= 0.6:
        gaps.append((t + 0.2, dur - 0.2))
    return spans, gaps


def _db(x):
    return float(20 * np.log10(max(float(x), 1e-9)))


def _wav(cfg, src, out, extra=()):
    run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-i", src, *extra, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out], "mix_failed", timeout=600)
    with wave.open(str(out), "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0, 16000


def _rms(x, sr, spans):
    parts = [x[int(a * sr):int(b * sr)] for a, b in spans if b > a]
    parts = [p for p in parts if len(p)]
    if not parts:
        return None
    return _db(np.sqrt(np.mean(np.concatenate(parts) ** 2)))


def beats(music_path, start_s, dur):
    """Beat times of the part of the track that is used (seconds on the video's timeline), or (None, why)."""
    try:
        import librosa
    except Exception as e:                       # the library is optional: no beats, said so, nothing is forced
        return None, f"זיהוי פעימות אינו זמין במחשב העריכה ({type(e).__name__})"
    try:
        y, sr = librosa.load(str(music_path), sr=22050, mono=True, offset=float(start_s), duration=float(dur) + 1.0)
        tempo, frames = librosa.beat.beat_track(y=y, sr=sr)
        times = [round(float(t), 3) for t in librosa.frames_to_time(frames, sr=sr) if t <= dur]
        tempo = float(np.atleast_1d(tempo)[0])
    except Exception as e:
        return None, f"זיהוי הפעימות נכשל ({type(e).__name__})"
    if len(times) < 4:
        return None, "לא נמצאו מספיק פעימות ברצועה"
    return {"tempo_bpm": round(tempo, 1), "beats_s": times, "method": "librosa.beat.beat_track"}, None


def snap(cuts, beat_times, tolerance_s=0.35):
    """Move a cut to the nearest beat ONLY when one is close enough. -> [(time, on_beat)]. Nothing is forced."""
    out = []
    for c in cuts:
        near = min(beat_times, key=lambda b: abs(b - c)) if beat_times else None
        out.append((near, True) if near is not None and abs(near - c) <= tolerance_s else (c, False))
    return out


def mix(cfg, video_in, out, audio, dur, speech_spans, mute_spans=(), work=None):
    """video_in: the finished cut with the ORIGINAL sound. audio: the job's audio options with local paths
    (music.path, narration.path). speech_spans: [(t0, t1)] where speech is present (word times / narration), used only to
    MEASURE. Returns the mix record for the package. Raises PipelineError(mix_failed)."""
    a_cfg = cfg["audio"]
    sc = {**SC, **(a_cfg.get("sidechain") or {})}
    work = Path(work or Path(out).parent)
    work.mkdir(parents=True, exist_ok=True)
    music, nar, orig = audio.get("music"), audio.get("narration"), audio.get("original") or {"mode": "keep", "level_db": 0}
    ff = tool(cfg, "ffmpeg")
    inputs, n = ["-i", str(video_in)], 1
    orig_gain = 0.0 if orig.get("mode") == "mute" else 10 ** (float(orig.get("level_db", 0)) / 20)
    of = f"[0:a]aresample=48000,volume={orig_gain:.4f}"
    for a, b in mute_spans or []:
        of += f",volume=0:enable='between(t,{a:.3f},{b:.3f})'"
    chains, speech_in = [of + "[orig]"], ["[orig]"]
    if nar:
        inputs += ["-i", str(nar["path"])]
        d = int(float(nar.get("start_s", 0)) * 1000)
        chains.append(f"[{n}:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I={a_cfg.get('voice_norm_lufs', -16)}:TP=-2:LRA=11,"
                      f"volume={10 ** (float(nar.get('volume_db', 0)) / 20):.4f},adelay={d}|{d},apad,atrim=0:{dur:.3f}[nar]")
        speech_in.append("[nar]")
        n += 1
    # the speech bus (original sound and / or narration) is also written out, so the music can be MEASURED against it
    chains.append("".join(speech_in) + f"amix=inputs={len(speech_in)}:normalize=0:duration=first,aformat=channel_layouts=stereo,asplit=2[speech][spstem]")
    if music:
        inputs += ["-ss", f"{float(music.get('start_s', 0)):.3f}", "-i", str(music["path"])]
        fo = max(0.0, dur - float(music.get("fade_out_s", 1.5)))
        chains.append(f"[{n}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:{dur:.3f},apad,atrim=0:{dur:.3f},volume={_GAIN},"
                      f"afade=t=in:st=0:d={float(music.get('fade_in_s', 0.5)):.3f},afade=t=out:st={fo:.3f}:d={float(music.get('fade_out_s', 1.5)):.3f}[mus]")
        if music.get("duck", True):
            chains.append("[speech]asplit=2[sp1][sp2]")
            chains.append(f"[mus][sp2]sidechaincompress=threshold={sc['threshold']}:ratio={sc['ratio']}:attack={sc['attack']}:release={sc['release']}[duck]")
            chains.append("[duck]asplit=2[m1][mstem]")
            chains.append("[sp1][m1]amix=inputs=2:normalize=0:duration=first[pre]")
        else:
            chains.append("[mus]asplit=2[m1][mstem]")
            chains.append("[speech][m1]amix=inputs=2:normalize=0:duration=first[pre]")
        n += 1
    else:
        chains.append("[speech]anull[pre]")
    graph = ";".join(chains)
    spans, gaps = speech_gaps(speech_spans, dur)
    stem, sp_stem = work / "mix_music_stem.wav", work / "mix_speech_stem.wav"
    gain_db, level_mode, want = MUSIC_UNDER_SPEECH["default"], "no_music", None
    if music:
        # pass 0: the stems at a trial gain. Where the music really sits under the speech is MEASURED, and the gain is moved by
        # the difference (the ducking depends on the speech, not on the music, so the shift carries over one to one).
        want, level_mode = music_under_speech(music), "no_speech_to_measure_against"
        run([ff, "-y", "-v", "error", *inputs, "-filter_complex", graph.replace(_GAIN, f"{10 ** (gain_db / 20):.5f}"), "-map", "[pre]", "-f", "null", "-",
             "-map", "[spstem]", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t", f"{dur:.3f}", str(sp_stem),
             "-map", "[mstem]", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t", f"{dur:.3f}", str(stem)], "mix_failed", timeout=900)
        m0, sr0 = _wav(cfg, stem, work / "mix_stem0_16k.wav")
        s0 = _rms(_wav(cfg, sp_stem, work / "mix_speech0_16k.wav")[0], sr0, spans) if spans else None
        u0 = _rms(m0, sr0, spans) if spans else None
        if s0 is not None and s0 > -70 and u0 is not None and u0 > -110:
            gain_db = max(-60.0, min(24.0, gain_db + (s0 + want) - u0))
            level_mode = "relative_to_speech"
    graph = graph.replace(_GAIN, f"{10 ** (gain_db / 20):.5f}")
    # pass 1: measure the pre-master, pass 2: normalise to the target with the measured values
    target, peak = a_cfg["target_lufs"], a_cfg["target_peak_db"]
    r = run([ff, "-hide_banner", "-nostats", "-y", *inputs, "-filter_complex", graph + f";[pre]loudnorm=I={target}:TP={peak}:LRA=11:print_format=json[o]",
             "-map", "[o]", "-f", "null", "-", "-map", "[spstem]", "-f", "null", "-"] + (["-map", "[mstem]", "-f", "null", "-"] if music else []), "mix_failed", timeout=900)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", (r.stderr or b"").decode("utf-8", errors="replace"))
    if not m:
        raise PipelineError("mix_failed", "the loudness of the mix could not be measured")
    meas = json.loads(m.group(0))
    norm = (f"[pre]loudnorm=I={target}:TP={peak}:LRA=11:measured_I={meas['input_i']}:measured_TP={meas['input_tp']}:measured_LRA={meas['input_lra']}:"
            f"measured_thresh={meas['input_thresh']}:offset={meas['target_offset']}:linear=true[o]")
    cmd = [ff, "-y", "-v", "error", *inputs, "-filter_complex", graph + ";" + norm, "-map", "0:v", "-map", "[o]", "-c:v", "copy", "-c:a", "aac", "-b:a", cfg["render"]["audio_bitrate"],
           "-ar", "48000", "-movflags", "+faststart", "-t", f"{dur:.3f}", str(out)]
    cmd += ["-map", "[spstem]", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t", f"{dur:.3f}", str(sp_stem)]
    if music:
        cmd += ["-map", "[mstem]", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-t", f"{dur:.3f}", str(stem)]
    run(cmd, "mix_failed", timeout=900)

    # ── measured on what was written ──
    mixed, sr = _wav(cfg, out, work / "mix_out_16k.wav")
    clipped = int(np.sum(np.abs(mixed) >= 0.999))
    rec = {"applied": True, "structure": "דיבור → מוזיקה (עוצמה, נקודת התחלה, כניסה ויציאה) → הנמכה מתחת לדיבור (sidechain) → איחוד → נרמול עוצמה",
           "params": {"target_lufs": target, "target_peak_db": peak,
                      "original": {"mode": orig.get("mode", "keep"), "level_db": orig.get("level_db", 0), "muted_spans_s": [[round(a, 2), round(b, 2)] for a, b in mute_spans or []]},
                      "music": ({k: music.get(k) for k in ("start_s", "volume_db", "fade_in_s", "fade_out_s", "duck")} | {"file": music.get("name"), "under_speech_db_asked": want, "level": level_mode,
                                 "gain_db_applied": round(gain_db, 1), "sidechain": sc if music.get("duck", True) else None}) if music else None,
                      "narration": ({k: nar.get(k) for k in ("start_s", "volume_db")} | {"file": nar.get("name")}) if nar else None},
           "measured": {"pre_master_lufs": float(meas["input_i"]), "pre_master_true_peak_db": float(meas["input_tp"]), "clipped_samples": clipped,
                        "peak_dbfs": round(_db(np.max(np.abs(mixed)) if len(mixed) else 0), 2)},
           "not_checked": "איך המיקס נשמע (איזון, אופי, התאמת המוזיקה לתוכן) — דורש האזנה שלך"}
    if music:
        mus, _ = _wav(cfg, stem, work / "mix_stem_16k.wav")
        under, free = _rms(mus, sr, spans), _rms(mus, sr, gaps)
        sp_level = _rms(_wav(cfg, sp_stem, work / "mix_speech_16k.wav")[0], sr, spans) if spans else None
        if sp_level is not None and sp_level < -70:          # the "speech" spans are silent (original sound muted and no narration there)
            sp_level = None
        rec["measured"].update(music_under_speech_db=None if under is None else round(under, 1), music_between_speech_db=None if free is None else round(free, 1),
                               ducking_db=None if under is None or free is None else round(free - under, 1),
                               speech_over_music_db=None if under is None or sp_level is None else round(sp_level - under, 1),
                               speech_seconds=round(sum(b - a for a, b in spans), 1),
                               music_level_db=round(_db(np.sqrt(np.mean(mus ** 2))) if len(mus) else -120.0, 1),
                               music_first_second_db=round(_db(np.sqrt(np.mean(mus[:sr] ** 2))) if len(mus) >= sr else -120.0, 1))
    return rec


def checks(cfg, rec, loudness_record):
    """Check records for the package: the mix against its targets. A measurement that could not be made is said, not passed."""
    from .checks import rec as R
    m, out = rec["measured"], []
    out.append(R("mix_clipping", "fail" if m["clipped_samples"] > 20 else "pass",
                 f"{m['clipped_samples']} דגימות בשיא מלא (עיוות אפשרי)" if m["clipped_samples"] > 20 else f"אין עיוות מקטימה (שיא {m['peak_dbfs']} dBFS, {m['clipped_samples']} דגימות בשיא מלא)"))
    if rec["params"]["music"]:
        s = m.get("speech_over_music_db")
        if s is None:
            out.append(R("mix_speech_over_music", "info", "אין דיבור למדוד מולו את המוזיקה (אין דיבור בסרטון, או שהסאונד המקורי מושתק)"))
        else:
            out.append(R("mix_speech_over_music", "pass" if s >= 10 else "review",
                         f"בזמן דיבור המוזיקה נמוכה מהדיבור ב-{s} dB" + ("" if s >= 10 else " — פחות מ-10 dB: המוזיקה עלולה להפריע להבנת הדיבור; להאזנה שלך")
                         + (f" · ההנמכה שנמדדה: {m['ducking_db']} dB" if m.get("ducking_db") is not None else "")))
    if rec["params"]["music"]:
        s, lvl = m.get("speech_over_music_db"), m.get("music_level_db")
        if lvl is not None and lvl < -60:
            out.append(R("mix_music_audible", "fail", f"הרצועה שנבחרה כמעט שקטה בקובץ הסופי ({lvl} dB) — המוזיקה לא נשמעת. לבדוק את הרצועה ואת נקודת ההתחלה שלה"))
        elif s is not None and s > MUSIC_INAUDIBLE_DB:
            out.append(R("mix_music_audible", "fail", f"המוזיקה נמוכה מהדיבור ב-{s} dB — כנראה לא נשמעת (מעל {MUSIC_INAUDIBLE_DB:.0f} dB היא נבלעת)"))
        elif s is not None:
            out.append(R("mix_music_audible", "pass", f"המוזיקה בקובץ הסופי, {s} dB מתחת לדיבור (התבקש {abs(rec['params']['music'].get('under_speech_db_asked') or 0):.0f}); בין משפטים עוצמתה {m.get('music_between_speech_db')} dB"))
        else:
            out.append(R("mix_music_audible", "pass", f"המוזיקה בקובץ הסופי ({lvl} dB לפני הנרמול); אין דיבור למדוד מולו"))
    out.append(R("mix_listen", "human_required", "איך המיקס נשמע — איזון, אופי והתאמה לתוכן — לא נבדק. דורש האזנה שלך"))
    return out
