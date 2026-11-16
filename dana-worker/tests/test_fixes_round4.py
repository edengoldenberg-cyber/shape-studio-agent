"""The faults found in the round-4 acceptance run must not come back:
1. the reviewer and the editor work by the rules IN FORCE (no highlight when the skill switched it off, no cover text on a story);
2. captions do not repeat the text of a full-frame animation scene, and nothing that is not in the scene is lost;
3. a spelling fix that was made is not undone by a later revision;
4. "without music" is a prohibition that is checked and kept, not an unsupported capability;
5. short cards: the words are divided by measured width, and what cannot be solved is said with its reason;
6. a finding the editor did not fix is not sent again.
Plus: a MEASURED violation of a mandatory rule fails the final review. No model call, no ffmpeg."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dana_pipeline import captions, editorial, effective, motion, review, skillgen, target    # noqa: E402

STYLE = {"highlight_enabled": True, "captions_enabled": True, "caption_max_lines": 1}
SKILL = {"name": "עדות אישית", "param_sources": {"highlight_enabled": "עדות אישית"}}


class RulesInForce(unittest.TestCase):
    def test_a_highlight_the_skill_switched_off_is_not_asked_for_and_not_judged(self):
        eff = effective.build(dict(STYLE, highlight_enabled=False), target.spec("reel"), "reel", SKILL)
        self.assertEqual((eff["highlight"], eff["cover_text"]), (False, True))
        self.assertIn("SWITCHED OFF", eff["lines"][0])                       # the planner, the editor and the reviewer are told
        self.assertIn("עדות אישית", eff["notes"][0])                         # and the owner is told who decided it
        self.assertEqual(list(eff["na"]), ["A10"])
        f = {"asset": "highlight", "fix": "highlight", "problem": "אין הדגשה צהובה באף כרטיס", "correction": "להוסיף הדגשה"}
        self.assertIn("כבויה", effective.not_applicable(f, eff))
        self.assertIsNotNone(effective.not_applicable(dict(f, asset="card", fix="cards"), eff))      # however it is filed
        self.assertIsNone(effective.not_applicable({"asset": "card", "fix": "cards", "problem": "הכרטיס חותך משפט", "correction": "לאחד"}, eff))

    def test_a_story_has_no_cover_text_and_nobody_asks_for_one(self):
        eff = effective.build(STYLE, target.spec("story"), "story", None)
        self.assertEqual((eff["highlight"], eff["cover_text"]), (True, False))
        self.assertEqual(sorted(eff["na"]), ["A3", "A9"])
        self.assertIn("סטורי", effective.not_applicable({"asset": "cover", "fix": "cover", "problem": "טקסט הקאבר ריק", "correction": "להוסיף ציטוט"}, eff))
        self.assertIsNone(effective.not_applicable({"asset": "cover", "fix": "cover", "problem": "טקסט הקאבר ריק", "correction": "x"},
                                                   effective.build(STYLE, target.spec("reel"), "reel", None)))      # on a reel it IS a finding

    def test_the_criterion_is_not_applicable_neither_met_nor_failed(self):
        eff = effective.build(dict(STYLE, highlight_enabled=False), target.spec("story"), "story", SKILL)
        res = {"issues": [], "effective": eff}
        rows = {r["id"]: r for r in editorial.criteria_table({}, res, [], {}, {"criteria": [{"id": "A10", "met": False, "note": "אין צהוב"}, {"id": "A5", "met": True, "note": "n"}]})}
        self.assertEqual((rows["A10"]["decided_by"], rows["A10"]["met"]), ("not_applicable", None))       # even if the model answered it
        self.assertEqual((rows["A9"]["decided_by"], rows["A3"]["decided_by"], rows["A5"]["met"]), ("not_applicable", "not_applicable", True))
        rv = review.build({"kind": "edit", "records": {}, "criteria": rows, "findings": [], "cover_text": "", "captions_added": True, "zooms": [], "graphics": []})
        st = {c["id"]: c["status"] for cat in rv["categories"] for c in cat["criteria"]}
        self.assertEqual((st["K5"], st["V1"], st["V2"]), ("na", "na", "na"))
        cover = next(c for c in rv["categories"] if c["key"] == "cover")
        self.assertNotEqual(cover["level"], "דורש שיפור")                    # an output without a cover is not marked down for it


def card(i, text, start, dur):
    return {"i": i, "plain": text, "start": start, "dur": dur, "highlight": []}


class SceneCaptions(unittest.TestCase):
    SCENE = [{"id": "animation_scene@30.0", "text": "לסמוך על עצמי, ועל היכולות שלי", "tl_start_s": 29.75, "tl_end_s": 33.31}]
    CARDS = [card(1, "ממש נותן לי", 29.0, 0.88), card(2, "לסמוך על", 29.88, 0.6), card(3, "עצמי,", 30.48, 0.88), card(4, "ועל היכולות", 31.4, 1.0),
             card(5, "שלי,", 32.4, 0.64), card(6, "ויש ליווי", 33.4, 0.8)]

    def test_cards_whose_words_the_scene_shows_are_not_drawn_over_it(self):
        self.assertEqual(motion.cards_in_scenes(self.CARDS, self.SCENE), {2: "animation_scene@30.0", 3: "animation_scene@30.0", 4: "animation_scene@30.0", 5: "animation_scene@30.0"})

    def test_a_card_with_a_word_the_scene_does_not_show_stays_drawn(self):
        cards = [card(1, "לסמוך על עצמי באמת", 30.0, 1.2), card(2, "היכולות שלי", 31.5, 1.0), card(3, "שלי היכולות", 32.4, 0.6)]
        self.assertEqual(motion.cards_in_scenes(cards, self.SCENE), {2: "animation_scene@30.0"})     # "באמת" is not in the scene; a different order is not the same text
        self.assertEqual(motion.cards_in_scenes(self.CARDS, []), {})


class SceneCut(unittest.TestCase):
    def test_cards_that_straddle_the_scene_are_cut_at_its_edges_and_only_the_scene_words_are_hidden(self):
        ws = [{"word": w, "start": 33.0 + 0.4 * n, "end": 33.3 + 0.4 * n} for n, w in enumerate("נותן לי לסמוך על עצמי ועל היכולות".split())]
        cards = [{"text": "נותן לי לסמוך", "highlight": ["לסמוך"]}, {"text": "על עצמי, ועל", "highlight": []}, {"text": "היכולות", "highlight": []}]
        spans = [ws[0:3], ws[3:6], ws[6:7]]
        scene = [{"id": "animation_scene@1", "text": "לסמוך על עצמי", "tl_start_s": 34.3, "tl_end_s": 36.3}]
        new, made = motion.isolate_scene_words(cards, spans, scene)
        self.assertEqual(([c["text"] for c in new], made), (["נותן לי", "לסמוך", "על עצמי,", "ועל", "היכולות"], 2))
        self.assertEqual(" ".join(c["text"] for c in new), " ".join(c["text"] for c in cards))      # same words, same order
        self.assertEqual(new[1]["highlight"], ["לסמוך"])
        timed = [card(i + 1, c["text"], t, 0.4) for i, (c, t) in enumerate(zip(new, [33.0, 34.3, 34.7, 35.9, 36.4]))]
        self.assertEqual(sorted(motion.cards_in_scenes(timed, scene)), [2, 3])                        # "נותן לי" and "ועל" stay on screen

    def test_nothing_is_cut_when_the_scene_words_are_not_said_near_it(self):
        ws = [{"word": w, "start": 3.0 + n, "end": 3.5 + n} for n, w in enumerate("לסמוך על עצמי".split())]
        cards = [{"text": "לסמוך על עצמי", "highlight": []}]
        self.assertEqual(motion.isolate_scene_words(cards, [ws], [{"id": "s", "text": "על עצמי", "tl_start_s": 40.0, "tl_end_s": 42.0}]), (cards, 0))


class SpellingKept(unittest.TestCase):
    KEPT = [{"heard": "מאויימת", "shown": "מאוימת", "reason": "הקשר"}]

    def test_a_revision_that_went_back_to_the_earlier_spelling_is_put_back(self):
        dec = {"cards": [{"text": "שאני לא", "highlight": []}, {"text": "מרגישה מאויימת,", "highlight": ["מאויימת"]}], "cover": {"text": "לא מאויימת"}, "spelling": []}
        self.assertEqual(effective.keep_spellings(dec, self.KEPT), ["'מאויימת' → 'מאוימת'"])
        self.assertEqual((dec["cards"][1], dec["cover"]["text"], dec["spelling"]), ({"text": "מרגישה מאוימת,", "highlight": ["מאוימת"]}, "לא מאוימת", self.KEPT))

    def test_nothing_else_is_touched_and_a_kept_choice_is_not_reported_as_restored(self):
        dec = {"cards": [{"text": "מרגישה מאוימת,", "highlight": []}, {"text": "מאויימתים", "highlight": []}], "cover": {"text": ""}, "spelling": list(self.KEPT)}
        self.assertEqual(effective.keep_spellings(dec, self.KEPT), [])
        self.assertEqual((dec["cards"][1]["text"], len(dec["spelling"])), ("מאויימתים", 1))            # only whole words


def skill_with(rules):
    return {"id": "s", "name": "ס", "version": 1, "rules": rules, "unsupported": [], "criteria": []}


RULES = [{"id": "r1", "text": "בלי מוזיקת רקע", "domain": "music", "support": "supported", "mandatory": True, "prohibition": True, "skill": "ס"},
         {"id": "r2", "text": "קטע אנימציה אחד במסך מלא", "domain": "animation", "support": "partial", "mandatory": True, "skill": "ס"},
         {"id": "r3", "text": "כותרת פתיחה מונפשת", "domain": "motion_graphics", "support": "partial", "mandatory": True, "skill": "ס"},
         {"id": "r4", "text": "כתוביות בשורה אחת בלבד", "domain": "captions", "support": "supported", "mandatory": True, "skill": "ס"}]
SAID = {"skill_rules": [{"id": "r1", "status": "cannot_tell", "note": "דורש האזנה"}, {"id": "r2", "status": "not_followed", "note": "לא נראה קטע בפריימים"},
                        {"id": "r3", "status": "not_followed", "note": "בפריים 0.4 אין כותרת"}, {"id": "r4", "status": "applied", "note": "שורה אחת"}], "skill_criteria": []}


class Prohibition(unittest.TestCase):
    def test_without_music_is_checked_as_a_prohibition_that_was_kept(self):
        r = skillgen.report(skill_with(RULES), {"caption_max_lines": 1}, SAID, {}, {"music_added": False, "scenes": 1, "overlays": 0, "max_caption_lines": 1})
        row = r["rules"][0]
        self.assertEqual((row["status"], row["decided_by"], row["verified"]), ("applied", "measured", False))
        self.assertIn("האיסור נשמר", row["note"])
        self.assertEqual(r["summary"]["unsupported"], 0)

    def test_a_broken_prohibition_is_a_measured_violation(self):
        r = skillgen.report(skill_with(RULES), {"caption_max_lines": 1}, SAID, {}, {"music_added": True, "scenes": 1, "overlays": 1, "max_caption_lines": 1})
        self.assertEqual((r["rules"][0]["status"], r["rules"][0]["verified"]), ("not_followed", True))
        self.assertEqual([v["id"] for v in r["mandatory_violations"]], ["r1"])


class MandatoryRule(unittest.TestCase):
    def test_a_violation_is_verified_only_when_a_measurement_shows_it(self):
        r = skillgen.report(skill_with(RULES), {"caption_max_lines": 1}, SAID, {}, {"music_added": False, "scenes": 1, "overlays": 0, "max_caption_lines": 2})
        by = {x["id"]: x for x in r["rules"]}
        self.assertEqual((by["r2"]["status"], by["r2"]["verified"]), ("not_checked", False))          # the model saw no scene in stills, but one IS in the file
        self.assertIn("נמדד שיש 1", by["r2"]["note"])
        self.assertEqual((by["r3"]["status"], by["r3"]["verified"]), ("not_followed", True))          # the model and the count agree: no overlay
        self.assertEqual((by["r4"]["status"], by["r4"]["verified"]), ("not_followed", True))          # measured on the cards, whatever the model said
        self.assertEqual(sorted(v["id"] for v in r["mandatory_violations"]), ["r3", "r4"])
        self.assertEqual(r["summary"]["mandatory_violations_verified"], 2)

    def test_a_measured_violation_of_a_mandatory_rule_fails_the_final_review_whatever_the_rating(self):
        clean = review.build({"kind": "edit", "records": {}, "criteria": {}, "findings": [], "cover_text": "x", "captions_added": True, "zooms": [], "graphics": []})
        prov = {"reviewed_at": "t", "final_sha256": "f", "on_delivered_file": True, "review_rounds": 1}
        ok = skillgen.report(skill_with(RULES), {"caption_max_lines": 1}, SAID, {}, {"music_added": False, "scenes": 1, "overlays": 1, "max_caption_lines": 1})
        self.assertEqual(review.final(clean, ok, prov, [], [], None, "reel", None)["verdict"], "ready_for_viewing")
        bad = skillgen.report(skill_with(RULES), {"caption_max_lines": 1}, SAID, {}, {"music_added": False, "scenes": 1, "overlays": 0, "max_caption_lines": 1})
        f = review.final(clean, bad, prov, [], [], None, "reel", None)
        self.assertEqual((f["verdict"], [v["id"] for v in f["mandatory_violations"]]), ("needs_fix", ["r3"]))
        self.assertTrue(f["verdict_reasons"][0].startswith("כלל מחייב של הסקיל הופר (נמדד)"))
        self.assertTrue(any(n.get("mandatory") and n["basis"] == "measured" for n in f["needs_improvement"]))

    def test_an_unverified_assessment_does_not_fail_it_by_itself(self):
        said = {"skill_rules": [{"id": "r4", "status": "not_followed", "note": "נראה לי שתי שורות"}], "skill_criteria": []}
        r = skillgen.report(skill_with(RULES[3:]), {"caption_max_lines": 1}, said, {}, {"max_caption_lines": 1})
        self.assertEqual((r["rules"][0]["status"], r["rules"][0]["verified"], r["mandatory_violations"]), ("not_followed", False, []))


def words(*items):
    t, out = 0.0, []
    for text, dur in items:
        out.append({"word": text, "start": round(t, 2), "end": round(t + dur - 0.02, 2)})
        t += dur
    return out


class Division(unittest.TestCase):
    # one line holds about 11 characters; speech is continuous
    FITS = staticmethod(lambda t: len(t) <= 11)

    def cards(self, groups, ws):
        cards, spans, k = [], [], 0
        for g in groups:
            cards.append({"text": " ".join(w["word"] for w in ws[k:k + g]), "highlight": []})
            spans.append(ws[k:k + g])
            k += g
        return cards, spans

    def test_the_same_words_are_divided_so_that_fewer_cards_flash_by(self):
        ws = words(("אני", 0.25), ("רואה", 0.2), ("את", 0.1), ("זה", 0.15), ("גם", 0.15), ("לפי", 0.3), ("המשקלים", 0.34))
        cards, spans = self.cards([1, 2, 2, 2], ws)                       # "אני" 0.25s | "רואה את" 0.30s | "זה גם" 0.30s | "לפי המשקלים" 0.64s
        new, stats = captions.regroup(cards, spans, self.FITS, 0.5, 25, 3, 0.4)
        self.assertEqual((stats["bad_before"], stats["bad_after"]), (3, 0))
        self.assertEqual(" ".join(c["text"] for c in new), " ".join(c["text"] for c in cards))      # same words, same order
        self.assertLess(stats["bad_after"], stats["bad_before"])
        self.assertTrue(all(self.FITS(c["text"]) for c in new))
        self.assertEqual(stats["runs_changed"], 1)

    def test_a_division_that_cannot_be_improved_is_left_alone(self):
        ws = words(("מרגישה", 0.4), ("שהתחזקתי,", 0.6))                    # joined they are 16 characters: too wide for one line
        cards, spans = self.cards([1, 1], ws)
        new, stats = captions.regroup(cards, spans, self.FITS, 0.5, 17, 3, 0.4)
        self.assertEqual((new, stats["runs_changed"], stats["bad_after"]), (cards, 0, stats["bad_before"]))

    def test_a_pause_is_never_joined_across_and_a_highlight_follows_its_word(self):
        ws = words(("זה", 0.2), ("ממש", 0.2))
        ws += [{"word": "תחושה", "start": 2.0, "end": 2.3}, {"word": "פנימית", "start": 2.32, "end": 2.6}]
        cards, spans = self.cards([1, 1, 1, 1], ws)
        cards[1]["highlight"] = ["ממש"]
        new, _ = captions.regroup(cards, spans, self.FITS, 0.5, 17, 3, 0.4)
        self.assertEqual([c["text"] for c in new], ["זה ממש", "תחושה", "פנימית"])                     # "תחושה פנימית" is 12 characters: it does not fit
        self.assertEqual(new[0]["highlight"], ["ממש"])

    def test_what_cannot_be_solved_goes_to_the_owner_with_the_reason_and_stays_visible(self):
        res = {"issues": [], "odiffs": [], "comfort_rows": [
            {"i": 2, "text": "מרגישה", "why": "על המסך 0.40s", "t0": 0.76, "cannot": "איחוד עם כרטיס שכן חורג מרוחב השורה (620px באזור הבטוח, גודל 96, שורה אחת)"},
            {"i": 9, "text": "כן", "why": "על המסך 0.30s", "t0": 5.0}]}
        det = editorial.deterministic_findings({}, {}, res, {})
        self.assertEqual([(f["fix"], f["severity"]) for f in det], [("owner", "advisory"), ("cards", "advisory")])     # both are still reported
        self.assertIn("620px", det[0]["correction"])
        self.assertIn("להכרעתך", det[0]["correction"])


def finding(id_, source, asset, fix, key=None):
    return {"id": id_, "source": source, "asset": asset, "fix": fix, "key": key or f"reviewer:{id_}", "problem": "p", "severity": "blocking"}


class OneAttempt(unittest.TestCase):
    def test_a_finding_the_editor_did_not_fix_is_not_sent_again_even_when_it_is_restated(self):
        sent = [finding("a1", "reviewer", "highlight", "highlight"), finding("b1", "check:A12", "card", "spelling", "ortho:x>y")]
        ver = [{"id": "a1", "status": "not_fixed", "evidence": "highlight ריק", "editor_said": "נוספה הדגשה"}, {"id": "b1", "status": "fixed", "editor_said": "תוקן"}]
        ex = effective.exhausted_after(sent, ver)
        again = finding("a2", "reviewer", "highlight", "highlight")              # the reviewer restates it under a new id
        self.assertIn(effective.topic(again), ex)
        self.assertIn("נוספה הדגשה", ex[effective.topic(again)])
        self.assertIn("highlight ריק", ex[effective.topic(again)])
        self.assertNotIn(effective.topic(finding("b2", "check:A12", "card", "spelling", "ortho:x>y")), ex)       # the fixed one is not blocked
        self.assertNotIn(effective.topic(finding("c1", "reviewer", "cover", "cover")), ex)                       # a different matter is still sent

    def test_an_identical_revision_is_recognised(self):
        a = {"cards": [{"text": "שלום", "highlight": []}], "cover": {"text": "שלום"}, "caption": {"text": "ק", "cta": None}, "segment": {"in_s": 1, "out_s": 9}}
        self.assertTrue(effective.same_edit(a, dict(a, revision_note="שיניתי")))
        self.assertFalse(effective.same_edit(a, dict(a, cards=[{"text": "שלום", "highlight": ["שלום"]}])))


if __name__ == "__main__":
    unittest.main()
