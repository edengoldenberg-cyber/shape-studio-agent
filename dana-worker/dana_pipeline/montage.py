"""A compilation ("לקט"): ONE video built from moments of several source files, chosen by what is SEEN.

Speech density is not the criterion here. For every source the picture is measured (movement, sharpness, exposure, shot
changes); candidate moments are taken from inside single shots, spread over the files; a tool-free model call looks at ONE
still of each candidate and chooses and orders them (message, opening, sequence). The model sees stills only: it does
not watch motion, it is told not to name an exercise unless the still plainly shows it, and never to judge how well
something is performed. Without the model the choice is made by the measurements alone and is marked as such.

The result carries an EDIT MAP: every part with its file and the time inside that file. One part can be replaced or
removed later without touching the others; the music can be replaced without planning again.
"""
import json
import math
import re
import subprocess
import time
from pathlib import Path

import numpy as np

from . import PIPELINE_VERSION, captions, checks, judgement, mix as mixer, motion, review, sources, story
from .core import PipelineError, run, sha256_file, tool, write_json

RUBRIC = "dana-montage-2026-11-16.1"
FPS_A, AW, AH = 4, 90, 160            # the analysis looks at 4 small grey frames per second
SEG_MIN, SEG_MAX, WINDOW = 1.2, 6.0, 3.0

SYSTEM = """You plan ONE short vertical compilation video for a small fitness and Pilates studio, from still frames of candidate
moments taken from several source clips. Return ONE JSON object. You have no tools. Free text is in Hebrew.

WHAT YOU SEE: one still frame per candidate, in the order of the list, plus measurements (movement, sharpness, length).
You do NOT see motion and you do NOT hear anything. So:
- describe only what a still plainly shows ("אישה שוכבת על מכשיר", "שתי מתאמנות עם משקולות"). When it is not clear, say so.
- do NOT name a specific exercise unless the still shows it unmistakably, and NEVER judge how well anything is performed
  (form, technique, effort, progress). Do not state results, benefits, prices, offers or any fact about the studio.
- a candidate marked "must" was required by the owner: it is always included.

THE JOB
1. "message": one sentence saying what this compilation shows a viewer (what is seen, not a promise).
2. "order": the candidates you use, in playing order, each with "seconds" (how long to show it, within the limits given),
   "seen" (what the still shows) and "why" (its job in the sequence). Choose by what is going on, by picture quality and
   by the message - not by how many candidates a file has. Leave out near-identical shots; keep variety (people, angles,
   equipment); keep the sequence easy to follow (do not jump back and forth between unrelated settings without reason).
3. "opening_why": why the first shot opens the video. 4. "sequence_why": the logic of the order in one sentence.
5. "title": an OPTIONAL editorial title of 2-6 Hebrew words shown in the first seconds, in your own words, describing what
   the video shows; null when the picture speaks for itself. No number, price, offer, name or claim.
6. "unused_files": the owner uploaded every file in order to use it. Take at least one moment from EVERY file unless a file has
   nothing usable; for each file you leave out entirely give {"file", "why"} (for example: it repeats another file, nothing happens
   in it, it is out of focus).
7. "doubts": anything you could not tell from stills and the owner should look at (people who may not have agreed to be
   filmed, a shot that may be out of focus in motion, and so on).
"""
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["message", "order", "opening_why", "sequence_why", "title", "doubts"],
          "properties": {"message": {"type": "string"}, "unused_files": {"type": "array", "maxItems": 12, "items": {"type": "object", "additionalProperties": False, "required": ["file", "why"],
                                                                                           "properties": {"file": {"type": "string"}, "why": {"type": "string"}}}},
                         "opening_why": {"type": "string"}, "sequence_why": {"type": "string"}, "title": {"type": ["string", "null"]},
                         "doubts": {"type": "array", "maxItems": 6, "items": {"type": "string"}},
                         "order": {"type": "array", "minItems": 2, "maxItems": 14, "items": {"type": "object", "additionalProperties": False, "required": ["candidate", "seconds", "seen", "why"],
                                   "properties": {"candidate": {"type": "integer"}, "seconds": {"type": "number"}, "seen": {"type": "string"}, "why": {"type": "string"}}}}}}
REVIEW_SYSTEM = """You review ONE finished compilation video from still frames (one per part, in playing order) and return ONE JSON object.
You have no tools. You do not see motion and do not hear anything: say nothing about sound, rhythm, smoothness or performance.
For each criterion id say whether it is met, with a one-sentence Hebrew note naming the stills you looked at. List findings only
with concrete evidence. Never name an exercise unless a still shows it unmistakably and never judge how well it is done."""
REVIEW_SCHEMA = {"type": "object", "additionalProperties": False, "required": ["criteria", "findings"],
                 "properties": {"criteria": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["id", "met", "note"],
                                             "properties": {"id": {"type": "string"}, "met": {"type": ["boolean", "null"]}, "note": {"type": "string"}}}},
                                "findings": {"type": "array", "maxItems": 8, "items": {"type": "object", "additionalProperties": False, "required": ["part", "problem", "evidence"],
                                             "properties": {"part": {"type": ["integer", "null"]}, "problem": {"type": "string"}, "evidence": {"type": "string"}}}}}}
MODEL_CRITERIA = [("M1", "structure", "הרצף מובן: אין קפיצה מבלבלת בין מקומות או אנשים"), ("M2", "message", "הקטעים מתאימים למסר שהוגדר"),
                  ("M3", "structure", "אין שני קטעים שנראים כמעט זהים"), ("M4", "opening", "השוט הפותח ברור ומושך את העין"),
                  ("M5", "message", "הכותרת מתארת את מה שרואים ואינה מוסיפה טענה או מידע עסקי")]


# ── measuring the picture ───────────────────────────────────────────────────
def analyse(cfg, video, dur):
    """Per quarter second: movement (mean absolute difference between frames), sharpness (variance of a Laplacian), brightness."""
    cmd = [tool(cfg, "ffmpeg"), "-v", "error", "-i", str(video), "-an", "-vf", f"fps={FPS_A},scale={AW}:{AH},format=gray", "-f", "rawvideo", "-"]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=cfg["timeouts"]["ffmpeg_s"])
    except subprocess.TimeoutExpired:
        raise PipelineError("montage_analysis_timeout", "ניתוח התמונה של המקורות לא הסתיים בזמן", True)
    if r.returncode != 0 or len(r.stdout) < AW * AH * 2:
        raise PipelineError("montage_analysis_failed", "לא ניתן היה לנתח את התמונה של המקורות", False, (r.stderr or b"").decode("utf-8", "replace")[-600:])
    f = np.frombuffer(r.stdout[: len(r.stdout) // (AW * AH) * AW * AH], dtype=np.uint8).reshape(-1, AH, AW).astype(np.float32) / 255.0
    motion_ = np.concatenate([[0.0], np.mean(np.abs(f[1:] - f[:-1]), axis=(1, 2))])
    lap = f[:, 1:-1, 1:-1] * 4 - f[:, :-2, 1:-1] - f[:, 2:, 1:-1] - f[:, 1:-1, :-2] - f[:, 1:-1, 2:]
    return {"t": np.arange(len(f)) / FPS_A, "motion": motion_, "sharp": lap.var(axis=(1, 2)), "luma": f.mean(axis=(1, 2))}


def shot_cuts(cfg, video):
    r = subprocess.run([tool(cfg, "ffmpeg"), "-v", "info", "-i", str(video), "-an", "-vf", "scale=320:-2,select='gt(scene,0.30)',showinfo", "-f", "null", "-"],
                       capture_output=True, timeout=cfg["timeouts"]["ffmpeg_s"])
    return sorted(float(x) for x in re.findall(r"pts_time:([0-9.]+)", (r.stderr or b"").decode("utf-8", "replace")))


def _z(x):
    s = float(np.std(x))
    return (x - float(np.mean(x))) / s if s > 1e-9 else np.zeros_like(x)


def candidates(an, cuts, smap, never, must, limit=18):
    """Moments worth showing: windows inside ONE shot of ONE file, scored by movement and sharpness, spread over the files."""
    zm, zs = _z(an["motion"]), _z(an["sharp"])
    edges = sorted({0.0, *[m["v_in"] for m in smap], *[m["v_out"] for m in smap], *cuts})
    out, per_file = [], max(2, math.ceil(limit / max(1, len(smap))))
    for m in smap:
        found = []
        for a, b in zip(edges, edges[1:]):
            if a < m["v_in"] - 1e-3 or b > m["v_out"] + 1e-3 or b - a < SEG_MIN + 0.4:
                continue
            t = a + 0.2
            while t + SEG_MIN <= b - 0.2:
                e = min(t + WINDOW, b - 0.2)
                if not any(t < n["to_s"] and e > n["from_s"] for n in never):
                    i0, i1 = int(t * FPS_A), max(int(t * FPS_A) + 1, int(e * FPS_A))
                    lum = float(np.mean(an["luma"][i0:i1]))
                    score = 0.6 * float(np.mean(zm[i0:i1])) + 0.4 * float(np.mean(zs[i0:i1])) - (1.5 if lum < 0.10 or lum > 0.93 else 0.0)
                    found.append({"in_s": round(t, 2), "out_s": round(e, 2), "score": round(score, 3), "motion": float(np.mean(an["motion"][i0:i1])),
                                  "sharp": float(np.mean(an["sharp"][i0:i1])), "luma": round(lum, 3), "source": m["id"], "name": m["name"], "must": False})
                t += 1.0
        found.sort(key=lambda c: -c["score"])
        kept = []
        for c in found:                          # the best windows of this file that do not overlap each other
            if len(kept) < per_file and not any(c["in_s"] < k["out_s"] + 0.5 and c["out_s"] > k["in_s"] - 0.5 for k in kept):
                kept.append(c)
        out += kept
    for k in must:                               # what the owner required is always a candidate
        a, b = k["from_s"], min(k["to_s"], k["from_s"] + SEG_MAX)
        i0, i1 = int(a * FPS_A), max(int(a * FPS_A) + 1, int(b * FPS_A))
        out = [c for c in out if not (c["in_s"] < b and c["out_s"] > a)]
        out.append({"in_s": round(a, 2), "out_s": round(b, 2), "score": 99.0, "motion": float(np.mean(an["motion"][i0:i1])), "sharp": float(np.mean(an["sharp"][i0:i1])),
                    "luma": round(float(np.mean(an["luma"][i0:i1])), 3), "source": k["source"], "name": k["name"], "must": True})
    out.sort(key=lambda c: (-c["must"], -c["score"]))
    out = sorted(out[:limit], key=lambda c: c["in_s"])
    med_m, med_s = float(np.median(an["motion"])), float(np.median(an["sharp"]))
    for n, c in enumerate(out, 1):
        c.update(n=n, movement="רבה" if c["motion"] > 1.6 * med_m else "מעטה" if c["motion"] < 0.6 * med_m else "בינונית",
                 sharpness="חדה" if c["sharp"] >= med_s else "רכה יחסית")
    return out


def stills(cfg, video, items, out_dir, key=lambda c: (c["in_s"] + c["out_s"]) / 2, w=360, h=640):
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for n, c in enumerate(items, 1):
        p = out_dir / f"s{n:02d}.jpg"
        run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-ss", f"{key(c):.2f}", "-i", video, "-frames:v", "1", "-vf", f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}", "-q:v", "5", p],
            "montage_stills_failed", timeout=120)
        paths.append(str(p))
    return paths


# ── the plan ────────────────────────────────────────────────────────────────
def limits(tg, tspec):
    return (8.0, 45.0) if tg == "story" else (10.0, 32.0)


def validate(raw, cands, lo, hi):
    """The model's order -> segments on the joined timeline. Returns (segments, notes)."""
    by, used, segs, notes = {c["n"]: c for c in cands}, set(), [], []
    for o in raw.get("order") or []:
        c = by.get(o.get("candidate"))
        if not c or c["n"] in used:
            continue
        used.add(c["n"])
        d = (c["out_s"] - c["in_s"]) if c["must"] else min(max(float(o.get("seconds") or WINDOW), SEG_MIN), c["out_s"] - c["in_s"], SEG_MAX)
        segs.append({"candidate": c["n"], "source_in_s": c["in_s"], "source_out_s": round(c["in_s"] + d, 2), "window_out_s": c["out_s"], "must": c["must"],
                     "seen": str(o.get("seen") or "")[:200], "why": str(o.get("why") or "")[:240]})
    for c in cands:                              # required by the owner and left out by the model: added, and said
        if c["must"] and c["n"] not in used:
            segs.append({"candidate": c["n"], "source_in_s": c["in_s"], "source_out_s": c["out_s"], "window_out_s": c["out_s"], "must": True, "seen": "", "why": "סומן על ידך כקטע שחייב להיכלל"})
            notes.append(f"קטע שסימנת כחובה (מועמד {c['n']}) לא נבחר בתכנון והוסף בסוף")
    total = lambda: sum(s["source_out_s"] - s["source_in_s"] for s in segs)
    while total() > hi and any(not s["must"] for s in segs):
        k = max((i for i, s in enumerate(segs) if not s["must"]), key=lambda i: i)       # the last optional part goes first
        notes.append(f"הקטע האחרון שאינו חובה הוסר כדי לעמוד במשך המרבי ({hi:.0f} שנ׳)")
        segs.pop(k)
    if len(segs) < 2:
        raise PipelineError("montage_plan_invalid", "the plan uses fewer than two moments", True)
    if total() < lo:
        notes.append(f"משך הלקט ({total():.1f} שנ׳) קצר מהמינימום ליעד ({lo:.0f} שנ׳): אין מספיק רגעים מתאימים במקורות")
    return segs, notes


def by_measurement(cands, lo, hi):
    """No model: the best-scored moments, in the order of the files. Marked as NOT a content judgement."""
    order = sorted(cands, key=lambda c: (-c["must"], -c["score"]))
    pick, t = [], 0.0
    for c in order:
        d = min(c["out_s"] - c["in_s"], WINDOW)
        if t + d > hi and not c["must"]:
            continue
        pick.append(c)
        t += d
        if t >= (lo + hi) / 2:
            break
    pick.sort(key=lambda c: c["in_s"])
    return [{"candidate": c["n"], "source_in_s": c["in_s"], "source_out_s": round(c["in_s"] + min(c["out_s"] - c["in_s"], WINDOW), 2), "window_out_s": c["out_s"], "must": c["must"],
             "seen": "", "why": "נבחר לפי מדידת תנועה וחדות בלבד — לא שיפוט תוכן"} for c in pick]


def on_beat(segs, beat, tolerance=0.35):
    """Lengthen or shorten a part a little so that its cut falls on a beat - only when a beat is close and the part stays inside
    its own shot and length limits. Returns how many cuts are on a beat."""
    t, hits = 0.0, 0
    for s in segs[:-1]:
        d = s["source_out_s"] - s["source_in_s"]
        cut = t + d
        near = min(beat, key=lambda b: abs(b - cut))
        nd = d + (near - cut)
        if abs(near - cut) <= tolerance and SEG_MIN <= nd <= min(SEG_MAX, s["window_out_s"] - s["source_in_s"]) and not (s.get("must") and nd < d):
            s["source_out_s"], s["on_beat"] = round(s["source_in_s"] + nd, 3), True
            hits += 1
            d = nd
        else:
            s["on_beat"] = False
        t += d
    return hits


def render(cfg, st, video, segs, work, out):
    """Cut every part from the joined source at the output size and put them one after the other (straight cuts)."""
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    W, H, r, parts = st["width"], st["height"], cfg["render"], []
    for n, s in enumerate(segs, 1):
        p = work / f"part_{n:02d}.mp4"
        d = s["source_out_s"] - s["source_in_s"]
        run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-ss", f"{s['source_in_s']:.3f}", "-t", f"{d:.3f}", "-i", video,
             "-vf", f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={st['fps']},setsar=1,format=yuv420p",
             "-af", f"aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d=0.025,afade=t=out:st={max(0.0, d - 0.03):.3f}:d=0.025",
             "-c:v", "libx264", "-crf", str(r["crf"]), "-preset", r["preset"], "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", r["audio_bitrate"], "-ar", "48000", p],
            "render_failed", timeout=cfg["timeouts"]["ffmpeg_s"])
        parts.append(p)
    lst = work / "parts.txt"
    lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
    run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", out], "render_failed", timeout=cfg["timeouts"]["ffmpeg_s"])
    t = 0.0
    for n, s in enumerate(segs, 1):
        d = round(s["source_out_s"] - s["source_in_s"], 3)
        s.update(n=n, tl_in_s=round(t, 3), tl_out_s=round(t + d, 3), role="opening" if n == 1 else "closing" if n == len(segs) else "body")
        t += d
    return round(t, 3)


def _row(cid, cat, text, status, basis, note=""):
    return {"id": cid, "category": cat, "criterion": text, "status": status, "basis": basis, "basis_label": review.BASIS_HE.get(basis, basis), "note": note, "time_s": None}


def _categories(rows):
    cats = []
    for key, label in review.CATEGORIES:
        mine = [r for r in rows if r["category"] == key]
        if not mine:
            continue
        met, miss = sum(r["status"] == "met" for r in mine), sum(r["status"] == "not_met" for r in mine)
        level = "לא נבדק" if not met + miss else next(name for th, name in review.LEVELS if met / (met + miss) >= th)
        cats.append({"key": key, "label": label, "level": level, "met": met, "decided": met + miss, "not_checked": sum(r["status"] == "not_checked" for r in mine),
                     "not_applicable": sum(r["status"] == "na" for r in mine), "criteria": mine})
    return cats


# ── the whole compilation ───────────────────────────────────────────────────
def produce(j, video, smap, sp, sha_before, tg, tspec, zone_used):
    """Returns (status, package). Writes final.mp4, cover.jpg and the JSON files into j.out."""
    cfg, st, options = j.cfg, j.style, j.options
    audio = options.get("audio") or {}
    music, nar = audio.get("music"), audio.get("narration")
    issues, records, usages, notes = [], [], [], []
    never, must, _ = sources.ranges(smap)
    lo, hi = limits(tg, tspec)
    prev = options.get("previous") if isinstance(options.get("previous"), dict) else None
    prev_segs = [s for s in ((prev or {}).get("plan") or {}).get("segments") or [] if s.get("source_id")] if ((prev or {}).get("plan") or {}).get("kind") == "montage" else []
    locked = bool(prev_segs)
    plan_meta = {"message": "", "opening_why": "", "sequence_why": "", "doubts": [], "title": None, "unused_why": {}}
    cands, judgement_mode, model_error = [], "model", None

    if locked:                                   # a correction: the previous parts are kept; only what was asked for changes
        with j.stage("plan"):
            segs = []
            for s in prev_segs:
                a, b = sources.to_joined(smap, s["source_id"], s["file_in_s"]), sources.to_joined(smap, s["source_id"], s["file_out_s"])
                if a is None or b is None or b - a < 0.5:
                    notes.append(f"קטע {s['n']} מהגרסה הקודמת לא נמצא עוד במקורות והושמט")
                    continue
                segs.append({"n_prev": s["n"], "source_in_s": a, "source_out_s": b, "window_out_s": b, "must": bool(s.get("must")), "seen": s.get("seen") or "", "why": s.get("why") or "",
                             "kept_from_previous": True})
            for e in options.get("segment_edits") or []:
                k = next((i for i, s in enumerate(segs) if s.get("n_prev") == e.get("n")), None)
                if k is None:
                    notes.append(f"בקשת שינוי לקטע {e.get('n')}: אין קטע כזה בגרסה הקודמת")
                elif e["action"] == "remove":
                    segs.pop(k)
                else:
                    a, b = sources.to_joined(smap, e["source_id"], e["from_s"]), sources.to_joined(smap, e["source_id"], e["to_s"])
                    if a is None or b is None or b - a < 0.5:
                        notes.append(f"החלפת קטע {e['n']}: הקובץ או הזמנים שנבחרו אינם תקינים — הקטע הקודם נשאר")
                    else:
                        segs[k] = {"n_prev": e["n"], "source_in_s": a, "source_out_s": min(b, a + SEG_MAX), "window_out_s": b, "must": True, "seen": "", "why": "הוחלף לבקשתך",
                                   "replaced_by_owner": True}
            if len(segs) < 1:
                raise PipelineError("montage_plan_invalid", "לא נשאר אף קטע בלקט אחרי השינויים שביקשת", False)
            pp = (prev or {}).get("plan") or {}
            plan_meta.update(message=pp.get("message") or "", opening_why=pp.get("opening_why") or "", sequence_why=pp.get("rationale") or "", title=pp.get("title"))
            judgement_mode = (prev or {}).get("judgement_mode") or "model"
    else:
        with j.stage("measure_sources"):
            an = analyse(cfg, video, sp["duration"])
            cuts = shot_cuts(cfg, video)
            cands = candidates(an, cuts, smap, never, must)
            if len(cands) < 2:
                raise PipelineError("montage_no_material", "לא נמצאו במקורות מספיק רגעים שאפשר להשתמש בהם (שוטים של לפחות 1.6 שניות שלא סומנו כאסורים)", False)
            imgs = stills(cfg, video, cands, j.work / "cand_stills")
        with j.stage("plan"):
            use_model = judgement.resolve_adapter(options, cfg) == "claude" and cfg["judgement"]["claude"].get("enabled")
            table = [{"candidate": c["n"], "file": c["name"], "at_s": sources.locate(smap, c["in_s"])["t"], "max_seconds": round(c["out_s"] - c["in_s"], 1),
                      "movement": c["movement"], "sharpness": c["sharpness"], **({"must": True} if c["must"] else {})} for c in cands]
            if use_model:
                text = "\n\n".join([
                    f"TARGET: {'an Instagram STORY (followers; cards)' if tg == 'story' else 'an Instagram REEL (a stranger in a feed: the first shot must catch the eye)'}. "
                    f"Total length {lo:.0f}-{hi:.0f} s. Each part {SEG_MIN}-{SEG_MAX:.0f} s and never longer than its max_seconds.",
                    "<brand_facts>\n" + json.dumps(options.get("brand") or {"note": "no verified brand facts were provided"}, ensure_ascii=False) + "\n</brand_facts>",
                    ("<owner_rules>\n" + "\n".join(f"- {str(r.get('text'))[:300]}" for r in options.get("rules") or [] if isinstance(r, dict) and r.get("text"))
                     + "\nApproved style rules; follow them where they apply to a compilation.\n</owner_rules>") if options.get("rules") else "",
                    ("<owner_request>\n" + str(options.get("change_request"))[:1500] + "\n</owner_request>") if options.get("change_request") else "",
                    "Music: " + ("a music track was uploaded; cuts may be moved slightly onto its beats." if music else "none."),
                    "KIND OF PROJECT: " + ("a TRAINING COMPILATION - it is meant to show people training and the studio in use. Prefer shots where something is being done. "
                                           "A person only talking to the camera says nothing here unless the sound is kept; use such a shot briefly, if at all."
                                           if (options.get("project_type") or "montage") == "montage" else "a NARRATED video - the narration carries the content and the picture supports it."),
                    "Original sound: " + ("MUTED - nothing that is said in the clips will be heard, so do not rely on speech." if (audio.get("original") or {}).get("mode") == "mute"
                                          else "kept under the music / narration."),
                    "<candidates>\n" + json.dumps(table, ensure_ascii=False, indent=1) + "\n</candidates>",
                    "The stills follow in the order of the list."])
                content = [{"type": "text", "text": text}] + [{"type": "image", "path": p} for p in imgs]
                try:
                    raw, u = judgement.claude_json(cfg, j.dir, SYSTEM, content, SCHEMA, "montage_plan")
                    u["role"] = "montage_planner"
                    usages.append(u)
                    segs, n2 = validate(raw, cands, lo, hi)
                    notes += n2
                    title, refused = motion.editorial_title(raw.get("title"))
                    if refused:
                        notes.append(f"הכותרת שהוצעה לא נכנסה: {refused}")
                    plan_meta.update(message=str(raw.get("message") or "")[:300], opening_why=str(raw.get("opening_why") or "")[:300], sequence_why=str(raw.get("sequence_why") or "")[:300],
                                     doubts=[str(d)[:240] for d in raw.get("doubts") or []], title=title,
                                     unused_why={str(u.get("file")): str(u.get("why") or "")[:240] for u in raw.get("unused_files") or [] if isinstance(u, dict)})
                except PipelineError as e:
                    if getattr(e, "usage", None):
                        usages.append(e.usage)
                    model_error, use_model = f"{e.code}: {e.message}", False
            if not use_model:
                segs, judgement_mode = by_measurement(cands, lo, hi), "fallback_heuristic"
                issues.append(judgement.issue("content_judgement_missing", "blocker", "הקטעים נבחרו לפי מדידת תנועה וחדות בלבד, לא בשיפוט תוכן — לבדוק לפני אישור"
                                              + (f" (מודל התוכן לא היה זמין: {model_error})" if model_error else "")))

    beat_info, beat_hits = None, None
    if music and audio.get("cut_on_beat"):
        with j.stage("beats"):
            total_guess = sum(s["source_out_s"] - s["source_in_s"] for s in segs)
            beat_info, why = mixer.beats(music["path"], music.get("start_s", 0), total_guess + 2.0)
            if beat_info:
                beat_hits = on_beat(segs, beat_info["beats_s"])
            else:
                issues.append(judgement.issue("beats_not_available", "warn", f"עריכה לפי קצב התבקשה אך לא בוצעה: {why}"))

    with j.stage("render_base"):
        dur = render(cfg, st, video, segs, j.work / "parts", j.work / "base.mp4")
        sources.describe(smap, segs)
    picture = j.work / "base.mp4"
    # a file the owner uploaded and that is not in the video at all is SAID, with the reason
    used_ids = {s["source_id"] for s in segs}
    unused = [{"id": m["id"], "name": m["name"], "why": plan_meta["unused_why"].get(m["name"]) or ("נשאר מחוץ לגרסה הקודמת" if locked else "לא נבחר ממנו אף רגע")} for m in smap if m["id"] not in used_ids]
    for u in unused:
        issues.append(judgement.issue("source_not_used", "warn", f"הקובץ \"{u['name']}\" אינו בסרטון: {u['why']}"))

    # ── an editorial title over the first seconds (the only graphic a compilation carries for now) ──
    graphics, graphics_dropped = [], []
    if plan_meta["title"]:
        with j.stage("graphics"):
            g = {"id": "hook_title@0.0", "kind": "hook_title", "label": motion.KINDS["hook_title"]["label"], "layer": "over_picture", "text": plan_meta["title"],
                 "tl_start_s": 0.25, "tl_end_s": round(min(2.6, dur - 0.2), 3), "reason": "מבהירה מה רואים בסרטון", "quote_is_exact": False, "text_class": "editorial",
                 "text_class_label": motion.TEXT_CLASS["editorial"], "based_on": None, "text_source": "ניסוח של דנה לפי מה שנראה בפריימים — לא ציטוט", "design": motion.DESIGN["hook_title"],
                 "tool": "HyperFrames (HTML + GSAP), רינדור מקומי", "check": motion.CHECK["over_picture"],
                 "decided_by": {"purpose_text_timing": "דנה (מודל)", "design_tool_check": "תבנית קבועה של המערכת — לא בחירה של דנה"}}
            faces = story.faces_at(cfg, picture, [0.5, 1.4, 2.3]) or []
            placed, dropped = motion.place([g], zone_used, {g["id"]: faces}, None, st["height"])
            graphics_dropped += dropped
            for it in placed:
                try:
                    frames_dir, n = motion.render(cfg, st, it, j.work / "graphics")
                    graphics.append(dict(it, frames=str(frames_dir), frames_n=n, ink_box=motion.ink_box(frames_dir, n)))
                except PipelineError as e:
                    graphics_dropped.append({"kind": it["kind"], "quote": it["text"], "why": f"הרינדור ב-HyperFrames נכשל ({e.code}) — הכותרת לא נוספה"})
            if graphics:
                captions.composite(cfg, picture, picture, [], None, j.work / "titled.mp4", dur, animation=None, graphics=graphics, fps=st["fps"])
                records.append(motion.check(cfg, j.work / "titled.mp4", picture, graphics, zone_used, {g["id"]: faces}, st["width"]))
                picture = j.work / "titled.mp4"

    # ── captions of the NARRATION: the words of the uploaded narration, timed by transcribing it; marked as narration, unverified ──
    cards, nar_words = [], []
    if nar and st.get("captions_enabled", True):
        with j.stage("render_cards"):
            try:
                wav = j.work / "narration_16k.wav"
                run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-i", nar["path"], "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], "narration_unreadable", timeout=300)
                off = float(nar.get("start_s", 0))
                nar_words = [dict(w, start=round(w["start"] + off, 3), end=round(w["end"] + off, 3)) for w in checks.transcribe(cfg, wav)["words"] if w["start"] + off < dur - 0.2]
                if nar_words:
                    line_px = captions.max_line_px(zone_used, st["width"])
                    fits = lambda t: len(t) <= cfg["cards"]["merge_max_chars"] and captions.text_px(cfg, st, t) <= line_px
                    one = [{"text": judgement.BIDI.sub("", w["word"]).strip(), "highlight": []} for w in nar_words]
                    grouped, _ = captions.regroup(one, [[w] for w in nar_words], fits, cfg["cards"]["min_on_screen_s"], cfg["cards"]["max_chars_per_s"], 3, cfg["cards"]["hold_after_s"])
                    spans, k = [], 0
                    for c in grouped:
                        n_w = len(c["text"].split())
                        spans.append(nar_words[k:k + n_w])
                        k += n_w
                    cards = captions.time_cards(grouped, spans, st["fps"], cfg["cards"]["hold_after_s"], dur)
                    png_dir = captions.render_png(cfg, st, [{"name": f"c{c['i']:03d}", "text": c["plain"], "highlight": []} for c in cards], j.work / "caps")
                    records += [checks.check_width(png_dir, cards, st["width"]), checks.check_safe_zone(cfg, png_dir, cards)]
                    captions.composite(cfg, picture, picture, cards, png_dir, j.work / "captioned.mp4", dur, animation=None, graphics=None, fps=st["fps"])
                    picture = j.work / "captioned.mp4"
                    issues.append(judgement.issue("narration_captions_unverified", "warn", f"הכתוביות ({len(cards)}) נוצרו מתמלול אוטומטי של הקריינות ולא אומתו. הן מציגות קריינות, לא ציטוט של המצולמים — לקרוא ולבדוק לפני אישור"))
            except PipelineError as e:
                cards = []
                issues.append(judgement.issue("narration_captions_failed", "warn", f"לא נוצרו כתוביות לקריינות ({e.code}); הקריינות עצמה נכנסה למיקס"))

    # ── the mix: original sound (kept or muted, per part), narration, music ──
    final = j.out / "final.mp4"
    mute = [(s["tl_in_s"], s["tl_out_s"]) for s in segs if s["n"] in ((audio.get("original") or {}).get("mute_segments") or [])]
    speech = [(w["start"], w["end"]) for w in nar_words]
    if nar and not speech:
        nd = mixer_probe(cfg, nar["path"])
        speech.append((float(nar.get("start_s", 0)), min(dur, float(nar.get("start_s", 0)) + nd)))
    with j.stage("mix"):
        mix_rec = mixer.mix(cfg, picture, final, audio, dur, speech, mute, j.work / "mix")
    mix_rec["beats"] = ({"requested": True, "tempo_bpm": beat_info["tempo_bpm"], "cuts": len(segs) - 1, "cuts_on_beat": beat_hits, "method": beat_info["method"],
                         "note": "חיתוך הוזז לפעימה רק כשפעימה הייתה קרובה והקטע נשאר בתוך השוט שלו; לא נכפה חיתוך בכל פעימה"} if beat_info
                        else {"requested": bool(audio.get("cut_on_beat")), "cuts_on_beat": None})
    mix_rec["music_license"] = (music or {}).get("license")
    mix_rec["narration_script"] = (nar or {}).get("script")

    with j.stage("checks"):
        loud = checks.check_loudness(cfg, final)
        records += [checks.check_output(cfg, final, dur), loud, checks.check_source_unchanged(getattr(j, "primary_source", j.source), sha_before)] + mixer.checks(cfg, mix_rec, loud)
        hit, missing = sources.check_marks(smap, segs)
        records.append(checks.rec("marks_never", "fail" if hit else "pass", ("נעשה שימוש בקטע שסימנת 'לא להשתמש': " + "; ".join(f"{h['name']} {h['from_s']}-{h['to_s']}" for h in hit)) if hit
                                  else f"לא נעשה שימוש באף קטע שסומן 'לא להשתמש' ({len(never)} סימונים)"))
        records.append(checks.rec("marks_must", "fail" if missing else "pass", ("קטע שסימנת 'חייב להיכלל' אינו בסרטון: " + "; ".join(f"{m['name']}" for m in missing)) if missing
                                  else f"כל הקטעים שסומנו 'חייב להיכלל' נמצאים בסרטון ({len(must)} סימונים)"))
        crossing = [s["n"] for s in segs if s.get("crosses_files")]
        records.append(checks.rec("edit_map", "fail" if crossing else "pass", f"קטעים שחוצים גבול בין קבצים: {crossing}" if crossing else f"לכל {len(segs)} הקטעים יש קובץ מקור וזמן בתוך הקובץ"))
        lens = [round(s["tl_out_s"] - s["tl_in_s"], 2) for s in segs]
        records.append(checks.rec("part_lengths", "pass" if all(SEG_MIN - 0.05 <= x <= SEG_MAX + 0.05 for x in lens) else "review", f"אורכי הקטעים: {lens} שנ׳ (סה\"כ {dur} שנ׳)"))
        if music and (music.get("license") or {}).get("status") != "owner_confirmed":
            issues.append(judgement.issue("music_license_not_confirmed", "blocker", f"הרישיון לשימוש במוזיקה \"{music.get('name')}\" לא אושר על ידך. קובץ שהועלה אינו מסומן אוטומטית כמורשה — אין לפרסם לפני שתאשר/י מקור ורישיון"))
        if nar and (nar.get("script") or {}).get("is_script") is None:
            issues.append(judgement.issue("narration_origin_unknown", "warn", "לא סומן אם הקריינות היא תסריט שנכתב לסרטון או דברי המצולמים. היא מוצגת כקריינות בלבד, לא כציטוט"))
    run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-ss", f"{min(0.6, dur / 2):.2f}", "-i", final, "-frames:v", "1", "-q:v", "3", j.out / "cover.jpg"], "cover_failed", timeout=120)

    # ── the picture measured across the parts, and the model's review of stills of the FINISHED file ──
    part_luma = []
    try:
        an2 = analyse(cfg, final, dur)
        for s in segs:
            i0, i1 = int(s["tl_in_s"] * FPS_A), max(int(s["tl_in_s"] * FPS_A) + 1, int(s["tl_out_s"] * FPS_A))
            part_luma.append(round(float(np.mean(an2["luma"][i0:i1])), 3))
    except PipelineError:
        pass
    crit, findings, reviewed, review_error = {}, [], False, None
    use_model = judgement_mode == "model" and cfg["judgement"]["claude"].get("enabled")
    if use_model:
        with j.stage("review"):
            try:
                rs = stills(cfg, final, segs[:10], j.work / "review_stills", key=lambda s: (s["tl_in_s"] + s["tl_out_s"]) / 2)
                asked = [{"id": i, "criterion": t} for i, _, t in MODEL_CRITERIA if i != "M5" or graphics]
                text = "\n\n".join(["<criteria>\n" + json.dumps(asked, ensure_ascii=False, indent=1) + "\n</criteria>",
                                    "<plan>\n" + json.dumps({"message": plan_meta["message"], "title": plan_meta["title"],
                                                             "parts": [{"part": s["n"], "file": s["source_name"], "seconds": round(s["tl_out_s"] - s["tl_in_s"], 1), "why": s["why"]} for s in segs]},
                                                            ensure_ascii=False, indent=1) + "\n</plan>", "One still per part follows, in playing order."])
                data, u = judgement.claude_json(cfg, j.dir, REVIEW_SYSTEM, [{"type": "text", "text": text}] + [{"type": "image", "path": p} for p in rs], REVIEW_SCHEMA, "montage_review")
                u["role"] = "reviewer"
                usages.append(u)
                crit = {c["id"]: c for c in data.get("criteria") or [] if isinstance(c, dict)}
                findings = [f for f in data.get("findings") or [] if isinstance(f, dict) and str(f.get("evidence") or "").strip()]
                reviewed = True
            except PipelineError as e:
                review_error = f"{e.code}: {e.message}"
    rec_by = {r["id"]: r for r in records}

    def from_rec(cid, cat, text, rid):
        r = rec_by.get(rid)
        if not r:
            return _row(cid, cat, text, "na", "measured", "לא רלוונטי בגרסה הזו")
        return _row(cid, cat, text, {"pass": "met", "fail": "not_met", "review": "not_met", "info": "na"}.get(r["status"], "not_checked"), "measured", r["summary"])

    rows = []
    for cid, cat, text in MODEL_CRITERIA:
        c = crit.get(cid)
        if cid == "M5" and not graphics:
            rows.append(_row(cid, cat, text, "na", "model", "אין כותרת בגרסה הזו"))
        elif not c or c.get("met") is None:
            rows.append(_row(cid, cat, text, "not_checked", "model", (c or {}).get("note") or (review_error or "הערכת המודל לא רצה על הגרסה הזו")))
        else:
            rows.append(_row(cid, cat, text, "met" if c["met"] else "not_met", "model", str(c.get("note") or "")[:300]))
    rows += [from_rec("S1", "structure", "לא נעשה שימוש בקטע שסומן 'לא להשתמש'", "marks_never"), from_rec("S2", "structure", "כל קטע שסומן 'חייב להיכלל' נמצא בסרטון", "marks_must"),
             from_rec("S3", "structure", "לכל קטע יש קובץ מקור וזמן מדויק (מפת עריכה)", "edit_map"), from_rec("P1", "pace", f"כל קטע באורך {SEG_MIN}–{SEG_MAX:.0f} שניות", "part_lengths")]
    if beat_info:
        share = beat_hits / max(1, len(segs) - 1)
        rows.append(_row("P2", "pace", "חיתוכים יושבים על פעימות המוזיקה כשזה אפשרי", "met" if share >= 0.5 else "not_met", "measured", f"{beat_hits} מתוך {len(segs) - 1} חיתוכים על פעימה ({beat_info['tempo_bpm']} BPM)"))
    else:
        rows.append(_row("P2", "pace", "חיתוכים יושבים על פעימות המוזיקה כשזה אפשרי", "na", "measured", "לא התבקשה עריכה לפי קצב" if not audio.get("cut_on_beat") else "זיהוי פעימות לא היה זמין"))
    rows.append(_row("P3", "pace", "הקצב מרגיש נכון בצפייה", "not_checked", "human", "דורש צפייה שלך"))
    if part_luma:
        spread = round(max(part_luma) - min(part_luma), 3)
        rows.append(_row("C1", "color", "הבהירות עקבית בין הקטעים (הפרש עד 0.18)", "met" if spread <= 0.18 else "not_met", "measured", f"בהירות ממוצעת לכל קטע: {part_luma}; הפרש מרבי {spread}"))
    else:
        rows.append(_row("C1", "color", "הבהירות עקבית בין הקטעים", "not_checked", "measured", "לא נמדד"))
    rows.append(_row("C2", "color", "הצבע והמראה עקביים בצפייה", "not_checked", "human", "גוון וצבע עור לא נמדדו בלקט; דורש צפייה שלך"))
    rows += [from_rec("G1", "graphics", "הכותרת נמצאת בסרטון, באזור הבטוח ולא על הפנים", "graphics_rendered"),
             from_rec("A1", "sound", "עוצמת הקול הכוללת ביעד", "loudness"), from_rec("A2", "sound", "אין עיוות מקטימה במיקס", "mix_clipping"),
             from_rec("A4", "sound", "בזמן דיבור המוזיקה נמוכה ממנו ב-10 dB לפחות", "mix_speech_over_music"),
             _row("A3", "sound", "המיקס נשמע טוב ומתאים לתוכן", "not_checked", "human", "דורש האזנה שלך"),
             (_row("K1", "captions", "כתוביות הקריינות בתוך הפריים ובאזור הבטוח", "met" if all((rec_by.get(i) or {}).get("status") in ("pass", "warn") for i in ("caption_width", "safe_zone")) else "not_met",
                   "measured", f"{len(cards)} כתוביות מתמלול אוטומטי של הקריינות") if cards else _row("K1", "captions", "כתוביות", "na", "measured", "אין קריינות, ולכן אין כתוביות בגרסה הזו")),
             (_row("K2", "captions", "הכתוביות תואמות את מה שנאמר בקריינות", "not_checked", "human", "נוצרו מתמלול אוטומטי ולא אומתו; דורש קריאה והאזנה שלך") if cards
              else _row("K2", "captions", "הכתוביות תואמות את הקריינות", "na", "measured", "אין כתוביות"))]
    dana_review = {"rubric_version": RUBRIC, "kind": "montage", "categories": _categories(rows), "improvements": [],
                   "legend": {"basis": review.BASIS_HE, "levels": [n for _, n in review.LEVELS] + ["לא נבדק"]},
                   "note": "הדירוג סופר כמה מהקריטריונים שנבדקו מתקיימים. קריטריון שלא נבדק מסומן כך ואינו נספר. הדירוג אינו אישור לפרסום.",
                   "perception": "מדידות על הקובץ; הערכת מודל על פריים אחד לכל קטע — המודל לא צפה בתנועה ולא שמע את האודיו."}

    for n in notes:
        issues.append(judgement.issue("montage_note", "info", n))
    for d in plan_meta["doubts"]:
        issues.append(judgement.issue("montage_doubt", "warn", d))
    review_items = [{"id": f"montage:finding:{k}", "kind": "editorial", "card": None, "t0": next((s["tl_in_s"] for s in segs if s["n"] == f.get("part")), None),
                     "t1": next((s["tl_out_s"] for s in segs if s["n"] == f.get("part")), None), "text": None, "original": str(f["problem"])[:300], "verdict": "needs_decision",
                     "explanation": str(f["evidence"])[:300], "ask": "לצפות בקטע ולהחליט"} for k, f in enumerate(findings, 1)]
    for i in issues:
        if i["severity"] == "blocker":
            review_items.append({"id": f"issue:{i['code']}", "kind": "content", "card": None, "t0": None, "t1": None, "text": None, "original": i["message"], "verdict": "needs_decision", "explanation": "", "ask": "נדרשת החלטה שלך"})
    failed = [r["id"] for r in records if r["status"] in ("fail", "review")]
    final_sha = sha256_file(final)
    provenance = {"reviewed_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "final_sha256": final_sha, "reviewed_sha256": final_sha, "on_delivered_file": True, "review_rounds": 1,
                  "delivered_round": 0, "model_review_ran": reviewed, "basis": "הבדיקות נמדדו על הקובץ הסופי. הערכת המודל נעשתה על פריים אחד לכל קטע מאותו קובץ — לא צפייה בתנועה ולא האזנה."}
    prev_review = options.get("previous_review") if isinstance(options.get("previous_review"), dict) else None
    final_review = review.final(dana_review, None, provenance, review_items, records, prev_review, tg, None)
    final_review["limits"] = ["המודל ראה פריים אחד לכל קטע: הוא לא צפה בתנועה ולא שמע דבר", "דנה אינה מזהה תרגילים ואינה שופטת איכות ביצוע",
                              "איש לא האזין למיקס", "הדירוג אינו אישור פרסום", "כל שינוי בסרטון הופך את הביקורת הזו ללא עדכנית"]

    # ── the edit map and the timeline ──
    sound = lambda s: ("מושתק" if (audio.get("original") or {}).get("mode") == "mute" or s["n"] in ((audio.get("original") or {}).get("mute_segments") or []) else "הסאונד המקורי") \
        + (" + קריינות" if nar else "") + (" + מוזיקה" if music else "")
    timeline = {"note": "כל קטע עם קובץ המקור והזמן בתוך הקובץ. המעברים הם חיתוכים ישרים.",
                "spans": [{"t0": s["tl_in_s"], "t1": s["tl_out_s"], "seconds": round(s["tl_out_s"] - s["tl_in_s"], 2), "picture": "footage",
                           "picture_label": f"{s['source_name']} · {s['file_in_s']:.1f}–{s['file_out_s']:.1f}s" + (f" — {s['seen']}" if s.get("seen") else ""),
                           "skill": "כללי הלקט הבסיסיים", "text": plan_meta["title"] if s["n"] == 1 and graphics else "", "text_layer": "כותרת עריכתית" if s["n"] == 1 and graphics else "אין טקסט",
                           "audio": sound(s), "assets": f"קובץ מקור: {s['source_name']}", "transition_in": "פתיחה" if s["n"] == 1 else "חיתוך ישר" + (" על פעימה" if segs[s["n"] - 2].get("on_beat") else "")}
                          for s in segs],
                "events": [{"t0": g["tl_start_s"], "t1": g["tl_end_s"], "kind": g["kind"], "label": f"{g['label']}: {g['text']}", "layer": "over_picture", "skill": "דנה", "why": g["reason"]} for g in graphics]}
    outputs = [{"name": "final.mp4", "what": "הלקט", "seconds": dur}]
    for name, payload in (("captions.json", [{k: c[k] for k in ("i", "start", "dur", "plain")} for c in cards]), ("transcript_source.json", {"words": [], "note": "לקט: לא בוצע תמלול"}), ("transcript_final.json", {"words": [], "note": "לקט: לא בוצע תמלול"})):
        write_json(j.out / name, payload)
    write_json(j.out / "checks.json", {"pipeline_version": PIPELINE_VERSION, "records": records})
    ed = {"status": "ready_for_owner_review" if not failed else "stopped_with_issues", "stop_reason": "montage_single_pass", "revisions": 0, "cycles": [], "delivered_cycle": 0,
          "criteria": [], "rules_in_force": ["כתוביות נוצרות רק לקריינות שהועלתה (מתמלול אוטומטי, לא מאומת)", "המעברים הם חיתוכים ישרים בלבד"],
          "budget": {"cost_usd_reported": round(sum(float(u.get("cost_usd") or 0) for u in usages), 4), "seconds": round(time.time() - j.t0, 1), "max_cycles": 0},
          "note": "לקט מופק במעבר אחד: תכנון לפי פריימים, רינדור, מיקס, בדיקות וביקורת על הקובץ הסופי. אין סבבי תיקון אוטומטיים."}
    write_json(j.out / "editorial.json", ed)
    cost = round(sum(float(u.get("cost_usd") or 0) for u in usages), 4)
    package = {
        "pipeline_version": PIPELINE_VERSION, "status": "success" if not failed and not review_items else "review_required", "kind": "montage", "judgement_mode": judgement_mode,
        "revision_mode": "locked_to_previous_plan" if locked else None, "project_type": options.get("project_type") or "montage",
        "source": {"sha256": sha_before, "duration": sp["duration"], "files": len(smap)}, "source_map": [{k: m[k] for k in m if k != "marks"} | {"marks": m.get("marks") or []} for m in smap],
        "segment": {"in_s": segs[0]["source_in_s"], "out_s": segs[-1]["source_out_s"]}, "duration": dur, "adapter": "claude" if judgement_mode == "model" else "heuristic",
        "judgement_usage": {"calls": usages, "cost_usd_reported": cost},
        "plan": {"kind": "montage", "message": plan_meta["message"], "hook": plan_meta["opening_why"], "rationale": plan_meta["sequence_why"], "opening_why": plan_meta["opening_why"], "title": plan_meta["title"],
                 "content_judgement": "model" if judgement_mode == "model" else "none", "segments": [{k: v for k, v in s.items() if k not in ("window_out_s", "candidate", "n_prev")} for s in segs],
                 "brief": [], "model_error": model_error, "candidates_considered": len(cands),
                 "basis": "מדידת תנועה, חדות ובהירות בכל המקורות, ופריים אחד לכל רגע מועמד. המודל לא צפה בתנועה ולא שמע את האודיו; הוא אינו מזהה תרגילים ואינו שופט איכות ביצוע."},
        "montage": {"candidates": [{k: c[k] for k in ("n", "name", "in_s", "out_s", "movement", "sharpness", "must")} for c in cands], "limits_s": [lo, hi], "notes": notes, "unused_sources": unused, "doubts": plan_meta["doubts"]},
        "zooms": [], "graphics": [{k: v for k, v in g.items() if k != "frames"} for g in graphics], "graphics_dropped": graphics_dropped, "spoken_text": " ".join(w["word"] for w in nar_words),
        "cards": [{"i": c["i"], "text": c["plain"], "lines": [c["plain"]], "highlight": [], "start": c["start"], "dur": c["dur"], "source_start_s": c["start"], "source_end_s": round(c["start"] + c["dur"], 3),
                   "of": "narration"} for c in cards],
        "adjustments": {"color": {"enabled": False, "applied": False, "note": "תיקון צבע לא מופעל בלקט בגרסה הזו"}, "audio_cleanup": {"enabled": False, "applied": False},
                        "zooms": {"enabled": False, "count": 0}, "caption_animation": {"enabled": False, "applied": "none"},
                        "graphics": {"enabled": True, "applied": bool(graphics), "count": len(graphics), "engine": "HyperFrames"}, "animation": {"enabled": False, "allowed": False, "applied": False, "count": 0}},
        "mix": mix_rec, "dana_review": dana_review, "final_review": final_review, "review_provenance": provenance, "review_compact": review.compact(dana_review), "timeline": timeline,
        "target": {"key": tg, "label": tspec["label"], "max_parts": tspec.get("max_parts"), "part_max_s": tspec.get("part_max_s"), "cover_text": False, "post_caption": False, "publish": tspec["publish"],
                   "safe_zone": {k: v for k, v in zone_used.items() if not k.startswith("_")}}, "outputs": outputs,
        "style": {k: st.get(k) for k in ("caption_size", "caption_y_px", "caption_max_lines", "font_family")} | {"captions_enabled": bool(cards)}, "captions_added": bool(cards), "captions_of": "narration" if cards else None,
        "cover": {"text": "", "frame_s": round(min(0.6, dur / 2), 2), "source": "first_part"}, "caption": {"text": "", "cta": None, "is_draft": True, "note": "ללקט לא נכתבת טיוטת קפשן אוטומטית"},
        "checks": records, "failed_checks": failed, "issues": issues, "review_items": review_items, "editorial": ed,
        "rules_used": {"skill": {"name": "dana-montage", "version": RUBRIC}, "profile": None, "references": []},
        "tools": {"ffmpeg": tool(cfg, "ffmpeg"), "motion_graphics": "HyperFrames"}, "timings_s": j.timings, "total_s": round(time.time() - j.t0, 1)}
    write_json(j.out / "package.json", package)
    return package["status"], package


def mixer_probe(cfg, path):
    from .core import probe as _p
    try:
        return float(_p(cfg, path)["duration"])
    except Exception:
        r = run([tool(cfg, "ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], "mix_failed", timeout=60)
        return float((r.stdout or b"0").decode().strip() or 0)
