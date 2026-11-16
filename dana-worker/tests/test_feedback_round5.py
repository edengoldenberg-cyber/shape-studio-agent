"""Changes made after the owner's acceptance feedback of 2026-11-16 ("the compilation has no direction", "I heard no music",
"the interview needs sharpening", "I did not see a clear final rating").

    python -X utf8 -m unittest discover -s dana-worker/tests -v
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from dana_pipeline import mix, montage, review, story  # noqa: E402

SMAP = [{"id": "src1", "name": "a.mp4", "start_s": 0.0, "end_s": 30.0, "marks": []}, {"id": "src2", "name": "b.mp4", "start_s": 30.0, "end_s": 60.0, "marks": []},
        {"id": "src3", "name": "c.mp4", "start_s": 60.0, "end_s": 90.0, "marks": []}]


def W(text, t0=0.0, step=0.5):
    return [{"word": w, "start": round(t0 + i * step, 3), "end": round(t0 + i * step + 0.4, 3), "probability": 0.9} for i, w in enumerate(text.split())]


class MusicLevel(unittest.TestCase):
    def test_the_level_is_how_far_under_the_speech_and_stays_in_the_audible_range(self):
        self.assertEqual(mix.music_under_speech({}), -14.0)
        self.assertEqual(mix.music_under_speech({"volume_db": -26}), -20.0)        # what made the music vanish on 2026-11-16
        self.assertEqual(mix.music_under_speech({"volume_db": 0}), -6.0)
        self.assertEqual(mix.music_under_speech({"volume_db": -10}), -10.0)

    def test_speech_and_the_gaps_between_it(self):
        spans, gaps = mix.speech_gaps([(1.0, 3.0), (3.05, 3.1), (5.0, 6.0)], 10.0)
        self.assertEqual(spans, [(1.0, 3.0), (5.0, 6.0)])
        self.assertEqual(gaps, [(0.2, 0.8), (3.2, 4.8), (6.2, 9.8)])

    def rec(self, **m):
        return {"params": {"music": {"under_speech_db_asked": -14.0}}, "measured": {"clipped_samples": 0, "peak_dbfs": -1.5, "ducking_db": 4.0, "music_between_speech_db": -24.0, **m}}

    def by(self, rec):
        return {c["id"]: c for c in mix.checks({}, rec, None)}

    def test_music_that_is_lost_under_the_speech_fails(self):
        c = self.by(self.rec(speech_over_music_db=30.3, music_level_db=-45.0))
        self.assertEqual(c["mix_music_audible"]["status"], "fail")
        self.assertIn("30.3", c["mix_music_audible"]["summary"])
        self.assertEqual(c["mix_speech_over_music"]["status"], "pass")            # the old check alone called this version fine

    def test_music_at_the_asked_level_passes_and_silence_fails(self):
        self.assertEqual(self.by(self.rec(speech_over_music_db=14.0, music_level_db=-30.0))["mix_music_audible"]["status"], "pass")
        self.assertEqual(self.by(self.rec(speech_over_music_db=None, music_level_db=-90.0))["mix_music_audible"]["status"], "fail")
        self.assertEqual(self.by(self.rec(speech_over_music_db=None, music_level_db=-26.0))["mix_music_audible"]["status"], "pass")

    def test_no_music_no_music_check(self):
        rec = self.rec()
        rec["params"]["music"] = None
        self.assertNotIn("mix_music_audible", self.by(rec))


class CompilationDirection(unittest.TestCase):
    def test_the_brief_is_cleaned_and_one_source_is_not_a_requirement(self):
        b = montage.brief_of({"brief": {"goal": "  להראות אווירה  ", "min_sources": "3", "demo": True, "reference": {"id": "r1", "title": "ref", "summary": "x" * 5000}}})
        self.assertEqual((b["goal"], b["min_sources"], b["demo"]), ("להראות אווירה", 3, True))
        self.assertEqual(len(b["reference"]["summary"]), 1500)
        self.assertEqual(montage.brief_of({"brief": {"min_sources": 1}})["min_sources"], 0)
        self.assertEqual(montage.brief_of({})["goal"], "")

    def test_the_request_says_whether_there_is_a_goal_a_reference_and_a_requirement(self):
        none = "\n".join(montage.brief_text(montage.brief_of({}), 3))
        self.assertIn("the owner gave no goal", none)
        self.assertIn("No reference video was attached", none)
        self.assertIn("no number of files is required", none)
        full = "\n".join(montage.brief_text(montage.brief_of({"brief": {"goal": "אנרגיה", "avoid": "בלי ראיונות", "min_sources": 5, "reference": {"id": "r", "title": "t", "summary": "קצב מהיר"}}}), 3))
        self.assertIn("אנרגיה", full)
        self.assertIn("בלי ראיונות", full)
        self.assertIn("<reference>", full)
        self.assertIn("at least 3 DIFFERENT files", full)                         # never more than there are

    def test_one_source_fails_only_when_several_were_required(self):
        one = [{"source_id": "src3"}, {"source_id": "src3"}]
        self.assertIsNone(montage.diversity(one, 0, SMAP)[1])                     # no requirement: one source is allowed
        r = montage.diversity(one, 2, SMAP)[1]
        self.assertEqual((r["id"], r["status"]), ("sources_diversity", "fail"))
        self.assertEqual(montage.diversity([{"source_id": "src3"}, {"source_id": "src1"}], 2, SMAP)[1]["status"], "pass")
        self.assertEqual(montage.diversity([{"source_id": "src3"}, {"source_id": "src1"}], 9, SMAP[:2])[1]["status"], "pass")   # asked for more files than exist

    def test_the_plan_keeps_the_role_of_each_part(self):
        cands = [{"n": 1, "in_s": 0.0, "out_s": 3.0, "must": False, "score": 1}, {"n": 2, "in_s": 40.0, "out_s": 43.0, "must": False, "score": 1}]
        segs, _ = montage.validate({"order": [{"candidate": 2, "seconds": 2, "seen": "", "role": "opening", "why": ""}, {"candidate": 1, "seconds": 2, "seen": "", "role": "banana", "why": ""}]}, cands, 3, 30)
        self.assertEqual([s["plan_role"] for s in segs], ["opening", None])
        for k in ("direction", "closing_why", "material_fit"):
            self.assertIn(k, montage.SCHEMA["required"])


class NarrationCaptionCorrections(unittest.TestCase):
    def test_a_corrected_stretch_stays_one_unit_with_the_owners_words(self):
        heard = W("אוקיי אז ההבדל בין המקום הזה")
        words, applied = story.apply_caption_edits(heard, [{"id": "ce_1", "source_start_s": 0.99, "source_end_s": 1.41, "text": "ההבדל הגדול"}])
        self.assertEqual(applied[0]["original"], "ההבדל")
        one, spans = montage.owner_units(words)
        self.assertEqual([u["text"] for u in one], ["אוקיי", "אז", "ההבדל הגדול", "בין", "המקום", "הזה"])
        self.assertTrue(all(w.get("synthetic") for w in spans[2]))                # never split or joined when the cards are divided
        self.assertEqual(sum(len(sp) for sp in spans), len(words))
        self.assertEqual((spans[2][0]["start"], spans[2][-1]["end"]), (1.0, 1.4))   # the place of the corrected words does not move

    def test_without_corrections_every_word_is_its_own_unit(self):
        one, spans = montage.owner_units(W("אחת שתיים שלוש"))
        self.assertEqual([len(sp) for sp in spans], [1, 1, 1])


class InterviewBeforeAfter(unittest.TestCase):
    WORDS = W("שלום אז מה שלומך היום אני מרגישה שהתחזקתי מאוד בסטודיו הזה יש פה קהילה חמה ואני נשארת בגלל האנשים", 0.0, 1.0)

    def plan(self, *parts, message="מ"):
        return {"message": message, "segments": [{"source_in_s": a, "source_out_s": b, "role": "body", "why": why} for a, b, why in parts], "left_out": [{"in_s": 0.0, "out_s": 5.0, "why": "הקדמה"}]}

    def test_what_was_cut_what_came_in_and_the_new_opening(self):
        d = story.plan_diff(self.plan((0.0, 10.0, "")), self.plan((5.0, 10.0, "פתיחה חזקה"), (13.0, 18.0, "סיום")), self.WORDS)
        self.assertEqual((d["before_s"], d["after_s"], d["parts_before"], d["parts_after"]), (10.0, 10.0, 1, 2))
        self.assertTrue(d["opening_changed"])
        self.assertEqual(d["opening_why"], "פתיחה חזקה")
        self.assertTrue(d["opening_after"].startswith("אני מרגישה"))
        self.assertEqual([(x["in_s"], x["out_s"], x["why"]) for x in d["removed"]], [(0.0, 5.0, "הקדמה")])
        self.assertEqual([x["why"] for x in d["added"]], ["סיום"])
        self.assertFalse(d["same_cut"])

    def test_a_part_that_moved_is_reported_as_moved(self):
        d = story.plan_diff(self.plan((0.0, 5.0, ""), (10.0, 15.0, "")), self.plan((10.0, 15.0, "נפתח במשפט החזק"), (0.0, 5.0, "")), self.WORDS)
        self.assertEqual((d["removed"], d["added"]), ([], []))
        self.assertEqual([(m["from_position"], m["to_position"]) for m in d["moved"]], [(2, 1), (1, 2)])

    def test_the_same_cut_and_plans_that_cannot_be_compared(self):
        self.assertTrue(story.plan_diff(self.plan((0.0, 5.0, "")), self.plan((0.0, 5.0, "")), self.WORDS)["same_cut"])
        self.assertIsNone(story.plan_diff(None, self.plan((0.0, 5.0, "")), self.WORDS))
        self.assertIsNone(story.plan_diff({"segments": [{"tl_in_s": 0}]}, self.plan((0.0, 5.0, "")), self.WORDS))

    def test_the_planner_is_told_to_sharpen(self):
        for phrase in ("SHARPEN", "ONE message", "repetition", "close on a sentence", "Do not pad"):
            self.assertIn(phrase, story.STORY_SYSTEM)
        self.assertIn("must not say anything the speaker did not say", story.STORY_SYSTEM)   # the limits stay


def review_of(rows, improvements=()):
    cats = []
    for key, label in review.CATEGORIES:
        mine = [r for r in rows if r["category"] == key]
        met, miss = sum(r["status"] == "met" for r in mine), sum(r["status"] == "not_met" for r in mine)
        cats.append({"key": key, "label": label, "level": "תקין" if met and not miss else "דורש שיפור" if met else "לא נבדק", "met": met, "decided": met + miss, "not_checked": 0, "criteria": mine})
    return {"rubric_version": review.RUBRIC_VERSION, "categories": cats, "improvements": list(improvements)}


def row(cid, cat, status, basis="model", note="", t=None):
    return {"id": cid, "category": cat, "criterion": cid + " קריטריון", "status": status, "basis": basis, "note": note, "time_s": t}


class FinalReviewForTheOwner(unittest.TestCase):
    def test_filler_words_are_counted_in_the_caption_text(self):
        f = review.filler_share("זה כאילו בית כזה שכאילו הרגשתי בו טוב מאוד כל הזמן")
        self.assertEqual((f["count"], f["words"]), (2, 11))                       # "שכאילו" is another word: only whole words are counted
        self.assertIsNone(review.filler_share("קצר מדי"))
        st, basis, note, _ = review._fact("filler_share", {"spoken_text": "כאילו כזה כאילו אני באה לפה כל יום בבוקר"})
        self.assertEqual((st, basis), ("not_met", "measured"))
        self.assertEqual(review._fact("filler_share", {"spoken_text": "אני באה לפה כל יום בבוקר ונהנית מכל רגע"})[0], "met")

    def test_a_weak_opening_is_something_dana_can_fix_and_it_comes_first(self):
        rows = [row("O2", "opening", "not_met", note="רקע יומיומי בלי טענה"), row("Y1", "sync", "not_met", "measured", "drift"), row("M1", "message", "met")]
        imps = review.improvements(rows, {"findings": [], "kind": "edit"})
        o2 = next(i for i in imps if i["criterion_id"] == "O2")
        self.assertTrue(o2["can_apply"])
        self.assertIn("פתיחה", o2["correction"])
        top, every = review.top_improvements(review_of(rows, imps), [], [])
        self.assertEqual((top[0]["category"], top[0]["who"], top[0]["time_s"], top[0]["replan"]), ("פתיחה", "dana", 0.0, True))
        self.assertEqual(top[0]["why"], "רקע יומיומי בלי טענה")
        self.assertNotIn("לא מתקיים", top[0]["title"])
        self.assertEqual(len(every), 2)

    def test_a_failed_check_is_said_in_plain_words_once(self):
        recs = [{"id": "mix_music_audible", "status": "fail", "summary": "המוזיקה נמוכה מהדיבור ב-30 dB"}, {"id": "energy_gate", "status": "review", "summary": "מילים חשודות"},
                {"id": "sync_lead", "status": "fail", "summary": "drift"}, {"id": "unknown_check", "status": "fail", "summary": "x"}]
        rows = [row("Y1", "sync", "not_met", "measured", "drift")]
        _, every = review.top_improvements(review_of(rows, review.improvements(rows, {"findings": []})), recs, [], owner_resolved=["energy_gate"])
        titles = [x["title"] for x in every]
        self.assertIn("המוזיקה כנראה לא נשמעת", titles)
        self.assertEqual(sum(t.startswith("Y1") or "לא מופיעות בדיוק" in t for t in titles), 1)     # the sync miss is not listed twice
        self.assertFalse(any("לא נאמרו" in t for t in titles))                    # settled by the owner's listening

    def final(self, rows, records=(), items=(), **kw):
        dr = review_of(rows, review.improvements(rows, {"findings": [], "kind": "edit"}))
        return review.final(dr, None, {"reviewed_at": "t", "final_sha256": "a" * 64, "on_delivered_file": True, "review_rounds": 1}, list(items), list(records), None, "reel", None, **kw)

    def test_the_card_has_a_status_a_summary_and_three_improvements(self):
        rows = [row("O2", "opening", "not_met"), row("M1", "message", "met"), row("S1", "structure", "not_met"), row("P1", "pace", "not_met"), row("K4", "captions", "not_met", "measured"), row("F3", "framing", "not_checked", "human")]
        f = self.final(rows)
        self.assertEqual(f["verdict"], "needs_fix")                               # a weak opening Dana can fix is not hidden behind "ready"
        self.assertEqual(f["plain"]["status"], "נדרש תיקון")
        self.assertIn("מסר", f["plain"]["works"])
        self.assertIn("פתיחה (0 מתוך 1)", f["plain"]["weak"])
        self.assertEqual(len(f["top_improvements"]), 3)
        self.assertEqual(f["improvements_total"], 4)
        self.assertTrue(all(x["category"] in ("פתיחה", "מבנה", "קצב") for x in f["top_improvements"]))    # content before technique
        self.assertTrue(all(k in f["top_improvements"][0] for k in ("title", "why", "action", "time_s", "who_label", "basis_label")))

    def test_nothing_open_is_ready_and_a_blocking_material_problem_is_not(self):
        ok = self.final([row("M1", "message", "met")])
        self.assertEqual((ok["verdict"], ok["plain"]["status"], ok["top_improvements"]), ("ready_for_viewing", "מוכן לצפייה", []))
        blocked = self.final([row("M1", "message", "met")], extra_improvements=[{"rank": 0, "blocks": True, "title": "הלקט משתמש בקובץ אחד; נדרשו 3", "why": "", "action": "להעלות חומר", "time_s": None,
                                                                              "who": "owner", "category": "חומר", "basis": "measured", "id": "i:x"}], note="בדיקת תשתית")
        self.assertEqual(blocked["verdict"], "needs_fix")
        self.assertEqual(blocked["top_improvements"][0]["title"], "הלקט משתמש בקובץ אחד; נדרשו 3")
        self.assertEqual(blocked["plain"]["note"], "בדיקת תשתית")

    def test_music_is_a_criterion_only_when_music_was_chosen(self):
        self.assertIn(("A4", "sound"), [(c[0], c[1]) for c in review.CRITERIA])
        self.assertIn("mix_music_audible", review.PLAIN)




class EndOfAPart(unittest.TestCase):
    """A part must not end ON a word's stamp when the stamp of the next word holds the pause (CLAUDE.md: a clip boundary does not cut a word)."""
    def setUp(self):
        from dana_pipeline.core import DEFAULTS, deep_merge
        self.cfg = deep_merge(DEFAULTS, {})
        self.profile = story.load_skill()[2]

    N = 24                                        # 24 words of half a second: a part of 12 s

    def words(self, next_dur):
        ws = [{"word": f"מילה{i}", "start": round(i * 0.5, 2), "end": round(i * 0.5 + 0.5, 2), "probability": 0.95} for i in range(self.N)]
        t = ws[-1]["end"]
        ws.append({"word": "זה", "start": t, "end": round(t + next_dur, 2), "probability": 0.9})            # its stamp touches the last word
        ws += [{"word": f"אחר{i}", "start": round(t + next_dur + 0.3 + i * 0.5, 2), "end": round(t + next_dur + 0.8 + i * 0.5, 2), "probability": 0.9} for i in range(5)]
        return ws

    def out_s(self, ws, **seg):
        end = self.N * 0.5
        raw = {"segments": [dict({"in_s": 0.0, "out_s": end - 0.2, "role": "body", "why": ""}, **seg)], "zooms": [], "cover": {}, "transcript_doubts": []}
        return story.validate_story(raw, ws, ws[-1]["end"] + 1, self.cfg, self.profile)["segments"][0]["source_out_s"]

    def test_the_cut_moves_into_the_pause_that_the_next_stamp_holds(self):
        self.assertAlmostEqual(self.out_s(self.words(0.98)), 12.16, places=2)      # "זה" stamped 0.98 s: most of it is a pause

    def test_real_continuous_speech_is_still_cut_on_the_boundary(self):
        self.assertAlmostEqual(self.out_s(self.words(0.25)), 12.0, places=2)       # a stamp of normal length: no room, no guess

    def test_a_locked_revision_keeps_the_edges_it_had(self):
        self.assertAlmostEqual(self.out_s(self.words(0.98), _keep=(0.0, 12.0)), 12.0, places=2)    # a version cut by the older rule is reproduced as it was
        self.assertAlmostEqual(self.out_s(self.words(0.25), _keep=(0.0, 12.16)), 12.16, places=2)


if __name__ == "__main__":
    unittest.main()
