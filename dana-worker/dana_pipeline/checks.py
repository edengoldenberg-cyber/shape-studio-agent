# -*- coding: utf-8 -*-
"""Automated checks. Every check returns a structured record:

    {"id", "status": "pass" | "fail" | "warn" | "human_required", "summary", "data"}

A "fail" is a fail. It is never turned into a pass by an explanation; only a re-edit
that passes, or an explicit owner exception recorded on the server, resolves it.
The thresholds and the matching rules of the sync check are the locked ones from
verify_against_audio.py (drift 120 ms, tail >= 0, NOT_FOUND = fail, energy gate).
"""
import json
import os
import re
import wave
from pathlib import Path

from .core import PipelineError, probe, run, sha256_file, tool
from .judgement import canon, strip

BIDI = re.compile(r"[‎‏‪-‮⁦-⁩]")
PUNCT_RE = re.compile(r'[.,?!;:…"\'׳]')
DURATION_EXEMPT = frozenset([
    "לי", "לא", "רק", "כן", "גם", "כי", "אם", "אך", "מה", "יש", "אין", "עם", "כל", "של", "על", "אל",
    "מן", "את", "בה", "בו", "לו", "לה", "בי", "בן", "כך", "שם", "אז", "עוד", "כבר", "אף", "אבל", "בין", "תוך",
])


def rec(cid, status, summary, **data):
    return {"id": cid, "status": status, "summary": summary, "data": data}


def clean(t):
    return BIDI.sub("", t).strip(".,?!;:…\"' ")


def norm_word(w):
    return PUNCT_RE.sub("", BIDI.sub("", w)).strip()


# ── ASR (large-v3 on the GPU — the only model allowed) ──────────────────────
_MODEL = {}


def transcribe(cfg, path, vad=False):
    a = cfg["asr"]
    for d in (cfg.get("paths") or {}).get("cuda_dll_dirs") or []:
        if d not in os.environ["PATH"]:
            os.environ["PATH"] = d + os.pathsep + os.environ["PATH"]
    try:
        from faster_whisper import WhisperModel
        key = (a["model"], a["device"], a["compute_type"])
        if key not in _MODEL:
            _MODEL[key] = WhisperModel(a["model"], device=a["device"], compute_type=a["compute_type"])
        kw = dict(language=a["language"], word_timestamps=True, beam_size=5)
        if vad:
            kw.update(vad_filter=True, vad_parameters={"min_silence_duration_ms": 500})
        segs, info = _MODEL[key].transcribe(str(path), **kw)
        words = []
        for s in segs:
            for w in (s.words or []):
                txt = w.word.strip()
                if clean(txt):
                    words.append({"word": txt, "start": round(w.start, 3), "end": round(w.end, 3),
                                  "probability": round(getattr(w, "probability", 1.0), 3)})
        return {"words": words, "duration": info.duration, "model": a["model"], "device": a["device"]}
    except PipelineError:
        raise
    except Exception as e:      # missing DLL, out of memory, driver problem
        raise PipelineError("asr_failed", f"transcription failed: {type(e).__name__}: {str(e)[:300]}", True)


# ── Sync against the audio of the OUTPUT file ───────────────────────────────
def _find_first(ws, target_word, card_t, card_dur, wide=False):
    pre, post = (3.0, 3.0) if wide else (0.15, 0.30)
    target, cands = norm_word(target_word), []
    for w in ws:
        if not (card_t - pre <= w["start"] <= card_t + card_dur + post):
            continue
        wn = norm_word(w["word"])
        score = 3 if wn == target else 2 if wn and target and (wn.startswith(target) or target.startswith(wn)) \
            else 1 if wn and target and (target in wn or wn in target) else 0
        if score:
            cands.append((-score, abs(w["start"] - card_t), w["start"]))
    return min(cands)[2] if cands else None


def _find_last_end(ws, target_word, card_t, card_dur):
    target, card_end, cands = norm_word(target_word), card_t + card_dur, []
    for w in ws:
        if not (card_t - 0.15 <= w["start"] <= card_end + 0.60):
            continue
        wn = norm_word(w["word"])
        score = 3 if wn == target else 2 if wn and target and (wn.startswith(target) or target.startswith(wn)) \
            else 1 if wn and target and (target in wn or wn in target) else 0
        if score:
            after_card = 1 if w["start"] >= card_end - 0.010 else 0     # belongs to the next card
            cands.append((-score, after_card, abs(w["start"] - card_end), w["end"]))
    return min(cands)[3] if cands else None


def _rms_db(samples, sr, t0, t1):
    import numpy as np
    seg = samples[max(0, int(t0 * sr)):min(len(samples), int(t1 * sr))].astype(np.float64)
    if len(seg) == 0:
        return None
    rms = float(np.sqrt(np.mean(seg ** 2)))
    return 20 * np.log10(rms / 32768.0) if rms > 0 else -100.0


def verify_sync(cfg, cards, heard, wav16k, groups=None):
    """Structured result for lead drift, tail, NOT_FOUND and the energy gate (locked rules).
    Words are compared in canonical form: which homophone spelling a caption shows is a
    TEXT question (see text_check) and must not show up as a timing failure."""
    import numpy as np
    s = cfg["sync"]
    ws = [dict(w, word=canon(w["word"], groups)) for w in heard if clean(w["word"])]
    shown = {c["i"]: c["plain"] for c in cards}
    cards = [dict(c, plain=" ".join(canon(t, groups) or t for t in c["plain"].split())) for c in cards]
    WARN, FAIL, SUSP, FB = s["drift_warn_s"], s["drift_fail_s"], 0.500, 0.300
    rows = []
    for c in cards:
        t, dur = c["start"], c["dur"]
        end = round(t + dur, 3)
        pw = c["plain"].split()
        exp_first, exp_last = clean(pw[0]), clean(pw[-1])
        heard_str = " ".join(w["word"] for w in ws if t - 0.05 <= w["start"] < end + 0.05) or "—"
        wt, fallback = _find_first(ws, exp_first, t, dur), False
        if wt is None or abs(wt - t) > SUSP:
            for fbw in pw[1:3]:
                fb = _find_first(ws, fbw, t, dur)
                if fb is not None and abs(fb - t) <= FB:
                    wt, fallback, exp_first = fb, True, fbw + " (fallback)"
                    break
        if wt is None:
            wt = _find_first(ws, pw[0], t, dur, wide=True)
            if wt is not None and abs(wt - t) > SUSP:
                wt = None
        if wt is None:
            status, drift_ms = "not_found", None
        else:
            drift = round(wt - t, 3)
            drift_ms = int(round(drift * 1000))
            ef, ew = (FB, FB * 0.67) if fallback else (FAIL, WARN)
            status = "fail" if abs(drift) >= ef else "warn" if abs(drift) >= ew else "ok"
        le = _find_last_end(ws, exp_last, t, dur)
        tail_ms = int(round((end - le) * 1000)) if le is not None else None
        rows.append({"i": c["i"], "plain": shown[c["i"]], "card_t": t, "card_end": end, "whisper_t": wt,
                     "drift_ms": drift_ms, "lead_ms": (-drift_ms if drift_ms is not None else None),
                     "status": status, "whisper_last_end": le, "tail_ms": tail_ms,
                     "tail_status": "unknown" if tail_ms is None else "fail" if tail_ms < 0 else "ok",
                     "expected_first": exp_first, "heard": heard_str})

    # energy gate — every caption word
    with wave.open(str(wav16k), "r") as wf:
        sr, nch = wf.getframerate(), wf.getnchannels()
        samples = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)
    if nch == 2:
        samples = samples[::2]
    suspicious = []
    for c in cards:
        pw, n = c["plain"].split(), len(c["plain"].split())
        for idx, word in enumerate(pw):
            w0, w1 = c["start"] + c["dur"] * idx / n, c["start"] + c["dur"] * (idx + 1) / n
            pn = norm_word(word)
            m = next((w for w in ws if norm_word(w["word"]) == pn and w0 - 0.3 <= w["start"] <= w1 + 0.3), None)
            a0, a1, prob = (m["start"], m["end"], m.get("probability", 1.0)) if m else (w0, w1, 1.0)
            reasons = []
            if prob < s["prob_threshold"]:
                reasons.append(f"prob={prob:.3f}<{s['prob_threshold']}")
            d = a1 - a0
            if d < s["min_word_dur_s"] and pn not in DURATION_EXEMPT:
                reasons.append(f"short {d * 1000:.0f}ms<{s['min_word_dur_s'] * 1000:.0f}ms")
            else:
                db = _rms_db(samples, sr, a0, a1)
                if db is None or db < s["rms_floor_db"]:
                    reasons.append(f"quiet {db if db is None else round(db, 1)}dB<{s['rms_floor_db']}dB")
            if reasons:
                suspicious.append({"card": c["i"], "word": word, "prob": prob, "start": a0, "end": a1, "reasons": reasons})

    def stats(vals):
        vals = [v for v in vals if v is not None]
        return {"avg": round(sum(vals) / len(vals)), "min": min(vals), "max": max(vals)} if vals else None

    return {
        "cards": rows, "suspicious_words": suspicious,
        "lead_fail": [r["i"] for r in rows if r["status"] == "fail"],
        "lead_warn": [r["i"] for r in rows if r["status"] == "warn"],
        "not_found": [r["i"] for r in rows if r["status"] == "not_found"],
        "tail_fail": [r["i"] for r in rows if r["tail_status"] == "fail"],
        "tail_unknown": [r["i"] for r in rows if r["tail_status"] == "unknown"],
        "lead_ms": stats([r["lead_ms"] for r in rows]), "tail_ms": stats([r["tail_ms"] for r in rows]),
        "thresholds": {"drift_fail_ms": int(FAIL * 1000), "drift_warn_ms": int(WARN * 1000), "tail_min_ms": 0},
    }


def sync_records(v):
    """Split the structured sync result into gate records. The gate reads FIELDS,
    never printed text (the old gate matched the substring 'FAIL: 0')."""
    def cards(ids):
        return ", ".join(f"#{i}" for i in ids)
    out = []
    lead = v["lead_ms"] or {}
    out.append(rec("sync_lead", "fail" if v["lead_fail"] else "warn" if v["lead_warn"] else "pass",
                   (f"drift מעל 120ms בכרטיסים {cards(v['lead_fail'])}" if v["lead_fail"] else
                    f"אזהרת drift בכרטיסים {cards(v['lead_warn'])}" if v["lead_warn"] else "כל הכרטיסים בתוך 120ms")
                   + (f" · lead avg {lead.get('avg')}ms min {lead.get('min')}ms max {lead.get('max')}ms" if lead else ""),
                   cards=v["lead_fail"], warn=v["lead_warn"], stats=lead))
    out.append(rec("sync_not_found", "fail" if v["not_found"] else "pass",
                   f"מילה ראשונה לא נמצאה באודיו בכרטיסים {cards(v['not_found'])}" if v["not_found"]
                   else "כל הכרטיסים נמצאו באודיו", cards=v["not_found"]))
    tail = v["tail_ms"] or {}
    out.append(rec("sync_tail", "fail" if v["tail_fail"] else "warn" if v["tail_unknown"] else "pass",
                   (f"כרטיסים שנעלמים לפני סוף המילה: {cards(v['tail_fail'])}" if v["tail_fail"] else
                    f"tail לא נמדד בכרטיסים {cards(v['tail_unknown'])}" if v["tail_unknown"] else "tail ≥ 0 בכל הכרטיסים")
                   + (f" · tail avg {tail.get('avg')}ms min {tail.get('min')}ms max {tail.get('max')}ms" if tail else ""),
                   cards=v["tail_fail"], unknown=v["tail_unknown"], stats=tail))
    sw = v["suspicious_words"]
    out.append(rec("energy_gate", "fail" if sw else "pass",
                   ("מילים חשודות (ייתכן שלא נאמרו): " + ", ".join(f"#{w['card']} '{w['word']}' [{'; '.join(w['reasons'])}]" for w in sw))
                   if sw else "אין מילים חשודות", words=sw))
    return out


# ── Card geometry ───────────────────────────────────────────────────────────
def _ink_box(png):
    import numpy as np
    from PIL import Image
    im = Image.open(png).convert("RGBA")
    ys, xs = np.where(np.array(im)[:, :, 3] > 8)
    return im.size, (None if len(xs) == 0 else (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())))


def check_width(png_dir, cards, frame_w):
    fails, warns, rows = [], [], []
    for c in cards:
        _, box = _ink_box(Path(png_dir) / f"c{c['i']:03d}.png")
        if box is None:
            fails.append(c["i"]); rows.append({"i": c["i"], "empty": True}); continue
        margin = min(box[0], frame_w - 1 - box[2])
        rows.append({"i": c["i"], "left": box[0], "right": frame_w - 1 - box[2], "width": box[2] - box[0]})
        if margin < 10:
            fails.append(c["i"])
        elif margin < 30:
            warns.append(c["i"])
    return rec("caption_width", "fail" if fails else "warn" if warns else "pass",
               f"כרטיסים שנחתכים בקצה הפריים: {fails}" if fails else
               f"כרטיסים קרובים לקצה: {warns}" if warns else f"כל {len(cards)} הכרטיסים בתוך הפריים",
               cards=fails, warn=warns, rows=rows)


def check_safe_zone(cfg, png_dir, cards):
    zone = json.loads(Path(cfg["paths"]["safe_zone"]).read_text(encoding="utf-8"))
    bad, rows = [], []
    for c in cards:
        size, box = _ink_box(Path(png_dir) / f"c{c['i']:03d}.png")
        problems = []
        if (size[0], size[1]) != (zone["frame"]["width"], zone["frame"]["height"]):
            problems.append(f"card is {size[0]}x{size[1]}")
        elif box is None:
            problems.append("empty card")
        else:
            x0, y0, x1, y1 = box
            if y0 < zone["top"]: problems.append(f"top y={y0}<{zone['top']}")
            if y1 > zone["bottom"]: problems.append(f"bottom y={y1}>{zone['bottom']}")
            if x0 < zone["left"]: problems.append(f"left x={x0}<{zone['left']}")
            lim = size[0] - zone["right_clear"]
            if x1 > lim and y1 >= zone.get("right_clear_from_y", 0): problems.append(f"right x={x1}>{lim}")
        rows.append({"i": c["i"], "ink_box": box, "problems": problems})
        if problems:
            bad.append(c["i"])
    return rec("safe_zone", "fail" if bad else "pass",
               (f"כרטיסים מחוץ לאזור הבטוח: {bad}" if bad else f"{len(cards)}/{len(cards)} כרטיסים בתוך האזור הבטוח")
               + " (האזור הוא הגדרת עבודה — לא נמדד מול אפליקציית אינסטגרם)",
               cards=bad, rows=rows, zone={k: v for k, v in zone.items() if not k.startswith("_")})


# ── What is actually on screen, measured from the rendered pixels ───────────
def cards_in_motion(cfg, final, base, png_dir, cards, fps):
    import numpy as np
    from PIL import Image
    boxes = [b for b in (_ink_box(Path(png_dir) / f"c{c['i']:03d}.png")[1] for c in cards) if b]
    if not boxes:
        return rec("cards_in_motion", "fail", "אין כרטיסים לבדיקה")
    W, H = cfg["style"]["width"], cfg["style"]["height"]
    x0, y0 = max(0, min(b[0] for b in boxes) - 8), max(0, min(b[1] for b in boxes) - 8)
    x0, y0 = x0 // 2 * 2, y0 // 2 * 2          # ffmpeg crops 4:2:0 video at even offsets; an odd offset here shifted the card layer by one pixel
    x1, y1 = min(W, max(b[2] for b in boxes) + 8), min(H, max(b[3] for b in boxes) + 8)
    w, h = (x1 - x0) // 2 * 2, (y1 - y0) // 2 * 2

    def band(path):
        r = run([tool(cfg, "ffmpeg"), "-v", "error", "-i", path, "-vf", f"crop={w}:{h}:{x0}:{y0},format=gray",
                 "-f", "rawvideo", "-"], "check_decode_failed", timeout=cfg["timeouts"]["ffmpeg_s"])
        return np.frombuffer(r.stdout, dtype=np.uint8).reshape(-1, h, w)

    fin, bas = band(final), band(base)
    n = min(len(fin), len(bas))
    layers = {}
    for c in cards:
        im = np.array(Image.open(Path(png_dir) / f"c{c['i']:03d}.png").convert("RGBA"))[y0:y0 + h, x0:x0 + w].astype(float)
        luma = 0.299 * im[:, :, 0] + 0.587 * im[:, :, 1] + 0.114 * im[:, :, 2]   # ffmpeg converts the RGB card with BT.601
        layers[c["i"]] = (im[:, :, 3] / 255.0, luma)   # ffmpeg's gray output is full range, like the PNG
    shown, blank, double, unknown = {c["i"]: [] for c in cards}, 0, [], []
    when = {c["i"]: (c["start"], c["start"] + c["dur"]) for c in cards}
    for f in range(n):
        a, b = fin[f].astype(float), bas[f].astype(float)
        errs = {i: np.abs(a - (b * (1 - al) + gr * al)).mean() for i, (al, gr) in layers.items()}
        best = min(errs, key=errs.get)
        none_err = np.abs(a - b).mean()
        if none_err <= errs[best]:
            blank += 1
            continue
        twins = [i for i in errs if abs(errs[i] - errs[best]) < 1e-6]
        if len(twins) > 1:                        # the same words on two cards: pick the one scheduled now
            t = f / fps
            best = min(twins, key=lambda i: 0.0 if when[i][0] - 0.04 <= t < when[i][1] + 0.04 else min(abs(t - when[i][0]), abs(t - when[i][1])))
        if errs[best] > max(6.0, 0.35 * none_err):
            near = sorted(errs, key=errs.get)[:4]
            pair = min(((i, j, np.abs(a - ((b * (1 - layers[i][0]) + layers[i][1] * layers[i][0])
                                           * (1 - layers[j][0]) + layers[j][1] * layers[j][0])).mean())
                        for i in near for j in near if i != j), key=lambda t: t[2], default=None)
            (double if pair and pair[2] < errs[best] * 0.6 else unknown).append(f)
            continue
        shown[best].append(f)
    c_cfg, fails, warns, rows = cfg["cards"], [], [], []
    for c in cards:
        fr = shown[c["i"]]
        if not fr:
            fails.append(f"כרטיס {c['i']} '{c['plain']}' לא מופיע בסרטון"); continue
        if fr != list(range(fr[0], fr[-1] + 1)):
            fails.append(f"כרטיס {c['i']} לא רציף על המסך")
        t0, t1 = fr[0] / fps, (fr[-1] + 1) / fps
        secs = t1 - t0
        lead, tail = t0 - c["first_word_audio_s"], t1 - c["last_word_end_audio_s"]
        cps = len(c["plain"].replace(" ", "")) / secs
        rows.append({"i": c["i"], "t0": round(t0, 3), "t1": round(t1, 3), "seconds": round(secs, 3),
                     "lead_ms": round(lead * 1000), "tail_ms": round(tail * 1000), "chars_per_s": round(cps, 1)})
        if lead > 0.12: fails.append(f"כרטיס {c['i']} מופיע {lead * 1000:.0f}ms אחרי המילה הראשונה")
        if tail < 0: fails.append(f"כרטיס {c['i']} נעלם {-tail * 1000:.0f}ms לפני סוף המילה האחרונה")
        if secs < c_cfg["min_on_screen_s"]: warns.append(f"כרטיס {c['i']} '{c['plain']}' על המסך {secs:.2f}s")
        if cps > c_cfg["max_chars_per_s"]: warns.append(f"כרטיס {c['i']} '{c['plain']}' נקרא ב-{cps:.0f} תווים/ש")
    for f in double: fails.append(f"פריים {f} ({f / fps:.2f}s) מציג שני כרטיסים")
    for f in unknown: fails.append(f"פריים {f} ({f / fps:.2f}s) — כתובית שאינה תואמת אף כרטיס")
    motion = rec("cards_in_motion", "fail" if fails else "pass",
                 "; ".join(fails[:6]) if fails else f"{len(cards)} כרטיסים, כל אחד רציף, אין פריים עם שני כרטיסים ({n} פריימים נבדקו)",
                 flags=fails, frames=n, blank=blank, rows=rows, band=[x0, y0, x0 + w, y0 + h])
    comfort = rec("reading_comfort", "warn" if warns else "pass",
                  "; ".join(warns[:6]) if warns else "משך וקצב קריאה בתוך כללי האצבע (0.5s, 17 תווים/ש)",
                  flags=warns, note="כללי אצבע, לא תקן — נוחות קריאה היא שיפוט אנושי")
    return motion, comfort


# ── Output file, loudness, source integrity ─────────────────────────────────
def check_output(cfg, final, expect_dur):
    p, st = probe(cfg, final), cfg["style"]
    bad = []
    if p["codec"] != "h264": bad.append(f"codec={p['codec']}")
    if p["pix_fmt"] != "yuv420p": bad.append(f"pix_fmt={p['pix_fmt']}")
    if (p["display_width"], p["display_height"]) != (st["width"], st["height"]):
        bad.append(f"size={p['display_width']}x{p['display_height']}")
    if abs(p["fps"] - st["fps"]) > 0.01: bad.append(f"fps={p['fps']:.2f}")
    if abs(p["duration"] - expect_dur) > 0.2: bad.append(f"duration={p['duration']:.2f}s (expected {expect_dur:.2f}s)")
    if not p["has_audio"] or p["audio_codec"] != "aac": bad.append(f"audio={p['audio_codec']}")
    return rec("output_file", "fail" if bad else "pass",
               "QA FAIL: " + ", ".join(bad) if bad else
               f"h264 yuv420p {p['display_width']}x{p['display_height']} {p['fps']:.0f}fps {p['duration']:.2f}s "
               f"{p['bit_rate'] / 1e6:.1f}Mb/s", probe=p, problems=bad)


def measure_loudness(cfg, path):
    r = run([tool(cfg, "ffmpeg"), "-hide_banner", "-nostats", "-i", path, "-vn", "-af",
             "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], "loudness_measure_failed", timeout=600)
    txt = r.stderr.decode("utf-8", errors="replace")
    try:
        return json.loads(txt[txt.rindex("{"):txt.rindex("}") + 1])
    except ValueError:
        raise PipelineError("loudness_measure_failed", "ffmpeg printed no loudness measurement", True)


def check_loudness(cfg, final):
    m, a = measure_loudness(cfg, final), cfg["audio"]
    lufs, tp = float(m["input_i"]), float(m["input_tp"])
    bad = []
    if abs(lufs - a["target_lufs"]) > a["lufs_tolerance"]: bad.append(f"{lufs} LUFS (target {a['target_lufs']}±{a['lufs_tolerance']})")
    if tp > a["target_peak_db"] + 1.0: bad.append(f"true peak {tp} dBTP")
    return rec("loudness", "fail" if bad else "pass",
               ("מחוץ ליעד: " + ", ".join(bad)) if bad else f"{lufs} LUFS, true peak {tp} dBTP, LRA {m['input_lra']}",
               integrated_lufs=lufs, true_peak_db=tp, lra=float(m["input_lra"]),
               note="מדידת עוצמה בלבד — לא מוכיחה איכות אודיו; נדרשת האזנה")


def check_source_unchanged(source, sha_before):
    after = sha256_file(source)
    return rec("source_unchanged", "pass" if after == sha_before else "fail",
               "קובץ המקור זהה לפני ואחרי (SHA-256)" if after == sha_before else "קובץ המקור השתנה במהלך העריכה!",
               before=sha_before, after=after)


def check_boundary(words, in_s, out_s, in_level_db=None, floor_db=None, out_level_db=None):
    """out_s inside a word = fail (locked rule). in_s inside a word's stamp is decided by the
    measured audio level at the cut: speech at the cut = fail, silence = pass."""
    names = lambda ws: ", ".join(f"'{w['word']}' {w['start']}-{w['end']}" for w in ws)
    cut_out = [w for w in words if w["start"] < out_s < w["end"]]
    # A word after a pause carries the pause inside its stamp. When the segment ends inside such a stamp
    # AND the audio at the cut is measured at room-tone level, the cut is in the pause before the word,
    # not in the word. Without that measurement, or for a normally stamped word, the locked rule applies.
    in_pause = [w for w in cut_out if w["end"] - w["start"] > max(0.60, 0.20 * len(strip(w["word"])))
                and out_level_db is not None and floor_db is not None and out_level_db <= floor_db + 12.0]
    cut_out = [w for w in cut_out if w not in in_pause]
    in_stamp = [w for w in words if w["start"] < in_s < w["end"]]
    # Adaptive: the cut is quiet when it is within 12 dB of this recording's own room tone
    # (a fixed threshold mistakes room tone for speech).
    limit = (floor_db + 12.0) if floor_db is not None else -38.0
    loud = in_level_db is not None and in_level_db > limit
    if cut_out or (in_stamp and (loud or in_level_db is None)):
        msg = []
        if cut_out: msg.append("סוף הקליפ חותך מילה: " + names(cut_out))
        if in_stamp and (loud or in_level_db is None):
            msg.append(f"תחילת הקליפ בתוך מילה ({names(in_stamp)}), עוצמה בנקודת החיתוך {in_level_db} dB, רעש חדר {floor_db} dB")
        return rec("clip_boundary", "fail", "; ".join(msg), cut_out=cut_out, in_stamp=in_stamp, in_level_db=in_level_db)
    note = (f" (תחילת הקליפ בתוך חותמת Whisper של {names(in_stamp)}, אך נמדד שקט בנקודת החיתוך: {in_level_db} dB, רעש חדר {floor_db} dB)"
            if in_stamp else "")
    if in_pause:
        note += (f" (סוף הקליפ בתוך חותמת של {names(in_pause)} שכוללת הפסקה; נמדד שקט בנקודת החיתוך: {out_level_db} dB, "
                 f"רעש חדר {floor_db} dB — המילה עצמה אינה בקליפ)")
    return rec("clip_boundary", "pass", "גבולות הקליפ לא חותכים מילה" + note, in_stamp=in_stamp, in_level_db=in_level_db,
               in_s=in_s, out_s=out_s)


def room_tone_db(wav):
    """10th percentile of 50 ms RMS windows: this recording's own quiet level, dBFS."""
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(str(wav))
    if x.ndim > 1:
        x = x.mean(axis=1)
    win = int(0.05 * sr)
    lv = [20 * np.log10(np.sqrt((x[i:i + win] ** 2).mean()) + 1e-9) for i in range(0, len(x) - win, win)]
    return round(float(np.percentile(lv, 10)), 1) if lv else None


def level_db(wav, t0, t1):
    """RMS level of [t0, t1] in a wav file, dBFS."""
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(str(wav))
    if x.ndim > 1:
        x = x.mean(axis=1)
    seg = x[int(t0 * sr):int(t1 * sr)]
    return round(float(20 * np.log10(np.sqrt((seg ** 2).mean()) + 1e-9)), 1) if len(seg) else None


# ── Text: which spelling is shown (separate from timing and from acoustic confidence) ──
def text_check(diffs):
    """Differences between the captions and a fresh transcription of the FINAL audio
    (captions.align_cards). The captions are the exact words of the source transcript; a
    difference is either a homophone spelling choice or the transcriber writing the same
    speech another way. Both need a reader/listener — neither is a timing matter."""
    items = [dict(d) for d in diffs]
    hom = [i for i in items if i["kind"] == "homophone"]
    other = [i for i in items if i["kind"] != "homophone"]
    parts = []
    if hom:
        parts.append("בחירת איות בין מילים שנשמעות זהה: " + ", ".join(f"#{i['card']} מוצג '{i['shown']}' (התמלול כתב '{i['heard']}')" for i in hom))
    if other:
        parts.append("התמלול של הקובץ הסופי שונה מהכתובית: " + ", ".join(f"#{i['card']} מוצג '{i['shown'] or '—'}' / נשמע '{i['heard'] or '—'}'" for i in other))
    return rec("caption_text", "review" if items else "pass",
               " · ".join(parts) if items else "כל מילות הכתוביות זהות לתמלול האודיו הסופי", items=items)


# ── Alignment to the final spoken words, and adjudication of the locked sync result ──
def alignment_check(cfg, cards, spans, align):
    """Card start against the reference onset of its first word (Whisper interval + VAD +
    envelope), with the uncertainty of that reference. This is a separate measurement:
    it never replaces or edits the locked sync records."""
    a = cfg["alignment"]
    rows, late, early_end, uncertain = [], [], [], []
    for c, sp in zip(cards, spans):
        ref = align.onset(sp[0])
        lead_ms = round((c["start"] - ref["t"]) * 1000)
        tail_ms = round((c["start"] + c["dur"] - sp[-1]["end"]) * 1000)
        rows.append({"i": c["i"], "card_t": c["start"], "ref_onset": ref["t"], "uncertainty_ms": round(ref["uncertainty_s"] * 1000),
                     "method": ref["method"], "lead_ms": lead_ms, "tail_ms": tail_ms, "evidence": ref["evidence"]})
        if abs(lead_ms) >= a["lead_fail_ms"]:
            late.append(c["i"])
        if tail_ms < -1:
            early_end.append(c["i"])
        if ref["uncertainty_s"] * 1000 > a["agree_ms"]:
            uncertain.append(c["i"])
    bad = sorted(set(late + early_end))
    n_vad = sum(1 for r in rows if r["method"].startswith("vad"))
    return rec("alignment_reference", "fail" if bad else "warn" if uncertain else "pass",
               (f"כרטיסים שאינם מיושרים למילה הנאמרת: {bad}" if bad else
                f"יישור תקין, אך אי-ודאות גבוהה (מעל {a['agree_ms']}ms) בכרטיסים {uncertain}" if uncertain else
                f"כל {len(rows)} הכרטיסים מיושרים לתחילת המילה הנאמרת (בתוך {a['lead_fail_ms']}ms)")
               + f" · {n_vad} כרטיסים אחרי הפסקה נמדדו ב-VAD ובמעטפת העוצמה",
               cards=bad, uncertain=uncertain, rows=rows,
               method="Whisper word interval + Silero VAD speech onset + level envelope; uncertainty = |VAD − envelope|")


def adjudicate_sync(cfg, sync, alignment):
    """For every card the locked sync check failed, state — with evidence — whether the
    failure is explained by a Whisper stamp that absorbed a pause. The locked result is
    NOT changed; this is a separate record for the reviewer."""
    a = cfg["alignment"]
    by_i = {r["i"]: r for r in alignment["data"]["rows"]}
    locked = {r["i"]: r for r in sync["cards"]}
    out = []
    for i in sorted(set(sync["lead_fail"] + sync["not_found"])):
        r, lk = by_i.get(i), locked[i]
        original = "NOT_FOUND" if lk["status"] == "not_found" else f"drift {lk['drift_ms']:+d}ms"
        if r is None:
            out.append({"card": i, "original": original, "verdict": "confirmed", "reason": "אין מדידת יישור לכרטיס הזה"})
            continue
        ev = r["evidence"]
        two_methods = r["method"] == "vad+envelope" and r["uncertainty_ms"] <= a["agree_ms"]
        inside = ev.get("whisper_start") is not None and ev["whisper_start"] - 0.05 <= r["ref_onset"] <= ev["whisper_end"]
        aligned = abs(r["lead_ms"]) < a["lead_fail_ms"]
        if two_methods and inside and aligned:
            verdict = "suspected_false_positive"
            reason = (f"חותמת Whisper למילה הראשונה היא {ev['whisper_start']:.2f}–{ev['whisper_end']:.2f}s ({ev['whisper_word_s']:.2f}s למילה אחת) "
                      f"וכוללת {ev['silence_inside_stamp_s']:.2f}s של שקט. שתי מדידות בלתי תלויות מוצאות שהדיבור מתחיל ב-"
                      f"{ev['vad_onset']:.2f}s (VAD) וב-{ev['envelope_onset']:.2f}s (מעטפת), הפרש {r['uncertainty_ms']}ms. "
                      f"הכרטיס מופיע ב-{r['card_t']:.2f}s, {abs(r['lead_ms'])}ms מתחילת הדיבור הנמדדת.")
        else:
            verdict = "confirmed"
            why = []
            if not two_methods: why.append("אין שתי מדידות מסכימות של תחילת הדיבור")
            if not inside: why.append("תחילת הדיבור הנמדדת מחוץ לחותמת המילה")
            if not aligned: why.append(f"הכרטיס רחוק {abs(r['lead_ms'])}ms מתחילת הדיבור הנמדדת")
            reason = "הכשל לא מוסבר במדידות: " + "; ".join(why)
        out.append({"card": i, "original": original, "verdict": verdict, "reason": reason,
                    "evidence": {"locked_whisper_t": lk["whisper_t"], "locked_drift_ms": lk["drift_ms"], "card_t": r["card_t"],
                                 "ref_onset": r["ref_onset"], "uncertainty_ms": r["uncertainty_ms"], "method": r["method"], **ev}})
    return out


def review_items(records, issues, cards, sync, adjudications, dur):
    """ONE list of everything the owner has to look at, each with a playable excerpt."""
    by_card = {c["i"]: c for c in cards}
    adj = {a["card"]: a for a in adjudications}

    def excerpt(i):
        c = by_card[i]
        return {"t0": round(max(0.0, c["start"] - 1.2), 2), "t1": round(min(dur, c["start"] + c["dur"] + 0.8), 2), "text": c["plain"]}

    items = []
    status = {r["id"]: r for r in records}
    al = status.get("alignment_reference")
    al_rows = {r["i"]: r for r in ((al or {}).get("data") or {}).get("rows") or []}
    al_bad = set(((al or {}).get("data") or {}).get("cards") or [])
    text_rec = status.get("caption_text")
    diff_cards = {t["card"] for t in (text_rec["data"]["items"] if text_rec else []) if t["kind"] == "asr_variance"}
    folded = {}
    for i in sorted(set(sync["lead_fail"] + sync["not_found"] + sync["tail_fail"])):
        a = adj.get(i)
        lk0 = next(r for r in sync["cards"] if r["i"] == i)
        small = lk0["status"] == "not_found" or (lk0["drift_ms"] is not None and abs(lk0["drift_ms"]) < 1000)
        if (i in diff_cards and i in al_rows and i not in al_bad and small and i not in sync["tail_fail"]
                and not (a and a["verdict"] == "suspected_false_positive")):
            lk = next(r for r in sync["cards"] if r["i"] == i)
            what = "NOT_FOUND" if lk["status"] == "not_found" else f"drift {lk['drift_ms']}ms" if lk["status"] == "fail" else f"tail {lk['tail_ms']}ms"
            folded[i] = (f" בדיקת הסנכרון הנעולה דיווחה {what} לכרטיס הזה, כי היא מחפשת את האיות שבכתובית; "
                         f"ביחס למילה שנשמעה בפועל הכרטיס מופיע {abs(al_rows[i]['lead_ms'])}ms מתחילתה.")
            continue
        locked = next(r for r in sync["cards"] if r["i"] == i)
        orig = a["original"] if a else f"tail {locked['tail_ms']}ms"
        items.append({"id": f"timing:{i}", "kind": "timing", "card": i, **excerpt(i),
                      "original": f"בדיקת הסנכרון הנעולה: {orig}",
                      "verdict": a["verdict"] if a else "confirmed", "explanation": a["reason"] if a else "הכרטיס נעלם לפני סוף המילה",
                      "ask": "האם הכתובית מופיעה יחד עם המילה?"})
    text = status.get("caption_text")
    for t in (text["data"]["items"] if text and text["status"] == "review" else []):
        if t["kind"] == "homophone":
            items.append({"id": f"text:{t['card']}:{t['shown']}", "kind": "text", "card": t["card"], **excerpt(t["card"]),
                          "original": f"מוצג '{t['shown']}', התמלול כתב '{t['heard']}' (נשמעות זהה)",
                          "verdict": "needs_reading", "explanation": "בחירת איות לפי ההקשר — לא עניין של תזמון או של איכות אודיו",
                          "ask": f"האם '{t['shown']}' היא המילה הנכונה במשפט?"})
        else:
            items.append({"id": f"text:{t['card']}:{t['kind']}", "kind": "text", "card": t["card"], **excerpt(t["card"]),
                          "original": f"בכתובית '{t['shown'] or '—'}', תמלול חוזר של הקובץ הסופי כתב '{t['heard'] or '—'}'",
                          "verdict": "needs_listening",
                          "explanation": "הכתובית זהה לתמלול המקור. תמלול שני של אותו אודיו כתב אחרת — צריך לשמוע מה נאמר בפועל."
                                         + folded.get(t["card"], ""),
                          "ask": "האם הכתובית תואמת את מה שנאמר?"})
    text_words = {(t["card"], w) for t in (text["data"]["items"] if text else []) for w in (t["shown"] or "").split()}
    for w in sync["suspicious_words"]:
        if (w["card"], strip(w["word"])) in text_words:
            continue                                   # low confidence caused by the homophone itself; listed once, as text
        items.append({"id": f"acoustic:{w['card']}:{strip(w['word'])}", "kind": "acoustic", "card": w["card"], **excerpt(w["card"]),
                      "original": f"ודאות אקוסטית נמוכה למילה '{w['word']}' ({'; '.join(w['reasons'])})",
                      "verdict": "needs_listening", "explanation": "התמלול לא בטוח שהמילה נאמרה — זו בדיקת שמיעה, לא בדיקת איות",
                      "ask": f"האם שומעים את המילה '{w['word']}'?"})
    covered = {"sync_lead", "sync_not_found", "sync_tail", "energy_gate", "caption_text"}
    for r in records:
        if r["status"] == "fail" and r["id"] not in covered:
            items.append({"id": f"check:{r['id']}", "kind": "technical", "card": None, "t0": None, "t1": None, "text": None,
                          "original": r["summary"], "verdict": "confirmed", "explanation": "בדיקה טכנית שנכשלה", "ask": "לתקן בעריכה חוזרת"})
    for i in issues:
        if i["severity"] == "blocker":
            items.append({"id": f"content:{i['code']}", "kind": "content", "card": None, "t0": None, "t1": None, "text": None,
                          "original": i["message"], "verdict": "needs_decision", "explanation": "", "ask": "נדרשת החלטה שלך"})
    return items


def assert_nothing_hidden(records, sync, issues, items):
    """Fail closed: every failed check, every card the locked sync check failed and every blocking
    issue must be represented in the owner's review list. Suppressing a redundant revision request
    must never make a failure disappear."""
    cards = {i["card"] for i in items if i.get("card")}
    ids = {i["id"] for i in items}
    missing = [f"card {c}" for c in sorted(set(sync["lead_fail"] + sync["not_found"] + sync["tail_fail"])) if c not in cards]
    missing += [f"word '{w['word']}' (card {w['card']})" for w in sync["suspicious_words"] if w["card"] not in cards]
    covered = {"sync_lead", "sync_not_found", "sync_tail", "energy_gate", "caption_text"}
    missing += [r["id"] for r in records if r["status"] == "fail" and r["id"] not in covered and f"check:{r['id']}" not in ids]
    missing += [i["code"] for i in issues if i["severity"] == "blocker" and f"content:{i['code']}" not in ids]
    text = next((r for r in records if r["id"] == "caption_text"), None)
    missing += [f"text difference on card {t['card']}" for t in ((text or {}).get("data") or {}).get("items") or [] if t["card"] not in cards]
    if missing:
        raise PipelineError("review_items_incomplete", "failed checks are missing from the review list: " + ", ".join(missing))


HUMAN_CHECKS = [
    rec("listening", "human_required", "האזנה לאיכות האודיו (רעש, דובר נוסף, חיתוך) — לא ניתן לאימות במדידה"),
    rec("framing", "human_required", "פריימינג, כתוביות מול פנים ותנועה — דורש צפייה"),
    rec("meaning", "human_required", "המשמעות והציטוט נשמרו כפי שנאמרו — דורש שיפוט"),
]
