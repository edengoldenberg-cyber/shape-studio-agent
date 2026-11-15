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
import sys
import time
import traceback
from pathlib import Path

from . import PIPELINE_VERSION, captions, checks, editorial, judgement
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


def render_base_and_voice(j, src_probe, in_s, out_s, last_word_end_tl):
    cfg, st = j.cfg, j.style
    dur = round(out_s - in_s, 3)
    W, H = st["width"], st["height"]
    rng = ":in_range=full:out_range=tv" if src_probe["full_range"] else ""
    vf = f"scale={W}:{H}:force_original_aspect_ratio=increase{rng},crop={W}:{H},format=yuv420p"
    base = j.work / "base.mp4"
    run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-ss", f"{in_s}", "-t", f"{dur}", "-i", j.source,
         "-vf", vf, "-r", str(st["fps"]), "-an", "-c:v", "libx264", "-crf", "10", "-preset", "medium",
         "-pix_fmt", "yuv420p", base], "render_failed", timeout=cfg["timeouts"]["ffmpeg_s"])
    a = cfg["audio"]
    raw = j.work / "voice_raw.wav"
    run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-ss", f"{in_s}", "-t", f"{dur}", "-i", j.source,
         "-vn", "-ar", "48000", "-c:a", "pcm_s24le", raw], "render_failed", timeout=cfg["timeouts"]["ffmpeg_s"])
    m = checks.measure_loudness(cfg, raw)
    fo_st = min(max(last_word_end_tl, dur - 0.20), dur - 0.03)
    fo_d = max(0.02, min(0.15, dur - fo_st))
    af = (f"loudnorm=I={a['target_lufs']}:TP={a['target_peak_db']}:LRA=11:measured_I={m['input_i']}:"
          f"measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:"
          f"offset={m['target_offset']}:linear=true,aresample=48000,afade=t=in:st=0:d=0.02,"
          f"afade=t=out:st={fo_st:.3f}:d={fo_d:.3f},apad=whole_dur={dur}")
    voice = j.work / "voice.wav"
    run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-i", raw, "-af", af, "-ar", "48000", "-c:a", "pcm_s24le",
         "-t", f"{dur}", voice], "render_failed", timeout=cfg["timeouts"]["ffmpeg_s"])
    return base, voice, dur, {"source_lufs": float(m["input_i"]), "source_true_peak": float(m["input_tp"])}


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


def edit(j, dec, words, sp, sha_before, check, cache):
    """EDIT stage: execute the decisions through the canonical pipeline and run every check."""
    cfg, st = j.cfg, j.style
    groups = cfg["language"]["homophone_groups"]
    in_s, out_s = dec["segment"]["in_s"], dec["segment"]["out_s"]
    issues, records = [], []
    key = hashlib.sha1(json.dumps([in_s, out_s, dec["cards"], st], ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
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
        base, voice, dur, audio_src = render_base_and_voice(j, sp, in_s, out_s, spans[-1][-1]["end"])
        records.append(checks.check_boundary(words, in_s, out_s, checks.level_db(j.work / "voice_raw.wav", 0.0, 0.05),
                                              checks.room_tone_db(j.work / "voice_raw.wav")))

    with j.stage("align"):
        # The reference is the FINAL audio: the words as they are heard in the cut, normalised voice track.
        v16 = to16k(cfg, voice, j.work / "voice_16k.wav")
        align = Alignment(v16, cfg["alignment"]["vad_min_silence_ms"])
        timing_source = "final_audio"
        voice_words = checks.transcribe(cfg, v16)["words"]

    with j.stage("render_cards"):
        for split_round in range(3):
            try:
                tspans, _ = captions.align_cards(dec["cards"], voice_words, groups)
            except PipelineError:
                tspans, timing_source = check(dec)[0], "source_transcript"   # same words, stamps from the source transcript
            cards = captions.time_cards(dec["cards"], tspans, st["fps"], cfg["cards"]["hold_after_s"], dur, align)
            png_dir = captions.render_png(cfg, st, [{"name": f"c{c['i']:03d}", "text": c["plain"], "highlight": c["highlight"]}
                                                    for c in cards], j.work / "caps")
            width, zone = checks.check_width(png_dir, cards, st["width"]), checks.check_safe_zone(cfg, png_dir, cards)
            too_wide = sorted(set(width["data"]["cards"]) | set(zone["data"]["cards"]))
            splittable = [i for i in too_wide if len(dec["cards"][i - 1]["text"].split()) > 1]
            if not splittable or split_round == 2:
                break
            # Routine fix: a card that does not fit is split in two. Same words, same order.
            new = []
            for n, c in enumerate(dec["cards"], 1):
                w = c["text"].split()
                if n in splittable:
                    for part in (w[:(len(w) + 1) // 2], w[(len(w) + 1) // 2:]):
                        text = " ".join(part)
                        new.append({"text": text, "highlight": [h for h in c["highlight"] if h in text]})
                else:
                    new.append(c)
            issues.append(judgement.issue("cards_split_to_fit", "info",
                                          f"כרטיסים שלא נכנסו לאזור הבטוח פוצלו לשניים: {splittable} (אותן מילים, אותו סדר)"))
            dec["cards"] = new
        records += [width, zone]

    final = j.out / "final.mp4"
    attempts = []
    for attempt in range(cfg["sync"]["max_fix_attempts"] + 1):
        with j.stage("composite"):
            captions.composite(cfg, base, voice, cards, png_dir, final, dur)
        with j.stage("verify"):
            wav = to16k(cfg, final, j.work / "final_audio_16k.wav")            # the audio of the OUTPUT file
            heard = checks.transcribe(cfg, wav)["words"]
            sync = checks.verify_sync(cfg, cards, heard, wav, groups)         # locked rules, unchanged
            out_align = Alignment(wav, cfg["alignment"]["vad_min_silence_ms"])
            try:
                ospans, odiffs = captions.align_cards(dec["cards"], heard, groups)
            except PipelineError as e:
                ospans, odiffs = None, []
                attempts.append({"attempt": attempt, "output_text_match": "failed", "reason": e.message})
            alignment = checks.alignment_check(cfg, cards, ospans, out_align) if ospans else None
            attempts.append({"attempt": attempt, "timing_source": timing_source, "locked_lead_fail": sync["lead_fail"],
                             "locked_not_found": sync["not_found"], "locked_tail_fail": sync["tail_fail"],
                             "alignment": alignment["status"] if alignment else "not_measured"})
        fixable = ospans and (alignment["status"] == "fail" or sync["tail_fail"])
        if not fixable or attempt == cfg["sync"]["max_fix_attempts"]:
            break
        new_cards = captions.time_cards(dec["cards"], ospans, st["fps"], cfg["cards"]["hold_after_s"], dur, out_align)
        if [(c["start"], c["dur"]) for c in new_cards] == [(c["start"], c["dur"]) for c in cards]:
            break                                   # nothing left to change automatically
        cards, timing_source = new_cards, "output_audio"
    records += checks.sync_records(sync)
    adjudications = []
    if alignment:
        records += [alignment, checks.text_check(odiffs)]
        adjudications = checks.adjudicate_sync(cfg, sync, alignment)
    else:
        records.append(checks.rec("alignment_reference", "fail", "לא ניתן להתאים את הכתוביות למילים שנשמעות בקובץ הסופי"))

    with j.stage("checks"):
        motion, comfort = checks.cards_in_motion(cfg, final, base, png_dir, cards, st["fps"])
        records += [motion, comfort, checks.check_output(cfg, final, dur), checks.check_loudness(cfg, final),
                    checks.check_source_unchanged(j.source, sha_before)]
        records += checks.HUMAN_CHECKS

    with j.stage("cover"):
        cover = make_cover(j, base, dec["cover"])

    c_cfg, comfort_rows = cfg["cards"], []
    by_i = {c["i"]: c for c in cards}
    for r in (motion["data"].get("rows") or []):
        why = []
        if r["seconds"] < c_cfg["min_on_screen_s"]:
            why.append(f"על המסך {r['seconds']:.2f}s")
        if r["chars_per_s"] > c_cfg["max_chars_per_s"]:
            why.append(f"נקרא ב-{r['chars_per_s']:.0f} תווים/ש")
        if why:
            comfort_rows.append({"i": r["i"], "text": by_i[r["i"]]["plain"], "why": ", ".join(why), "t0": r["t0"]})
    seg_words = [w for w in words if w["end"] > in_s + 0.05 and w["start"] < out_s - 0.05]
    res = {"key": key, "cards": cards, "records": records, "sync": sync, "adjudications": adjudications, "odiffs": odiffs,
           "heard": heard, "dur": dur, "final": final, "base": base, "cover": cover, "png_dir": png_dir, "attempts": attempts,
           "timing_source": timing_source, "audio_src": audio_src, "motion_rows": motion["data"].get("rows") or [],
           "comfort_rows": comfort_rows, "source_text": " ".join(w["word"] for w in seg_words), "issues": issues,
           "reused_render": False}
    cache.update(key=key, res=res)
    return res


def pipeline(j):
    cfg, st = j.cfg, j.style
    groups = cfg["language"]["homophone_groups"]
    options = dict(j.job.get("options") or {})
    ecfg = cfg["editorial"]

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

    usages, cycles, injection = [], [], None
    render_cache, stop = {}, None

    def spent():
        return round(sum(u.get("cost_usd_reported") or 0 for u in usages), 4), round(time.time() - j.t0, 1)

    # ── PLAN ────────────────────────────────────────────────────────────────
    with j.stage("plan"):
        dec, j_issues, _, usage = judgement.decide_validated({"options": dict(options, _tag="plan")}, words, sp["duration"], cfg, st, j.dir, check)
        usages += (usage or {}).get("calls", [])
        if options.get("test_inject"):
            raw, injection = editorial.inject(as_raw(dec), options["test_inject"])
            dec, j_issues = judgement.validate(raw, words, sp["duration"], cfg, st, exclude=options.get("exclude_ranges"), brand=options.get("brand"))
        if dec["adapter"] == "heuristic":
            j_issues.append(judgement.issue("heuristic_selection", "warn",
                                            "הקטע, חלוקת הכתוביות והקאבר נבחרו בכלל אוטומטי, לא בשיפוט תוכן — לבדוק לפני אישור"))
        plan = {"objective": dec["plan"]["objective"], "selected_message": dec["segment"]["complete_thought"],
                "stands_alone": dec["segment"]["reason"], "audience": dec["segment"]["audience_relevance"] or None,
                "source_range_s": [dec["segment"]["in_s"], dec["segment"]["out_s"]],
                "exact_spoken_text": " ".join(w["word"] for w in seg_words(dec)),
                "edit_brief": dec["plan"]["brief"],
                "caption_requirements": ["רק מה שנאמר בסרטון ועובדות מאומתות", "בלי מחיר, הצעה או הבטחה", "CTA רק אם הוגדר"],
                "cover_requirements": ["ציטוט מדויק של 2–5 מילים מהקטע"],
                "verified_facts": dec["plan"]["facts_used"], "missing_information": dec["plan"]["missing_info"],
                "adapter": dec["adapter"], "test_injection": injection}
        write_json(j.ed / "plan.json", plan)

    use_model = dec["adapter"] == "claude" and cfg["judgement"]["claude"].get("enabled")
    sent_prev, res, tools, det, review = [], None, None, [], None
    for n in range(ecfg["max_cycles"] + 1):
        # ── EDIT ────────────────────────────────────────────────────────────
        t_edit = time.time()
        res = edit(j, dec, words, sp, sha_before, check, render_cache)
        res["issues"] = base_issues + j_issues + res["issues"]
        edit_s = round(time.time() - t_edit, 1)
        # ── REVIEW ──────────────────────────────────────────────────────────
        with j.stage("review"):
            tools = editorial.caption_tools(cfg, dec["caption"]["text"])
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
            # advisory findings are offered to the editor once; blocking ones every cycle
            actionable = [f for f in findings if f["fix"] in editorial.EDITOR_FIXES and (f["severity"] == "blocking" or n == 0)]
            cost, secs = spent()
            cycle = {"cycle": n, "segment_s": [dec["segment"]["in_s"], dec["segment"]["out_s"]], "cards": len(res["cards"]),
                     "caption": dec["caption"]["text"], "cover_text": dec["cover"]["text"], "edit_seconds": edit_s,
                     "reused_render": res["reused_render"], "skill_tools": tools,
                     "criteria": editorial.criteria_table(dec, res, det, tools, review), "findings": findings,
                     "reviewer_frames_s": (review or {}).get("frames_s"), "review_error": review_error,
                     # restated automatic checks are not sent to the editor; they stay in the owner's review list
                     "reviewer_findings_not_forwarded": (review or {}).get("dropped_as_already_measured") or [],
                     "verification_of_previous": verification, "editor_addressed": dec.get("addressed") or [],
                     "sent_to_editor": [f["id"] for f in actionable] if use_model else [],
                     "cost_usd_reported_so_far": cost, "seconds_so_far": secs}
            cycles.append(cycle)
            write_json(j.ed / f"cycle_{n}.json", cycle)
        blocking_left = [f for f in findings if f["severity"] == "blocking"]
        if not use_model:
            stop = "no_editor_model"
            break
        if not actionable:
            stop = "accepted" if not blocking_left else "needs_owner"
            break
        if n == ecfg["max_cycles"]:
            stop = "cycle_limit"
            break
        if cost >= ecfg["max_total_cost_usd"] or secs >= ecfg["max_total_s"]:
            stop = "budget"
            break
        # ── REVISE: findings go back to the editor as data ─────────────────
        with j.stage("revise"):
            opts = dict(options, previous=as_raw(dec), _tag=f"edit{n + 1}", allowed_spellings=editorial.allowed_spellings(res),
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
            dec, j_issues, sent_prev = new_dec, new_issues, actionable

    # ── PACKAGE ─────────────────────────────────────────────────────────────
    issues, records, cards = res["issues"], res["records"], res["cards"]
    chosen = [f"'{x['heard']}' → '{x['shown']}'" for x in dec["spelling"]]
    if chosen:
        issues.append(judgement.issue("orthography_chosen", "info", "כתיב שהוכרע לפי ההקשר (אותו דיבור, איות שונה בין שני התמלולים): " + ", ".join(chosen)))
    review_items = checks.review_items(records, issues, cards, res["sync"], res["adjudications"], res["dur"])
    final_findings = cycles[-1]["findings"]
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
                                 "ask": "נדרשת החלטה שלך" if f["fix"] == "owner" else "לא תוקן אוטומטית בתוך מגבלת הסבבים"})
    checks.assert_nothing_hidden(records, res["sync"], issues, review_items)
    cost, secs = spent()
    accepted = stop == "accepted"
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
    package = {
        "pipeline_version": PIPELINE_VERSION, "status": status,
        "source": {"sha256": sha_before, "duration": sp["duration"], "probe": sp},
        "segment": dec["segment"], "considered": dec["considered"], "duration": res["dur"], "adapter": dec["adapter"],
        "judgement_usage": {"calls": usages} if usages else None, "instruction_bundle": bundle_info, "revision_note": dec["revision_note"],
        "spelling": dec["spelling"], "timing_source": res["timing_source"],
        "style": {k: st[k] for k in ("caption_size", "caption_y_px", "backing", "highlight_enabled", "font_family")},
        "style_overrides": j.style_overrides,
        "spoken_text": " ".join(c["plain"] for c in cards),
        "cards": [{"i": c["i"], "text": c["plain"], "highlight": c["highlight"], "start": c["start"], "dur": c["dur"]} for c in cards],
        "cover": dec["cover"], "caption": dec["caption"],
        "checks": [{k: r[k] for k in ("id", "status", "summary")} for r in records],
        "failed_checks": failed, "issues": issues, "review_items": review_items, "audio": res["audio_src"],
        "editorial": {"status": ed["status"], "stop_reason": stop, "revisions": ed["revisions"], "test_injection": injection,
                      "objective": plan["objective"], "brief": plan["edit_brief"], "missing_information": plan["missing_information"],
                      "verified_facts": plan["verified_facts"], "perception": editorial.PERCEPTION,
                      "criteria": cycles[-1]["criteria"],
                      "cycles": [{"cycle": c["cycle"], "findings": [{k: f[k] for k in ("id", "source", "asset", "card", "problem", "correction", "severity", "fix")} for f in c["findings"]],
                                  "sent_to_editor": c["sent_to_editor"], "verification_of_previous": c["verification_of_previous"],
                                  "caption": c["caption"], "cover_text": c["cover_text"], "reused_render": c["reused_render"]} for c in cycles],
                      "budget": ed["budget"]},
        "tools": {"caption_renderer_sha256": cfg.get("caption_renderer_sha256"), "asr_model": cfg["asr"]["model"],
                  "ffmpeg": tool(cfg, "ffmpeg")},
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
                     "transcript_source.json", "transcript_final.json"):
            p = j.out / name
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
