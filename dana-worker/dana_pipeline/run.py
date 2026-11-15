# -*- coding: utf-8 -*-
"""Orchestrator: one source clip -> one vertical reel + review package.

    python -m dana_pipeline.run --config worker.config.json --job-dir <dir> --source <file>

Non-interactive: it never prompts and never opens a player. The outcome is always written to
<job-dir>/result.json and mirrored by the exit code:

    0 success          package ready, every automated check passed
    2 review_required  package ready, but a check failed or an item needs the owner
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
        raw = judgement.decide(j.job, words, sp["duration"], cfg, j.dir)
        usage = raw.pop("_usage", None)
        dec, j_issues = judgement.validate(raw, words, sp["duration"], cfg, st)
        issues += j_issues
        if dec["adapter"] == "heuristic":
            issues.append(judgement.issue("heuristic_selection", "warn",
                                          "הקטע, חלוקת הכתוביות והקאבר נבחרו בכלל אוטומטי, לא בשיפוט תוכן — לבדוק לפני אישור"))
        if dec["caption"]["cta"] is None:
            issues.append(judgement.issue("cta_missing", "warn", "אין CTA: לא הוגדרה הצעה/קריאה לפעולה מאושרת בהגדרות המותג"))
        issues.append(judgement.issue("caption_is_draft", "info", "הקפשן הוא טיוטה — אין עדיין פרופיל קול מאושר"))
        in_s, out_s = dec["segment"]["in_s"], dec["segment"]["out_s"]

    with j.stage("match_cards"):
        # words that overlap the segment (a stamp may begin before the cut; see clip_boundary)
        seg = [dict(w, start=round(max(0.0, w["start"] - in_s), 3), end=round(min(out_s, w["end"]) - in_s, 3))
               for w in words if w["end"] > in_s + 0.05 and w["start"] < out_s - 0.05]
        spans, skipped = captions.match_cards(dec["cards"], seg, dec["homophones"])
        if skipped:
            issues.append(judgement.issue("words_not_captioned", "warn",
                                          "מילים שנשמעות בקטע ואינן בכתוביות: " + " ".join(w["word"] for w in skipped[:20]),
                                          words=[w["word"] for w in skipped]))

    with j.stage("render_base"):
        base, voice, dur, audio_src = render_base_and_voice(j, sp, in_s, out_s, spans[-1][-1]["end"])
        cards, notes = captions.time_cards(dec["cards"], spans, st["fps"], cfg["cards"]["hold_after_s"], dur, voice)
        records.append(checks.check_boundary(words, in_s, out_s, checks.level_db(j.work / "voice_raw.wav", 0.0, 0.05),
                                              checks.room_tone_db(j.work / "voice_raw.wav")))

    with j.stage("render_cards"):
        png_dir = captions.render_png(cfg, st, [{"name": f"c{c['i']:03d}", "text": c["plain"], "highlight": c["highlight"]}
                                                for c in cards], j.work / "caps")
        records += [checks.check_width(png_dir, cards, st["width"]), checks.check_safe_zone(cfg, png_dir, cards)]

    final = j.out / "final.mp4"
    attempts, sync = [], None
    for attempt in range(cfg["sync"]["max_fix_attempts"] + 1):
        with j.stage(f"composite_{attempt}"):
            captions.composite(cfg, base, voice, cards, png_dir, final, dur)
        with j.stage(f"verify_{attempt}"):
            wav = j.work / "final_audio_16k.wav"
            run([tool(cfg, "ffmpeg"), "-y", "-v", "error", "-i", final, "-vn", "-ar", "16000", "-ac", "1",
                 "-sample_fmt", "s16", wav], "check_decode_failed", timeout=600)
            heard = checks.transcribe(cfg, wav)["words"]
            sync = checks.verify_sync(cfg, cards, heard, wav, dec["homophones"])
            flagged = set(sync["lead_fail"] + sync["not_found"])
            if flagged:
                try:
                    vspans, _ = captions.match_cards(dec["cards"], checks.transcribe(cfg, wav, vad=True)["words"], dec["homophones"])
                    sync["vad_evidence"] = [{"i": c["i"], "card_t": c["start"], "vad_first_word_start": sp[0]["start"],
                                             "envelope_start": c["first_word_audio_s"],
                                             "card_minus_vad_ms": round((c["start"] - sp[0]["start"]) * 1000)}
                                            for c, sp in zip(cards, vspans) if c["i"] in flagged]
                except PipelineError:
                    sync["vad_evidence"] = None
            bad = sync["lead_fail"] or sync["not_found"] or sync["tail_fail"]
            attempts.append({"attempt": attempt, "timing": "source_transcript" if attempt == 0 else "final_audio",
                             "lead_fail": sync["lead_fail"], "not_found": sync["not_found"], "tail_fail": sync["tail_fail"]})
        if not bad or attempt == cfg["sync"]["max_fix_attempts"]:
            break
        # Routine fix: re-time the cards from the words heard in the FINAL audio, then re-render.
        try:
            spans2, _ = captions.match_cards(dec["cards"], heard, dec["homophones"])
        except PipelineError as e:
            attempts.append({"attempt": attempt, "retime": "not_possible", "reason": e.message})
            break
        new_cards, notes2 = captions.time_cards(dec["cards"], spans2, st["fps"], cfg["cards"]["hold_after_s"], dur, voice)
        if [(c["start"], c["dur"]) for c in new_cards] == [(c["start"], c["dur"]) for c in cards]:
            break                                   # nothing left to change automatically
        cards, notes = new_cards, notes + notes2
    write_json(j.out / "transcript_final.json", {"words": heard})
    write_json(j.out / "captions.json", cards)
    records += checks.sync_records(sync)

    with j.stage("checks"):
        motion, comfort = checks.cards_in_motion(cfg, final, base, png_dir, cards, st["fps"])
        records += [motion, comfort, checks.check_output(cfg, final, dur), checks.check_loudness(cfg, final),
                    checks.check_source_unchanged(j.source, sha_before)]
        records += checks.HUMAN_CHECKS

    with j.stage("cover"):
        cover = make_cover(j, base, dec["cover"])

    failed = [r["id"] for r in records if r["status"] == "fail"]
    blockers = [i["code"] for i in issues if i["severity"] == "blocker"]
    status = REVIEW_REQUIRED if failed or blockers else SUCCESS
    write_json(j.out / "checks.json", {"records": records, "sync": sync, "sync_attempts": attempts, "timing_notes": notes})
    quote = " ".join(c["plain"] for c in cards)
    package = {
        "pipeline_version": PIPELINE_VERSION, "status": status,
        "source": {"sha256": sha_before, "duration": sp["duration"], "probe": sp},
        "segment": dec["segment"], "duration": dur, "adapter": dec["adapter"], "judgement_usage": usage,
        "style": {k: st[k] for k in ("caption_size", "caption_y_px", "backing", "highlight_enabled", "font_family")},
        "style_overrides": j.style_overrides,
        "spoken_text": quote, "cards": [{"i": c["i"], "text": c["plain"], "highlight": c["highlight"],
                                         "start": c["start"], "dur": c["dur"]} for c in cards],
        "cover": dec["cover"], "caption": dec["caption"],
        "checks": [{k: r[k] for k in ("id", "status", "summary")} for r in records],
        "failed_checks": failed, "issues": issues, "audio": audio_src,
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
