# -*- coding: utf-8 -*-
"""Measured picture and sound adjustments: gentle, per video, recorded, and each one can be switched off.

Nothing here is a fixed look. Every adjustment starts from a MEASUREMENT of this video and is applied
only when the measurement is outside a stated range; a video that measures inside the ranges is left
untouched. The adjustments are computed against the SOURCE picture and sound, so a later version never
corrects an already corrected picture (no double correction).

Picture  exposure (gamma), contrast, white balance (channel gains), saturation — ffmpeg eq + colorchannelmixer.
         Skin guard: the same filter is applied to sampled frames and the measured face area is compared
         before / after; a shift beyond the limits halves the correction, then drops the white balance.
Sound    high-pass against rumble and FFT noise reduction, only when the measured room tone / rumble call
         for it. Speech guard: the level of the spoken words is compared before / after.

What this module cannot judge: whether the picture LOOKS right and whether the voice SOUNDS natural.
Those stay with the owner; the before / after material is produced for exactly that.
"""
import math
from pathlib import Path

from .core import PipelineError, run, tool

KINDS = ("color", "audio_cleanup", "zooms", "caption_animation", "graphics")

# ── Ranges (working values, recorded in every package) ──────────────────────────────────────────────
LIMITS = {
    "face_luma_low": 0.40, "face_luma_high": 0.74, "frame_luma_low": 0.30, "frame_luma_high": 0.68,
    "gamma_min": 0.88, "gamma_max": 1.22,
    "flat_range": 0.60, "contrast_max": 1.10,
    "cast_threshold": 0.05, "cast_correct_share": 0.5, "gain_max": 0.05, "neutral_min_share": 0.03,
    "sat_low": 0.16, "sat_high": 0.55, "sat_up": 1.08, "sat_down": 0.94,
    "skin_hue_shift_deg": 4.0, "skin_sat_change": 0.12, "skin_luma_min": 0.33, "skin_luma_max": 0.82,
    "snr_target_db": 30.0, "nr_min_db": 3.0, "nr_max_db": 6.0, "rumble_share": 0.08, "highpass_hz": 70,
    "speech_change_max_db": 1.5,
}


def enabled(options, kind):
    """An adjustment kind is on unless the owner switched it off for this project."""
    return (options or {}).get("adjustments", {}).get(kind, True) is not False


# ── Picture ─────────────────────────────────────────────────────────────────────────────────────────
def read_frames(cfg, video, times, vf=None, width=320):
    """RGB frames (float 0..1, HxWx3) at the given times, optionally through a filter chain."""
    import numpy as np
    out = []
    for t in times:
        chain = (vf + "," if vf else "") + f"scale={width}:-2,format=rgb24"
        r = run([tool(cfg, "ffmpeg"), "-v", "error", "-ss", f"{max(0.0, t):.3f}", "-i", video, "-frames:v", "1", "-vf", chain,
                 "-f", "rawvideo", "-"], "adjust_measure_failed", timeout=180)
        n = len(r.stdout) // (width * 3)
        if n < 2:
            out.append(None)
            continue
        out.append(np.frombuffer(r.stdout[:n * width * 3], dtype=np.uint8).reshape(n, width, 3).astype(np.float32) / 255.0)
    return out


def _stats(img, box=None):
    """Luma percentiles, saturation, neutral-pixel channel balance and (with a face box) the face area."""
    import numpy as np
    r, g, b = img[:, :, 0], img[:, :, 1], img[:, :, 2]
    luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    mx, mn = img.max(axis=2), img.min(axis=2)
    sat = np.where(mx > 1e-4, (mx - mn) / np.maximum(mx, 1e-4), 0.0)
    neutral = (sat < 0.12) & (luma > 0.30) & (luma < 0.92)
    out = {"p1": float(np.percentile(luma, 1)), "p50": float(np.percentile(luma, 50)), "p99": float(np.percentile(luma, 99)),
           "sat": float(sat.mean()), "neutral_share": float(neutral.mean())}
    if neutral.mean() > 0.005:
        out["neutral_rgb"] = [float(r[neutral].mean()), float(g[neutral].mean()), float(b[neutral].mean())]
    if box:
        h, w = luma.shape
        x0, y0 = int(max(0, box[0] + 0.2 * box[2]) * w), int(max(0, box[1] + 0.25 * box[3]) * h)
        x1, y1 = int(min(1, box[0] + 0.8 * box[2]) * w), int(min(1, box[1] + 0.85 * box[3]) * h)
        if x1 - x0 >= 4 and y1 - y0 >= 4:
            f = img[y0:y1, x0:x1].reshape(-1, 3)
            fr, fg, fb = f[:, 0].mean(), f[:, 1].mean(), f[:, 2].mean()
            fl = 0.2126 * fr + 0.7152 * fg + 0.0722 * fb
            cb, cr = (fb - fl) / 1.8556, (fr - fl) / 1.5748
            out["face"] = {"luma": float(fl), "hue_deg": float(math.degrees(math.atan2(cr, cb))), "sat": float(math.hypot(cb, cr))}
    return out


def measure_picture(frames, boxes=None):
    """Median of the per-frame statistics. `boxes` are face boxes as FRACTIONS of the frame (x, y, w, h) or None."""
    import numpy as np
    rows = [_stats(f, (boxes or [None] * len(frames))[i]) for i, f in enumerate(frames) if f is not None]
    if not rows:
        raise PipelineError("adjust_measure_failed", "no frame could be read for the picture measurement")
    med = lambda k: round(float(np.median([r[k] for r in rows])), 4)
    out = {"frames": len(rows), "luma_p1": med("p1"), "luma_p50": med("p50"), "luma_p99": med("p99"), "saturation": med("sat"),
           "neutral_share": med("neutral_share")}
    neu = [r["neutral_rgb"] for r in rows if "neutral_rgb" in r]
    if neu and out["neutral_share"] >= LIMITS["neutral_min_share"]:
        out["neutral_rgb"] = [round(float(np.median([n[i] for n in neu])), 4) for i in range(3)]
    faces = [r["face"] for r in rows if "face" in r]
    if faces:
        out["face"] = {k: round(float(np.median([f[k] for f in faces])), 4) for k in ("luma", "hue_deg", "sat")}
        out["face_frames"] = len(faces)
    return out


def color_plan(m, strength=1.0):
    """Measurement → parameters. Returns (params, decisions). An empty params dict means: leave the picture alone."""
    L, p, why = LIMITS, {}, []
    face = (m.get("face") or {}).get("luma")
    ref, lo, hi, what = (face, L["face_luma_low"], L["face_luma_high"], "בהירות הפנים") if face is not None else \
        (m["luma_p50"], L["frame_luma_low"], L["frame_luma_high"], "בהירות חציונית של הפריים (לא נמדדו פנים)")
    if ref < lo or ref > hi:
        target = lo + 0.06 if ref < lo else hi - 0.06
        gamma = math.log(max(ref, 1e-3)) / math.log(target)            # out = in ** (1/gamma)
        gamma = 1 + (min(max(gamma, L["gamma_min"]), L["gamma_max"]) - 1) * strength
        if abs(gamma - 1) >= 0.015:
            p["gamma"] = round(gamma, 3)
            why.append(f"חשיפה: {what} נמדדה {ref:.2f} (טווח {lo:.2f}–{hi:.2f}) → gamma {p['gamma']}")
    else:
        why.append(f"חשיפה: {what} {ref:.2f} בתוך הטווח {lo:.2f}–{hi:.2f} — בלי שינוי")
    rng = m["luma_p99"] - m["luma_p1"]
    if rng < L["flat_range"]:
        c = 1 + (min(L["flat_range"] / max(rng, 0.2), L["contrast_max"]) - 1) * strength
        if c - 1 >= 0.015:
            p["contrast"] = round(c, 3)
            why.append(f"קונטרסט: טווח הבהירות {rng:.2f} קטן מ-{L['flat_range']:.2f} → contrast {p['contrast']}")
    else:
        why.append(f"קונטרסט: טווח הבהירות {rng:.2f} — בלי שינוי")
    neu = m.get("neutral_rgb")
    if neu:
        avg = sum(neu) / 3
        cast = [(c - avg) / avg for c in neu]
        if max(abs(c) for c in cast) >= L["cast_threshold"]:
            gains = [1 - min(max(c * L["cast_correct_share"] * strength, -L["gain_max"]), L["gain_max"]) for c in cast]
            p["gains"] = [round(g, 4) for g in gains]
            why.append("איזון לבן: באזורים הניטרליים נמדדה סטייה R/G/B של " + "/".join(f"{c * 100:+.0f}%" for c in cast)
                       + f" → תיקון של חצי מהסטייה, עד {L['gain_max'] * 100:.0f}% לערוץ")
        else:
            why.append("איזון לבן: האזורים הניטרליים מאוזנים (סטייה מתחת ל-5%) — בלי שינוי")
    else:
        why.append("איזון לבן: אין מספיק אזורים ניטרליים למדידה — לא נגעתי (לא מנחשת צבע)")
    s = m["saturation"]
    if s < L["sat_low"] or s > L["sat_high"]:
        k = L["sat_up"] if s < L["sat_low"] else L["sat_down"]
        p["saturation"] = round(1 + (k - 1) * strength, 3)
        why.append(f"רוויה: נמדדה {s:.2f} (טווח {L['sat_low']:.2f}–{L['sat_high']:.2f}) → saturation {p['saturation']}")
    else:
        why.append(f"רוויה: {s:.2f} בתוך הטווח — בלי שינוי")
    return p, why


def color_filter(p):
    """ffmpeg filter chain for the parameters, or None."""
    if not p:
        return None
    parts = []
    if p.get("gains"):
        r, g, b = p["gains"]
        parts.append(f"colorchannelmixer=rr={r}:gg={g}:bb={b}")
    eq = [f"{k}={p[k]}" for k in ("gamma", "contrast", "saturation") if k in p]
    if eq:
        parts.append("eq=" + ":".join(eq))
    return ",".join(parts) or None


def skin_ok(before, after):
    L = LIMITS
    b, a = before.get("face"), after.get("face")
    if not b or not a:
        return True, "לא נמדדו פנים — אין בדיקת גוון עור"
    dh = abs(a["hue_deg"] - b["hue_deg"])
    ds = abs(a["sat"] - b["sat"]) / max(b["sat"], 1e-3)
    ok = dh <= L["skin_hue_shift_deg"] and ds <= L["skin_sat_change"] and L["skin_luma_min"] <= a["luma"] <= L["skin_luma_max"]
    return ok, f"גוון עור: שינוי גוון {dh:.1f}° (מותר {L['skin_hue_shift_deg']}°), שינוי רוויה {ds * 100:.0f}% (מותר {L['skin_sat_change'] * 100:.0f}%), בהירות {a['luma']:.2f}"


def plan_color(cfg, video, times, boxes, pre_vf=None):
    """Measure → plan → skin guard. `pre_vf` is the crop/scale chain the render uses, so the measurement
    is of the picture the viewer gets. Returns the record stored in the package (record['filter'] may be None)."""
    frames = read_frames(cfg, video, times, pre_vf)
    before = measure_picture(frames, boxes)
    rec = {"measured_before": before, "frames_s": [round(t, 2) for t in times], "limits": LIMITS, "attempts": [],
           "basis": "מדידה על פריימים דגומים לאורך הקטע; מה שנראה נכון לעין — בבדיקה שלך בלפני/אחרי"}
    for strength, drop_wb in ((1.0, False), (0.5, False), (0.5, True)):
        params, why = color_plan(before, strength)
        if drop_wb:
            params.pop("gains", None)
            why.append("איזון לבן בוטל כדי לשמור על גוון העור")
        vf = color_filter(params)
        if not vf:
            rec.update(applied=False, params={}, filter=None, decisions=why, measured_after=None,
                       skin_guard="אין שינוי בתמונה" if not rec["attempts"] else rec["attempts"][-1]["skin"])
            return rec
        after = measure_picture(read_frames(cfg, video, times, (pre_vf + "," if pre_vf else "") + vf), boxes)
        ok, note = skin_ok(before, after)
        rec["attempts"].append({"strength": strength, "white_balance": not drop_wb, "params": params, "skin": note, "ok": ok})
        if ok:
            rec.update(applied=True, params=params, filter=vf, decisions=why, measured_after=after, skin_guard=note)
            return rec
    rec.update(applied=False, params={}, filter=None, measured_after=None,
               decisions=["התיקון המוצע שינה את גוון העור מעבר למותר גם בעוצמה מופחתת — התמונה נשארה כמו שהיא"],
               skin_guard=rec["attempts"][-1]["skin"])
    return rec


# ── Sound ───────────────────────────────────────────────────────────────────────────────────────────
def measure_voice(wav, words):
    """Background level, speech level, signal-to-noise and the share of energy below the high-pass frequency.

    The background is measured ONLY between the spoken words (gaps of at least 0.3 s, away from the word
    edges), never as a percentile of the whole track: in dense speech a percentile lands on breaths and
    word tails and reports "noise" that is really the voice. With less than 0.6 s of such gaps the
    background is "not measurable" and no cleaning is planned."""
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(str(wav))
    if x.ndim > 1:
        x = x.mean(axis=1)
    win = int(0.05 * sr)
    db = lambda seg: 20 * math.log10(float(np.sqrt((seg ** 2).mean())) + 1e-9)
    sp = [db(x[int(max(0, w["start"]) * sr):int(w["end"] * sr)]) for w in words if int(w["end"] * sr) - int(max(0, w["start"]) * sr) > 16]
    lv = [db(x[i:i + win]) for i in range(0, max(len(x) - win, 1), win)]
    speech = float(np.median(sp)) if sp else (float(np.percentile(lv, 80)) if lv else -90.0)
    edges = [0.0] + [t for w in words for t in (w["start"], w["end"])] + [len(x) / sr]
    gaps = [(edges[i] + 0.1, edges[i + 1] - 0.1) for i in range(0, len(edges), 2) if edges[i + 1] - edges[i] >= 0.3]
    glv = [db(x[i:i + win]) for g0, g1 in gaps for i in range(int(g0 * sr), int(g1 * sr) - win, win)]
    gap_s = round(sum(g1 - g0 for g0, g1 in gaps), 2)
    measurable = gap_s >= 0.6 and len(glv) >= 8
    floor = float(np.percentile(glv, 30)) if measurable else None
    n = min(len(x), sr * 60)
    spec = np.abs(np.fft.rfft(x[:n])) ** 2
    freqs = np.fft.rfftfreq(n, 1 / sr)
    rumble = float(spec[freqs < LIMITS["highpass_hz"]].sum() / max(spec.sum(), 1e-12))
    return {"room_tone_db": round(floor, 1) if measurable else None, "speech_db": round(speech, 1),
            "snr_db": round(speech - floor, 1) if measurable else None, "rumble_share": round(rumble, 3), "words": len(sp),
            "gap_seconds": gap_s, "how": "רעש הרקע נמדד רק ברווחים שבין המילים (0.3 שניות ומעלה)"}


def audio_plan(m, strength=1.0):
    L, p, why = LIMITS, {}, []
    if m["rumble_share"] >= L["rumble_share"]:
        p["highpass_hz"] = L["highpass_hz"]
        why.append(f"רעש נמוך: {m['rumble_share'] * 100:.0f}% מהאנרגיה מתחת ל-{L['highpass_hz']}Hz → סינון תדרים נמוכים")
    else:
        why.append(f"רעש נמוך: {m['rumble_share'] * 100:.0f}% מהאנרגיה מתחת ל-{L['highpass_hz']}Hz — בלי סינון")
    if m.get("snr_db") is None:
        why.append(f"רעש רקע: הדיבור רצוף ({m.get('gap_seconds', 0)} שניות של רווחים בלבד) — אי אפשר למדוד את הרקע בנפרד מהקול, ולכן בלי ניקוי")
    elif m["snr_db"] < L["snr_target_db"]:
        nr = min(max(L["snr_target_db"] - m["snr_db"], L["nr_min_db"]), L["nr_max_db"]) * strength
        if nr >= 2.0:
            p["noise_reduction_db"] = round(nr, 1)
            p["noise_floor_db"] = round(min(max(m["room_tone_db"], -80.0), -35.0), 1)
            why.append(f"רעש רקע: יחס דיבור/רעש {m['snr_db']:.0f}dB ברווחים שבין המילים (יעד {L['snr_target_db']:.0f}dB) → הפחתת רעש {p['noise_reduction_db']}dB")
    else:
        why.append(f"רעש רקע: יחס דיבור/רעש {m['snr_db']:.0f}dB — בלי ניקוי")
    return p, why


def audio_filter(p):
    parts = []
    if p.get("highpass_hz"):
        parts.append(f"highpass=f={p['highpass_hz']}")
    if p.get("noise_reduction_db"):
        parts.append(f"afftdn=nr={p['noise_reduction_db']}:nf={p['noise_floor_db']}:tn=0")
    return ",".join(parts) or None


def plan_audio(cfg, raw_wav, words, work):
    """Measure → plan → speech guard. Returns (record, cleaned wav path or the raw path)."""
    before = measure_voice(raw_wav, words)
    rec = {"measured_before": before, "limits": {k: LIMITS[k] for k in ("snr_target_db", "nr_min_db", "nr_max_db", "rumble_share", "highpass_hz", "speech_change_max_db")},
           "attempts": [], "basis": "מדידת עוצמות בלבד; אם הקול נשמע טבעי — רק בהאזנה שלך"}
    for strength in (1.0, 0.5):
        params, why = audio_plan(before, strength)
        af = audio_filter(params)
        if not af:
            rec.update(applied=False, params={}, filter=None, decisions=why, measured_after=None, speech_guard="אין שינוי בסאונד")
            return rec, raw_wav
        out = Path(work) / "voice_clean.wav"
        run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-i", raw_wav, "-af", af, "-ar", "48000", "-c:a", "pcm_s24le", out],
            "audio_cleanup_failed", timeout=cfg["timeouts"]["ffmpeg_s"])
        after = measure_voice(out, words)
        change = after["speech_db"] - before["speech_db"]
        ok = abs(change) <= LIMITS["speech_change_max_db"]
        note = (f"עוצמת הדיבור השתנתה ב-{abs(change):.1f}dB (מותר עד {LIMITS['speech_change_max_db']}dB); "
                f"רעש הרקע בין המילים {before['room_tone_db']}dB → {after['room_tone_db']}dB")
        rec["attempts"].append({"strength": strength, "params": params, "speech": note, "ok": ok})
        if ok:
            rec.update(applied=True, params=params, filter=af, decisions=why, measured_after=after, speech_guard=note)
            return rec, out
    rec.update(applied=False, params={}, filter=None, measured_after=None, speech_guard=rec["attempts"][-1]["speech"],
               decisions=["ניקוי הרעש פגע בעוצמת הדיבור מעבר למותר גם בעוצמה מופחתת — הסאונד נשאר כמו שהוא"])
    return rec, raw_wav


# ── Before / after material for the owner ───────────────────────────────────────────────────────────
def compare_frames(cfg, before_video, after_video, times, out, before_offset=0.0):
    """One image: for each time of the finished video, the frame before (left) and after (right).
    `before_offset` is where the before-clip starts on the finished video's timeline."""
    ins, parts = [], []
    for n, t in enumerate(times):
        ins += ["-ss", f"{max(0.0, t - before_offset):.3f}", "-i", before_video, "-ss", f"{t:.3f}", "-i", after_video]
        parts.append(f"[{2 * n}:v]scale=360:640[b{n}];[{2 * n + 1}:v]scale=360:640[a{n}];[b{n}][a{n}]hstack=inputs=2[r{n}]")
    parts.append("".join(f"[r{n}]" for n in range(len(times))) + (f"vstack=inputs={len(times)}[o]" if len(times) > 1 else "null[o]"))
    run([tool(cfg, "ffmpeg"), "-y", "-v", "error", *ins, "-filter_complex", ";".join(parts), "-map", "[o]", "-frames:v", "1", "-q:v", "3", out],
        "compare_failed", timeout=300)
    return out


def compare_clip(cfg, before_video, after_video, t0, dur, out):
    """Side-by-side clip: before (left, a clip that starts at t0 of the finished video) and after (right),
    with the sound of the finished file."""
    run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-t", f"{dur:.3f}", "-i", before_video,
         "-ss", f"{t0:.3f}", "-t", f"{dur:.3f}", "-i", after_video,
         "-filter_complex", "[0:v]scale=540:960,setsar=1[b];[1:v]scale=540:960,setsar=1[a];[b][a]hstack=inputs=2[o]",
         "-map", "[o]", "-map", "1:a?", "-c:v", "libx264", "-crf", "20", "-preset", "fast", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out], "compare_failed", timeout=600)
    return out
