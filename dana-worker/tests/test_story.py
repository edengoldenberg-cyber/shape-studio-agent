"""Unit tests for the content plan, the joined timeline, zooms, caption placement and transcript handling.
No GPU, no model call, no ffmpeg."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dana_pipeline import captions, judgement, story                      # noqa: E402
from dana_pipeline.core import DEFAULTS, PipelineError, deep_merge          # noqa: E402

CFG = deep_merge(DEFAULTS, {})
_, _, PROFILE = story.load_skill()
TEXT = "אני רותי מתאמנת שנה תמיד יש חששות להגיע למקום חדש אבל כאן נעלמו החששות מהר זו אווירה תומכת וזה לבוא הביתה באמת"


def words(gap_after=(4, 12), step=0.4, gap=0.6):
    out, t = [], 0.0
    for i, w in enumerate(TEXT.split()):
        out.append({"word": w, "start": round(t, 3), "end": round(t + step - 0.05, 3), "probability": 0.95})
        t += step + (gap if i + 1 in gap_after else 0.0)
    return out


W = words()
DUR = W[-1]["end"] + 0.5


def raw(**over):
    base = {"message": "m", "hook": "תמיד יש חששות", "rationale": "r", "brief": ["b"],
            "segments": [{"in_s": W[4]["start"], "out_s": W[21]["end"], "role": "hook", "why": "w"}],
            "zooms": [], "cover": {"quote": "נעלמו החששות", "at_s": W[12]["start"], "why": "c"}, "transcript_doubts": [],
            "burned_in_text": {"present": False, "examples": []}}
    base.update(over)
    return base


class Plan(unittest.TestCase):
    def test_single_part_is_snapped_between_words(self):
        pl = story.validate_story(raw(), W, DUR, CFG, PROFILE)
        s = pl["segments"][0]
        self.assertTrue(W[3]["end"] <= s["source_in_s"] <= W[4]["start"])
        self.assertGreaterEqual(s["source_out_s"], W[21]["end"])
        self.assertEqual(story.join_check(W, pl["segments"]), [])
        self.assertTrue(pl["cover"]["quote_is_exact"])
        self.assertAlmostEqual(pl["cover"]["tl_s"], W[12]["start"] - s["source_in_s"], places=2)

    def test_continuous_speech_cut_sits_on_the_word_boundary(self):
        w = words(gap_after=(), step=0.4)
        for a, b in zip(w, w[1:]):
            a["end"] = b["start"]                                  # no gap at all between words
        pl = story.validate_story(raw(segments=[{"in_s": w[4]["start"], "out_s": w[21]["end"], "role": "hook", "why": ""}]), w, DUR, CFG, PROFILE)
        self.assertEqual(pl["segments"][0]["source_in_s"], w[4]["start"])
        self.assertEqual(story.join_check(w, pl["segments"]), [])

    def test_two_parts_in_plan_order_build_one_timeline(self):
        r = raw(segments=[{"in_s": W[12]["start"], "out_s": W[21]["end"], "role": "hook", "why": "a"},
                          {"in_s": W[4]["start"], "out_s": W[9]["end"], "role": "body", "why": "b"}],
                cover={"quote": "אווירה תומכת", "at_s": W[16]["start"], "why": ""})
        pl = story.validate_story(r, W, DUR, CFG, PROFILE)
        self.assertEqual(len(pl["segments"]), 2)
        self.assertTrue(pl["reordered"])
        self.assertEqual(pl["segments"][1]["tl_in_s"], pl["segments"][0]["tl_out_s"])
        tw = story.timeline_words(W, pl["segments"])
        self.assertEqual([x["word"] for x in tw], TEXT.split()[12:22] + TEXT.split()[4:10])
        self.assertTrue(all(a["start"] <= b["start"] for a, b in zip(tw, tw[1:])))
        self.assertEqual(tw[0]["src_start"], W[12]["start"])
        self.assertAlmostEqual(story.tl_to_source(tw[-1]["start"], pl["segments"]), W[9]["start"], places=2)

    def test_adjacent_parts_are_one_part_and_overlap_is_refused(self):
        r = raw(segments=[{"in_s": W[4]["start"], "out_s": W[9]["end"], "role": "hook", "why": "a"},
                          {"in_s": W[10]["start"], "out_s": W[21]["end"], "role": "body", "why": "b"}])
        self.assertEqual(len(story.validate_story(r, W, DUR, CFG, PROFILE)["segments"]), 1)
        r = raw(segments=[{"in_s": W[4]["start"], "out_s": W[12]["end"], "role": "hook", "why": ""},
                          {"in_s": W[10]["start"], "out_s": W[21]["end"], "role": "body", "why": ""}])
        with self.assertRaises(PipelineError):
            story.validate_story(r, W, DUR, CFG, PROFILE)

    def test_cover_quote_that_was_not_said_is_dropped(self):
        pl = story.validate_story(raw(cover={"quote": "הכי טוב בארץ", "at_s": 3.0, "why": ""}), W, DUR, CFG, PROFILE)
        self.assertEqual(pl["cover"]["quote"], "")
        self.assertFalse(pl["cover"]["quote_is_exact"])

    def test_material_already_used_is_refused(self):
        with self.assertRaises(PipelineError):
            story.validate_story(raw(), W, DUR, CFG, PROFILE, exclude=[[W[6]["start"], W[8]["end"]]])

    def test_doubt_must_name_a_word_that_exists(self):
        pl = story.validate_story(raw(transcript_doubts=[{"word": "תומכת", "at_s": W[17]["start"], "note": "n"},
                                                         {"word": "מילהשאינה", "at_s": 3.0, "note": "n"}]), W, DUR, CFG, PROFILE)
        self.assertEqual([d["word"] for d in pl["doubts"]], ["תומכת"])
        self.assertEqual(pl["doubts"][0]["kind"], "context")


class Zooms(unittest.TestCase):
    def plan(self, zooms):
        return story.validate_story(raw(zooms=zooms), W, DUR, CFG, PROFILE)

    def test_none_is_valid_and_early_or_outside_zooms_are_dropped(self):
        self.assertEqual(self.plan([])["zooms"], [])
        pl = self.plan([{"at_s": W[5]["start"], "strength": "light", "reason": "early"},
                        {"at_s": W[1]["start"], "strength": "light", "reason": "outside"}])
        self.assertEqual(pl["zooms"], [])
        self.assertEqual(len(pl["zooms_dropped"]), 2)

    def test_zoom_holds_until_the_cut_or_the_release_and_never_overlaps(self):
        pl = self.plan([{"at_s": W[12]["start"], "strength": "strong", "release_s": W[15]["end"], "reason": "key"},
                        {"at_s": W[13]["start"], "strength": "medium", "reason": "overlap"},
                        {"at_s": W[19]["start"] + 3, "strength": "strong", "reason": "second strong"}])
        z = pl["zooms"][0]
        self.assertEqual(z["scale"], PROFILE["params"]["zoom_scale_strong"])
        self.assertGreaterEqual(z["tl_t_s"], PROFILE["params"]["zoom_min_start_s"])
        self.assertLess(z["hold_until_s"], pl["segments"][0]["tl_out_s"])
        self.assertGreaterEqual(z["hold_until_s"] - z["tl_t_s"], PROFILE["params"]["zoom_min_hold_s"])
        self.assertEqual(sum(1 for x in pl["zooms"] if x["strength"] == "strong"), 1)
        for a, b in zip(pl["zooms"], pl["zooms"][1:]):
            self.assertGreater(b["tl_t_s"], a["hold_until_s"])

    def test_filter_eases_in_holds_and_cuts_back(self):
        z = [{"tl_t_s": 3.0, "ease_s": 0.32, "hold_until_s": 6.0, "scale": 1.2, "focus": [0.5, 0.4]}]
        self.assertEqual(story.zoom_value(z, 2.9), 1.0)
        self.assertTrue(1.0 < story.zoom_value(z, 3.16) < 1.2)
        self.assertAlmostEqual(story.zoom_value(z, 4.0), 1.2)
        self.assertEqual(story.zoom_value(z, 6.0), 1.0)                 # a cut, not an animated zoom-out
        f = story.zoom_filter(z, 1080, 1920)
        self.assertIn("eval=frame", f)
        self.assertNotIn("\\", f)
        self.assertIsNone(story.zoom_filter([], 1080, 1920))

    def test_focus_follows_the_measured_face_and_owner_edits_apply(self):
        z = story.zoom_focus([{"id": "z@1.0", "scale": 1.15}, {"id": "z@2.0", "scale": 1.15}], [(400, 500, 280, 280), None], 1080, 1920)
        self.assertEqual(z[0]["focus_source"], "face_measured")
        self.assertAlmostEqual(z[0]["focus"][0], 0.5, places=2)
        self.assertEqual(z[1]["focus_source"], "default_no_face_measured")
        out, log = story.apply_zoom_edits(z, [{"id": "z@1.0", "action": "remove"}, {"id": "z@2.0", "action": "set", "scale": 9}], PROFILE)
        self.assertEqual([x["id"] for x in out], ["z@2.0"])
        self.assertEqual(out[0]["scale"], PROFILE["params"]["zoom_scale_max"])
        self.assertEqual(len(log), 2)


class Captions(unittest.TestCase):
    ZONE = {"top": 230, "bottom": 1440}
    STYLE = {"caption_size": 96}

    def test_position_keeps_clear_of_the_face(self):
        y, info = story.caption_position(PROFILE, self.STYLE, self.ZONE, [(400, 560, 280, 280), (420, 520, 270, 270)], 2)
        top, bottom = info["face_band"]
        block = int(96 * 1.1 * 2) + 24
        self.assertTrue(y - block / 2 >= bottom or y + block / 2 <= top)
        self.assertTrue(230 <= y - block / 2 and y + block / 2 <= 1440)

    def test_preferred_position_is_kept_when_free_or_unmeasured(self):
        y, info = story.caption_position(PROFILE, self.STYLE, self.ZONE, [(400, 200, 200, 200)], 1)
        self.assertEqual(y, PROFILE["params"]["caption_y_px"])
        y, info = story.caption_position(PROFILE, self.STYLE, self.ZONE, None, 1)
        self.assertEqual(y, PROFILE["params"]["caption_y_px"])
        self.assertIsNone(info["face_band"])

    def test_two_lines_keep_the_words_and_the_break_is_layout_only(self):
        t = captions.two_lines("נעלמו החששות כאילו היו")
        self.assertEqual(t.replace("\n", " "), "נעלמו החששות כאילו היו")
        self.assertEqual(t.count("\n"), 1)
        self.assertIsNone(captions.two_lines("הביתה"))
        html = captions.card_html("<b>שורה\nשנייה", [], {"backing": False})
        self.assertIn("<br>", html)
        self.assertIn("&lt;b&gt;", html)                              # content never becomes markup


class Transcript(unittest.TestCase):
    def test_owner_correction_replaces_only_its_span_and_keeps_the_original(self):
        w = [dict(x) for x in W]
        out, applied = story.apply_caption_edits(w, [{"id": "ce1", "source_start_s": W[17]["start"], "source_end_s": W[17]["end"],
                                                      "original": "תומכת", "text": "תומכת מאוד"}])
        self.assertEqual([x["word"] for x in out[17:19]], ["תומכת", "מאוד"])
        self.assertTrue(all(x.get("owner") for x in out[17:19]))
        self.assertEqual(len(out), len(W) + 1)
        self.assertEqual(applied[0]["original"], "תומכת")
        self.assertEqual(W[17]["word"], "תומכת")                        # the source list is not modified
        self.assertAlmostEqual(out[18]["end"], W[17]["end"], places=2)

    def test_edit_outside_any_word_or_empty_changes_nothing(self):
        out, applied = story.apply_caption_edits([dict(x) for x in W], [{"source_start_s": 900, "source_end_s": 901, "text": "x"},
                                                                        {"source_start_s": 1, "source_end_s": 2, "text": "  "}])
        self.assertEqual(applied, [])
        self.assertEqual([x["word"] for x in out], TEXT.split())

    def test_second_pass_disagreement_is_a_doubt_not_a_replacement(self):
        second = [dict(x) for x in W]
        second[17] = dict(second[17], word="עומכת")
        d = story.pass_disagreements(W, second)
        self.assertEqual([(x["word"], x["kind"]) for x in d], [("תומכת", "passes_disagree")])
        self.assertIn("עומכת", d[0]["note"])
        self.assertEqual(story.pass_disagreements(W, W), [])

    def test_low_confidence_skips_words_the_owner_corrected(self):
        w = [dict(x) for x in W]
        w[3]["probability"], w[5]["probability"], w[5]["owner"] = 0.5, 0.4, True
        self.assertEqual([x["word"] for x in story.low_confidence(w, 0.8)], [W[3]["word"]])


class Adapter(unittest.TestCase):
    def test_worker_configuration_decides_unless_the_job_adapter_is_allowed(self):
        cfg = deep_merge(CFG, {"judgement": {"adapter": "claude", "job_adapters_allowed": ["scripted"]}})
        self.assertEqual(judgement.resolve_adapter({"adapter": "heuristic"}, cfg), "claude")     # what the server used to send
        self.assertEqual(judgement.resolve_adapter({}, cfg), "claude")
        self.assertEqual(judgement.resolve_adapter({"adapter": "scripted"}, cfg), "scripted")
        self.assertEqual(judgement.resolve_adapter({"adapter": "heuristic"}, CFG), "heuristic")  # tests may still ask

    def test_profile_from_the_job_overrides_only_known_numbers(self):
        p = story.resolve_profile({"profile": {"id": "mine", "version": "3", "params": {"caption_size": 110, "evil": "x", "font_family": 5}}}, PROFILE)
        self.assertEqual((p["id"], p["status"], p["params"]["caption_size"]), ("mine", "owner_approved", 110))
        self.assertNotIn("evil", p["params"])
        self.assertEqual(p["params"]["font_family"], "Heebo")
        self.assertEqual(story.resolve_profile({}, PROFILE)["status"], "unapproved")

    def test_skill_is_versioned_and_hashed(self):
        text, info, prof = story.load_skill()
        self.assertRegex(info["sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(info["version"], "0.1.0")
        self.assertIn("Measured acceptance", text)
        self.assertRegex(story.profile_info(prof)["sha256"], r"^[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
