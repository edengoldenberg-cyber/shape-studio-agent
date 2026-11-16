"""Unit tests for library skills on the worker: the rule-by-rule report, the reviewer block, draft-test status.
No model call, no ffmpeg."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dana_pipeline import skillgen, story    # noqa: E402

SKILL = {"id": "skl_x", "name": "ראיון רגוע", "version": 2, "sha256": "a" * 64, "status": "approved", "chosen_by": "default",
         "rules": [{"id": "r1", "text": "לפתוח במשפט החזק", "domain": "opening", "support": "supported"},
                   {"id": "r2", "text": "בלי זומים", "domain": "zooms", "support": "supported"},
                   {"id": "r3", "text": "כותרת פתיחה", "domain": "motion_graphics", "support": "partial"}],
         "unsupported": [{"id": "r4", "text": "להוסיף מוזיקה", "domain": "music", "why": "העובד לא מוסיף מוזיקה"}],
         "not_adopted": [{"id": "r5", "text": "דיזולב", "domain": "transitions"}],
         "criteria": [{"id": "k1", "text": "נפתח במשפט המרכזי", "domain": "opening"}, {"id": "k2", "text": "אין זום", "domain": "zooms"}]}
REVIEW = {"skill_rules": [{"id": "r1", "status": "applied", "note": "נפתח ב'ההבדל בין'"}, {"id": "r2", "status": "not_followed", "note": "יש שני זומים"},
                          {"id": "r3", "status": "cannot_tell", "note": ""}],
          "skill_criteria": [{"id": "k1", "met": True, "note": "כן"}, {"id": "k2", "met": False, "note": "זום ב-12s"}]}


class Report(unittest.TestCase):
    def test_every_rule_gets_one_honest_status(self):
        r = skillgen.report(SKILL, {"caption_size": 84, "caption_max_lines": 1}, REVIEW, {"caption_size": 84, "caption_max_lines": 2})
        self.assertEqual([(x["id"], x["status"]) for x in r["rules"]],
                         [("r1", "applied"), ("r2", "not_followed"), ("r3", "not_checked"), ("r4", "unsupported")])
        self.assertEqual(r["summary"], {"applied": 1, "not_followed": 1, "not_applicable": 0, "unsupported": 1, "not_checked": 1, "fully_applied": False})
        self.assertEqual(r["rules"][3]["decided_by"], "worker_capabilities")          # never judged "applied" by a model

    def test_parameters_are_compared_by_code_and_a_project_override_is_shown(self):
        r = skillgen.report(SKILL, {"caption_size": 84, "caption_max_lines": 1}, REVIEW, {"caption_size": 84, "caption_max_lines": 2})
        self.assertEqual([(p["key"], p["applied"]) for p in r["params"]], [("caption_size", True), ("caption_max_lines", False)])
        self.assertIn("הסקיל עצמו לא השתנה", r["params"][1]["note"])

    def test_without_a_model_review_nothing_is_called_applied(self):
        r = skillgen.report(SKILL, {}, None, {})
        self.assertTrue(all(x["status"] in ("not_checked", "unsupported") for x in r["rules"]))
        self.assertFalse(r["summary"]["fully_applied"])
        self.assertTrue(all(c["met"] is None for c in r["criteria"]))

    def test_hypotheses_that_were_not_adopted_are_listed_and_not_applied(self):
        r = skillgen.report(SKILL, {}, REVIEW, {})
        self.assertEqual(r["not_adopted"], SKILL["not_adopted"])
        self.assertNotIn("r5", [x["id"] for x in r["rules"]])

    def test_the_reviewer_is_asked_about_every_rule_and_criterion(self):
        block = skillgen.review_block(SKILL)
        for token in ("r1", "r2", "r3", "k1", "k2", "cannot_tell"):
            self.assertIn(token, block)
        self.assertNotIn("להוסיף מוזיקה", block)            # an unsupported rule is not sent for judging


class Profile(unittest.TestCase):
    def test_a_draft_under_test_is_never_reported_as_approved(self):
        _, _, default = story.load_skill()
        p = story.resolve_profile({"profile": {"id": "skill:skl_x", "version": "1", "params": {"caption_size": 84}, "rules": ["x"], "status": "draft_test"}}, default)
        self.assertEqual((p["status"], p["params"]["caption_size"]), ("draft_test", 84))
        q = story.resolve_profile({"profile": {"id": "skill:skl_x", "version": "1", "params": {}, "status": "anything-else"}}, default)
        self.assertEqual(q["status"], "owner_approved")
        self.assertEqual(story.resolve_profile({}, default)["status"], "unapproved")


if __name__ == "__main__":
    unittest.main()
