# -*- coding: utf-8 -*-
"""Orchestrator: one source clip -> one vertical reel + review package.

    python -m dana_pipeline.run --config worker.config.json --job-dir <dir> --source <file>

Stages (each leaves inspectable files in the job folder):
    plan    → editorial/plan.json                    what, why, exact words, brief, facts, missing info
    edit    → out/final.mp4, out/cover.jpg, checks   the canonical pipeline executes the plan
    review  → editorial/cycle_N.json                 findings on the RESULT; actionable ones go back to the editor
At most `editorial.max_cycles` revisions inside a time and cost budget.

Non-interactive: it never prompts and never opens a player. The outcome is always written to
<job-dir>/result.json and mirrored by the exit code:

    0 success          package ready, every automated check passed
    2 review_required  package ready, but something needs the owner (see review_items)
    3 waiting          cannot continue without something external (e.g. decisions)
    1 failure          no package; result.json carries code / message / retryable
"""
import argparse
import hashlib
import json
import shutil
import sys
import time
import traceback
from pathlib import Path

from . import PIPELINE_VERSION, adjust, captions, checks, editorial, effective, interpret, judgement, motion, readable, review
from . import review as review_rubric
from . import skillgen
from . import target as target_mod
from . import story
from .align import Alignment
from .core import (EXIT, FAILURE, REVIEW_REQUIRED, STYLE_OVERRIDABLE, SUCCESS, WAITING, PipelineError, Waiting,
                   load_config, probe, read_json, run, sha256_file, tool, utf8_stdout, write_json)


class Job:
    def __init__(self, cfg, job_dir, source):
        self.cfg, self.dir, self.source = cfg, Path(job_dir), Path(source)
        self.out, self.work, self.ed = self.dir / "out", self.dir / "work", self.dir / "editorial"
        for d in (self.out, self.work, self.ed):
            d.mkdir(parents=True, exist_ok=True)
        self.job = read_json(self.dir / "job.json") if (self.dir / "job.json").is_file() else {}
        self.timings, self.stages, self.t0 = {}, [], time.time()
        over = {k: v for k, v in ((self.job.get("options") or {}).get("style_overrides") or {}).items()
                if k in STYLE_OVERRIDABLE}
        self.style = dict(cfg["style"], **over)
        self.style_overrides = over
        self.options = dict(self.job.get("options") or {})

    def stage(self, name):
        job = self

        class _S:
            def __enter__(s):
                s.t = time.time()
                job.stages.append({"stage": name, "status": "running"})
                job.save_state()
                print(f"[stage] {name}", flush=True)

            def __exit__(s, et, ev, tb):
                job.timings[name] = round(job.timings.get(name, 0) + time.time() - s.t, 2)
                job.stages[-1].update(status="failed" if et else "done", seconds=round(time.time() - s.t, 2))
                job.save_state()
                return False
        return _S()

    def save_state(self):
        write_json(self.dir / "state.json", {"pipeline_version": PIPELINE_VERSION, "stages": self.stages,
                                             "elapsed_s": round(time.time() - self.t0, 1)})


def to16k(cfg, src, dst):
    run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-i", src, "-vn", "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", dst],
        "check_decode_failed", timeout=600)
    return dst


def crop_fractions(sp, boxes):
    """Face boxes in source pixels → fractions of the centred 9:16 crop the render uses."""
    sw, sh = sp["display_width"], sp["display_height"]
    cw, ch = min(sw, sh * 9 / 16), min(sh, sw * 16 / 9)
    x0, y0 = (sw - cw) / 2, (sh - ch) / 2
    return [None if b is None else ((b[0] - x0) / cw, (b[1] - y0) / ch, b[2] / cw, b[3] / ch) for b in boxes or []]


def render_base_and_voice(j, src_probe, in_s, out_s, last_word_end_tl, seg_words):
    cfg, st = j.cfg, j.style
    dur = round(out_s - in_s, 3)
    W, H = st["width"], st["height"]
    rng = ":in_range=full:out_range=tv" if src_probe["full_range"] else ""
    plain = f"scale={W}:{H}:force_original_aspect_ratio=increase{rng},crop={W}:{H}"
    measure_vf = plain
    zf = story.zoom_filter(getattr(j, "active_zooms", None), W, H)
    if zf:        # crop the source to 9:16 once, then scale straight to the zoom level (no second scaling of the picture)
        plain = "crop='min(iw,ih*9/16)':'min(ih,iw*16/9)'," + zf.replace(":eval=frame", f"{rng}:eval=frame")
    # ── picture: measured on the SOURCE cut (so a later version never corrects a corrected picture) ──
    if not adjust.enabled(j.options, "color"):
        color = {"enabled": False, "applied": False, "decisions": ["תיקון הצבע כובה לפרויקט הזה"]}
    elif not st["captions_enabled"] and not j.options.get("polish"):
        color = {"enabled": True, "applied": False, "skipped": "edited_source",
                 "decisions": ["המקור כבר ערוך (כתוביות צרובות) — לא מתקנת צבע של סרטון שכנראה כבר תוקן, כדי לא לתקן פעמיים"]}
    else:
        times = [round(in_s + dur * (k + 0.5) / 6, 2) for k in range(6)]
        boxes = story.faces_at(cfg, j.source, times)
        color = dict(adjust.plan_color(cfg, j.source, times, crop_fractions(src_probe, boxes) if boxes else None, measure_vf), enabled=True)
        color["frames_s"] = [round(t - in_s, 2) for t in times]
    j.plain_vf, j.color = plain, color
    vf = plain + ("," + color["filter"] if color.get("filter") else "") + ",format=yuv420p"
    base = j.work / "base.mp4"
    run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-ss", f"{in_s}", "-t", f"{dur}", "-i", j.source,
         "-vf", vf, "-r", str(st["fps"]), "-an", "-c:v", "libx264", "-crf", "10", "-preset", "medium",
         "-pix_fmt", "yuv420p", base], "render_failed", timeout=cfg["timeouts"]["ffmpeg_s"])
    a = cfg["audio"]
    raw = j.work / "voice_raw.wav"
    run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-ss", f"{in_s}", "-t", f"{dur}", "-i", j.source,
         "-vn", "-ar", "48000", "-c:a", "pcm_s24le", raw], "render_failed", timeout=cfg["timeouts"]["ffmpeg_s"])
    # ── sound: clean only what the measurement calls for, then normalise the level ──
    if adjust.enabled(j.options, "audio_cleanup"):
        audio, voice_in = adjust.plan_audio(cfg, raw, seg_words, j.work)
        audio["enabled"] = True
    else:
        audio, voice_in = {"enabled": False, "applied": False, "decisions": ["ניקוי הסאונד כובה לפרויקט הזה"]}, raw
    j.audio = audio
    m = checks.measure_loudness(cfg, voice_in)
    fo_st = min(max(last_word_end_tl, dur - 0.20), dur - 0.03)
    fo_d = max(0.02, min(0.15, dur - fo_st))
    af = (f"loudnorm=I={a['target_lufs']}:TP={a['target_peak_db']}:LRA=11:measured_I={m['input_i']}:"
          f"measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:"
          f"offset={m['target_offset']}:linear=true,aresample=48000,afade=t=in:st=0:d=0.02,"
          f"afade=t=out:st={fo_st:.3f}:d={fo_d:.3f},apad=whole_dur={dur}")
    voice = j.work / "voice.wav"
    run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-i", voice_in, "-af", af, "-ar", "48000", "-c:a", "pcm_s24le",
         "-t", f"{dur}", voice], "render_failed", timeout=cfg["timeouts"]["ffmpeg_s"])
    return base, voice, dur, {"source_lufs": float(m["input_i"]), "source_true_peak": float(m["input_tp"])}


def make_compare(j, in_s, dur, final, graphics, zooms):
    """Before / after material: the same moments of the cut without colour correction, graphics and captions
    (left) and the finished file (right) - three stills and one short clip. Returns the record for the package."""
    cfg, st = j.cfg, j.style
    anchor = (graphics[0]["tl_start_s"] - 0.6) if graphics else (zooms[0]["tl_t_s"] - 1.0) if zooms else dur / 2 - 3
    t0 = round(min(max(anchor, 0.0), max(0.0, dur - 6.0)), 2)
    span = round(min(6.0, dur - t0), 2)
    before = j.work / "before.mp4"
    run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-ss", f"{in_s}", "-t", f"{dur}", "-i", j.source, "-vf", j.plain_vf + ",format=yuv420p",
         "-r", str(st["fps"]), "-an", "-ss", f"{t0}", "-t", f"{span}", "-c:v", "libx264", "-crf", "16", "-preset", "veryfast", "-pix_fmt", "yuv420p", before],
        "compare_failed", timeout=cfg["timeouts"]["ffmpeg_s"])
    times = [round(t0 + span * k, 2) for k in (0.15, 0.5, 0.85)]
    adjust.compare_frames(cfg, before, final, times, j.out / "compare_frames.jpg", before_offset=t0)
    adjust.compare_clip(cfg, before, final, t0, span, j.out / "compare_clip.mp4")
    return {"frames_s": times, "clip_s": [t0, round(t0 + span, 2)], "frames": "compare_frames.jpg", "clip": "compare_clip.mp4",
            "left": "הקטע בלי תיקון צבע, בלי גרפיקה ובלי כתוביות", "right": "הסרטון הסופי",
            "sound": "בקליפ נשמע הסאונד הסופי בלבד; ההבדל בסאונד מוצג כמספרים שנמדדו"}


def make_cover(j, base, cover):
    cfg, st = j.cfg, j.style
    frame = j.work / "cover_frame.png"
    run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-ss", f"{cover['frame_s']}", "-i", base, "-frames:v", "1", frame],
        "cover_failed", timeout=300)
    out = j.out / "cover.jpg"
    if cover["text"]:
        png_dir = captions.render_png(cfg, st, [{"name": "cover", "text": cover["text"], "highlight": []}],
                                      j.work / "cover", size_key="cover_size", y_key="cover_y_px")
        run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-i", frame, "-i", png_dir / "cover.png",
             "-filter_complex", "[0:v][1:v]overlay=format=auto", "-frames:v", "1", "-q:v", "2", out], "cover_failed", timeout=300)
    else:
        run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-i", frame, "-frames:v", "1", "-q:v", "2", out], "cover_failed", timeout=300)
    return out


def as_raw(dec):
    """Validated decisions → the model-facing shape (for a revision's <previous_version> and for tests)."""
    s = dec["segment"]
    return {"segment": {"in_s": s["in_s"], "out_s": s["out_s"], "message": s["complete_thought"], "stands_alone": s["reason"],
                        "audience": s["audience_relevance"] or None},
            "cards": [{"text": c["text"], "highlight": list(c["highlight"])} for c in dec["cards"]],
            "cover": dict(dec["cover"]), "caption": {"text": dec["caption"]["text"], "cta": dec["caption"]["cta"]},
            "spelling": [{"heard": x["heard"], "shown": x["shown"], "context": x["reason"]} for x in dec["spelling"]],
            "objective": dec["plan"]["objective"], "brief": dec["plan"]["brief"], "facts_used": dec["plan"]["facts_used"],
            "missing_info": dec["plan"]["missing_info"], "adapter": dec["adapter"]}


def hard_failures(records):
    """How many mandatory automatic checks failed. A revision may not make this number worse."""
    return sum(1 for r in records if r["status"] == "fail")


def edit(j, dec, words, sp, sha_before, check, cache):
    """EDIT stage: execute the decisions through the canonical pipeline and run every check."""
    cfg, st = j.cfg, j.style
    groups = cfg["language"]["homophone_groups"]
    in_s, out_s = dec["segment"]["in_s"], dec["segment"]["out_s"]
    issues, records = [], []
    shift = round(getattr(j, "plan_shift_src", in_s) - in_s, 3)        # content-plan timeline → this cut's timeline
    W, H = st["width"], st["height"]
    k = max(W / sp["display_width"], H / sp["display_height"])
    to_out = lambda b: b and (b[0] * k - (sp["display_width"] * k - W) / 2, b[1] * k - (sp["display_height"] * k - H) / 2, b[2] * k, b[3] * k)
    zooms = [dict(z, tl_t_s=round(z["tl_t_s"] + shift, 3), hold_until_s=round(min(z["hold_until_s"] + shift, out_s - in_s), 3))
             for z in getattr(j, "zooms", []) if z["tl_t_s"] + shift >= 0]
    if zooms:
        zb = story.faces_at(cfg, j.source, [in_s + z["tl_t_s"] + z["ease_s"] for z in zooms])
        story.zoom_focus(zooms, [to_out(b) for b in zb] if zb else None, W, H)
    if not adjust.enabled(j.options, "zooms"):
        zooms = []
    j.active_zooms = zooms
    anim_name = st.get("caption_animation") if adjust.enabled(j.options, "caption_animation") else "none"
    animation = captions.ANIMATIONS.get(anim_name)
    all_planned = motion.shift(getattr(j, "graphics", []), shift, round(out_s - in_s, 3)) if st["captions_enabled"] else []
    planned_scenes = [g for g in all_planned if g.get("layer") == "replaces_picture"]
    planned_graphics = [g for g in all_planned if g.get("layer") != "replaces_picture"]
    plan_cover = (getattr(j, "story", None) or {}).get("cover") or {}
    if plan_cover.get("tl_s") is not None:               # the cover frame is the moment the quoted words are said
        dec["cover"]["frame_s"] = round(min(max(plan_cover["tl_s"] + shift + 0.2, 0.0), out_s - in_s - 0.1), 3)
    key = hashlib.sha1(json.dumps([in_s, out_s, dec["cards"], st, zooms, j.options.get("adjustments"), anim_name, all_planned], ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    spans, skipped = check(dec)
    inner = [s for s in skipped if s["before_card"] not in (1, None)]
    edge = [s for s in skipped if s["before_card"] in (1, None)]
    if inner:
        issues.append(judgement.issue(
            "words_omitted_inside_segment", "blocker",
            "מילים שנאמרו באמצע הקטע ואינן בכתוביות (סכנה לשינוי משמעות): "
            + " | ".join(f"לפני כרטיס {s['before_card']}: " + " ".join(w["word"] for w in s["words"]) for s in inner)))
    if edge:
        issues.append(judgement.issue("words_at_segment_edge_not_captioned", "warn",
                                      "מילים בקצה הקטע שאינן בכתוביות: " + " ".join(w["word"] for s in edge for w in s["words"])))
    if dec["caption"]["cta"] is None:
        issues.append(judgement.issue("cta_missing", "warn", "אין CTA: לא הוגדרה הצעה/קריאה לפעולה מאושרת בהגדרות המותג"))
    issues.append(judgement.issue("caption_is_draft", "info", "הקפשן הוא טיוטה — אין עדיין פרופיל קול מאושר"))

    if cache.get("key") == key:                  # same cut and same cards: only text assets changed
        r = dict(cache["res"])
        with j.stage("cover"):
            make_cover(j, r["base"], dec["cover"])
        r.update(issues=issues, reused_render=True)
        return r

    with j.stage("render_base"):
        base, voice, dur, audio_src = render_base_and_voice(j, sp, in_s, out_s, spans[-1][-1]["end"], [w for g in spans for w in g])
        records.append(checks.check_boundary(words, in_s, out_s, checks.level_db(j.work / "voice_raw.wav", 0.0, 0.05),
                                              checks.room_tone_db(j.work / "voice_raw.wav"),
                                              checks.level_db(j.work / "voice_raw.wav", max(0.0, dur - 0.05), dur)))
    # ── animation scenes: for their seconds they REPLACE the footage in the picture track (the voice is untouched) ──
    plain_base, scenes, scenes_dropped = base, [], []
    if planned_scenes:
        with j.stage("animation"):
            for g in planned_scenes:
                try:
                    frames_dir, n = motion.render_scene(cfg, st, g, j.work / "scenes")
                    scenes.append(dict(g, frames=str(frames_dir), frames_n=n))
                except PipelineError as e:        # reported, never left as "planned only"
                    scenes_dropped.append({"kind": g["kind"], "quote": g["text"], "why": f"הרינדור ב-HyperFrames נכשל ({e.code}) — קטע האנימציה לא נוסף לסרטון"})
                    issues.append(judgement.issue("animation_scene_not_rendered", "warn", f"קטע האנימציה '{g['text']}' לא נוסף: הרינדור ב-HyperFrames נכשל ({e.code})"))
            if scenes:
                base = motion.apply_scenes(cfg, plain_base, scenes, j.work / "base_scenes.mp4", st["fps"], cfg["timeouts"]["ffmpeg_s"])

    with j.stage("measure_picture"):
        zone = read_json(cfg["paths"]["safe_zone"])
        sample_t = [round(0.4 + n * max(0.0, dur - 0.8) / 11, 2) for n in range(12)]
        face_boxes = story.faces_at(cfg, base, sample_t)
        prof = getattr(j, "profile", None)
        cap_pos = None
        if prof and "caption_y_px" not in j.style_overrides:
            y, cap_pos = story.caption_position(prof, st, zone, face_boxes, st["caption_max_lines"])
            st["caption_y_px"] = y
        elif prof:
            cap_pos = {"preferred_y": prof["params"]["caption_y_px"], "chosen_y": st["caption_y_px"], "face_band": None,
                       "note": "מיקום שקבע הבעלים — לא הוזז אוטומטית"}
        if prof and dec["cover"]["text"]:
            cb = story.faces_at(cfg, base, [dec["cover"]["frame_s"]])
            st["cover_y_px"] = story.caption_position(dict(prof, params=dict(prof["params"], caption_y_px=st["cover_y_px"])),
                                                      dict(st, caption_size=st["cover_size"]), zone, cb, 1)[0]
        if zooms:
            m = (prof or {"params": {}})["params"].get("zoom_face_margin", 0.04)
            zt = [round(min(z["tl_t_s"] + z["ease_s"] + 0.1, z["hold_until_s"] - 0.04), 2) for z in zooms] + \
                 [round((z["tl_t_s"] + z["hold_until_s"]) / 2, 2) for z in zooms] + [round(z["hold_until_s"] - 0.08, 2) for z in zooms]
            zb2 = story.faces_at(cfg, base, zt)
            if zb2 is None:
                records.append(checks.rec("zoom_face_inside", "review", "לא ניתן היה למדוד את מיקום הפנים בזמן הזומים — לבדיקת הבעלים"))
            else:
                bad = [f"{t}s" for t, b in zip(zt, zb2) if b is None or b[0] < m * W or b[0] + b[2] > W * (1 - m)
                       or b[1] - 0.3 * b[3] < 0 or b[1] + b[3] * 1.15 > H]
                records.append(checks.rec("zoom_face_inside", "fail" if bad else "pass",
                                          (f"בזמן זום הפנים חתוכות או לא זוהו ב: {', '.join(bad)}" if bad else
                                           f"הפנים בתוך הפריים בכל {len(zt)} הפריימים שנדגמו בזמן הזומים")
                                          + " (נמדד בפריימים בודדים; אינו בדיקה של תחושת התנועה)", frames_s=zt))

    with j.stage("align"):
        # The reference is the FINAL audio: the words as they are heard in the cut, normalised voice track.
        v16 = to16k(cfg, voice, j.work / "voice_16k.wav")
        align = Alignment(v16, cfg["alignment"]["vad_min_silence_ms"])
        timing_source = "final_audio"
        own = story.owner_groups([w for w in words if w["end"] > in_s + 0.05 and w["start"] < out_s - 0.05], in_s)
        voice_words = story.keep_owner_corrections(checks.transcribe(cfg, v16)["words"], own)[0]

    with j.stage("render_cards"):
        joined, layouts, two_lined = {}, {}, set()
        for split_round in range(4):
            try:
                tspans, _ = captions.align_cards(dec["cards"], voice_words, groups)
            except PipelineError:
                tspans, timing_source = check(dec)[0], "source_transcript"   # same words, stamps from the source transcript
            cards = captions.time_cards(dec["cards"], tspans, st["fps"], cfg["cards"]["hold_after_s"], dur, align)
            if split_round == 0:
                # Routine fix: the same words, in the same order, are divided into cards again so that as few as possible flash by.
                # Only divisions that fit the safe width on the allowed number of lines are considered (measured, not guessed), so a
                # join is never made and then undone.
                fit_zone = read_json(cfg["paths"]["safe_zone"])
                line_px = captions.max_line_px(fit_zone, st["width"])
                one_line = st["caption_max_lines"] < 2
                fits = lambda t: len(t) <= cfg["cards"]["merge_max_chars"] and (not one_line or captions.text_px(cfg, st, t) <= line_px)
                j.caption_fit = {"line_px": line_px, "caption_size": st["caption_size"], "max_lines": st["caption_max_lines"], "fits": fits}
                max_words = int(((getattr(j, "profile", None) or {}).get("params") or {}).get("max_words_per_line", 3)) * int(st["caption_max_lines"])
                new, fit_stats = captions.regroup(dec["cards"], tspans, fits, cfg["cards"]["min_on_screen_s"], cfg["cards"]["max_chars_per_s"],
                                                  max(max_words, 2), cfg["cards"]["hold_after_s"])
                j.caption_fit["stats"] = fit_stats
                if fit_stats["runs_changed"]:
                    issues.append(judgement.issue("cards_regrouped", "info",
                                                  f"המילים חולקו מחדש לכרטיסים (אותן מילים, אותו סדר) כדי שפחות כרטיסים יחלפו מהר מדי: "
                                                  f"{fit_stats['bad_before']} קצרים לפני, {fit_stats['bad_after']} אחרי (הערכה לפי זמני המילים)"))
                    dec["cards"] = new
                    continue
            if split_round <= 1 and planned_scenes and not getattr(j, "_scene_cut_done", None) == id(dec):
                # the words a full-frame scene shows get cards of their own (not drawn over it); the words around them keep theirs
                j._scene_cut_done = id(dec)
                new, made = motion.isolate_scene_words(dec["cards"], tspans, planned_scenes)
                if made:
                    issues.append(judgement.issue("cards_cut_at_scene", "info", f"{made} כרטיסים נחתכו בגבול קטע האנימציה (אותן מילים, אותו סדר), כדי שהמילים שבסצנה לא יוצגו פעמיים"))
                    dec["cards"] = new
                    continue
            png_dir = captions.render_png(cfg, st, [{"name": f"c{c['i']:03d}", "text": layouts.get(c["plain"], c["plain"]), "highlight": c["highlight"]}
                                                    for c in cards], j.work / "caps")
            width, zone = checks.check_width(png_dir, cards, st["width"]), checks.check_safe_zone(cfg, png_dir, cards)
            too_wide = sorted(set(width["data"]["cards"]) | set(zone["data"]["cards"]))
            # Routine fix 1: a card that is too wide on one line is laid out on two (same words, same order).
            relaid = [i for i in too_wide if st["caption_max_lines"] >= 2 and dec["cards"][i - 1]["text"] not in layouts
                      and captions.two_lines(dec["cards"][i - 1]["text"])]
            if relaid and split_round < 3:
                for i in relaid:
                    layouts[dec["cards"][i - 1]["text"]] = captions.two_lines(dec["cards"][i - 1]["text"])
                two_lined.update(relaid)
                continue
            splittable = [i for i in too_wide if len(dec["cards"][i - 1]["text"].split()) > 1]
            if not splittable or split_round == 3:
                break
            # Routine fix: a card that does not fit is split in two. Same words, same order.
            new = []
            for n, c in enumerate(dec["cards"], 1):
                w = c["text"].split()
                if n in splittable and c["text"] in joined:
                    new += joined[c["text"]]              # a join that does not fit the safe zone is undone
                elif n in splittable:
                    for part in (w[:(len(w) + 1) // 2], w[(len(w) + 1) // 2:]):
                        text = " ".join(part)
                        new.append({"text": text, "highlight": [h for h in c["highlight"] if h in text]})
                else:
                    new.append(c)
            issues.append(judgement.issue("cards_split_to_fit", "info",
                                          f"כרטיסים שלא נכנסו לאזור הבטוח פוצלו לשניים: {splittable} (אותן מילים, אותו סדר)"))
            dec["cards"] = new
        records += [width, zone]

    burned_cards = cards
    if not st["captions_enabled"]:        # the cards stay as DATA (text + times); nothing is drawn over the source's own captions
        cards = []
        records[:] = [r for r in records if r["id"] not in ("caption_width", "safe_zone")]
        records.append(checks.rec("captions_not_added", "info", "במקור כבר צרובות כתוביות — דנה לא הוסיפה שכבת כתוביות נוספת"))
    elif face_boxes is not None:
        cbx = story.faces_at(cfg, base, [round(c["start"] + c["dur"] / 2, 2) for c in cards]) or []
        hit = []
        for c, fb in zip(cards, cbx):
            ink = checks._ink_box(Path(png_dir) / f"c{c['i']:03d}.png")[1]
            if fb and ink and ink[1] < fb[1] + fb[3] and ink[3] > fb[1] and ink[0] < fb[0] + fb[2] and ink[2] > fb[0]:
                hit.append(c["i"])
        if hit and prof and "caption_y_px" not in j.style_overrides and not getattr(j, "_face_retry", None) == key:
            # The position was chosen from 12 sampled frames; the speaker moved at these cards. Measure again with their
            # frames included and move ALL the captions together (one position for the whole video), then draw them again.
            j._face_retry = key
            more = [fb for c, fb in zip(cards, cbx) if c["i"] in hit and fb]
            y2, pos2 = story.caption_position(prof, st, read_json(cfg["paths"]["safe_zone"]), list(face_boxes) + more, st["caption_max_lines"])
            if y2 != st["caption_y_px"]:
                issues.append(judgement.issue("captions_moved_off_face", "info", f"הכתוביות הוזזו מ-{st['caption_y_px']}px ל-{y2}px: בכרטיסים {hit} הן כיסו את הפנים (נמדד שוב עם הפריימים של הכרטיסים האלה)"))
                st["caption_y_px"], cap_pos = y2, dict(pos2, note=pos2["note"] + " · נמדד שוב אחרי שכתובית כיסתה את הפנים")
                png_dir = captions.render_png(cfg, st, [{"name": f"c{c['i']:03d}", "text": layouts.get(c["plain"], c["plain"]), "highlight": c["highlight"]} for c in cards], j.work / "caps")
                records[:] = [r for r in records if r["id"] not in ("caption_width", "safe_zone")] + [checks.check_width(png_dir, cards, st["width"]), checks.check_safe_zone(cfg, png_dir, cards)]
                hit = []
                for c, fb in zip(cards, cbx):
                    ink = checks._ink_box(Path(png_dir) / f"c{c['i']:03d}.png")[1]
                    if fb and ink and ink[1] < fb[1] + fb[3] and ink[3] > fb[1] and ink[0] < fb[0] + fb[2] and ink[2] > fb[0]:
                        hit.append(c["i"])
        records.append(checks.rec("caption_face_overlap", "fail" if hit else "pass",
                                  (f"כתוביות שמכסות את אזור הפנים שנמדד: {hit}" if hit else f"אף אחת מ-{len(cards)} הכתוביות אינה מכסה את אזור הפנים שנמדד")
                                  + " (פריים אחד לכל כתובית)", cards=hit))
    # ── motion graphics (HyperFrames): placed clear of the face and of the captions, rendered, then overlaid ──
    graphics, graphics_dropped, g_faces = [], list(scenes_dropped), {}
    if planned_graphics:
        with j.stage("graphics"):
            zone = read_json(cfg["paths"]["safe_zone"])
            for g in planned_graphics:
                g_faces[g["id"]] = story.faces_at(cfg, base, [round(g["tl_start_s"] + 0.3, 2), round((g["tl_start_s"] + g["tl_end_s"]) / 2, 2), round(g["tl_end_s"] - 0.3, 2)]) or []
            inks = [b for b in (checks._ink_box(Path(png_dir) / f"c{c['i']:03d}.png")[1] for c in cards) if b]
            band = (min(b[1] for b in inks), max(b[3] for b in inks)) if inks else None
            placed, not_placed = motion.place(planned_graphics, zone, g_faces, band, st["height"])
            graphics_dropped += not_placed
            for g in placed:
                try:
                    frames_dir, n = motion.render(cfg, st, g, j.work / "graphics")
                    graphics.append(dict(g, frames=str(frames_dir), frames_n=n, ink_box=motion.ink_box(frames_dir, n)))
                except PipelineError as e:        # a graphic that cannot be rendered is reported, never silently "planned only"
                    graphics_dropped.append({"kind": g["kind"], "quote": g["text"], "why": f"הרינדור ב-HyperFrames נכשל ({e.code}) — הגרפיקה לא נוספה לסרטון"})
                    issues.append(judgement.issue("graphic_not_rendered", "warn", f"{g['label']} '{g['text']}' לא נוספה: הרינדור ב-HyperFrames נכשל ({e.code})"))
    final = j.out / "final.mp4"
    attempts = []
    for attempt in range(cfg["sync"]["max_fix_attempts"] + 1):
        in_scene = motion.cards_in_scenes(cards, scenes)        # their words are on screen in the scene itself
        drawn = [c for c in cards if c["i"] not in in_scene]
        with j.stage("composite"):
            captions.composite(cfg, base, voice, drawn, png_dir, final, dur, animation=animation if drawn else None, graphics=graphics, fps=st["fps"])
        with j.stage("verify"):
            wav = to16k(cfg, final, j.work / "final_audio_16k.wav")            # the audio of the OUTPUT file
            heard, kept_notes = story.keep_owner_corrections(checks.transcribe(cfg, wav)["words"], own)
            sync = checks.verify_sync(cfg, cards, heard, wav, groups)         # locked rules, unchanged
            out_align = Alignment(wav, cfg["alignment"]["vad_min_silence_ms"])
            try:
                ospans, odiffs = captions.align_cards(dec["cards"], heard, groups) if cards else (None, [])
            except PipelineError as e:
                ospans, odiffs = None, []
                attempts.append({"attempt": attempt, "output_text_match": "failed", "reason": e.message})
            alignment = checks.alignment_check(cfg, cards, ospans, out_align) if ospans else None
            attempts.append({"attempt": attempt, "timing_source": timing_source, "locked_lead_fail": sync["lead_fail"],
                             "locked_not_found": sync["not_found"], "locked_tail_fail": sync["tail_fail"],
                             "alignment": alignment["status"] if alignment else "not_measured"})
        if not cards:
            ospans = None
        fixable = ospans and (alignment["status"] == "fail" or sync["tail_fail"])
        if not fixable or attempt == cfg["sync"]["max_fix_attempts"]:
            break
        new_cards = captions.time_cards(dec["cards"], ospans, st["fps"], cfg["cards"]["hold_after_s"], dur, out_align)
        if [(c["start"], c["dur"]) for c in new_cards] == [(c["start"], c["dur"]) for c in cards]:
            break                                   # nothing left to change automatically
        cards, timing_source = new_cards, "output_audio"
    records += checks.sync_records(sync)
    adjudications = []
    if alignment and cards:
        records += [alignment, checks.text_check(odiffs)]
        adjudications = checks.adjudicate_sync(cfg, sync, alignment)
    elif cards:
        records.append(checks.rec("alignment_reference", "fail", "לא ניתן להתאים את הכתוביות למילים שנשמעות בקובץ הסופי"))

    with j.stage("checks"):
        if cards:
            motion_rec, comfort = checks.cards_in_motion(cfg, final, base, png_dir, drawn, st["fps"], anim_s=animation["in_s"] if animation else 0.0)
            records += [motion_rec, comfort]
            if in_scene:
                records.append(checks.rec("captions_in_scene", "info",
                                          f"{len(in_scene)} כתוביות לא צוירו בזמן קטע האנימציה, כי המילים שלהן מוצגות בו: "
                                          + " | ".join(c["plain"] for c in cards if c["i"] in in_scene)
                                          + ". כתובית שיש בה מילה שאינה בסצנה נשארת מצוירת.", cards=sorted(in_scene)))
        else:
            motion_rec = {"data": {}}
        if graphics:
            records.append(motion.check(cfg, final, base, graphics, read_json(cfg["paths"]["safe_zone"]), g_faces, st["width"]))
        if scenes:
            records.append(motion.check_scenes(cfg, final, plain_base, scenes))
        records += [checks.check_output(cfg, final, dur), checks.check_loudness(cfg, final),
                    checks.check_source_unchanged(getattr(j, "orig_source", j.source), sha_before)]
        records += checks.HUMAN_CHECKS

    with j.stage("cover"):
        cover = make_cover(j, base, dec["cover"])
    with j.stage("compare"):
        try:
            compare = make_compare(j, in_s, dur, final, graphics, zooms)
        except PipelineError as e:
            compare = {"error": f"{e.code}: {e.message}"}
    gaps = [(b["start"] - a["end"], a["end"]) for a, b in zip(heard, heard[1:])]
    facts = {"first_word_s": heard[0]["start"] if heard else None,
             "longest_pause": {"s": round(max(gaps)[0], 2), "at_s": round(max(gaps)[1], 2)} if gaps else None,
             "face_inside": None}
    if face_boxes and any(face_boxes):
        W_, H_ = st["width"], st["height"]
        cut = [t for t, b in zip(sample_t, face_boxes) if b and (b[0] < 0 or b[0] + b[2] > W_ or b[1] < 0 or b[1] + b[3] > H_)]
        facts["face_inside"] = {"frames": len(face_boxes), "found": sum(1 for b in face_boxes if b), "bad": cut}

    c_cfg, comfort_rows = cfg["cards"], []
    by_i = {c["i"]: c for c in cards}
    for r in (motion_rec["data"].get("rows") or []):
        why = []
        if r["seconds"] < c_cfg["min_on_screen_s"]:
            why.append(f"על המסך {r['seconds']:.2f}s")
        if r["chars_per_s"] > c_cfg["max_chars_per_s"]:
            why.append(f"נקרא ב-{r['chars_per_s']:.0f} תווים/ש")
        if why:
            comfort_rows.append({"i": r["i"], "text": by_i[r["i"]]["plain"], "why": ", ".join(why), "t0": r["t0"]})
    # WHY a card that still flashes by could not be helped: measured against the width one line allows
    fit = getattr(j, "caption_fit", None)
    if fit and comfort_rows and st["captions_enabled"]:
        order = [c["i"] for c in cards]
        for row in comfort_rows:
            k = order.index(row["i"])
            near = [cards[k - 1]["plain"] + " " + row["text"]] if k > 0 and cards[k]["start"] - (cards[k - 1]["start"] + cards[k - 1]["dur"]) < 0.25 else []
            near += [row["text"] + " " + cards[k + 1]["plain"]] if k + 1 < len(cards) and cards[k + 1]["start"] - (cards[k]["start"] + cards[k]["dur"]) < 0.25 else []
            if not any(fit["fits"](t) for t in near):
                row["cannot"] = (f"איחוד עם כרטיס שכן חורג מרוחב השורה ({fit['line_px']}px באזור הבטוח, גודל {fit['caption_size']}, "
                                 f"{'שורה אחת' if fit['max_lines'] < 2 else str(fit['max_lines']) + ' שורות'}), והדיבור רציף — אין לאן להזיז את התזמון")
        blocked = [r for r in comfort_rows if r.get("cannot")]
        if blocked:
            issues.append(judgement.issue(
                "caption_rule_conflict", "warn",
                f"{len(blocked)} כרטיסים חולפים מהר מדי ואין חלוקה אחרת של המילים שפותרת זאת: בגודל {fit['caption_size']} וב"
                f"{'שורה אחת' if fit['max_lines'] < 2 else str(fit['max_lines']) + ' שורות'} נכנסים עד {fit['line_px']}px באזור הבטוח של היעד, "
                "והדיבור רציף. להכרעתך: גודל כתובית קטן יותר, שתי שורות, או לקבל את הכרטיסים כפי שהם.", cards=[r["i"] for r in blocked]))
    seg_words = [w for w in words if w["end"] > in_s + 0.05 and w["start"] < out_s - 0.05]
    cards = burned_cards if not st["captions_enabled"] else cards
    for c in cards:
        c["lines"] = layouts.get(c["plain"], c["plain"]).split("\n")
        if st["captions_enabled"] and c["i"] in in_scene:
            c["in_scene"] = in_scene[c["i"]]
    if two_lined and st["captions_enabled"]:
        issues.append(judgement.issue("cards_two_lines", "info", f"{len(two_lined)} כרטיסים הוצגו בשתי שורות כדי להיכנס לאזור הבטוח (אותן מילים, אותו סדר)"))
    for n in kept_notes:
        issues.append(judgement.issue("owner_correction_kept", "info",
                                      f"ב-{n['t0']}s התמלול החוזר שמע '{n['heard']}' במקום שבו תיקנת ל-'{n['owner']}'. התיקון שלך נשמר; זה מידע בלבד.",
                                      t0=n["t0"], heard=n["heard"], owner=n["owner"]))
    res = {"color": j.color, "audio_clean": j.audio, "graphics": [{k: v for k, v in g.items() if k != "frames"} for g in scenes + graphics],
           "graphics_dropped": graphics_dropped, "compare": compare, "facts": facts, "animation": anim_name if cards and st["captions_enabled"] else "none",
           "captions_added": bool(st["captions_enabled"]), "zooms": zooms, "caption_position": cap_pos, "shift": shift, "key": key, "cards": cards, "records": records, "sync": sync, "adjudications": adjudications, "odiffs": odiffs,
           "heard": heard, "dur": dur, "final": final, "base": base, "cover": cover, "png_dir": png_dir, "attempts": attempts,
           "timing_source": timing_source, "audio_src": audio_src, "motion_rows": motion_rec["data"].get("rows") or [],
           "spans": tspans, "voice": voice, "voice_words": voice_words, "comfort_rows": comfort_rows, "caption_fit": {k: v for k, v in (fit or {}).items() if k != "fits"} or None, "source_text": " ".join(w["word"] for w in seg_words), "issues": issues,
           "reused_render": False}
    cache.update(key=key, res=res)
    return res


def pipeline(j):
    cfg, st = j.cfg, j.style
    groups = cfg["language"]["homophone_groups"]
    options = j.options                      # one object: what the request interpretation changes is what the edit stage reads
    ecfg = cfg["editorial"]
    tg = target_mod.of(options)              # reel | story: changes the plan (structure, length), the safe zone, cover and caption
    tspec = target_mod.spec(tg)
    zone_used = target_mod.use_zone(cfg, tg, j.dir)

    with j.stage("source"):
        if not j.source.is_file():
            raise PipelineError("source_missing", f"source file not found: {j.source.name}")
        sha_before = sha256_file(j.source)
        want = ((j.job.get("source") or {}).get("sha256") or "").lower()
        if want and want != sha_before:
            raise PipelineError("source_hash_mismatch", "the downloaded source does not match the uploaded file", True)
        try:
            sp = probe(cfg, j.source)
        except PipelineError as e:
            raise PipelineError("source_unreadable", "הקובץ אינו וידאו שניתן לקרוא — יש להעלות קובץ אחר", False, e.detail)
        if not sp["has_audio"]:
            raise PipelineError("no_audio", "the source has no audio track — captions need speech")
        if sp["duration"] < cfg["segment"]["min_s"]:
            raise PipelineError("source_too_short", f"source is {sp['duration']:.1f}s; minimum {cfg['segment']['min_s']}s")
        base_issues = []
        if sp["display_width"] > sp["display_height"]:
            base_issues.append(judgement.issue("horizontal_source_cropped", "warn",
                                               "המקור אופקי — נחתך למרכז 9:16. יש לבדוק שהדובר/ת בפריים"))

    with j.stage("transcribe_source"):
        cache = Path(cfg["paths"]["work_root"]) / "cache" / "asr" / f"{sha_before}.json"
        if cache.is_file():
            tr = read_json(cache)
        else:
            t = time.time()
            tr = checks.transcribe(cfg, j.source, vad=True)
            tr["elapsed_s"] = round(time.time() - t, 1)
            write_json(cache, tr)
        words = tr["words"]
        write_json(j.out / "transcript_source.json", tr)
        if not words:
            raise PipelineError("no_speech", "no speech was found in the source")

    usages, cycles, injection = [], [], None
    render_cache, stop = {}, None

    def seg_words(dec):
        a, b = dec["segment"]["in_s"], dec["segment"]["out_s"]
        return [dict(w, start=round(max(0.0, w["start"] - a), 3), end=round(min(b, w["end"]) - a, 3))
                for w in words if w["end"] > a + 0.05 and w["start"] < b - 0.05]

    def check(dec):
        """The cards must be the words of the segment, in order. A spelling that the second
        transcription wrote for the same speech is accepted when the letters are otherwise identical."""
        seg = seg_words(dec)
        try:
            return captions.match_cards(dec["cards"], seg, groups)
        except PipelineError:
            a = judgement.skeleton(" ".join(judgement.canon(t, groups) for c in dec["cards"] for t in c["text"].split()))
            b = judgement.skeleton(" ".join(judgement.canon(w["word"], groups) for w in seg))
            if a != b:
                raise
            return captions.align_cards(dec["cards"], seg, groups)[0], []

    def spent():
        return round(sum(u.get("cost_usd_reported") or 0 for u in usages), 4), round(time.time() - j.t0, 1)

    # ── THE OWNER'S FREE-TEXT REQUEST: which areas does it ask to change? ───
    # A request that names captions, style, zooms, colour, sound or graphics changes ONLY that; the rest of the
    # previous version is kept exactly. Only a request about the content itself leads to a new plan, and says so.
    interpretation, derived_updates = None, []
    prev0 = options.get("previous") or {}
    if (judgement.resolve_adapter(options, cfg) == "claude" and (prev0.get("plan") or {}).get("content_judgement") == "model"
            and str(options.get("change_request") or "").strip() and not options.get("polish")):
        with j.stage("interpret"):
            try:
                interpretation, u = interpret.interpret(cfg, j.dir, options["change_request"], prev0, prev0.get("style") or {}, options.get("adjustments") or {})
                usages.append(u)
            except PipelineError as e:
                if getattr(e, "usage", None):
                    usages.append(e.usage)
                interpretation = {"needs_replan": True, "domains": [], "domain_labels": [], "not_applied": [], "changed": False,
                                  "explanation": f"לא ניתן היה לפרש את הבקשה אוטומטית ({e.code}) — הגרסה תוכננה מחדש לפי ההערה"}
        interpretation["request"] = str(options["change_request"])[:2000]
        if interpretation["needs_replan"]:
            interpretation["mode"] = "replan"
        else:
            interpretation["mode"] = "targeted" if interpretation.get("changed") else "nothing_applied"
            options["caption_edits"] = (options.get("caption_edits") or []) + interpretation["caption_edits"]
            options["zoom_edits"] = (options.get("zoom_edits") or []) + interpretation["zoom_edits"]
            options["adjustments"] = {**(options.get("adjustments") or {}), **interpretation["adjustments"]}
            j.style_overrides.update(interpretation["style"])
            options.pop("change_request")          # no content request is left: the revision is locked to the previous plan

    # ── LIBRARY SKILL: the owner's choice / the approved default arrive with the job; "let Dana suggest" is decided here ──
    # Several skills may be combined. They are MERGED here, before planning, into one set of rules, parameters and criteria,
    # so there is one editing plan and no pass that overwrites another.
    skill_choice = None
    ok = lambda c: isinstance(c, dict) and isinstance(c.get("skill"), dict) and isinstance(c.get("profile"), dict)
    skill_set = [c for c in options.get("skill_set") or [] if ok(c)]
    if (options.get("skill_candidates") and not skill_set and judgement.resolve_adapter(options, cfg) == "claude" and cfg["judgement"]["claude"].get("enabled")):
        with j.stage("choose_skill"):
            cands = [c for c in options["skill_candidates"] if ok(c)]
            try:
                hits, why, u = skillgen.choose(cfg, j.dir, words, cands, tg)
                usages.append(u)
            except PipelineError as e:
                hits, why = [], f"הבחירה האוטומטית נכשלה ({e.code}) — נערך בלי סקיל מהספרייה"
                if getattr(e, "usage", None):
                    usages.append(e.usage)
        skill_choice = {"considered": [{"id": c["skill"]["id"], "name": c["skill"]["name"]} for c in cands], "chosen": [c["skill"]["id"] for c in hits], "why": why}
        if hits:
            options["skill"], options["profile"] = skillgen.merge(hits, chosen_by="dana", why=why)
    elif skill_set:
        options["skill"], options["profile"] = skillgen.merge(skill_set)
    skill = options.get("skill") if isinstance(options.get("skill"), dict) and isinstance(options.get("profile"), dict) else None
    # an animation scene is planned only when a chosen skill has a rule about animation, or the owner asked for it on this project
    options["allow_animation_scene"] = bool(adjust.enabled(options, "animation") and (options.get("animation_scene") is True
                                            or any(r.get("domain") == "animation" for r in (skill or {}).get("rules") or [])))
    reviews = {}

    # ── RULES + TRANSCRIPT STATE ────────────────────────────────────────────
    skill_text, skill_info, default_profile = story.load_skill()
    profile = j.profile = story.resolve_profile(options, default_profile)
    pp = profile["params"]
    # defaults < profile < the owner's overrides for this project
    j.style = st = {**cfg["style"], **{k: pp[k] for k in ("caption_size", "caption_y_px", "caption_max_lines", "backing", "highlight_enabled", "font_family", "caption_shadow",
                                                       "caption_animation", "caption_ink", "caption_highlight") if k in pp},
                    **j.style_overrides}
    cfg["cards"].update(min_on_screen_s=pp["min_on_screen_s"], max_chars_per_s=pp["max_chars_per_s"])
    eff = j.effective = effective.build(st, tspec, tg, skill)
    options["effective_rules"] = eff["lines"]
    standing_rules = [r for r in options.get("rules") or [] if isinstance(r, dict)]
    # the planner and the editor get the owner's standing rules and the approved profile's style rules together
    options["rules"] = standing_rules + [{"id": f"profile:{profile['id']}", "text": r} for r in profile.get("rules") or []]
    source_words = words
    words, corrections = story.apply_caption_edits([dict(w, src_start=w["start"], src_end=w["end"]) for w in words], options.get("caption_edits"))
    doubts = story.low_confidence(source_words, cfg["sync"]["prob_threshold"])
    if cfg["judgement"].get("second_pass"):
        with j.stage("transcribe_check"):
            cache2 = cache.with_name(f"{sha_before}.pass2.json")
            tr2 = read_json(cache2) if cache2.is_file() else checks.transcribe(cfg, j.source, vad=False)
            write_json(cache2, tr2)
            doubts += story.pass_disagreements(source_words, tr2["words"])

    # ── CONTENT PLAN (model): message, opening, parts, zooms, cover ─────────
    adapter = judgement.resolve_adapter(options, cfg)
    mode = {"claude": "model", "scripted": "scripted"}.get(adapter, "fallback_heuristic")
    j.orig_source, j.zooms, j.story, pl, model_error, zoom_log = j.source, [], None, None, None, []
    prev, revision_mode, locked_raw = options.get("previous") or {}, None, None
    polish = options.get("polish") if isinstance(options.get("polish"), dict) else None
    if polish and adapter == "claude":
        # The owner's own finished edit: nothing about the content is chosen here. Only technical improvements are applied.
        pl, mode, revision_mode = story.polish_plan(words, sp["duration"], polish.get("burned_in_text", True)), "polish", "polish"
        if polish.get("add_captions") is not True:
            st["captions_enabled"] = False
    elif adapter == "claude" and prev.get("plan") and not str(options.get("change_request") or "").strip():
        # The owner asked only for caption / style / zoom changes: the previous plan is kept exactly, no re-planning.
        try:
            pl = story.plan_from_previous(prev, words, cfg, profile, target=tg)
            locked_raw = story.decisions_from_previous(prev, options.get("caption_edits"))
            derived_updates = locked_raw.pop("_derived", [])
            for g in pl.get("graphics") or []:          # a graphic quotes the transcript: it follows the owner's corrections too
                g["text"], ch = story.correct_derived(g["text"], options.get("caption_edits"), quote=True)
                derived_updates += [dict(x, where="גרפיקה") for x in ch]
            if interpretation and interpretation.get("cover_quote"):
                locked_raw["cover"]["text"] = interpretation["cover_quote"]
            # "apply the review's improvements": same plan, but the editor may act on the reviewer's findings
            revision_mode = "apply_review" if options.get("apply_review") else "locked_to_previous_plan"
        except PipelineError as e:
            pl, locked_raw = None, None
            base_issues.append(judgement.issue("revision_replanned", "warn",
                                               f"לא ניתן היה לשחזר במדויק את תוכנית הגרסה הקודמת ({e.message}) — הגרסה תוכננה מחדש; ייתכנו שינויים שלא ביקשת"))
    if adapter == "claude" and prev and revision_mode is None:
        revision_mode = "replanned"
    if adapter == "claude" and pl is None:
        with j.stage("plan"):
            src16 = to16k(cfg, j.source, j.work / "source_16k.wav")
            times = sorted({round(sp["duration"] * n / 7, 2) for n in range(1, 7)}
                           | {round((d["source_start_s"] + d["source_end_s"]) / 2, 2) for d in doubts[:4]})
            shots = story.source_frames(cfg, j.source, times, j.work / "story_frames")
            try:
                pl, u = story.plan(cfg, j.dir, words, src16, sp["duration"],
                                   dict(options, previous_plan=(options.get("previous") or {}).get("story_plan")), profile, skill_text, frames=shots)
                usages += u
            except PipelineError as e:
                usages += ((e.detail or {}).get("claude_calls") if isinstance(e.detail, dict) else None) or []
                if cfg["judgement"].get("on_model_failure") != "fallback_marked":
                    raise
                mode, model_error = "fallback_heuristic", f"{e.code}: {e.message}"
                options["adapter"], cfg["judgement"]["adapter"] = "heuristic", "heuristic"
    if pl:
        doubts += pl["doubts"]
        if pl["burned_in_text"]["present"]:
            st["captions_enabled"] = False
            pl["graphics_dropped"] = (pl.get("graphics_dropped") or []) + [
                {"kind": g["kind"], "quote": g["text"], "why": "במקור יש כתוביות צרובות — גרפיקה נוספת הייתה מתנגשת בהן"} for g in pl.get("graphics") or []]
            pl["graphics"] = []
            pl["zooms_dropped"] += [{"at_s": z["source_t_s"], "why": "במקור יש כתוביות צרובות — זום היה חותך אותן"} for z in pl["zooms"]]
            pl["zooms"] = []
            base_issues.append(judgement.issue(
                "source_has_burned_captions", "warn",
                "בקובץ המקור כבר צרובות כתוביות (נראה בפריימים בודדים מהמקור). דנה לא הוסיפה שכבת כתוביות שנייה ולא עשתה זום, "
                "כי שניהם היו פוגעים בכתוביות הקיימות. לשליטה מלאה בכתוביות ובזומים נדרש חומר גלם בלי כתוביות."))
        pl["zooms"], zoom_log = story.apply_zoom_edits(pl["zooms"], options.get("zoom_edits"), profile)
        bad_joins = story.join_check(words, pl["segments"])
        if story.is_single_pass(pl):
            options["fixed_segment"] = [pl["segments"][0]["source_in_s"], pl["segments"][0]["source_out_s"]]
            j.plan_shift_src = pl["segments"][0]["source_in_s"]
        else:
            with j.stage("assemble"):
                asm = story.assemble(cfg, j.source, sp, pl["segments"], j.work / "assembled.mkv")
            words = story.timeline_words(words, pl["segments"])
            j.source, sp = asm, probe(cfg, asm)
            options["fixed_segment"] = [0.0, pl["total_s"]]
            j.plan_shift_src = 0.0
            options.pop("exclude_ranges", None)
        base_issues.append(judgement.issue("cut_joins", "blocker" if bad_joins else "info",
                                           ("חיתוך בין חלקים נופל בתוך מילה: " + " | ".join(bad_joins)) if bad_joins else
                                           f"{len(pl['segments'])} חלקים מהמקור; כל החיתוכים נופלים בין מילים"))
        j.zooms, j.story = pl["zooms"], pl
        j.cut_joins = {"bad": bool(bad_joins), "note": ("חיתוך בתוך מילה: " + " | ".join(bad_joins)) if bad_joins else
                       f"{len(pl['segments'])} חלקים; כל החיתוכים נופלים בין מילים"}
        # each kind can be switched off, and ONE graphic can be removed by its id - nothing else in the edit moves
        removed = {str(e.get("id")) for e in options.get("graphic_edits") or [] if isinstance(e, dict) and e.get("action") == "remove"}
        j.graphics = []
        for g in pl.get("graphics") or []:
            scene = g.get("layer") == "replaces_picture"
            why = ("הוסר על ידך בפרויקט הזה" if g["id"] in removed else "קטעי אנימציה כובו לפרויקט הזה" if scene and not adjust.enabled(options, "animation")
                   else "מואושן גרפיק כובה לפרויקט הזה" if not scene and not adjust.enabled(options, "graphics") else None)
            if why:
                pl["graphics_dropped"] = (pl.get("graphics_dropped") or []) + [{"kind": g["kind"], "quote": g["text"], "why": why}]
            else:
                j.graphics.append(g)
        options["story"] = {"message": pl["message"], "hook": pl["hook"], "brief": pl["brief"],
                            "cover_quote": "" if not st["captions_enabled"] else pl["cover"]["quote"]}
        options["card_rules"] = (f"each card holds 1-{pp['max_words_per_line'] * pp['caption_max_lines']} words and is shown on at most "
                                 f"{pp['caption_max_lines']} lines of about {pp['max_chars_per_line'] + tspec['chars_per_line_bonus']} characters; break cards where a person pauses.")
        if not tspec["cover_text"]:
            options["story"]["cover_quote"] = ""            # a story has no cover
        write_json(j.ed / "story_plan.json", pl)

    # ── PLAN ────────────────────────────────────────────────────────────────
    with j.stage("plan"):
        if locked_raw is not None:
            locked_raw["segment"].update(in_s=options["fixed_segment"][0], out_s=options["fixed_segment"][1])
            locked_raw["facts_used"] = [v for v in (options.get("brand") or {}).values()
                                        if isinstance(v, str) and v and v in locked_raw["caption"]["text"]]   # brand facts the kept caption relies on
            dec, j_issues = judgement.validate(locked_raw, words, sp["duration"], cfg, st, brand=options.get("brand"))
            dec["adapter"] = "claude"
            if (prev.get("cover") or {}).get("frame_s") is not None:
                dec["cover"]["frame_s"] = float(prev["cover"]["frame_s"])
            check(dec)
        else:
            dec, j_issues, _, usage = judgement.decide_validated({"options": dict(options, _tag="plan")}, words, sp["duration"], cfg, st, j.dir, check)
            usages += (usage or {}).get("calls", [])
        if options.get("test_inject"):
            raw, injection = editorial.inject(as_raw(dec), options["test_inject"])
            dec, j_issues = judgement.validate(raw, words, sp["duration"], cfg, st, exclude=options.get("exclude_ranges"), brand=options.get("brand"))
        if dec["adapter"] == "heuristic":
            j_issues.append(judgement.issue("heuristic_selection", "warn",
                                            "הקטע, חלוקת הכתוביות והקאבר נבחרו בכלל אוטומטי, לא בשיפוט תוכן — לבדוק לפני אישור"
                                            + (f" (מודל התוכן לא היה זמין: {model_error})" if model_error else "")))
        if not st["captions_enabled"] or not tspec["cover_text"]:
            dec["cover"]["text"] = ""          # the frame already shows the source's own caption / a story has no cover
        plan = {"objective": dec["plan"]["objective"], "selected_message": dec["segment"]["complete_thought"],
                "stands_alone": dec["segment"]["reason"], "audience": dec["segment"]["audience_relevance"] or None,
                "source_range_s": [dec["segment"]["in_s"], dec["segment"]["out_s"]],
                "exact_spoken_text": " ".join(w["word"] for w in seg_words(dec)),
                "edit_brief": dec["plan"]["brief"],
                "caption_requirements": ["רק מה שנאמר בסרטון ועובדות מאומתות", "בלי מחיר, הצעה או הבטחה", "CTA רק אם הוגדר"],
                "cover_requirements": ["ציטוט מדויק של 2–5 מילים מהקטע"] if eff["cover_text"] else ["אין קאבר עם טקסט בגרסה הזו"],
                "rules_in_force": eff["notes"],
                "verified_facts": dec["plan"]["facts_used"], "missing_information": dec["plan"]["missing_info"],
                "adapter": dec["adapter"], "test_injection": injection}
        write_json(j.ed / "plan.json", plan)

    use_model = dec["adapter"] == "claude" and cfg["judgement"]["claude"].get("enabled")
    sent_prev, res, tools, det, review, prev_signature, kept, final_cycle = [], None, None, [], None, set(), None, 0
    exhausted, kept_spellings, allowed_all, escalations = {}, [], set(), []
    for n in range(ecfg["max_cycles"] + 1):
        # ── EDIT ────────────────────────────────────────────────────────────
        t_edit = time.time()
        res = edit(j, dec, words, sp, sha_before, check, render_cache)
        res["issues"] = base_issues + j_issues + res["issues"]
        edit_s = round(time.time() - t_edit, 1)
        # ── REVIEW ──────────────────────────────────────────────────────────
        with j.stage("review"):
            tools = editorial.caption_tools(cfg, dec["caption"]["text"])
            res["style_rules"] = [str(r.get("text"))[:300] for r in options.get("rules") or [] if r.get("text")]
            res["skill"], res["effective"] = skill, eff
            det = editorial.deterministic_findings(cfg, dec, res, tools)
            review, review_error = None, None
            if use_model:
                try:
                    review, u = editorial.model_review(cfg, j.dir, dec, res, sent_prev, f"review{n}", j.work)
                    usages.append(u)
                except PipelineError as e:
                    review_error = f"{e.code}: {e.message}"
                    if getattr(e, "usage", None):
                        usages.append(e.usage)
            findings = det + (review["findings"] if review else [])
            verification = editorial.verify(sent_prev, det, review, dec.get("addressed")) if sent_prev else []
            # A finding the editor was already asked about and did not fix is NOT sent again: another round would spend time and
            # change nothing. It goes to the owner with what the editor said and what the check found.
            exhausted.update(effective.exhausted_after(sent_prev, verification))
            # advisory findings are offered to the editor once; blocking ones until they are fixed or exhausted
            wanted = [f for f in findings if f["fix"] in editorial.EDITOR_FIXES and not f["key"].startswith("comfort:")
                      and (f["severity"] == "blocking" or n == 0)]
            actionable = [f for f in wanted if effective.topic(f) not in exhausted]
            escalated = [{"id": f["id"], "problem": f["problem"], "why_not_sent_again": exhausted[effective.topic(f)]} for f in wanted if effective.topic(f) in exhausted]
            escalations[:] = escalated
            signature = {(f["asset"], f.get("card"), f["fix"]) for f in actionable if f["severity"] == "blocking"}
            repeated = bool(n) and bool(signature) and signature <= prev_signature
            cost, secs = spent()
            cycle = {"cycle": n, "segment_s": [dec["segment"]["in_s"], dec["segment"]["out_s"]], "cards": len(res["cards"]),
                     "caption": dec["caption"]["text"], "cover_text": dec["cover"]["text"], "edit_seconds": edit_s,
                     "reused_render": res["reused_render"], "skill_tools": tools,
                     "criteria": editorial.criteria_table(dec, res, det, tools, review), "findings": findings,
                     "reviewer_frames_s": (review or {}).get("frames_s"), "review_error": review_error,
                     # restated automatic checks are not sent to the editor; they stay in the owner's review list
                     "reviewer_findings_not_forwarded": (review or {}).get("dropped_as_already_measured") or [],
                     # asked for something a rule in force excludes (a highlight the skill switched off, a cover text on a story)
                     "reviewer_findings_not_applicable": (review or {}).get("dropped_not_applicable") or [],
                     "not_sent_again": escalated, "rules_in_force": eff["notes"],
                     "verification_of_previous": verification, "editor_addressed": dec.get("addressed") or [],
                     "sent_to_editor": [f["id"] for f in actionable] if use_model else [],
                     "cost_usd_reported_so_far": cost, "seconds_so_far": secs}
            reviews[n] = review
            cycle["reviewed_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            cycle["final_sha256"] = (review or {}).get("reviewed_sha256") or sha256_file(j.out / "final.mp4")
            cycles.append(cycle)
            write_json(j.ed / f"cycle_{n}.json", cycle)
        # A revision that makes the mandatory checks WORSE is rejected: the previous result is restored
        # and the finding that triggered it goes to the owner instead.
        if kept is not None and hard_failures(res["records"]) > hard_failures(kept["res"]["records"]):
            cycles[-1]["rejected"] = (f"the revision raised the number of failed checks from {hard_failures(kept['res']['records'])} "
                                      f"to {hard_failures(res['records'])}; the previous result was restored")
            cycles[-1]["sent_to_editor"] = []
            write_json(j.ed / f"cycle_{n}.json", cycles[-1])
            shutil.copyfile(j.work / "kept_final.mp4", j.out / "final.mp4")
            shutil.copyfile(j.work / "kept_cover.jpg", j.out / "cover.jpg")
            dec, res, j_issues, final_cycle = kept["dec"], kept["res"], kept["issues"], kept["cycle"]
            render_cache.clear()
            stop = "revision_regressed"
            break
        final_cycle = n
        blocking_left = [f for f in findings if f["severity"] == "blocking"]
        if not use_model:
            stop = "no_editor_model"
            break
        if revision_mode in ("locked_to_previous_plan", "polish"):   # nothing the owner did not ask for is changed by the editor
            stop = "locked_revision" if not blocking_left else "needs_owner"
            cycles[-1]["sent_to_editor"] = []
            write_json(j.ed / f"cycle_{n}.json", cycles[-1])
            break
        if not actionable:
            stop = "accepted" if not blocking_left else "needs_owner"
            if escalated:
                cycles[-1]["stopped_because"] = (f"{len(escalated)} הערות נשלחו לעורך פעם אחת ולא נפתרו; סבב נוסף לא היה משנה דבר — הועברו להכרעתך עם הראיות")
                write_json(j.ed / f"cycle_{n}.json", cycles[-1])
            break
        if repeated:                                # the same blocking request again: another cycle would change nothing
            stop = "no_progress"
            cycles[-1]["sent_to_editor"] = []
            cycles[-1]["stopped_because"] = "the same blocking findings were returned after a revision; escalated to the owner with the evidence"
            write_json(j.ed / f"cycle_{n}.json", cycles[-1])
            break
        prev_signature = signature
        if n == ecfg["max_cycles"]:
            stop = "cycle_limit"
            break
        if cost >= ecfg["max_total_cost_usd"] or secs >= ecfg["max_total_s"]:
            stop = "budget"
            break
        # ── REVISE: findings go back to the editor as data ─────────────────
        shutil.copyfile(j.out / "final.mp4", j.work / "kept_final.mp4")
        shutil.copyfile(j.out / "cover.jpg", j.work / "kept_cover.jpg")
        kept = {"dec": dec, "res": res, "issues": j_issues, "cycle": n}
        with j.stage("revise"):
            # spelling choices already made stay made: they remain allowed, the editor is told, and the code puts them back if needed
            allowed_all.update(editorial.allowed_spellings(res))
            for s_ in dec.get("spelling") or []:
                if judgement.skeleton(s_["heard"]) == judgement.skeleton(s_["shown"]) and not any(x["heard"] == s_["heard"] for x in kept_spellings):
                    kept_spellings.append(dict(s_))
            opts = dict(options, previous=as_raw(dec), _tag=f"edit{n + 1}", allowed_spellings=sorted(allowed_all), kept_spellings=kept_spellings,
                        review_findings=[{k: f[k] for k in ("id", "asset", "card", "time_s", "problem", "correction", "evidence", "severity")}
                                         for f in actionable])
            opts.pop("change_request", None)
            try:
                new_dec, new_issues, _, usage = judgement.decide_validated({"options": opts}, words, sp["duration"], cfg, st, j.dir, check)
                usages += (usage or {}).get("calls", [])
            except PipelineError as e:
                for u in ((e.detail or {}).get("claude_calls") if isinstance(e.detail, dict) else None) or []:
                    usages.append(u)
                cycles[-1]["editor_error"] = f"{e.code}: {e.message}"
                write_json(j.ed / f"cycle_{n}.json", cycles[-1])
                stop = "editor_failed"
                break
            if not st["captions_enabled"] or not tspec["cover_text"]:
                new_dec["cover"]["text"] = ""
            restored = effective.keep_spellings(new_dec, kept_spellings)
            if restored:
                new_issues.append(judgement.issue("spelling_kept", "info", "תיקון כתיב מסבב קודם נשמר (העורך חזר לכתיב הקודם והוא הוחזר): " + ", ".join(restored)))
            if effective.same_edit(dec, new_dec):       # the editor changed nothing that is seen: rendering it again would only spend time
                stop = "editor_made_no_change"
                cycles[-1]["stopped_because"] = "העורך החזיר את אותה עריכה בדיוק; ההערות שנשלחו אליו הועברו להכרעתך"
                escalations[:] = [{"id": f["id"], "problem": f["problem"], "why_not_sent_again": "העורך לא שינה דבר בתגובה להערה"} for f in actionable]
                write_json(j.ed / f"cycle_{n}.json", cycles[-1])
                break
            dec, j_issues, sent_prev = new_dec, new_issues, actionable

    # ── when the style in force leaves captions that flash by: a readable alternative, shown next to the result ──
    # Nothing is applied. The owner gets the numbers and a short clip of the same seconds, and may ask for it.
    readability = None
    blocked = [r for r in res.get("comfort_rows") or [] if r.get("cannot")]
    fit_now = res.get("caption_fit") or {}
    if len(blocked) >= 2 and st["captions_enabled"] and fit_now.get("line_px"):
        with j.stage("readable"):
            try:
                alt = readable.alternatives(cfg, st, dec["cards"], res["spans"], fit_now["line_px"], int(pp.get("max_words_per_line", 3)))
                best = alt["alternatives"][0] if alt["alternatives"] else None
                readability = {"problem": next((i["message"] for i in res["issues"] if i["code"] == "caption_rule_conflict"), None), "current": alt["current"],
                               "alternatives": [{k: a[k] for k in ("key", "label", "overrides", "short_cards")} for a in alt["alternatives"]], "basis": alt["basis"],
                               "note": "החלופה אינה מיושמת ואינה נשמרת כהעדפה. היא תיושם רק אם תבקש/י, ורק בפרויקט הזה."}
                if best and best["short_cards"] < alt["current"]["short_cards"]:
                    readability["clip_s"] = readable.preview(cfg, st, best, res["voice_words"], cfg["language"]["homophone_groups"], res["base"], res["voice"], j.out / "final.mp4",
                                                             res["dur"], blocked, fit_now["line_px"], j.work / "readable", j.out / "readable_compare.mp4", st["fps"])
                    readability.update(shown=best["key"], clip="readable_compare.mp4")
            except PipelineError as e:
                readability = dict(readability or {}, error=f"{e.code}: {e.message}")

    # ── PACKAGE ─────────────────────────────────────────────────────────────
    issues, records, cards = res["issues"], res["records"], res["cards"]
    chosen = [f"'{x['heard']}' → '{x['shown']}'" for x in dec["spelling"]]
    if chosen:
        issues.append(judgement.issue("orthography_chosen", "info", "כתיב שהוכרע לפי ההקשר (אותו דיבור, איות שונה בין שני התמלולים): " + ", ".join(chosen)))
    review_items = checks.review_items(records, issues, cards, res["sync"], res["adjudications"], res["dur"])
    final_findings = cycles[final_cycle]["findings"]          # the findings of the result that is actually delivered
    already = {"issue:unverified_number": "content:unverified_number", "issue:words_omitted": "content:words_omitted_inside_segment"}
    have = {r["id"] for r in review_items}
    for f in final_findings:
        if f["severity"] != "blocking" or already.get(f["key"]) in have:
            continue
        if f["key"].startswith("ortho:") and any(r["kind"] == "text" and r["card"] == f.get("card") for r in review_items):
            continue                              # the same difference is already listed as a text item
        if True:
            review_items.append({"id": f"editorial:{f['id']}", "kind": "editorial", "card": f.get("card"), "t0": None, "t1": None, "text": None,
                                 "original": f["problem"], "verdict": "needs_decision",
                                 "explanation": f"תיקון מבוקש: {f['correction']}. ראיה: {f['evidence']}",
                                 "ask": "נדרשת החלטה שלך" if f["fix"] == "owner" else
                                 next((e["why_not_sent_again"] for e in escalations if e["id"] == f["id"]), "לא תוקן אוטומטית")})
    checks.assert_nothing_hidden(records, res["sync"], issues, review_items)
    cost, secs = spent()
    accepted = stop in ("accepted", "locked_revision")
    ed = {"perception": editorial.PERCEPTION, "acceptance_criteria": [{"id": i, "criterion": t, "decided_by": w} for i, t, w in editorial.ACCEPTANCE],
          "plan": plan, "test_injection": injection, "cycles": cycles, "revisions": len(cycles) - 1,
          "status": "ready_for_owner_review" if accepted else "stopped_with_issues", "stop_reason": stop,
          "note": "קבלה עריכתית פנימית פירושה 'מוכן לבדיקת הבעלים' בלבד. היא אינה אישור פרסום ואינה גוברת על בדיקה אוטומטית שנכשלה.",
          "budget": {"cost_usd_reported": cost, "seconds": secs, "max_cycles": ecfg["max_cycles"],
                     "max_total_cost_usd": ecfg["max_total_cost_usd"], "max_total_s": ecfg["max_total_s"]},
          "usage": {"calls": usages, "billing_note": "cost_usd_reported is the CLI's list-price calculation, not an invoice; "
                                                     "the calls ran under the logged-in Claude account unless api_key_in_env is true"}}
    write_json(j.out / "editorial.json", ed)
    write_json(j.out / "transcript_final.json", {"words": res["heard"]})
    write_json(j.out / "captions.json", cards)
    failed = [r["id"] for r in records if r["status"] in ("fail", "review")]
    status = REVIEW_REQUIRED if review_items else SUCCESS
    write_json(j.out / "checks.json", {"records": records, "sync_locked": res["sync"], "adjudications": res["adjudications"],
                                       "attempts": res["attempts"], "review_items": review_items})
    try:
        bundle_info = judgement.load_bundle()[1] if dec["adapter"] == "claude" else None
    except PipelineError:
        bundle_info = None
    shift, in0 = res.get("shift", 0.0), dec["segment"]["in_s"]

    def src_time(t):                       # a time in the finished video → the time in the ORIGINAL source
        return story.tl_to_source(round(t - shift, 3), pl["segments"]) if pl else round(in0 + t, 3)

    def final_time(src_t):                 # a source time → the finished video (None when that moment is not used)
        if not pl:
            return round(src_t - in0, 3) if in0 <= src_t <= dec["segment"]["out_s"] else None
        for s in pl["segments"]:
            if s["source_in_s"] - 0.05 <= src_t <= s["source_out_s"] + 0.05:
                return round(max(0.0, s["tl_in_s"] + src_t - s["source_in_s"] + shift), 3)
        return None

    seen, doubt_rows = {}, []
    for d in doubts:
        a, b = final_time(d["source_start_s"]), final_time(d["source_end_s"])
        if a is None or any(c["source_start_s"] <= d["source_start_s"] <= c["source_end_s"] for c in corrections):
            continue
        if d["word_index"] in seen:              # one row per word: the reasons are listed together
            row = seen[d["word_index"]]
            if d["kind"] not in row["kinds"]:
                row["kinds"].append(d["kind"])
                row["note"] += " · " + d["note"]
            continue
        card = next((c["i"] for c in cards if c["start"] - 0.05 <= a <= c["start"] + c["dur"] + 0.05), None)
        doubt_rows.append({"card": card, "tl_start_s": a, "tl_end_s": b if b is not None else a, "source_start_s": d["source_start_s"],
                           "source_end_s": d["source_end_s"], "word": d["word"], "kind": d["kind"], "kinds": [d["kind"]], "note": d["note"]})
        seen[d["word_index"]] = doubt_rows[-1]
    doubt_rows.sort(key=lambda r: r["tl_start_s"])
    story_pkg = None
    if pl:
        story_pkg = {"message": pl["message"], "hook": pl["hook"], "rationale": pl["rationale"], "content_judgement": pl.get("content_judgement") or "model",
                     "segments": [{k: s[k] for k in ("n", "source_in_s", "source_out_s", "tl_in_s", "tl_out_s", "role", "why")} for s in pl["segments"]],
                     "brief": pl["brief"], "left_out": pl["left_out"], "reordered": pl["reordered"], "zooms_not_used": pl["zooms_dropped"],
                     "cover_why": pl["cover"]["why"], "burned_in_text": pl["burned_in_text"], "revision_note": pl["revision_note"],
                     "graphics_not_used": (pl.get("graphics_dropped") or []) + (res.get("graphics_dropped") or []),
                     "basis": "תמלול אוטומטי עם זמני מילים, עוצמת קול שנמדדה לכל מילה ופריימים בודדים מהמקור. המודל לא שמע את האודיו ולא צפה בתנועה."}
    else:
        story_pkg = {"message": "", "hook": "", "rationale": "", "content_judgement": "none", "segments": [
            {"n": 1, "source_in_s": in0, "source_out_s": dec["segment"]["out_s"], "tl_in_s": 0.0, "tl_out_s": res["dur"], "role": "body",
             "why": "כלל אוטומטי — לא שיפוט תוכן" if mode == "fallback_heuristic" else "הוגדר ידנית"}], "brief": [], "model_error": model_error}
    crit = cycles[final_cycle]["criteria"]
    dana_review = review_rubric.build(dict(
        res["facts"], kind="polish" if polish else "edit", records={r["id"]: r for r in records}, criteria={c["id"]: c for c in crit},
        findings=final_findings, zooms=res.get("zooms") or [], graphics=res.get("graphics") or [], color=res["color"], audio=res["audio_clean"],
        cover_text=dec["cover"]["text"], captions_added=bool(st["captions_enabled"]), cut_joins=getattr(j, "cut_joins", None),
        burned_in_text=bool(pl and pl["burned_in_text"]["present"])))
    review_vs_previous = review_rubric.compare(prev.get("dana_review"), dana_review)
    # ── was the review made on the file that is delivered, after every change? ──
    final_sha = sha256_file(j.out / "final.mp4")
    fc = cycles[final_cycle]
    provenance = {"reviewed_at": fc.get("reviewed_at"), "final_sha256": final_sha, "reviewed_sha256": fc.get("final_sha256"),
                  "on_delivered_file": fc.get("final_sha256") == final_sha, "review_rounds": len(cycles), "delivered_round": final_cycle,
                  "model_review_ran": bool(reviews.get(final_cycle)),
                  "basis": "הבדיקות האוטומטיות נמדדו על הקובץ הסופי. הערכת המודל נעשתה על תמלול האודיו של אותו קובץ ועל פריימים בודדים ממנו — לא האזנה ולא צפייה בתנועה."}
    measured = {"overlays": sum(1 for g in res.get("graphics") or [] if g.get("layer") != "replaces_picture"),
                "scenes": sum(1 for g in res.get("graphics") or [] if g.get("layer") == "replaces_picture"),
                "music_added": False, "sound_effects_added": False, "b_roll_added": False, "transition_effects_added": False,       # the worker has no stage that adds them
                "max_caption_lines": max((len(c.get("lines") or [1]) for c in cards), default=0), "style_overrides": sorted(j.style_overrides)}
    skill_report = skillgen.report(skill, st, reviews.get(final_cycle), (options.get("profile") or {}).get("params"), measured) if skill else None
    # ── a story is delivered as its cards too: one file per part, cut from the reviewed file ──
    outputs = [{"name": "final.mp4", "what": "כל הכרטיסים ברצף, לצפייה ולביקורת" if tg == "story" else "הריל", "seconds": res["dur"]}]
    if tg == "story" and pl:
        for sg in pl["segments"][:4]:
            a, b = max(0.0, sg["tl_in_s"] + res.get("shift", 0.0)), min(res["dur"], sg["tl_out_s"] + res.get("shift", 0.0))
            name = f"story_part_{sg['n']}.mp4"
            run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-ss", f"{a:.3f}", "-t", f"{b - a:.3f}", "-i", j.out / "final.mp4", "-c:v", "libx264", "-crf", "16", "-preset", "medium",
                 "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-af", f"afade=t=in:st=0:d=0.02,afade=t=out:st={max(0.0, b - a - 0.03):.3f}:d=0.03", "-movflags", "+faststart", j.out / name],
                "render_failed", timeout=cfg["timeouts"]["ffmpeg_s"])
            outputs.append({"name": name, "what": f"כרטיס סטורי {sg['n']}", "seconds": round(b - a, 2), "tl_in_s": round(a, 3), "tl_out_s": round(b, 3)})
    prev_review = options.get("previous_review") if isinstance(options.get("previous_review"), dict) else prev.get("dana_review")
    # ── what the owner already decided BY LISTENING is not asked again, in any later version ──
    # The key is the place in the SOURCE recording and what was doubted, so it survives a new cut and new card numbers.
    card_by_i = {c["i"]: c for c in cards}
    heard_ok = {d.get("key") for d in options.get("hearing_decisions") or [] if isinstance(d, dict) and d.get("decision") == "ok"}
    for it in review_items:
        if it.get("kind") in ("timing", "text", "acoustic") and it.get("card") in card_by_i:
            doubt = it["id"].split(":", 2)[2] if it["id"].count(":") >= 2 else it["kind"]
            it["hearing_key"] = f"{it['kind']}|{round(src_time(card_by_i[it['card']]['start'] + 0.02) * 2) / 2}|{doubt}"
            if it["hearing_key"] in heard_ok:
                it["owner_decision"] = "ok"
    REC_KIND = {"sync_lead": "timing", "sync_not_found": "timing", "sync_tail": "timing", "energy_gate": "acoustic", "caption_text": "text"}
    still_open = {it["kind"] for it in review_items if it.get("kind") in REC_KIND.values() and not it.get("owner_decision")}
    was_decided = {it["kind"] for it in review_items if it.get("owner_decision")}
    owner_resolved = sorted(r["id"] for r in records if r["status"] in ("fail", "review") and REC_KIND.get(r["id"]) in was_decided and REC_KIND.get(r["id"]) not in still_open)
    final_review = review_rubric.final(dana_review, skill_report, provenance, review_items, records, prev_review, tg, skill_info, owner_resolved=owner_resolved)
    timeline = review_rubric.timeline(pl["segments"], res["dur"], res.get("shift", 0.0), cards, res.get("zooms") or [], res.get("graphics") or [], skill, res["audio_clean"], tg) if pl else None
    adjustments = {
        "color": res["color"], "audio_cleanup": res["audio_clean"],
        "zooms": {"enabled": adjust.enabled(options, "zooms"), "applied": bool(res.get("zooms")), "count": len(res.get("zooms") or [])},
        "caption_animation": {"enabled": adjust.enabled(options, "caption_animation"), "applied": res["animation"] != "none", "style": res["animation"]},
        "animation": {"enabled": adjust.enabled(options, "animation"), "allowed": bool(options.get("allow_animation_scene")),
                      "applied": any(g.get("layer") == "replaces_picture" for g in res.get("graphics") or []),
                      "count": sum(1 for g in res.get("graphics") or [] if g.get("layer") == "replaces_picture"),
                      "what": "טיפוגרפיה מונפשת במסך מלא מציטוט מדויק. אנימציה שממחישה את הנאמר (איור, דמויות, וידאו שנוצר) אינה קיימת במערכת."},
        "graphics": {"enabled": adjust.enabled(options, "graphics"), "applied": any(g.get("layer") != "replaces_picture" for g in res.get("graphics") or []),
                     "count": sum(1 for g in res.get("graphics") or [] if g.get("layer") != "replaces_picture"),
                     "engine": "HyperFrames " + (motion.version(cfg) or "?") if res.get("graphics") else None},
    }
    auto = [r for r in records if r["status"] not in ("human_required", "info")]
    quality = {
        "technical": {"passed": sum(1 for r in auto if r["status"] == "pass"), "failed": sum(1 for r in auto if r["status"] in ("fail", "review")),
                      "warned": sum(1 for r in auto if r["status"] == "warn"),
                      "failed_ids": [r["id"] for r in auto if r["status"] in ("fail", "review")],
                      "basis": "מדידות אוטומטיות על הקובץ הסופי"},
        "content_review": {"met": sum(1 for c in crit if c.get("met")), "total": len(crit),
                           "not_met": [{"id": c["id"], "note": str(c.get("note") or "")[:200]} for c in crit if not c.get("met")],
                           "basis": "הערכת מודל על תמלול, תוצאות הבדיקות ופריימים בודדים — לא שמיעה ולא צפייה בתנועה. אינה הוכחה לאיכות."
                           if mode == "model" else "לא בוצעה הערכת תוכן"},
        "owner_needed": {"listening_doubts": len(doubt_rows), "review_items": len(review_items),
                         "human_checks": [r["summary"] for r in records if r["status"] == "human_required"]},
        "not_verified": ["דיוק התמלול — רק האזנה שלך מאמתת מילים", "תחושת התנועה של זומים וחיתוכים — נבדקו פריימים בודדים",
                         "המראה בתוך אפליקציית אינסטגרם — האזור הבטוח הוא הגדרת עבודה", "פרסום ונתוני ביצועים"],
    }
    package = {
        "pipeline_version": PIPELINE_VERSION, "status": status,
        "judgement_mode": mode, "revision_mode": revision_mode, "quality": quality, "plan": story_pkg,
        "zooms": [{k: z.get(k) for k in ("id", "source_t_s", "tl_t_s", "scale", "strength", "ease_s", "hold_until_s", "reason", "evidence", "focus", "focus_source")}
                  for z in res.get("zooms") or []],
        "zoom_edits_applied": zoom_log,
        "graphics": res.get("graphics") or [], "adjustments": adjustments, "compare": res.get("compare"), "readability": readability,
        "dana_review": dana_review, "review_vs_previous": review_vs_previous, "review_provenance": provenance,
        "skill_report": skill_report, "skill_choice": skill_choice, "final_review": final_review, "timeline": timeline,
        "review_compact": review_rubric.compact(dana_review), "owner_resolved_checks": owner_resolved,
        "target": {"key": tg, "label": tspec["label"], "publish": tspec["publish"], "cover_text": tspec["cover_text"], "post_caption": tspec["post_caption"],
                   "part_max_s": tspec["part_max_s"], "safe_zone": {k: v for k, v in zone_used.items() if not k.startswith("_")}, "safe_zone_source": zone_used.get("_source")},
        "outputs": outputs,
        "request_interpretation": interpretation, "derived_text_updates": derived_updates,
        "transcript": {"status": "owner_corrected_partial" if corrections else "auto_unverified",
                       "note": "תמלול אוטומטי (Whisper). מילים בספק מסומנות להאזנה; דנה לא החליפה אף מילה בניחוש.",
                       "doubts": doubt_rows, "corrections_applied": corrections},
        "caption_position": res.get("caption_position"), "captions_added": bool(st["captions_enabled"]),
        "rules_used": {"skill": dict(skill_info, text=skill_text), "profile": dict(story.profile_info(profile), params=pp),
                       "standing_rules": [{"id": str(r.get("id")), "version": r.get("version")} for r in standing_rules],
                       "profile_rules": list(profile.get("rules") or []),
                       "library_skill": {k: skill.get(k) for k in ("id", "name", "version", "sha256", "status", "chosen_by")} if skill else None,
                       "references": [profile["source_reference"]] if profile.get("source_reference") else [], "note": "אין עדיין רפרנסים מנותחים; הפרופיל הוא ברירת המחדל המובנית עד שתאשר/י פרופיל"},
        "source": {"sha256": sha_before, "duration": sp["duration"], "probe": sp},
        "segment": dec["segment"], "considered": dec["considered"], "duration": res["dur"], "adapter": dec["adapter"],
        "judgement_usage": {"calls": usages} if usages else None, "instruction_bundle": bundle_info, "revision_note": dec["revision_note"],
        "spelling": dec["spelling"], "timing_source": res["timing_source"],
        "style": {k: st[k] for k in ("caption_size", "caption_y_px", "caption_max_lines", "backing", "highlight_enabled", "font_family", "captions_enabled", "caption_animation", "caption_ink", "caption_highlight")},
        "style_overrides": j.style_overrides,
        "spoken_text": " ".join(c["plain"] for c in cards),
        "cards": [{"i": c["i"], "text": c["plain"], "lines": c.get("lines"), "highlight": c["highlight"], "start": c["start"], "dur": c["dur"],
                   "source_start_s": src_time(c["start"] + 0.02), "source_end_s": src_time(max(c["start"] + 0.02, c["last_word_end_audio_s"])),
                   **({"in_scene": c["in_scene"]} if c.get("in_scene") else {})} for c in cards],
        "cover": dict(dec["cover"], source="plan" if pl else "fallback"),
        "caption": dict(dec["caption"], status="draft_no_voice" if tspec["post_caption"] else "not_applicable_story"),
        "checks": [{k: r[k] for k in ("id", "status", "summary")} for r in records],
        "failed_checks": failed, "issues": issues, "review_items": review_items, "audio": res["audio_src"],
        "editorial": {"status": ed["status"], "stop_reason": stop, "revisions": ed["revisions"], "test_injection": injection,
                      "objective": plan["objective"], "brief": plan["edit_brief"], "missing_information": plan["missing_information"],
                      "verified_facts": plan["verified_facts"], "perception": editorial.PERCEPTION,
                      "criteria": cycles[final_cycle]["criteria"], "delivered_cycle": final_cycle, "rules_in_force": eff["notes"],
                      "caption_fit": res.get("caption_fit"),
                      "cycles": [{"cycle": c["cycle"], "rejected": c.get("rejected"), "stopped_because": c.get("stopped_because"), "findings": [{k: f[k] for k in ("id", "source", "asset", "card", "problem", "correction", "severity", "fix")} for f in c["findings"]],
                                  "sent_to_editor": c["sent_to_editor"], "verification_of_previous": c["verification_of_previous"],
                                  "not_sent_again": c.get("not_sent_again") or [], "not_applicable": c.get("reviewer_findings_not_applicable") or [],
                                  "caption": c["caption"], "cover_text": c["cover_text"], "reused_render": c["reused_render"]} for c in cycles],
                      "budget": ed["budget"]},
        "tools": {"caption_renderer_sha256": cfg.get("caption_renderer_sha256"), "asr_model": cfg["asr"]["model"],
                  "ffmpeg": tool(cfg, "ffmpeg"), "motion_graphics": adjustments["graphics"]["engine"]},
        "timings_s": j.timings, "total_s": round(time.time() - j.t0, 1),
    }
    write_json(j.out / "package.json", package)
    return status, package


def main(argv=None):
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--job-dir", required=True)
    ap.add_argument("--source", required=True)
    a = ap.parse_args(argv)
    job_dir = Path(a.job_dir)
    job_dir.mkdir(parents=True, exist_ok=True)
    result = {"pipeline_version": PIPELINE_VERSION}
    j = None
    try:
        cfg = load_config(a.config)
        j = Job(cfg, job_dir, a.source)
        status, package = pipeline(j)
        arts = []
        for name in ("final.mp4", "cover.jpg", "package.json", "checks.json", "captions.json", "editorial.json",
                     "transcript_source.json", "transcript_final.json", "compare_frames.jpg", "compare_clip.mp4",
                     "story_part_1.mp4", "story_part_2.mp4", "story_part_3.mp4", "story_part_4.mp4"):
            p = j.out / name
            if not p.is_file() and name.startswith(("compare_", "story_part_")):
                continue
            arts.append({"name": name, "sha256": sha256_file(p), "bytes": p.stat().st_size})
        result.update(status=status, artifacts=arts, failed_checks=package["failed_checks"],
                      review_items=[r["id"] for r in package["review_items"]], editorial=package["editorial"]["status"],
                      issues=[i["code"] for i in package["issues"]], timings_s=j.timings, total_s=package["total_s"])
    except Waiting as w:
        result.update(status=WAITING, code=w.code, message=w.message)
    except PipelineError as e:
        result.update(status=FAILURE, code=e.code, message=e.message, retryable=bool(e.retryable),
                      detail=e.detail if isinstance(e.detail, (str, dict)) else None)
    except Exception as e:                       # a bug is a failure, never a silent success
        result.update(status=FAILURE, code="pipeline_crash", message=f"{type(e).__name__}: {e}", retryable=False,
                      detail=traceback.format_exc()[-2000:])
    if j is not None:
        result["stages"] = j.stages
    write_json(job_dir / "result.json", result)
    print(json.dumps({k: result.get(k) for k in ("status", "code", "message", "failed_checks", "editorial")}, ensure_ascii=False))
    return EXIT[result["status"]]


if __name__ == "__main__":
    sys.exit(main())
