"""Compilation from several source files, the source map, the owner's marks, cutting by the beat. No ffmpeg, no model call."""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dana_pipeline import mix, montage, sources, tts                    # noqa: E402
from dana_pipeline.core import DEFAULTS, PipelineError, deep_merge       # noqa: E402

SMAP = [{"id": "src1", "name": "a.mp4", "v_in": 0.0, "v_out": 30.0, "duration": 30.0, "marks": [{"from_s": 0, "to_s": 4, "kind": "never", "note": None}]},
        {"id": "src2", "name": "b.mp4", "v_in": 30.0, "v_out": 55.0, "duration": 25.0, "marks": []},
        {"id": "src3", "name": "c.mp4", "v_in": 55.0, "v_out": 95.0, "duration": 40.0, "marks": [{"from_s": 5, "to_s": 8, "kind": "must", "note": "חובה"}]}]


class SourceMap(unittest.TestCase):
    def test_a_moment_of_the_joined_file_is_traced_to_its_file_and_time(self):
        self.assertEqual(sources.locate(SMAP, 42.5), {"id": "src2", "name": "b.mp4", "t": 12.5})
        self.assertEqual(sources.to_joined(SMAP, "src3", 5), 60.0)
        self.assertIsNone(sources.to_joined(SMAP, "src9", 5))

    def test_marks_become_ranges_on_the_joined_timeline_and_file_borders_are_closed(self):
        never, must, bounds = sources.ranges(SMAP)
        self.assertEqual([(n["from_s"], n["to_s"], n["source"]) for n in never], [(0.0, 4.0, "src1")])
        self.assertEqual([(m["from_s"], m["to_s"], m["source"]) for m in must], [(60.0, 63.0, "src3")])
        self.assertEqual(bounds, [30.0, 55.0])

    def test_the_edit_map_names_file_and_time_for_every_part_and_flags_a_part_that_crosses_files(self):
        segs = sources.describe(SMAP, [{"source_in_s": 31.0, "source_out_s": 34.0}, {"source_in_s": 53.0, "source_out_s": 57.0}])
        self.assertEqual((segs[0]["source_id"], segs[0]["file_in_s"], segs[0]["file_out_s"], segs[0]["crosses_files"]), ("src2", 1.0, 4.0, False))
        again = sources.describe(SMAP, [{"source_in_s": sources.to_joined(SMAP, "src2", segs[0]["file_in_s"]), "source_out_s": sources.to_joined(SMAP, "src2", segs[0]["file_out_s"])}])
        self.assertEqual((again[0]["file_in_s"], again[0]["file_out_s"]), (1.0, 4.0))          # kept in a later version: the same part, not shifted
        self.assertTrue(segs[1]["crosses_files"])

    def test_the_marks_are_checked_on_the_plan(self):
        ok = [{"source_in_s": 10.0, "source_out_s": 13.0}, {"source_in_s": 59.8, "source_out_s": 63.2}]
        self.assertEqual(sources.check_marks(SMAP, ok), ([], []))
        hit, missing = sources.check_marks(SMAP, [{"source_in_s": 2.0, "source_out_s": 6.0}])
        self.assertEqual((len(hit), len(missing)), (1, 1))               # a "never" range was used and the "must" range is not in


def analysis(seconds, lively=()):
    n = int(seconds * montage.FPS_A)
    m, s, l = np.full(n, 0.01), np.full(n, 0.002), np.full(n, 0.5)
    for a, b in lively:
        m[int(a * montage.FPS_A):int(b * montage.FPS_A)] = 0.08
        s[int(a * montage.FPS_A):int(b * montage.FPS_A)] = 0.01
    return {"t": np.arange(n) / montage.FPS_A, "motion": m, "sharp": s, "luma": l}


class Candidates(unittest.TestCase):
    def setUp(self):
        self.never, self.must, _ = sources.ranges(SMAP)
        self.c = montage.candidates(analysis(95, [(1, 4), (10, 14), (35, 39), (70, 74)]), [20.0, 45.0, 80.0], SMAP, self.never, self.must)

    def test_moments_come_from_every_file_stay_inside_one_shot_and_avoid_what_was_marked_never(self):
        self.assertEqual({c["source"] for c in self.c}, {"src1", "src2", "src3"})
        edges = [0.0, 20.0, 30.0, 45.0, 55.0, 80.0, 95.0]
        for c in self.c:
            self.assertTrue(any(a <= c["in_s"] and c["out_s"] <= b for a, b in zip(edges, edges[1:])), c)       # never across a shot change or a file border
            self.assertFalse(c["in_s"] < 4.0 and c["source"] == "src1", c)                                       # the owner said: not these seconds
        self.assertTrue(any(c["in_s"] >= 10 and c["out_s"] <= 14.5 for c in self.c))                             # the lively stretch is found

    def test_what_the_owner_required_is_always_a_candidate(self):
        must = [c for c in self.c if c["must"]]
        self.assertEqual([(c["in_s"], c["out_s"], c["source"]) for c in must], [(60.0, 63.0, "src3")])

    def test_the_plan_keeps_a_required_moment_even_when_the_model_left_it_out_and_respects_the_length_limit(self):
        opt = [c["n"] for c in self.c if not c["must"]]
        raw = {"order": [{"candidate": n, "seconds": 3, "seen": "אישה על מכשיר", "why": "w"} for n in opt] + [{"candidate": 999, "seconds": 3, "seen": "", "why": ""}]}
        segs, notes = montage.validate(raw, self.c, 10.0, 12.0)
        self.assertTrue(any(s["must"] for s in segs))
        need = next(s for s in segs if s["must"])
        self.assertEqual((need["source_in_s"], need["source_out_s"]), (60.0, 63.0))        # in full: never shortened by the model's length
        self.assertTrue(any("חובה" in n for n in notes))
        self.assertLessEqual(sum(s["source_out_s"] - s["source_in_s"] for s in segs if not s["must"]), 12.0)
        self.assertTrue(all(montage.SEG_MIN <= s["source_out_s"] - s["source_in_s"] <= montage.SEG_MAX for s in segs))
        with self.assertRaises(PipelineError):
            montage.validate({"order": [{"candidate": 999, "seconds": 2, "seen": "", "why": ""}]}, [c for c in self.c if not c["must"]], 10, 30)

    def test_without_a_model_the_choice_is_by_measurement_and_says_so(self):
        segs = montage.by_measurement(self.c, 10.0, 30.0)
        self.assertGreaterEqual(len(segs), 2)
        self.assertTrue(all("לא שיפוט תוכן" in s["why"] for s in segs))
        self.assertEqual([s["source_in_s"] for s in segs], sorted(s["source_in_s"] for s in segs))


class Beat(unittest.TestCase):
    def test_a_cut_moves_to_a_beat_only_when_one_is_close_and_the_part_stays_inside_its_shot(self):
        segs = [{"source_in_s": 10.0, "source_out_s": 12.8, "window_out_s": 14.0}, {"source_in_s": 40.0, "source_out_s": 42.0, "window_out_s": 42.1},
                {"source_in_s": 60.0, "source_out_s": 63.0, "window_out_s": 63.0}]
        hits = montage.on_beat(segs, [1.0, 2.0, 3.0, 4.0, 5.5, 6.0])
        self.assertEqual((hits, segs[0]["on_beat"], segs[0]["source_out_s"]), (1, True, 13.0))       # 2.8 s -> 3.0 s: on the beat
        self.assertEqual((segs[1]["on_beat"], segs[1]["source_out_s"]), (False, 42.0))                # the beat at 5.5 would need 2.5 s, but its shot ends at 2.1 s

    def test_a_moment_the_owner_required_is_never_shortened_to_reach_a_beat(self):
        segs = [{"source_in_s": 60.0, "source_out_s": 63.0, "window_out_s": 63.0, "must": True}, {"source_in_s": 10.0, "source_out_s": 13.0, "window_out_s": 13.0}]
        montage.on_beat(segs, [2.8, 5.0])
        self.assertEqual((segs[0]["source_out_s"], segs[0]["on_beat"]), (63.0, False))

    def test_nothing_is_forced(self):
        self.assertEqual(mix.snap([2.9, 7.4], [1.0, 3.0, 5.0]), [(3.0, True), (7.4, False)])


class Narration(unittest.TestCase):
    CFG = deep_merge(DEFAULTS, {})

    def test_the_connection_is_prepared_and_not_active_without_a_key_and_an_explicit_switch(self):
        import os
        old = os.environ.pop(tts.KEY_ENV, None)
        try:
            st = tts.status(self.CFG)
            self.assertEqual((st["state"], st["active"], st["key_present"], len(st["missing"])), ("prepared_not_active", False, False, 2))
            with self.assertRaises(PipelineError) as e:
                tts.synthesize(self.CFG, "טקסט", "voice", "x.mp3", {"by": "עדן", "max_usd": 1})
            self.assertEqual(e.exception.code, "tts_not_active")           # nothing is sent
        finally:
            if old is not None:
                os.environ[tts.KEY_ENV] = old

    def test_a_cost_estimate_is_arithmetic_and_names_its_source(self):
        e = tts.estimate("א" * 600, "eleven_v3", takes=6)
        self.assertEqual((e["characters"], e["estimated_usd"], e["within_request_limit"]), (600, 0.288, True))
        self.assertIn("לאמת", e["basis"])
        with self.assertRaises(PipelineError):
            tts.estimate("x", "eleven_multilingual_v2")                    # the provider's default model does not list Hebrew


if __name__ == "__main__":
    unittest.main()
