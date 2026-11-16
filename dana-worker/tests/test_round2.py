"""Unit tests for round 2: measured adjustments, motion graphics planning, request interpretation,
the category review and derived-text corrections. No GPU, no model call, no ffmpeg, no HyperFrames."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dana_pipeline import adjust, captions, interpret, motion, review, story    # noqa: E402

PIC = {"frames": 6, "luma_p1": 0.02, "luma_p50": 0.55, "luma_p99": 0.99, "saturation": 0.25, "neutral_share": 0.2,
       "neutral_rgb": [0.6, 0.6, 0.6], "face": {"luma": 0.6, "hue_deg": 118.0, "sat": 0.12}}


class Colour(unittest.TestCase):
    def test_a_picture_inside_the_ranges_is_left_alone(self):
        p, why = adjust.color_plan(PIC)
        self.assertEqual(p, {})
        self.assertIsNone(adjust.color_filter(p))
        self.assertTrue(all("בלי שינוי" in w for w in why))

    def test_a_dark_face_gets_a_bounded_gamma_and_nothing_else(self):
        p, why = adjust.color_plan(dict(PIC, face=dict(PIC["face"], luma=0.30)))
        self.assertEqual(set(p), {"gamma"})
        self.assertTrue(1.0 < p["gamma"] <= adjust.LIMITS["gamma_max"])
        self.assertIn("eq=gamma=", adjust.color_filter(p))

    def test_white_balance_corrects_half_the_cast_and_never_more_than_the_cap(self):
        p, _ = adjust.color_plan(dict(PIC, neutral_rgb=[0.72, 0.60, 0.50]))
        self.assertTrue(all(abs(g - 1) <= adjust.LIMITS["gain_max"] + 1e-9 for g in p["gains"]))
        self.assertLess(p["gains"][0], 1)            # red was high → reduced
        self.assertGreater(p["gains"][2], 1)

    def test_no_neutral_area_means_no_white_balance_guess(self):
        m = dict(PIC)
        m.pop("neutral_rgb")
        p, why = adjust.color_plan(m)
        self.assertNotIn("gains", p)
        self.assertTrue(any("לא מנחשת" in w for w in why))

    def test_skin_guard_rejects_a_hue_shift(self):
        ok, _ = adjust.skin_ok(PIC, dict(PIC, face=dict(PIC["face"], hue_deg=126.0)))
        self.assertFalse(ok)
        self.assertTrue(adjust.skin_ok(PIC, dict(PIC, face=dict(PIC["face"], hue_deg=119.0)))[0])

    def test_each_kind_can_be_switched_off(self):
        self.assertTrue(adjust.enabled({}, "color"))
        self.assertFalse(adjust.enabled({"adjustments": {"color": False}}, "color"))
        self.assertTrue(adjust.enabled({"adjustments": {"color": False}}, "graphics"))


class Sound(unittest.TestCase):
    def test_dense_speech_without_gaps_is_not_cleaned(self):
        p, why = adjust.audio_plan({"room_tone_db": None, "speech_db": -18, "snr_db": None, "rumble_share": 0.0, "gap_seconds": 0.2})
        self.assertEqual(p, {})
        self.assertTrue(any("אי אפשר למדוד" in w for w in why))

    def test_noise_reduction_is_gentle_and_bounded(self):
        p, _ = adjust.audio_plan({"room_tone_db": -40, "speech_db": -18, "snr_db": 22, "rumble_share": 0.2, "gap_seconds": 3})
        self.assertLessEqual(p["noise_reduction_db"], adjust.LIMITS["nr_max_db"])
        self.assertEqual(p["highpass_hz"], adjust.LIMITS["highpass_hz"])
        self.assertIn("afftdn", adjust.audio_filter(p))

    def test_clean_audio_is_left_alone(self):
        p, _ = adjust.audio_plan({"room_tone_db": -62, "speech_db": -18, "snr_db": 44, "rumble_share": 0.0, "gap_seconds": 3})
        self.assertEqual(p, {})


TEXT = "תמיד יש חששות להגיע למקום חדש אבל כאן נעלמו החששות מהר זו אווירה תומכת"
WORDS = [{"word": w, "start": round(i * 0.4, 2), "end": round(i * 0.4 + 0.35, 2)} for i, w in enumerate(TEXT.split())]
SEG = [{"n": 1, "i0": 0, "i1": len(WORDS) - 1, "source_in_s": 0.0, "source_out_s": 6.0, "tl_in_s": 0.0, "tl_out_s": 6.0}]


def to_tl(t):
    return (SEG[0], round(t, 3)) if 0 <= t <= 6.05 else (None, None)


class Graphics(unittest.TestCase):
    def test_only_an_exact_quotation_becomes_a_graphic(self):
        items, dropped = motion.validate([{"kind": "key_phrase", "quote": "נעלמו החששות מהר", "at_s": 3.2, "why": "המסר"},
                                          {"kind": "hook_title", "quote": "המקום הכי טוב בארץ", "at_s": 0, "why": "x"}], WORDS, SEG, to_tl, 6.0)
        self.assertEqual([g["text"] for g in items], ["נעלמו החששות מהר"])
        self.assertTrue(items[0]["quote_is_exact"])
        self.assertIn("אינו ציטוט מדויק", dropped[0]["why"])

    def test_none_is_valid_and_no_more_than_one_of_a_kind(self):
        self.assertEqual(motion.validate([], WORDS, SEG, to_tl, 6.0), ([], []))
        items, dropped = motion.validate([{"kind": "key_phrase", "quote": "תמיד יש חששות", "at_s": 0, "why": "a"},
                                          {"kind": "key_phrase", "quote": "אווירה תומכת", "at_s": 5, "why": "b"}], WORDS, SEG, to_tl, 6.0)
        self.assertEqual(len(items), 1)
        self.assertEqual(len(dropped), 1)

    def test_a_graphic_is_never_placed_over_the_face_or_the_captions(self):
        zone = {"top": 230, "bottom": 1440, "left": 60, "right_clear": 230}
        g = [{"id": "g1", "kind": "key_phrase", "label": "x", "text": "נעלמו החששות", "tl_start_s": 1.0, "tl_end_s": 3.0}]
        placed, dropped = motion.place(g, zone, {"g1": [(300, 700, 400, 400)]}, (1000, 1200))
        self.assertEqual(placed[0]["y_px"], 260)                         # above the face
        face_at_top = {"g1": [(300, 250, 400, 400)]}                     # the face fills the upper area …
        placed, dropped = motion.place(g, zone, face_at_top, (700, 1400))   # … and the captions fill what is below it
        self.assertEqual(placed, [])
        self.assertIn("לא נוספה", dropped[0]["why"])

    def test_layout_keeps_the_words(self):
        self.assertEqual(" ".join(motion.lines_of("נעלמו החששות מהר מאוד כאן")), "נעלמו החששות מהר מאוד כאן")
        self.assertEqual(motion.lines_of("קצר"), ["קצר"])


PREV = {"cards": [{"text": "תמיד יש חששות", "start": 0.0, "source_start_s": 10.0, "source_end_s": 11.2},
                  {"text": "להגיע לסטודי", "start": 1.2, "source_start_s": 11.2, "source_end_s": 12.4}],
        "zooms": [{"id": "z@11.2", "tl_t_s": 1.2, "scale": 1.15}], "graphics": [], "cover": {"text": "תמיד יש חששות"}}


class Interpretation(unittest.TestCase):
    def test_a_caption_fix_becomes_a_source_time_edit_and_nothing_else(self):
        out = interpret.validate({"domains": ["captions_text"], "needs_replan": False, "explanation": "x",
                                  "caption_edits": [{"card": 2, "text": "להגיע לסטודיו"}]}, PREV)
        self.assertEqual(out["caption_edits"], [{"source_start_s": 11.2, "source_end_s": 12.4, "original": "להגיע לסטודי", "text": "להגיע לסטודיו",
                                                 "card": 2, "from": "owner_request"}])
        self.assertEqual((out["style"], out["zoom_edits"], out["adjustments"]), ({}, [], {}))
        self.assertTrue(out["changed"])

    def test_style_values_are_clamped_and_unknown_things_are_reported(self):
        out = interpret.validate({"domains": ["caption_style", "zooms"], "needs_replan": False, "explanation": "x", "style": {"caption_size": 500, "caption_ink": "red"},
                                  "zoom_edits": [{"id": "nope", "action": "remove"}, {"id": "z@11.2", "action": "set", "scale": 3}], "switch_off": ["graphics"]}, PREV)
        self.assertEqual(out["style"], {"caption_size": 140})
        self.assertEqual(out["zoom_edits"], [{"id": "z@11.2", "action": "set", "scale": 1.5}])
        self.assertEqual(out["adjustments"], {"graphics": False})
        self.assertTrue(any("זום לא מוכר" in x for x in out["not_applied"]))

    def test_a_content_request_is_a_replan_and_applies_nothing(self):
        out = interpret.validate({"domains": ["content"], "needs_replan": True, "explanation": "x", "caption_edits": [{"card": 1, "text": "אחר"}]}, PREV)
        self.assertTrue(out["needs_replan"])
        self.assertEqual(out["caption_edits"], [])

    def test_a_cover_quote_must_be_words_of_the_video(self):
        ok = interpret.validate({"domains": ["cover"], "needs_replan": False, "explanation": "x", "cover_quote": "יש חששות"}, PREV)
        bad = interpret.validate({"domains": ["cover"], "needs_replan": False, "explanation": "x", "cover_quote": "הכי טוב בעיר"}, PREV)
        self.assertEqual(ok["cover_quote"], "יש חששות")
        self.assertIsNone(bad["cover_quote"])


def facts(**over):
    rec = lambda s: {"status": s, "summary": "s"}
    f = {"kind": "edit", "records": {k: rec("pass") for k in ("clip_boundary", "caption_width", "safe_zone", "caption_face_overlap", "sync_lead", "sync_not_found",
                                                             "sync_tail", "cards_in_motion", "output_file", "zoom_face_inside", "graphics_rendered", "loudness")},
         "criteria": {i: {"id": i, "met": True, "note": "n", "decided_by": "reviewer"} for i in ("A1", "A3", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "A13", "A14", "A15", "A16", "A17", "A18")},
         "findings": [], "first_word_s": 0.2, "longest_pause": {"s": 0.6, "at_s": 4.0}, "face_inside": {"frames": 12, "found": 12, "bad": []},
         "cut_joins": {"bad": False, "note": "ok"}, "zooms": [{"reason": "r"}], "graphics": [{"quote_is_exact": True, "tl_start_s": 1.0}],
         "color": {"measured_before": PIC, "limits": adjust.LIMITS, "applied": False}, "audio": {"measured_before": {"snr_db": 40, "room_tone_db": -60}, "limits": adjust.LIMITS},
         "cover_text": "x", "captions_added": True}
    f.update(over)
    return f


class Review(unittest.TestCase):
    def test_twelve_categories_fixed_criteria_and_a_rubric_version(self):
        rv = review.build(facts())
        self.assertEqual([c["key"] for c in rv["categories"]], [k for k, _ in review.CATEGORIES])
        self.assertEqual(rv["rubric_version"], review.RUBRIC_VERSION)
        self.assertEqual(sum(len(c["criteria"]) for c in rv["categories"]), len(review.CRITERIA))
        self.assertTrue(all(c["level"] == "תקין" for c in rv["categories"]))

    def test_what_only_a_person_can_judge_is_not_checked_and_never_counted(self):
        rv = review.build(facts())
        sound = next(c for c in rv["categories"] if c["key"] == "sound")
        self.assertEqual((sound["met"], sound["decided"], sound["not_checked"]), (2, 2, 1))
        human = [c for cat in rv["categories"] for c in cat["criteria"] if c["basis"] == "human"]
        self.assertTrue(human and all(c["status"] == "not_checked" for c in human))

    def test_a_category_with_nothing_decided_is_not_checked_not_a_mark(self):
        rv = review.build(facts(criteria={}, cut_joins=None, records={}))
        msg = next(c for c in rv["categories"] if c["key"] == "message")
        self.assertEqual((msg["level"], msg["decided"]), ("לא נבדק", 0))

    def test_improvements_technical_first_and_who_can_apply(self):
        f = facts(findings=[{"id": "x1", "source": "reviewer", "asset": "caption", "card": None, "time_s": None, "problem": "p", "correction": "c", "evidence": "e",
                             "severity": "advisory", "fix": "caption"}])
        f["records"]["loudness"] = {"status": "fail", "summary": "-20 LUFS"}
        rv = review.build(f)
        self.assertEqual(rv["improvements"][0]["kind"], "technical_defect")
        self.assertTrue(rv["improvements"][0]["can_apply"])
        self.assertEqual(rv["improvements"][-1]["kind"], "creative_preference")
        self.assertEqual(next(c for c in rv["categories"] if c["key"] == "sound")["level"], "דורש שיפור")

    def test_burned_captions_are_not_rated_as_danas_caption_layer(self):
        rv = review.build(facts(captions_added=False))
        sync = next(c for c in rv["categories"] if c["key"] == "sync")
        self.assertEqual((sync["level"], sync["not_applicable"]), ("לא נבדק", 4))

    def test_two_versions_compare_only_on_the_same_rubric(self):
        a, b = review.build(facts()), review.build(facts(longest_pause={"s": 2.0, "at_s": 4.0}))
        rows = review.compare(a, b)
        pace = next(r for r in rows if r["key"] == "pace")
        self.assertEqual((pace["before"]["level"], pace["after"]["level"]), ("תקין", "דורש שיפור"))
        self.assertIsNone(review.compare(dict(a, rubric_version="old"), b))


class DerivedText(unittest.TestCase):
    def test_a_corrected_card_is_carried_into_cover_and_caption(self):
        edits = [{"original": "להגיע לסטודי", "text": "להגיע לסטודיו"}]
        self.assertEqual(story.correct_derived("להגיע לסטודי", edits, quote=True)[0], "להגיע לסטודיו")
        text, ch = story.correct_derived("היא מספרת איך זה להגיע לסטודי בפעם הראשונה", edits)
        self.assertEqual(text, "היא מספרת איך זה להגיע לסטודיו בפעם הראשונה")
        self.assertEqual(ch[0]["to"], "להגיע לסטודיו")

    def test_a_short_word_is_never_replaced_blindly_in_free_text(self):
        self.assertEqual(story.correct_derived("לא ידעתי שזה לא קשה", [{"original": "לא", "text": "לו"}])[0], "לא ידעתי שזה לא קשה")

    def test_previous_decisions_follow_the_correction(self):
        dec = story.decisions_from_previous(dict(PREV, cover={"text": "להגיע לסטודי", "frame_s": 1}, caption={"text": "להגיע לסטודי זה מרגש", "cta": None}),
                                            [{"source_start_s": 11.2, "source_end_s": 12.4, "original": "להגיע לסטודי", "text": "להגיע לסטודיו"}])
        self.assertEqual(dec["cards"][1]["text"], "להגיע לסטודיו")
        self.assertEqual(dec["cards"][0]["text"], "תמיד יש חששות")                # untouched
        self.assertEqual(dec["cover"]["text"], "להגיע לסטודיו")
        self.assertEqual({d["where"] for d in dec["_derived"]}, {"קאבר", "קפשן הפוסט"})

    def test_polish_keeps_the_owners_edit_whole(self):
        pl = story.polish_plan(WORDS, 6.0, burned=True)
        self.assertEqual((len(pl["segments"]), pl["zooms"], pl["graphics"], pl["content_judgement"]), (1, [], [], "owner_edit"))
        self.assertTrue(pl["burned_in_text"]["present"])


class Animation(unittest.TestCase):
    def test_known_animations_only(self):
        self.assertIsNone(captions.ANIMATIONS["none"])
        self.assertEqual(captions.ANIMATIONS["rise"]["in_s"], 0.12)
        self.assertIsNone(captions.ANIMATIONS.get("spin"))


if __name__ == "__main__":
    unittest.main()
