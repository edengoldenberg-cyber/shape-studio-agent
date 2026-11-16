"""Dana's final rating: the summary mark out of 100, the next steps, and rating an EXISTING file without a render.

    python -X utf8 -m unittest discover -s dana-worker/tests -v
"""
import copy
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from dana_pipeline import rereview, review  # noqa: E402
from dana_pipeline.core import PipelineError  # noqa: E402
from test_round2 import facts  # noqa: E402

SHA = "a" * 64
PROV = {"reviewed_at": "2026-11-16T16:12:37+0200", "final_sha256": SHA, "reviewed_sha256": SHA, "on_delivered_file": True, "review_rounds": 1}
SPOKEN = "אני מרגישה שהסטודיו נתן לי כוח וביטחון ואני באה לכאן כל שבוע בשמחה גדולה"


def rows_of(rv):
    return {r["id"]: r for c in rv["categories"] for r in c["criteria"]}


def group(sc, key):
    return next(g for g in sc["groups"] if g["key"] == key)


class Score(unittest.TestCase):
    def test_a_group_is_the_share_of_its_decided_criteria_and_the_total_is_the_average_of_the_marked_groups(self):
        rec = lambda s: {"status": s, "summary": "s"}
        f = facts(spoken_text=SPOKEN)
        f["records"]["sync_lead"] = rec("fail")
        f["records"]["mix_music_audible"] = rec("pass")
        sc = review.score(review.build(f))
        g = group(sc, "captions_sync")
        self.assertEqual((g["met"], g["decided"], g["score"]), (9, 10, 90))
        marked = [x["score"] for x in sc["groups"] if x["score"] is not None]
        self.assertEqual(sc["overall"], round(sum(marked) / len(marked)))
        self.assertEqual(sc["out_of"], 100)
        self.assertEqual(sc["version"], review.SCORE_VERSION)
        self.assertIn("ממוצע", sc["how"])

    def test_a_half_is_rounded_up_the_same_way_the_server_does(self):
        rows = [{"id": str(k), "category": "structure", "status": "met" if k < 5 else "not_met", "basis": "measured"} for k in range(8)]
        sc = review.score({"rubric_version": "x", "categories": [{"key": "structure", "label": "מבנה", "criteria": rows}]})
        g = next(x for x in sc["groups"] if x["key"] == "structure_pace")
        self.assertEqual((g["met"], g["decided"], g["score"]), (5, 8, 63))          # 62.5: not 62
        self.assertEqual(sc["overall"], 63)

    def test_what_was_not_checked_gets_no_mark_and_is_not_counted(self):
        sc = review.score(review.build(facts(criteria={}, records={}, cut_joins=None, first_word_s=None, longest_pause=None, face_inside=None, color=None, audio=None,
                                             zooms=None, graphics=None, cover_text="")))
        self.assertIsNone(sc["overall"])                               # nothing was decided: no number is made up
        self.assertTrue(all(g["score"] is None and g["level"] == "לא נבדק" for g in sc["groups"]))
        self.assertEqual(sc["coverage"]["decided"], 0)
        # the human-only criteria never count, whatever else was decided
        full = review.score(review.build(facts(spoken_text=SPOKEN)))
        self.assertEqual(full["coverage"]["human_only"], 4)
        self.assertEqual(full["coverage"]["decided"] + full["coverage"]["not_checked"] + full["coverage"]["not_applicable"], full["coverage"]["criteria"])
        self.assertIn("לא נבדקו ואינם בציון", full["coverage"]["text"])

    def test_a_component_the_skill_switched_off_is_not_required(self):
        with_z = review.score(review.build(facts(spoken_text=SPOKEN)))
        without = review.score(review.build(facts(spoken_text=SPOKEN, zooms=[], graphics=[])))        # edited without zooms and without graphics
        self.assertEqual(group(without, "visual")["score"], 100)                                 # nothing is lost for what was not asked
        self.assertLess(group(without, "visual")["decided"], group(with_z, "visual")["decided"])
        self.assertGreater(without["coverage"]["not_applicable"], with_z["coverage"]["not_applicable"])

    def test_the_bases_are_kept_apart(self):
        sc = review.score(review.build(facts(spoken_text=SPOKEN)))
        by = sc["coverage"]["by_basis"]
        self.assertGreater(by["measured"]["decided"], 0)
        self.assertGreater(by["model"]["decided"], 0)
        self.assertEqual(by["measured"]["decided"] + by["model"]["decided"] + by["frames"]["decided"], sc["coverage"]["decided"])
        self.assertTrue(any("לא שמע" in x for x in sc["limits"]))

    def test_the_mark_does_not_cancel_a_mandatory_failure(self):
        rec = [{"id": "energy_gate", "status": "fail", "summary": "x"}]
        rv = review.build(facts(spoken_text=SPOKEN))
        fin = review.final(rv, None, PROV, [], rec, None, "reel", None, issues=[])
        self.assertEqual(fin["verdict"], "needs_fix")
        self.assertEqual(fin["score"]["blocking"]["count"], 1)
        self.assertIn("אינו מבטל", fin["score"]["blocking"]["text"])
        self.assertGreaterEqual(fin["score"]["overall"], 90)             # the arithmetic is untouched; the failure is listed beside it


class NextSteps(unittest.TestCase):
    def test_three_separate_lists(self):
        rec = lambda s: {"status": s, "summary": "s"}
        f = facts(spoken_text=SPOKEN)
        f["records"]["sync_lead"] = rec("fail")
        f["criteria"]["A16"] = {"id": "A16", "met": False, "note": "פתיחה חלשה", "decided_by": "reviewer"}
        rv = review.build(f)
        issues = [{"code": "cta_missing", "severity": "warn", "message": "אין CTA"}, {"code": "music_license_not_confirmed", "severity": "blocker", "message": "רישיון"},
                  {"code": "caption_is_draft", "severity": "info", "message": "קפשן טיוטה"}, {"code": "cards_regrouped", "severity": "info", "message": "מידע בלבד"}]
        records = [{"id": "energy_gate", "status": "fail", "summary": "מילה חשודה"}]
        fin = review.final(rv, {"summary": None, "rules": [{"status": "unsupported", "text": "חיתוך חד"}], "params": [], "criteria": []}, PROV,
                           [{"id": "t:1"}, {"id": "t:2", "owner_decision": "ok"}], records, None, "reel", None, issues=issues)
        ns = fin["next_steps"]
        self.assertEqual({x["id"] for x in ns["dana"]}, {"c:Y1", "c:O2"})
        self.assertTrue(next(x for x in ns["dana"] if x["id"] == "c:O2")["replan"])                 # a content improvement changes the cut ...
        self.assertFalse(next(x for x in ns["dana"] if x["id"] == "c:Y1")["replan"])                # ... a caption timing fix does not
        self.assertEqual({x["id"] for x in ns["owner"]}, {"r:energy_gate", "i:caption_is_draft"})
        self.assertEqual({(x["kind"]) for x in ns["blockers"]}, {"מידע עסקי", "רישיון", "יכולת"})
        self.assertEqual(ns["open_items"], 1)
        self.assertEqual(ns["apply"]["count"], 2)
        self.assertIn("רק את 2", ns["apply"]["text"])
        self.assertNotIn("cards_regrouped", str(ns))                                               # an informational note is not a step


def package(rubric="dana-review-2026-11-16.1", music=False):
    """A delivered package as the worker stored it under the previous rubric: no filler-words and no audible-music criterion."""
    rv = review.build(facts(spoken_text=SPOKEN))
    rv["rubric_version"] = rubric
    for c in rv["categories"]:
        c["criteria"] = [r for r in c["criteria"] if r["id"] not in ("P3", "A4")]
    rv["categories"] = review.categorize([r for c in rv["categories"] for r in c["criteria"]])
    fin = {"skills": [{"name": "dana-review", "version": rubric, "role": "סקיל הביקורת"}, {"name": "dana-editing", "version": "0.1.0", "role": "כללי העריכה הבסיסיים"}],
           "target": "reel", "verdict": "ready_for_viewing", "changes": None}
    return {"dana_review": rv, "final_review": fin, "review_provenance": dict(PROV), "review_items": [], "issues": [], "owner_resolved_checks": [],
            "cards": [{"i": k, "text": w} for k, w in enumerate(SPOKEN.split())], "mix": {"params": {"music": {"file": "m.m4a"}}} if music else None}


class RatingOfAnExistingFile(unittest.TestCase):
    def test_the_stored_review_is_brought_to_the_rubric_in_force_without_deciding_anything_again(self):
        pkg = package()
        before = copy.deepcopy(rows_of(pkg["dana_review"]))
        r = rereview.rate(pkg, {"records": []}, SHA, 5, now="2026-11-16T22:00:00+0200")
        after = rows_of(r["dana_review"])
        self.assertEqual(r["mode"], "rubric_upgrade")
        self.assertEqual(r["rubric_version"], review.RUBRIC_VERSION)
        self.assertEqual((r["file_sha256"], r["version"], r["rated_at"], r["measured_at"]), (SHA, 5, "2026-11-16T22:00:00+0200", PROV["reviewed_at"]))
        self.assertFalse(r["model_called"] or r["rendered"])
        for cid, row in before.items():                                 # every decision made on the file is kept as it was
            self.assertEqual((after[cid]["status"], after[cid]["basis"], after[cid]["note"]), (row["status"], row["basis"], row["note"]))
        self.assertEqual(after["P3"]["status"], "met")                  # counted in the caption text of this file
        self.assertEqual(after["P3"]["basis"], "measured")
        self.assertEqual(after["A4"]["status"], "na")                   # no music was chosen: not required
        self.assertEqual({c["id"] for c in r["final_review"]["same_file"]["criteria"]}, {"P3", "A4"})
        self.assertEqual([s["name"] for s in r["skills"]], ["dana-review", "dana-editing"])
        self.assertEqual(r["skills"][0]["version"], review.RUBRIC_VERSION)
        self.assertEqual(r["final_review"]["score"]["overall"], 100)
        self.assertEqual(r["score_version"], review.SCORE_VERSION)

    def test_music_that_was_mixed_but_never_measured_is_not_checked_rather_than_assumed(self):
        r = rereview.rate(package(music=True), {"records": []}, SHA, 2)
        self.assertEqual(rows_of(r["dana_review"])["A4"]["status"], "not_checked")
        r2 = rereview.rate(package(music=True), {"records": [{"id": "mix_music_audible", "status": "fail", "summary": "המוזיקה 28dB מתחת לדיבור"}]}, SHA, 2)
        self.assertEqual(rows_of(r2["dana_review"])["A4"]["status"], "not_met")
        self.assertLess(r2["final_review"]["score"]["overall"], 100)

    def test_a_change_of_the_mark_for_the_same_file_is_explained(self):
        pkg = package()
        pkg["cards"] = [{"i": k, "text": w} for k, w in enumerate("כאילו אני כזה מרגישה כאילו שהסטודיו כזה נתן לי כוח".split())]      # 4 fillers of 10 words
        r = rereview.rate(pkg, {"records": []}, SHA, 1)
        sf = r["final_review"]["same_file"]
        self.assertEqual(rows_of(r["dana_review"])["P3"]["status"], "not_met")
        self.assertEqual(sf["previous"]["overall"], 100)
        self.assertLess(sf["now"]["overall"], 100)
        self.assertIn("בלי שהסרטון השתנה", sf["text"])
        self.assertIn("מילות מילוי", sf["text"])
        self.assertEqual([g["label"] for g in sf["groups"]], ["מבנה וקצב"])

    def test_it_refuses_measurements_of_another_file(self):
        with self.assertRaises(PipelineError) as e:
            rereview.rate(package(), {"records": []}, "b" * 64, 1)
        self.assertEqual(e.exception.code, "review_of_other_file")
        with self.assertRaises(PipelineError) as e:
            rereview.rate({"review_provenance": dict(PROV)}, {"records": []}, SHA, 1)
        self.assertEqual(e.exception.code, "no_review_to_rate")

    def test_a_review_already_on_the_rubric_in_force_only_gets_the_mark_and_the_next_steps(self):
        rv = review.build(facts(spoken_text=SPOKEN))
        fin = review.final(rv, None, PROV, [], [], None, "reel", {"name": "dana-editing", "version": "0.1.0"}, issues=[])
        stored = copy.deepcopy(fin)
        for k in ("score", "next_steps", "all_improvements"):          # as packages delivered before the mark existed
            stored.pop(k)
        pkg = {"dana_review": rv, "final_review": stored, "review_provenance": dict(PROV), "review_items": [], "issues": [{"code": "cta_missing", "severity": "warn", "message": "אין CTA"}]}
        r = rereview.rate(pkg, {"records": []}, SHA, 7)
        self.assertEqual(r["mode"], "rating_added")
        self.assertEqual(r["dana_review"], rv)
        self.assertEqual(r["final_review"]["score"], fin["score"])
        self.assertEqual(r["final_review"]["verdict"], stored["verdict"])
        self.assertEqual([x["kind"] for x in r["final_review"]["next_steps"]["blockers"]], ["מידע עסקי"])
        self.assertIn("שום קריטריון לא הוכרע מחדש", r["final_review"]["same_file"]["text"])


if __name__ == "__main__":
    unittest.main()
