# -*- coding: utf-8 -*-
"""Unit tests for the canonical pipeline. No GPU, no Chrome, no ffmpeg, no network.

    python -X utf8 -m unittest discover -s dana-worker/tests -v
"""
import json
import re
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dana_pipeline import captions, checks, judgement, run as runner                      # noqa: E402
from dana_pipeline.core import (DEFAULTS, EXIT, FAILURE, REVIEW_REQUIRED, STATE_BY_EXIT, SUCCESS, WAITING,  # noqa: E402
                                PipelineError, Waiting, deep_merge, load_config, sha256_file)

CFG = deep_merge(DEFAULTS, {})
STYLE = dict(CFG["style"])


def words(*triples):
    return [{"word": w, "start": s, "end": e, "probability": 0.99} for w, s, e in triples]


SRC = words(("שלום", 1.0, 1.4), ("לכולם", 1.45, 1.9), ("אני", 2.4, 2.6), ("מתאמנת", 2.65, 3.2), ("כאן", 3.25, 3.6),
            ("כבר", 4.5, 4.8), ("שנה", 4.85, 5.3), ("וזה", 6.0, 6.3), ("שינה", 6.35, 6.8), ("לי", 6.85, 7.0),
            ("את", 7.05, 7.2), ("החיים", 7.25, 7.9))
DEC = {"segment": {"in_s": 0.9, "out_s": 8.2}, "cards": [{"text": "שלום לכולם"}, {"text": "אני מתאמנת כאן", "highlight": ["מתאמנת"]},
       {"text": "כבר שנה"}, {"text": "וזה שינה לי"}, {"text": "את החיים"}], "cover": {"text": "שינה לי את החיים"},
       "caption": {"text": "[טיוטה] ציטוט", "cta": None}}


def wav_with_speech(path, spans, dur=9.0, sr=16000):
    x = np.random.default_rng(1).normal(0, 20, int(dur * sr))
    for a, b in spans:
        x[int(a * sr):int(b * sr)] += np.random.default_rng(2).normal(0, 6000, int(b * sr) - int(a * sr))
    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(sr)
        wf.writeframes(np.clip(x, -32000, 32000).astype(np.int16).tobytes())


class States(unittest.TestCase):
    def test_four_explicit_states_with_distinct_exit_codes(self):
        self.assertEqual(EXIT, {SUCCESS: 0, FAILURE: 1, REVIEW_REQUIRED: 2, WAITING: 3})
        self.assertEqual(len(set(EXIT.values())), 4)
        self.assertEqual(STATE_BY_EXIT[2], REVIEW_REQUIRED)

    def test_main_writes_result_and_exit_code_for_a_failure(self):
        with tempfile.TemporaryDirectory() as d:
            code = runner.main(["--config", str(Path(d) / "missing.json"), "--job-dir", d, "--source", "x.mp4"])
            res = json.loads((Path(d) / "result.json").read_text(encoding="utf-8"))
        self.assertEqual(code, 1)
        self.assertEqual((res["status"], res["code"]), (FAILURE, "config_invalid"))

    def test_no_interactive_calls_in_the_pipeline(self):
        root = Path(__file__).resolve().parents[1]
        for f in list((root / "dana_pipeline").glob("*.py")) + [root / "worker.py"]:
            src = f.read_text(encoding="utf-8")
            self.assertIsNone(re.search(r"(?<![\w.])input\(", src), f.name + " prompts for input")
            self.assertNotIn("shell=True", src, f.name)
            self.assertNotIn("os.startfile", src, f.name)


class Config(unittest.TestCase):
    def test_changed_renderer_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            for n in ("chrome.exe", "renderer.py", "zone.json"):
                (d / n).write_text("x", encoding="utf-8")
            base = {"paths": {"work_root": str(d / "w"), "chrome": str(d / "chrome.exe"), "caption_renderer": str(d / "renderer.py"),
                              "font_dir": str(d), "safe_zone": str(d / "zone.json"), "ffmpeg": sys.executable, "ffprobe": sys.executable}}
            (d / "c.json").write_text(json.dumps({**base, "caption_renderer_sha256": "0" * 64}), encoding="utf-8")
            with self.assertRaises(PipelineError) as e:
                load_config(d / "c.json")
            self.assertIn("caption renderer changed", e.exception.message)
            (d / "c.json").write_text(json.dumps({**base, "caption_renderer_sha256": sha256_file(d / "renderer.py")}), encoding="utf-8")
            self.assertEqual(load_config(d / "c.json")["judgement"]["adapter"], "heuristic")
            (d / "c.json").write_text(json.dumps({"paths": {}}), encoding="utf-8")
            with self.assertRaises(PipelineError) as e:
                load_config(d / "c.json")
            self.assertIn("paths.work_root is missing", e.exception.message)

    def test_pinned_backup_matches_the_example_config(self):
        root = Path(__file__).resolve().parents[1]
        want = json.loads((root / "worker.config.example.json").read_text(encoding="utf-8"))["caption_renderer_sha256"]
        self.assertEqual(sha256_file(root / "vendor" / "caption_layer.local-2026-09-13.py"), want)


class Judgement(unittest.TestCase):
    def test_valid_decisions_and_exact_quotation(self):
        dec, issues = judgement.validate(dict(DEC), SRC, 10.0, CFG, STYLE)
        self.assertEqual(dec["segment"]["in_s"], 0.88)                       # snapped to a 25 fps frame
        self.assertEqual(dec["cards"][1]["highlight"], ["מתאמנת"])
        self.assertTrue(dec["caption"]["is_draft"])
        self.assertNotIn("cover_text_not_a_quotation", [i["code"] for i in issues])

    def test_content_can_never_be_markup_or_extra_fields(self):
        for bad in ({**DEC, "cards": [{"text": "<script>alert(1)</script>"}]},
                    {**DEC, "cards": [{"text": "שלום", "highlight": ["לא בכרטיס"]}]},
                    {**DEC, "run": "rm -rf /"},
                    {**DEC, "segment": {"in_s": 5, "out_s": 2}},
                    {**DEC, "segment": {"in_s": 0, "out_s": 2}},              # shorter than the minimum
                    {**DEC, "cards": []}):
            with self.assertRaises(PipelineError) as e:
                judgement.validate(bad, SRC, 10.0, CFG, STYLE)
            self.assertEqual(e.exception.code, "judgement_invalid")

    def test_out_point_never_cuts_a_word_and_in_point_is_not_moved_by_a_stamp(self):
        dec, issues = judgement.validate({**DEC, "segment": {"in_s": 1.2, "out_s": 7.5}}, SRC, 10.0, CFG, STYLE)
        self.assertGreaterEqual(dec["segment"]["out_s"], 7.9)                # 'החיים' ends at 7.9
        self.assertEqual(dec["segment"]["in_s"], 1.2)
        self.assertTrue(any("checked on the audio level" in i["message"] for i in issues))

    def test_deviation_from_the_asr_is_a_blocker_and_a_paraphrased_cover_is_flagged(self):
        dec, issues = judgement.validate({**DEC, "homophones": {"עם": "אם"}, "cover": {"text": "החיים שלי השתנו"}}, SRC, 10.0, CFG, STYLE)
        codes = {i["code"]: i["severity"] for i in issues}
        self.assertEqual(codes["caption_differs_from_asr"], "blocker")
        self.assertEqual(codes["cover_text_not_a_quotation"], "warn")

    def test_highlight_is_selective_and_can_be_disabled_per_project(self):
        many = {**DEC, "cards": [{"text": c["text"], "highlight": [c["text"]]} for c in DEC["cards"]]}
        _, issues = judgement.validate(many, SRC, 10.0, CFG, STYLE)
        self.assertIn("highlight_not_selective", [i["code"] for i in issues])
        dec, _ = judgement.validate(dict(DEC), SRC, 10.0, CFG, dict(STYLE, highlight_enabled=False))
        self.assertEqual([c["highlight"] for c in dec["cards"]], [[]] * 5)

    def test_heuristic_quotes_exactly_and_invents_nothing(self):
        raw = judgement.heuristic(SRC, 10.0, CFG)
        dec, _ = judgement.validate(raw, SRC, 10.0, CFG, STYLE)
        self.assertEqual(" ".join(c["text"] for c in dec["cards"]), " ".join(w["word"] for w in SRC))
        self.assertTrue(all(len(c["text"].split()) <= 3 and not c["highlight"] for c in dec["cards"]))
        self.assertIsNone(dec["caption"]["cta"])
        self.assertIn("טיוטה", dec["caption"]["text"])
        with self.assertRaises(PipelineError):
            judgement.heuristic([], 10.0, CFG)

    def test_scripted_without_decisions_is_waiting_not_failure(self):
        with tempfile.TemporaryDirectory() as d, self.assertRaises(Waiting) as e:
            judgement.decide({"options": {"adapter": "scripted"}}, SRC, 10.0, CFG, d)
        self.assertEqual(e.exception.code, "decisions_missing")

    def test_claude_adapter_is_off_by_default_and_has_no_tools(self):
        with self.assertRaises(Waiting) as e:
            judgement.decide({"options": {"adapter": "claude"}}, SRC, 10.0, CFG, ".")
        self.assertEqual(e.exception.code, "claude_adapter_disabled")
        cmd = judgement.claude_command(CFG, "{}")
        self.assertEqual(cmd[cmd.index("--tools") + 1], "")
        self.assertEqual(cmd[cmd.index("--setting-sources") + 1], "")
        for flag in ("--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--max-budget-usd", "--json-schema"):
            self.assertIn(flag, cmd)
        for forbidden in ("--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "bypassPermissions", "--add-dir"):
            self.assertNotIn(forbidden, " ".join(cmd))


class Captions(unittest.TestCase):
    def setUp(self):
        self.dec, _ = judgement.validate(dict(DEC), SRC, 10.0, CFG, STYLE)
        self.in_s = self.dec["segment"]["in_s"]
        self.seg = [dict(w, start=round(w["start"] - self.in_s, 3), end=round(w["end"] - self.in_s, 3)) for w in SRC]

    def test_cards_follow_the_words_never_overlap_and_never_end_early(self):
        spans, skipped = captions.match_cards(self.dec["cards"], self.seg)
        cards, _ = captions.time_cards(self.dec["cards"], spans, 25, 0.40, 7.3)
        self.assertEqual(skipped, [])
        for c, sp in zip(cards, spans):
            self.assertLessEqual(c["start"], sp[0]["start"] + 1e-6)                       # shown by the first word
            self.assertGreaterEqual(c["start"] + c["dur"], sp[-1]["end"] - 1e-6)          # tail >= 0
        for a, b in zip(cards, cards[1:]):
            self.assertLess(a["start"] + a["dur"], b["start"] + 1e-6)                     # no shared frame
        self.assertLessEqual(cards[1]["start"] + cards[1]["dur"], self.seg[4]["end"] + 0.45)   # does not sit through the pause

    def test_a_card_that_is_not_in_the_audio_stops_the_job(self):
        bad = [{"text": "שלום לכולם"}, {"text": "משהו שלא נאמר"}]
        with self.assertRaises(PipelineError) as e:
            captions.match_cards(bad, self.seg)
        self.assertEqual(e.exception.code, "caption_text_mismatch")

    def test_card_html_is_escaped(self):
        html = captions.card_html('a < b & "c"', ["b"], dict(STYLE, backing=False))
        self.assertEqual(html, 'a &lt; <span class="hl">b</span> &amp; &quot;c&quot;')


class SyncGate(unittest.TestCase):
    """The gate reads structured fields. The old gate matched the text 'FAIL: 0', which is
    also inside 'TAIL FAIL: 0', so drift failures passed whenever the tail was clean."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.wav = Path(self.tmp.name) / "a.wav"
        self.heard = words(("שלום", 0.10, 0.50), ("לכולם", 0.55, 1.00), ("אני", 1.50, 1.70), ("מתאמנת", 1.75, 2.30), ("כאן", 2.35, 2.70))
        wav_with_speech(self.wav, [(0.1, 1.0), (1.5, 2.7)], dur=4.0)

    def tearDown(self):
        self.tmp.cleanup()

    def cards(self, second_start=1.48):
        return [{"i": 1, "start": 0.08, "dur": 0.95, "plain": "שלום לכולם"}, {"i": 2, "start": second_start, "dur": 2.75 - second_start, "plain": "אני מתאמנת כאן"}]

    def status(self, v):
        return {r["id"]: r["status"] for r in checks.sync_records(v)}

    def test_all_good(self):
        v = checks.verify_sync(CFG, self.cards(), self.heard, self.wav)
        self.assertEqual(self.status(v), {"sync_lead": "pass", "sync_not_found": "pass", "sync_tail": "pass", "energy_gate": "pass"})

    def test_lead_failure_with_a_clean_tail_is_a_failure(self):
        v = checks.verify_sync(CFG, self.cards(second_start=1.20), self.heard, self.wav)     # card 300 ms before the word
        st = self.status(v)
        self.assertEqual((v["lead_fail"], v["tail_fail"]), ([2], []))
        self.assertEqual((st["sync_lead"], st["sync_tail"]), ("fail", "pass"))

    def test_tail_not_found_and_energy_are_separate_gates(self):
        early = [{"i": 1, "start": 0.08, "dur": 0.60, "plain": "שלום לכולם"}]                # gone 320 ms before 'לכולם' ends
        self.assertEqual(self.status(checks.verify_sync(CFG, early, self.heard, self.wav))["sync_tail"], "fail")
        ghost = self.cards() + [{"i": 3, "start": 3.0, "dur": 0.8, "plain": "יעיל מאוד"}]
        v = checks.verify_sync(CFG, ghost, self.heard, self.wav)
        self.assertEqual(v["not_found"], [3])
        self.assertEqual(self.status(v)["sync_not_found"], "fail")
        self.assertIn("יעיל", [w["word"] for w in v["suspicious_words"]])                    # silence where the word should be
        low = [dict(w, probability=0.5) if w["word"] == "מתאמנת" else w for w in self.heard]
        self.assertEqual(self.status(checks.verify_sync(CFG, self.cards(), low, self.wav))["energy_gate"], "fail")

    def test_boundary_out_point_is_locked_and_in_point_uses_the_measured_level(self):
        self.assertEqual(checks.check_boundary(SRC, 0.5, 7.5)["status"], "fail")              # out_s inside 'החיים'
        self.assertEqual(checks.check_boundary(SRC, 1.2, 8.2, in_level_db=-33.0, floor_db=-36.0)["status"], "pass")
        self.assertEqual(checks.check_boundary(SRC, 1.2, 8.2, in_level_db=-12.0, floor_db=-36.0)["status"], "fail")
        self.assertEqual(checks.check_boundary(SRC, 1.2, 8.2)["status"], "fail")              # no measurement is not a pass


if __name__ == "__main__":
    unittest.main(verbosity=2)
