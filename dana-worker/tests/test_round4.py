"""Unit tests for round 4: reel / story targets, the animation scene vs. an overlay graphic, combining skills into one
plan, the timeline and Dana's final review. No model call, no ffmpeg, no HyperFrames."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dana_pipeline import adjust, motion, review, skillgen, story, target    # noqa: E402
from dana_pipeline.core import DEFAULTS, PipelineError, deep_merge            # noqa: E402

CFG = deep_merge(DEFAULTS, {})
_, _, PROFILE = story.load_skill()
TEXT = ("אני מתאמנת כאן שנה ותמיד יש חששות להגיע למקום חדש אבל כאן נעלמו החששות מהר זו אווירה תומכת וזה לבוא הביתה באמת "
        "המדריכות מכירות אותי בשם ויודעות מה כואב לי ומה אני יכולה לעשות ובכל אימון אני יוצאת חזקה יותר ממה שנכנסתי")
W = [{"word": w, "start": round(i * 0.5, 2), "end": round(i * 0.5 + 0.42, 2), "probability": 0.95} for i, w in enumerate(TEXT.split())]
DUR = W[-1]["end"] + 0.5


def raw(segs, **over):
    base = {"message": "m", "hook": "h", "rationale": "r", "brief": [], "segments": [{"in_s": W[a]["start"], "out_s": W[b]["end"], "role": "body", "why": "w"} for a, b in segs],
            "zooms": [], "cover": {"quote": "נעלמו החששות", "at_s": W[14]["start"], "why": "c"}, "transcript_doubts": [], "burned_in_text": {"present": False, "examples": []}}
    base.update(over)
    return base


class Target(unittest.TestCase):
    def test_a_story_is_cards_with_its_own_limits_zone_cover_and_caption(self):
        self.assertEqual(target.of({"target": "story"}), "story")
        self.assertEqual(target.of({"target": "tiktok"}), "reel")
        lo, hi, part = target.limits(CFG, "story", 200)
        self.assertEqual((hi, part), (60.0, 15.0))
        self.assertIsNone(target.limits(CFG, "reel", 200)[2])
        s, r = target.spec("story"), target.spec("reel")
        self.assertEqual((s["cover_text"], s["post_caption"], r["cover_text"], r["post_caption"]), (False, False, True, True))
        self.assertEqual((s["zone"]["right_clear"], s["zone"]["bottom"]), (60, 1580))
        self.assertIn("לא נבדק", s["publish"])                      # producing a story file is not publishing it

    def test_a_story_keeps_adjacent_parts_as_separate_cards_and_a_reel_joins_them(self):
        segs = [(0, 17), (18, 35)]
        st = story.validate_story(raw(segs), W, DUR, CFG, PROFILE, target="story")
        rl = story.validate_story(raw(segs), W, DUR, CFG, PROFILE, target="reel")
        self.assertEqual((len(st["segments"]), len(rl["segments"]), st["target"]), (2, 1, "story"))

    def test_a_story_card_longer_than_15_seconds_is_sent_back_to_the_planner(self):
        with self.assertRaises(PipelineError) as e:
            story.validate_story(raw([(0, 38)]), W, DUR, CFG, PROFILE, target="story")
        self.assertIn("at most 15s", e.exception.message)
        self.assertEqual(len(story.validate_story(raw([(0, 38)]), W, DUR, CFG, PROFILE, target="reel")["segments"]), 1)

    def test_the_planner_is_told_the_target(self):
        _, prompt = story.story_prompt(W, [0.0] * len(W), DUR, CFG, {"target": "story"}, PROFILE, "skill")
        self.assertIn("STORY", prompt)
        self.assertIn("No part longer than 15 s", prompt)
        self.assertIn("NOT available", prompt)                       # no animation scene unless a skill or the owner asked
        _, p2 = story.story_prompt(W, [0.0] * len(W), DUR, CFG, {"target": "reel", "allow_animation_scene": True}, PROFILE, "skill")
        self.assertIn("REEL", p2)
        self.assertIn("animation_scene", p2)


class Scene(unittest.TestCase):
    G = [{"kind": "animation_scene", "quote": "נעלמו החששות מהר", "at_s": 7.5, "why": "המשפט שהסרטון נשען עליו"},
         {"kind": "key_phrase", "quote": "מכירות אותי בשם", "at_s": 11.5, "why": "הדגשה"}]

    def plan(self, **kw):
        return story.validate_story(raw([(0, 40)], graphics=self.G, zooms=[{"at_s": 7.0, "strength": "medium", "reason": "r"}]), W, DUR, CFG, PROFILE, **kw)

    def test_a_scene_is_only_planned_when_it_was_asked_for(self):
        pl = self.plan()
        self.assertEqual([g["kind"] for g in pl["graphics"]], ["key_phrase"])
        self.assertTrue(any("לא התבקש" in d["why"] for d in pl["graphics_dropped"]))

    def test_a_scene_replaces_the_picture_an_overlay_sits_on_it_and_they_are_never_confused(self):
        pl = self.plan(allow_scene=True)
        by = {g["kind"]: g for g in pl["graphics"]}
        self.assertEqual((by["animation_scene"]["layer"], by["key_phrase"]["layer"]), ("replaces_picture", "over_picture"))
        self.assertTrue(by["animation_scene"]["quote_is_exact"])
        self.assertEqual(by["animation_scene"]["id"], f"animation_scene@{by['animation_scene']['source_t_s']:.1f}")   # stable id: one item can be removed
        self.assertEqual(pl["zooms"], [])                             # a zoom cannot run through a scene: the footage is not on screen
        self.assertTrue(any("קטע אנימציה" in d["why"] for d in pl["zooms_dropped"]))

    def test_a_scene_is_words_only_and_never_in_the_first_seconds(self):
        items, dropped = motion.validate([{"kind": "animation_scene", "quote": "אני מתאמנת כאן", "at_s": 0, "why": "x"},
                                          {"kind": "animation_scene", "quote": "הסטודיו הכי טוב בארץ", "at_s": 20, "why": "x"}], W,
                                         [{"n": 1, "i0": 0, "i1": len(W) - 1, "source_in_s": 0.0, "source_out_s": DUR, "tl_in_s": 0.0, "tl_out_s": DUR}],
                                         lambda t: ({"n": 1}, t) if False else (SEG, round(t, 3)), DUR, allow_scene=True)
        self.assertEqual(items, [])
        self.assertEqual(len(dropped), 2)

    def test_scene_layout_keeps_the_words_in_order(self):
        self.assertEqual(" ".join(motion.scene_lines("נעלמו החששות מהר זו אווירה")), "נעלמו החששות מהר זו אווירה")
        self.assertEqual(len(motion.scene_lines("אחת שתיים שלוש")), 3)


SEG = {"n": 1, "i0": 0, "i1": len(W) - 1, "source_in_s": 0.0, "source_out_s": DUR, "tl_in_s": 0.0, "tl_out_s": DUR}


def payload(name, params, rules, criteria=1):
    return {"skill": {"id": "skl_" + name, "name": name, "version": 1, "sha256": "a" * 64, "status": "approved", "chosen_by": "owner",
                      "rules": [{"id": f"r{i + 1}", "text": t, "domain": d, "support": "supported"} for i, (t, d) in enumerate(rules)],
                      "unsupported": [], "not_adopted": [], "criteria": [{"id": f"k{i + 1}", "text": "c", "domain": "other"} for i in range(criteria)], "references": []},
            "profile": {"id": "skill:skl_" + name, "version": "1", "params": params, "rules": [t for t, _ in rules], "status": "owner_approved"}}


class Combination(unittest.TestCase):
    A = payload("תוכן", {"caption_size": 84, "caption_max_lines": 1}, [("לפתוח במשפט החזק", "opening")])
    B = payload("גרפיקה", {"caption_size": 110, "zoom_scale_light": 1.1}, [("קטע אנימציה על משפט המפתח", "animation"), ("כותרת פתיחה", "motion_graphics")])

    def test_several_skills_become_one_set_and_the_earlier_one_wins_a_disagreement(self):
        skill, profile = skillgen.merge([self.A, self.B])
        self.assertEqual(profile["params"], {"caption_size": 84, "caption_max_lines": 1, "zoom_scale_light": 1.1})
        self.assertEqual(skill["param_overridden"], [{"key": "caption_size", "used": {"skill": "תוכן", "value": 84}, "not_used": {"skill": "גרפיקה", "value": 110},
                                                     "by": "סדר העדיפות שנקבע לסקילים"}])
        self.assertEqual([(r["id"], r["skill"]) for r in skill["rules"]], [("1.r1", "תוכן"), ("2.r1", "גרפיקה"), ("2.r2", "גרפיקה")])
        self.assertEqual([c["id"] for c in skill["criteria"]], ["1.k1", "2.k1"])
        self.assertEqual((skill["name"], profile["id"], len(skill["skills"])), ("תוכן + גרפיקה", "skillset:skl_תוכן+skl_גרפיקה", 2))
        self.assertEqual(skillgen.merge([self.B, self.A])[1]["params"]["caption_size"], 110)      # the order IS the priority

    def test_one_skill_is_merged_to_itself(self):
        skill, profile = skillgen.merge([self.A])
        self.assertEqual((profile["id"], skill["sha256"], skill["param_overridden"]), ("skill:skl_תוכן", "a" * 64, []))
        self.assertEqual(skillgen.merge([]), (None, None))

    def test_the_report_says_which_skill_each_rule_belongs_to(self):
        skill, profile = skillgen.merge([self.A, self.B])
        rep = skillgen.report(skill, {"caption_size": 84, "caption_max_lines": 1, "zoom_scale_light": 1.1},
                              {"skill_rules": [{"id": "1.r1", "status": "applied", "note": "n"}, {"id": "2.r1", "status": "not_followed", "note": "n"}], "skill_criteria": []}, profile["params"])
        self.assertEqual([(r["skill"], r["status"]) for r in rep["rules"]], [("תוכן", "applied"), ("גרפיקה", "not_followed"), ("גרפיקה", "not_checked")])
        self.assertEqual(len(rep["skill"]["skills"]), 2)


def facts(**over):
    rec = lambda s: {"id": "x", "status": s, "summary": "s"}
    f = {"kind": "edit", "records": {k: dict(rec("pass"), id=k) for k in ("clip_boundary", "caption_width", "safe_zone", "caption_face_overlap", "sync_lead", "sync_not_found",
                                                                         "sync_tail", "cards_in_motion", "output_file", "zoom_face_inside", "graphics_rendered", "loudness")},
         "criteria": {i: {"id": i, "met": True, "note": "n", "decided_by": "reviewer"} for i in ("A1", "A3", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "A13", "A14", "A15", "A16", "A17", "A18")},
         "findings": [], "first_word_s": 0.2, "longest_pause": {"s": 0.6, "at_s": 4.0}, "face_inside": {"frames": 12, "found": 12, "bad": []},
         "cut_joins": {"bad": False, "note": "ok"}, "zooms": [{"reason": "r"}], "graphics": [{"quote_is_exact": True, "tl_start_s": 1.0}],
         "color": {"measured_before": {"luma_p50": 0.5, "face": {"luma": 0.6}, "neutral_rgb": [0.6, 0.6, 0.6]}, "limits": adjust.LIMITS, "applied": False},
         "audio": {"measured_before": {"snr_db": 40, "room_tone_db": -60}, "limits": adjust.LIMITS}, "cover_text": "x", "captions_added": True}
    f.update(over)
    return f


PROV = {"reviewed_at": "2026-11-16T10:00:00+0200", "final_sha256": "f" * 64, "on_delivered_file": True, "review_rounds": 2}
BASE = {"name": "dana-editing", "version": "0.1.0"}


class FinalReview(unittest.TestCase):
    def test_it_names_the_file_the_skills_and_only_counts_what_was_checked(self):
        rv = review.build(facts())
        f = review.final(rv, None, PROV, [], list(facts()["records"].values()), None, "reel", BASE)
        self.assertEqual((f["title"], f["verdict"], f["on_delivered_file"], f["file_sha256"]), ("הביקורת הסופית של דנה", "ready_for_viewing", True, "f" * 64))
        self.assertEqual([s["name"] for s in f["skills"]], ["dana-review", "dana-editing"])
        c = f["coverage"]
        self.assertEqual(c["decided"] + c["not_checked"] + c["not_applicable"], c["criteria"])
        self.assertEqual(len(c["human_only"]), 4)                     # sound, motion, look: listed, never marked
        self.assertTrue(all("ציון" not in x["criterion"] for x in f["not_checked"]))
        self.assertIn("לא לפי הדירוג לבדו", f["verdict_basis"])

    def test_a_failed_check_means_another_fix_whatever_the_rating_says(self):
        fx = facts()
        fx["records"]["loudness"] = {"id": "loudness", "status": "fail", "summary": "-20 LUFS"}
        rv = review.build(fx)
        f = review.final(rv, None, PROV, [], list(fx["records"].values()), None, "reel", BASE)
        self.assertEqual(f["verdict"], "needs_fix")
        self.assertTrue(any("loudness" in r for r in f["verdict_reasons"]))
        self.assertTrue(any(n["category"] == "סאונד" for n in f["needs_improvement"]))

    def test_open_items_go_to_the_owner_and_skills_are_reported(self):
        rv = review.build(facts())
        rep = {"skill": {"skills": [{"id": "skl_a", "name": "תוכן", "version": 2, "status": "approved"}]}, "params": [{"applied": True}], "criteria": [{"met": True}, {"met": None}],
               "rules": [{"text": "בלי זומים", "status": "not_followed", "note": "זום ב-12s", "skill": "תוכן"}, {"text": "x", "status": "not_checked", "note": "n", "skill": "תוכן"}],
               "summary": {"applied": 3, "not_followed": 1, "not_applicable": 0, "unsupported": 1, "not_checked": 1, "fully_applied": False}}
        f = review.final(rv, rep, PROV, [{"id": "text:1"}], list(facts()["records"].values()), None, "story", BASE)
        self.assertEqual((f["verdict"], f["target"]), ("needs_owner", "story"))
        self.assertEqual(f["skills"][-1], {"name": "תוכן", "version": 2, "role": "סקיל מהספרייה", "id": "skl_a"})
        self.assertEqual((f["skill_compliance"]["criteria_met"], f["skill_compliance"]["criteria_total"]), (1, 2))
        self.assertTrue(any(n.get("skill") == "תוכן" and "בלי זומים" in n["criterion"] for n in f["needs_improvement"]))
        self.assertTrue(any("לא יושמו במלואם" in r for r in f["verdict_reasons"]))

    def test_a_change_in_the_rating_is_explained_criterion_by_criterion(self):
        before = review.compact(review.build(facts()))
        now = review.build(facts(longest_pause={"s": 2.4, "at_s": 9.0}))
        f = review.final(now, None, PROV, [], [], before, "reel", BASE)
        self.assertEqual([(c["criterion"], c["before"], c["after"]) for c in f["changes"]["criteria"]], [("אין שתיקה ארוכה מ-1.2 שניות בתוך הסרטון", "מתקיים", "לא מתקיים")])
        self.assertIn("2.40s", f["changes"]["criteria"][0]["why"])
        self.assertEqual(f["changes"]["categories"][0]["label"], "קצב")
        self.assertIsNone(review.final(now, None, PROV, [], [], dict(before, rubric_version="old"), "reel", BASE)["changes"])


class Placement(unittest.TestCase):
    ZONE = {"top": 230, "bottom": 1440}

    def test_a_graphic_that_does_not_fit_is_made_smaller_before_it_is_dropped_and_never_covers_the_face(self):
        g = [{"id": "hook_title@1.0", "kind": "hook_title", "text": "אני ממש מרגישה שהתחזקתי"}]
        face = {"hook_title@1.0": [(300, 620, 480, 480)]}             # hair line at 452: the full-size title (to 461) does not fit above it
        placed, dropped = motion.place(g, self.ZONE, face, (1150, 1260))
        self.assertEqual((len(placed), dropped), (1, []))
        self.assertLess(placed[0]["scale"], 1.0)
        self.assertLessEqual(placed[0]["y_px"] + placed[0]["height_px"] + 24, 620 - 0.35 * 480)
        self.assertGreaterEqual(placed[0]["y_px"], 230)
        roomy = motion.place(g, self.ZONE, {"hook_title@1.0": [(300, 800, 400, 400)]}, (1400, 1430))[0][0]
        self.assertEqual(roomy["scale"], 1.0)                         # when there is room nothing is shrunk
        tight, why = motion.place(g, self.ZONE, {"hook_title@1.0": [(200, 380, 700, 700)]}, (1250, 1380))
        self.assertEqual(tight, [])                                   # a close-up with no free place: dropped and said, not drawn over the face
        self.assertIn("אין מקום פנוי", why[0]["why"])


class Timeline(unittest.TestCase):
    def test_every_stretch_names_picture_skill_text_sound_assets_and_transition(self):
        segs = [{"n": 1, "source_in_s": 10.0, "source_out_s": 20.0, "tl_in_s": 0.0, "tl_out_s": 10.0}, {"n": 2, "source_in_s": 40.0, "source_out_s": 46.0, "tl_in_s": 10.0, "tl_out_s": 16.0}]
        cards = [{"plain": "שלום לכולם", "start": 1.0, "dur": 1.0}, {"plain": "נעלמו החששות", "start": 5.2, "dur": 1.0}, {"plain": "להתראות", "start": 12.0, "dur": 1.0}]
        gfx = [{"id": "animation_scene@15.0", "kind": "animation_scene", "label": "קטע אנימציה", "layer": "replaces_picture", "text": "נעלמו החששות", "tl_start_s": 5.0, "tl_end_s": 7.5, "reason": "r"},
               {"id": "hook_title@10.0", "kind": "hook_title", "label": "כותרת פתיחה", "layer": "over_picture", "text": "שלום לכולם", "tl_start_s": 0.25, "tl_end_s": 2.6, "reason": "r"}]
        skill = {"name": "תוכן + גרפיקה", "rules": [{"domain": "opening", "skill": "תוכן"}, {"domain": "animation", "skill": "גרפיקה"}, {"domain": "motion_graphics", "skill": "גרפיקה"}]}
        tl = review.timeline(segs, 16.0, 0.0, cards, [{"tl_t_s": 12.0, "hold_until_s": 15.0, "scale": 1.15, "reason": "r"}], gfx, skill, {"applied": True}, "reel")
        self.assertEqual([(s["t0"], s["t1"], s["picture"]) for s in tl["spans"]], [(0.0, 5.0, "footage"), (5.0, 7.5, "animation_scene"), (7.5, 10.0, "footage"), (10.0, 16.0, "footage")])
        scene = tl["spans"][1]
        self.assertEqual((scene["skill"], scene["text"], scene["transition_in"]), ("גרפיקה", "נעלמו החששות", "חיתוך ישר לסצנה (הקול ממשיך)"))
        self.assertIn("HyperFrames", scene["assets"])
        self.assertIn("קול הדוברת", scene["audio"])
        self.assertEqual((tl["spans"][0]["skill"], tl["spans"][2]["transition_in"], tl["spans"][3]["transition_in"]), ("תוכן", "חיתוך ישר חזרה לצילום", "חיתוך ישר בין חלקים, מעבר קול של 25ms"))
        self.assertEqual([(e["kind"], e["layer"]) for e in tl["events"]], [("hook_title", "over_picture"), ("zoom", "on_footage")])
        self.assertEqual(sum(s["seconds"] for s in tl["spans"]), 16.0)


if __name__ == "__main__":
    unittest.main()
