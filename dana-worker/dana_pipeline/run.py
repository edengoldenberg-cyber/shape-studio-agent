# -*- coding: utf-8 -*-
"""Orchestrator: one source clip -> one vertical reel + review package.

    python -m dana_pipeline.run --config worker.config.json --job-dir <dir> --source <file>

Non-interactive: it never prompts and never opens a player. The outcome is always written to
<job-dir>/result.json and mirrored by the exit code:

    0 success          package ready, every automated check passed
    2 review_required  package ready, but something needs the owner (see review_items)
    3 waiting          cannot continue without something external (e.g. decisions)
    1 failure          no package; result.json carries code / message / retryable
"""
import argparse
import json
import sys
import time
import traceback
from pathlib import Path

from . import PIPELINE_VERSION, captions, checks, judgement
from .align import Alignment
from .core import (EXIT, FAILURE, REVIEW_REQUIRED, STYLE_OVERRIDABLE, SUCCESS, WAITING, PipelineError, Waiting,
                   load_config, probe, read_json, run, sha256_file, tool, utf8_stdout, write_json)


class Job:
    def __init__(self, cfg, job_dir, source):
        self.cfg, self.dir, self.source = cfg, Path(job_dir), Path(source)
        self.out = self.dir / "out"
        self.work = self.dir / "work"
        self.out.mkdir(parents=True, exist_ok=True)
        self.work.mkdir(parents=True, exist_ok=True)
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
                job.timings[name] = round(time.time() - s.t, 2)
                job.stages[-1].update(status="failed" if et else "done", seconds=job.timings[name])
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


def pipeline(j):
    cfg, st = j.cfg, j.style
    groups = cfg["language"]["homophone_groups"]
    issues, records = [], []

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
        if sp["display_width"] > sp["display_height"]:
            issues.append(judgement.issue("horizontal_source_cropped", "warn",
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

    with j.stage("judgement"):
        def seg_words(dec):
            a, b = dec["segment"]["in_s"], dec["segment"]["out_s"]
            return [dict(w, start=round(max(0.0, w["start"] - a), 3), end=round(min(b, w["end"]) - a, 3))
                    for w in words if w["end"] > a + 0.05 and w["start"] < b - 0.05]

        def check(dec):                    # the cards must be the words of the segment, in order
            return captions.match_cards(dec["cards"], seg_words(dec), groups)

        dec, j_issues, (spans, skipped), usage = judgement.decide_validated(j.job, words, sp["duration"], cfg, st, j.dir, check)
        issues += j_issues
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
        if dec["adapter"] == "heuristic":
            issues.append(judgement.issue("heuristic_selection", "warn",
                                          "הקטע, חלוקת הכתוביות והקאבר נבחרו בכלל אוטומטי, לא בשיפוט תוכן — לבדוק לפני אישור"))
        if dec["caption"]["cta"] is None:
            issues.append(judgement.issue("cta_missing", "warn", "אין CTA: לא הוגדרה הצעה/קריאה לפעולה מאושרת בהגדרות המותג"))
        issues.append(judgement.issue("caption_is_draft", "info", "הקפשן הוא טיוטה — אין עדיין פרופיל קול מאושר"))
        in_s, out_s = dec["segment"]["in_s"], dec["segment"]["out_s"]

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
        with j.stage(f"composite_{attempt}"):
            captions.composite(cfg, base, voice, cards, png_dir, final, dur)
        with j.stage(f"verify_{attempt}"):
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
    write_json(j.out / "transcript_final.json", {"words": heard})
    write_json(j.out / "captions.json", cards)
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
        make_cover(j, base, dec["cover"])

    review = checks.review_items(records, issues, cards, sync, adjudications, dur)
    failed = [r["id"] for r in records if r["status"] in ("fail", "review")]
    status = REVIEW_REQUIRED if review else SUCCESS
    write_json(j.out / "checks.json", {"records": records, "sync_locked": sync, "adjudications": adjudications,
                                       "attempts": attempts, "review_items": review})
    try:
        bundle_info = judgement.load_bundle()[1] if dec["adapter"] == "claude" else None
    except PipelineError:
        bundle_info = None
    package = {
        "pipeline_version": PIPELINE_VERSION, "status": status,
        "source": {"sha256": sha_before, "duration": sp["duration"], "probe": sp},
        "segment": dec["segment"], "considered": dec["considered"], "duration": dur, "adapter": dec["adapter"],
        "judgement_usage": usage, "instruction_bundle": bundle_info, "revision_note": dec["revision_note"],
        "spelling": dec["spelling"], "timing_source": timing_source,
        "style": {k: st[k] for k in ("caption_size", "caption_y_px", "backing", "highlight_enabled", "font_family")},
        "style_overrides": j.style_overrides,
        "spoken_text": " ".join(c["plain"] for c in cards),
        "cards": [{"i": c["i"], "text": c["plain"], "highlight": c["highlight"], "start": c["start"], "dur": c["dur"]} for c in cards],
        "cover": dec["cover"], "caption": dec["caption"],
        "checks": [{k: r[k] for k in ("id", "status", "summary")} for r in records],
        "failed_checks": failed, "issues": issues, "review_items": review, "audio": audio_src,
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
        for name in ("final.mp4", "cover.jpg", "package.json", "checks.json", "captions.json",
                     "transcript_source.json", "transcript_final.json"):
            p = j.out / name
            arts.append({"name": name, "sha256": sha256_file(p), "bytes": p.stat().st_size})
        result.update(status=status, artifacts=arts, failed_checks=package["failed_checks"],
                      review_items=[r["id"] for r in package["review_items"]],
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
    print(json.dumps({k: result.get(k) for k in ("status", "code", "message", "failed_checks")}, ensure_ascii=False))
    return EXIT[result["status"]]


if __name__ == "__main__":
    sys.exit(main())
