# -*- coding: utf-8 -*-
"""Dana's rating of an EXISTING final file, without editing or rendering anything.

    python -m dana_pipeline.rereview --job-dir <dir>

    <dir>/job.json          {"options": {"review_of": {"version": n, "file_sha256": "<sha of the stored final file>"}}}
    <dir>/in/package.json   the package of that version, as delivered
    <dir>/in/checks.json    its check records
    <dir>/out/review.json   the result (this module writes it)

Why this exists: a review used to be built only at the end of an edit job, so bringing a review up to date meant a
new render and a new version. Here the review of ONE delivered file is brought up to the criteria in force:

  * The file is identified by its SHA-256. The measurements and the model's assessment that are stored with the version
    were made on exactly that file (the package says so); if they were made on another file this job refuses.
  * Every criterion that was decided on that file keeps its decision, its basis and its evidence.
  * A criterion the current rubric added is decided only when it can be computed from what was measured on that file
    (filler words from the caption text, audible music from the mix measurement). Otherwise it is "not checked".
  * The summary mark, the three most important improvements and the next steps are built from that, by review.py.

Nothing is measured again, the model is not called, no video is produced and no version is created. The result says so.
A fresh measurement or a fresh model assessment of an existing file is a different job and is not done here.
"""
import argparse
import json
import sys
import time
import traceback
from pathlib import Path

from . import PIPELINE_VERSION, review
from .core import EXIT, FAILURE, SUCCESS, PipelineError, read_json, utf8_stdout, write_json

HE = {"met": "מתקיים", "not_met": "לא מתקיים", "not_checked": "לא נבדק", "na": "לא רלוונטי"}
BASE_ROLE = "כללי העריכה הבסיסיים"


def _spoken(pkg):
    """What is said in the video, as the pipeline counted it: the words of the captions."""
    cards = pkg.get("cards") or []
    return " ".join(str(c.get("plain") or c.get("text") or "") for c in cards) or str(pkg.get("spoken_text") or "")


def _new_row(cid, cat, text, src, pkg, rec):
    """A criterion the stored review does not have: decided only from what was measured on this file."""
    if src == ("fact", "filler_share"):
        st, basis, note, t = review._fact("filler_share", {"spoken_text": _spoken(pkg)})
        return review._row(cid, cat, text, st, basis, note, t)
    if src[0] == "record":
        r = rec.get(src[1])
        st, basis, note = review._from_record(r)
        if src[1] == "mix_music_audible" and r is None:
            music = ((pkg.get("mix") or {}).get("params") or {}).get("music")
            st, note = ("not_checked", "מוזיקה עורבבה בגרסה הזו, אבל הנשמעות שלה מול הדיבור לא נמדדה אז") if music else ("na", "לא נבחרה מוזיקה לסרטון הזה")
        return review._row(cid, cat, text, st, basis, note)
    if src[0] == "human":
        return review._row(cid, cat, text, "not_checked", "human", "רק צפייה או האזנה שלך יכולה להכריע")
    return review._row(cid, cat, text, "not_checked", "none", "קריטריון חדש; אי אפשר לקבוע אותו מהמדידות השמורות של הקובץ הזה")


def upgrade(pkg, records):
    """The stored review of an edit, on the current rubric. -> (dana_review, changes)"""
    old = pkg["dana_review"]
    have = {r["id"]: r for c in old["categories"] for r in c.get("criteria") or []}
    labels = dict(review.CATEGORIES)
    rec = {r["id"]: r for r in records}
    rows, changed = [], []
    for cid, cat, text, src in review.CRITERIA:
        if cid in have:
            rows.append(dict(have[cid], criterion=text, category=cat))
            continue
        row = _new_row(cid, cat, text, src, pkg, rec)
        rows.append(row)
        changed.append({"kind": "added", "id": cid, "category": labels[cat], "criterion": text, "before": "לא היה בקריטריונים", "after": HE[row["status"]],
                        "why": row["note"], "basis": row["basis"]})
    now_ids = {c[0] for c in review.CRITERIA}
    for cid, r in have.items():
        if cid not in now_ids:
            changed.append({"kind": "removed", "id": cid, "category": labels.get(r["category"], r["category"]), "criterion": r["criterion"],
                            "before": HE.get(r["status"], r["status"]), "after": "הוסר מהקריטריונים", "why": "", "basis": r["basis"]})
    kind = old.get("kind") or "edit"
    from_findings = [i for i in old.get("improvements") or [] if str(i.get("id") or "").startswith("f:")]       # the reviewer's findings: kept as they were made
    from_rows = review.improvements(rows, {"findings": [], "kind": kind, "burned_in_text": bool((pkg.get("burned_in_text") or {}).get("present")) if isinstance(pkg.get("burned_in_text"), dict) else False})
    imps = sorted(from_findings + from_rows, key=lambda o: (o["importance"], not o["can_apply"]))
    return dict(old, rubric_version=review.RUBRIC_VERSION, categories=review.categorize(rows), improvements=imps), changed


def rate(pkg, checks, file_sha, version, now=None):
    """-> the review record of one existing file. Raises PipelineError when the stored review is not about that file."""
    now = now or time.strftime("%Y-%m-%dT%H:%M:%S%z")
    old, old_final = pkg.get("dana_review"), pkg.get("final_review") or {}
    prov = dict(pkg.get("review_provenance") or {})
    if not old or not old.get("categories"):
        raise PipelineError("no_review_to_rate", "לגרסה הזו אין ביקורת שמורה שאפשר לדרג ממנה", False)
    if not file_sha or prov.get("final_sha256") != file_sha:
        raise PipelineError("review_of_other_file", "המדידות השמורות של הגרסה הזו נעשו על קובץ אחר מהקובץ השמור — אי אפשר לדרג ממנן", False)
    records = checks.get("records") or []
    items = pkg.get("review_items") or []
    issues = pkg.get("issues") or []
    kind = old.get("kind") or "edit"
    if kind != "montage" and old.get("rubric_version") != review.RUBRIC_VERSION:
        mode, mode_label = "rubric_upgrade", "הביקורת עודכנה לגרסת הקריטריונים שבתוקף"
        dana_review, changed = upgrade(pkg, records)
        base = next(({"name": s.get("name"), "version": s.get("version")} for s in old_final.get("skills") or [] if s.get("role") == BASE_ROLE), None)
        final = review.final(dana_review, pkg.get("skill_report"), prov, items, records, None, old_final.get("target") or (pkg.get("target") or {}).get("key"), base,
                             owner_resolved=pkg.get("owner_resolved_checks") or [], issues=issues)
        final["changes"] = old_final.get("changes")            # the comparison with the previous VERSION stays as it was made
    else:
        # the review is already on the rubric in force: nothing in it is decided again; the mark and the next steps are added
        mode, mode_label = "rating_added", "לביקורת הקיימת נוספו הציון המסכם והצעדים הבאים"
        dana_review, changed = old, []
        settled = set(old_final.get("settled_by_owner") or [])
        failed = [r for r in records if r["status"] in ("fail", "review") and r["id"] not in settled]
        broken = old_final.get("mandatory_violations") or []
        extra = review.material_blocks(issues)
        top, every = review.top_improvements(dana_review, records, broken, settled, extra)
        final = dict(old_final)
        if not final.get("top_improvements"):
            final["top_improvements"], final["improvements_total"] = top, len(every)
        final.update(score=review.score(dana_review, review.blocking_of(failed, broken, extra)), all_improvements=every[:24],
                     next_steps=review.next_steps(every, [i for i in items if not i.get("owner_decision")], issues, pkg.get("skill_report")))
    before = review.score(old)
    after = final["score"]
    moved = [{"label": a["label"], "before": b["score"], "after": a["score"]} for a, b in zip(after["groups"], before["groups"]) if a["score"] != b["score"]]
    if before["overall"] != after["overall"]:
        text = (f"הציון לאותו קובץ השתנה מ-{before['overall']} ל-{after['overall']} בלי שהסרטון השתנה, כי הקריטריונים עודכנו "
                f"מגרסה {old.get('rubric_version')} לגרסה {dana_review['rubric_version']}: " + "; ".join(f"{c['criterion']} ({c['after']})" for c in changed if c["kind"] == "added")[:400] + ".")
    elif changed:
        text = (f"הציון המסכם לא השתנה ({after['overall']}). הקריטריונים עודכנו מגרסה {old.get('rubric_version')} לגרסה {dana_review['rubric_version']}: "
                + "; ".join(f"{c['criterion']} ({c['after']})" for c in changed)[:400] + ".")
    else:
        text = "אותו קובץ ואותם קריטריונים: שום קריטריון לא הוכרע מחדש."
    rating = {"rated_at": now, "mode": mode, "mode_label": mode_label, "measured_at": prov.get("reviewed_at"), "model_called": False, "rendered": False,
              "note": "הדירוג חושב מהמדידות ומהערכת המודל שנעשו על הקובץ הזה בזמן הפקתו. לא נעשתה מדידה חדשה, המודל לא הופעל שוב, "
                      "ולא נוצר סרטון או גרסה חדשה."}
    final["rating"] = rating
    final["rubric_version"] = dana_review["rubric_version"]
    final["file_sha256"] = file_sha
    final["same_file"] = {"previous": {"rubric_version": old.get("rubric_version"), "overall": before["overall"]},
                          "now": {"rubric_version": dana_review["rubric_version"], "overall": after["overall"]}, "criteria": changed, "groups": moved, "text": text}
    prov.update(rated_at=now, rating_mode=mode)
    return {"schema": 1, "pipeline_version": PIPELINE_VERSION, "mode": mode, "version": version, "file_sha256": file_sha, "rated_at": now,
            "measured_at": prov.get("reviewed_at"), "rubric_version": dana_review["rubric_version"], "score_version": review.SCORE_VERSION,
            "skills": final.get("skills") or [], "model_called": False, "rendered": False,
            "dana_review": dana_review, "final_review": final, "review_compact": review.compact(dana_review), "review_provenance": prov}


def main(argv=None):
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-dir", required=True)
    ap.add_argument("--config")                     # accepted for symmetry with the other pipeline modules; nothing here needs a tool
    ap.add_argument("--source")
    a = ap.parse_args(argv)
    job_dir = Path(a.job_dir)
    result = {"pipeline_version": PIPELINE_VERSION}
    try:
        print("[stage] rate", flush=True)
        job = read_json(job_dir / "job.json")
        of = (job.get("options") or {}).get("review_of") or {}
        rec = rate(read_json(job_dir / "in" / "package.json"), read_json(job_dir / "in" / "checks.json"), of.get("file_sha256"), of.get("version"))
        (job_dir / "out").mkdir(parents=True, exist_ok=True)
        write_json(job_dir / "out" / "review.json", rec)
        result.update(status=SUCCESS, mode=rec["mode"], overall=rec["final_review"]["score"]["overall"])
    except PipelineError as e:
        result.update(status=FAILURE, code=e.code, message=e.message, retryable=bool(e.retryable))
    except Exception as e:
        result.update(status=FAILURE, code="pipeline_crash", message=f"{type(e).__name__}: {e}", retryable=False, detail=traceback.format_exc()[-2000:])
    write_json(job_dir / "result.json", result)
    print(json.dumps({k: result.get(k) for k in ("status", "code", "message", "mode", "overall")}, ensure_ascii=False))
    return EXIT[result["status"]]


if __name__ == "__main__":
    sys.exit(main())
