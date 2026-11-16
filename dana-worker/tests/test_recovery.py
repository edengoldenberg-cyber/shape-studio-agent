"""Recovery fixes after 2026-11-16 (the machine slept for 851 s in the middle of a job and its lease expired).

    python -X utf8 -m unittest discover -s dana-worker/tests -v
"""
import ast
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import worker  # noqa: E402


class KeepAwake(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows only")
    def test_windows_accepts_the_request_and_its_release(self):
        try:
            self.assertTrue(worker.keep_awake(True))
        finally:
            self.assertTrue(worker.keep_awake(False))

    def test_the_request_is_released_when_the_job_ends_or_fails(self):
        """In the worker loop the edit job runs between keep_awake(True) and a `finally: keep_awake(False)`."""
        tree = ast.parse((ROOT / "worker.py").read_text(encoding="utf-8"))
        main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main")
        calls = lambda nodes, name: [c for n in nodes for c in ast.walk(n) if isinstance(c, ast.Call) and getattr(c.func, "id", None) == name]
        guarded = [t for t in ast.walk(main) if isinstance(t, ast.Try) and t.finalbody and calls(t.body, "handle")]
        self.assertEqual(len(guarded), 1)
        off = calls(guarded[0].finalbody, "keep_awake")
        self.assertEqual([c.args[0].value for c in off], [False])
        on = [c for c in calls([main], "keep_awake") if c.args[0].value is True]
        self.assertEqual(len(on), 1)
        self.assertLess(on[0].lineno, guarded[0].lineno + 1)

    def test_it_never_fails_a_job(self):
        self.assertIn(worker.keep_awake(True), (True, False))
        self.assertIn(worker.keep_awake(False), (True, False))




class StartAfterPowerLoss(unittest.TestCase):
    """The machine can be up before the network or the server is: the worker waits, it does not exit."""
    class Api:
        worker_id = "w"

        def __init__(self, outcomes):
            self.outcomes, self.calls = list(outcomes), 0

        def call(self, *a, **k):
            self.calls += 1
            o = self.outcomes.pop(0)
            if isinstance(o, Exception):
                raise o
            return o

    def cfg(self, d):
        return {"paths": {"work_root": d, "chrome": "x", "claude_exe": "x", "face_model": "x"}, "judgement": {}}

    def run_hello(self, outcomes, d, **kw):
        import unittest.mock as mock
        api, waits = self.Api(outcomes), []
        with mock.patch.object(worker, "capabilities", lambda cfg: {}), mock.patch.object(worker, "log", lambda m: None):
            return worker.hello(api, self.cfg(d), sleep=waits.append, **kw), api, waits

    def test_an_unreachable_server_is_waited_for(self):
        import tempfile, urllib.error
        with tempfile.TemporaryDirectory() as d:
            down = urllib.error.URLError("refused")
            (res, api, waits) = self.run_hello([down, down, ConnectionResetError(), (200, {"ok": True})], d)
        self.assertEqual(res, (200, {"ok": True}))
        self.assertEqual((api.calls, waits), (4, [30, 30, 30]))

    def test_a_server_that_refuses_is_not_retried(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            (res, api, waits) = self.run_hello([(401, {"error": "token"})], d)
        self.assertEqual((res[0], api.calls, waits), (401, 1, []))

    def test_the_stop_file_ends_the_wait(self):
        import tempfile, urllib.error
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "STOP").write_text("", encoding="utf-8")
            (res, api, waits) = self.run_hello([urllib.error.URLError("down")] * 3, d)
        self.assertEqual((res, api.calls, waits), ((None, "stopped"), 1, []))


if __name__ == "__main__":
    unittest.main()
