"""Voice messages on the editing worker: download → local transcription → text to the server, and the recording never stays.

    python -X utf8 -m unittest discover -s dana-worker/tests -p test_voice.py -v

No GPU, no network: a local mock of the server contract (/api/voice/worker/*) and a stub transcriber.
"""
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import worker  # noqa: E402

AUDIO = b"OggS" + bytes(range(256)) * 40
SHA = hashlib.sha256(AUDIO).hexdigest()
TOKEN = "t" * 32
SECRET_TEXT = "אני רוצה לעבור לשיעור של חמש"


class Server:
    """The server side of the contract. `jobs` waits to be leased; everything the worker sends is recorded."""

    def __init__(self, jobs=None, lease_status=None, audio=AUDIO, audio_status=200):
        self.jobs, self.lease_status, self.audio, self.audio_status = list(jobs or []), lease_status, audio, audio_status
        self.results, self.requests, outer = [], [], self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, code, body=None):
                raw = json.dumps(body).encode() if body is not None else b""
                self.send_response(code)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _auth(self):
                return self.headers.get("Authorization") == f"Bearer {TOKEN}"

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                outer.requests.append(("POST", self.path, self.headers.get("X-Lease-Token")))
                if not self._auth():
                    return self._json(401, {"error": "unauthorized"})
                if self.path == "/api/voice/worker/lease":
                    if outer.lease_status:
                        return self._json(outer.lease_status, {"error": "x"})
                    if not outer.jobs:
                        return self._json(204)
                    return self._json(200, {"job": outer.jobs.pop(0), "leaseToken": "lease-1"})
                if self.path.endswith("/result"):
                    outer.results.append((self.path.split("/")[-2], self.headers.get("X-Lease-Token"), body))
                    return self._json(200, {"ok": True})
                self._json(404, {"error": "not_found"})

            def do_GET(self):
                outer.requests.append(("GET", self.path, self.headers.get("X-Lease-Token")))
                if not self._auth() or self.headers.get("X-Lease-Token") != "lease-1":
                    return self._json(401, {"error": "unauthorized"})
                if outer.audio_status != 200:
                    return self._json(outer.audio_status, {"error": "x"})
                self.send_response(200)
                self.send_header("Content-Length", str(len(outer.audio)))
                self.end_headers()
                self.wfile.write(outer.audio)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def job(**over):
    return {"id": "vm_abc12345", "ext": "ogg", "sha256": SHA, "bytes": len(AUDIO), "receivedAt": "2026-11-17T10:00:00Z", **over}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cfg = {"paths": {"work_root": str(self.root)}, "voice": {"timeout_s": 3}}
        self.srv = None
        self.seen = []                       # what the stub transcriber found on disk

    def tearDown(self):
        if self.srv:
            self.srv.close()
        worker.release_instance()
        self.tmp.cleanup()

    def serve(self, **kw):
        self.srv = Server(**kw)
        return worker.Api(self.srv.url, TOKEN, "w-test")

    def ok_runner(self, cfg, cfg_path, audio, out):
        self.seen.append((Path(audio).read_bytes() == AUDIO, Path(audio).parent.parent == self.root / "voice"))
        return {"text": SECRET_TEXT, "language": "he", "duration_s": 4.2, "model": "large-v3", "avg_logprob": -0.21, "no_speech_prob": 0.02}, None

    def run_job(self, api, leased, runner=None):
        buf = io.StringIO()
        with redirect_stdout(buf):
            ok = worker.handle_voice(api, self.cfg, "cfg.json", leased, runner=runner or self.ok_runner)
        return ok, buf.getvalue()

    def nothing_left(self):
        v = self.root / "voice"
        return not v.exists() or not any(v.iterdir())


class Transcription(Base):
    def test_a_recording_is_downloaded_transcribed_posted_and_deleted(self):
        api = self.serve()
        ok, logged = self.run_job(api, {"job": job(), "leaseToken": "lease-1"})
        self.assertTrue(ok)
        self.assertEqual(self.seen, [(True, True)])
        jid, lease, body = self.srv.results[0]
        self.assertEqual((jid, lease, body["status"], body["text"], body["language"], body["model"]), ("vm_abc12345", "lease-1", "transcribed", SECRET_TEXT, "he", "large-v3"))
        self.assertEqual((body["duration_s"], body["avg_logprob"], body["no_speech_prob"]), (4.2, -0.21, 0.02))
        self.assertTrue(self.nothing_left())
        self.assertNotIn(SECRET_TEXT, logged)                       # the content is never logged
        self.assertNotIn(TOKEN, logged)
        self.assertIn("vm_abc12345", logged)

    def test_a_hash_mismatch_is_a_failed_result_and_nothing_is_transcribed(self):
        api = self.serve(audio=AUDIO + b"x")
        ok, _ = self.run_job(api, {"job": job(), "leaseToken": "lease-1"})
        self.assertFalse(ok)
        self.assertEqual(self.seen, [])
        self.assertEqual((self.srv.results[0][2]["status"], self.srv.results[0][2]["error"]["code"]), ("failed", "voice_transfer_failed"))
        self.assertTrue(self.nothing_left())

    def test_bad_fields_are_refused_without_a_download(self):
        for bad in ({"ext": "exe"}, {"ext": "../x"}, {"sha256": "zz"}, {"bytes": worker.VOICE_MAX_BYTES + 1}):
            api = self.serve()
            ok, _ = self.run_job(api, {"job": job(**bad), "leaseToken": "lease-1"})
            self.assertFalse(ok)
            self.assertEqual(self.srv.results[0][2]["error"]["code"], "voice_invalid", bad)
            self.assertFalse([r for r in self.srv.requests if r[0] == "GET"], bad)
            self.assertTrue(self.nothing_left())
            self.srv.close()
            self.srv = None

    def test_a_bad_id_touches_neither_the_disk_nor_the_server(self):
        api = self.serve()
        ok, _ = self.run_job(api, {"job": job(id="../../etc"), "leaseToken": "lease-1"})
        self.assertFalse(ok)
        self.assertEqual((self.srv.requests, self.srv.results), ([], []))
        self.assertTrue(self.nothing_left())

    def test_a_failed_transcription_is_reported_and_the_recording_is_deleted(self):
        api = self.serve()
        fail = lambda *a: (None, {"code": "voice_asr_failed", "message": "transcription failed: RuntimeError: CUDA out of memory"})
        ok, _ = self.run_job(api, {"job": job(), "leaseToken": "lease-1"}, runner=fail)
        self.assertFalse(ok)
        self.assertEqual(self.srv.results[0][2], {"status": "failed", "error": {"code": "voice_asr_failed", "message": "transcription failed: RuntimeError: CUDA out of memory"}})
        self.assertTrue(self.nothing_left())

    def test_a_transcriber_that_raises_still_leaves_nothing_behind(self):
        api = self.serve()

        def boom(*a):
            raise OSError("disk")
        ok, _ = self.run_job(api, {"job": job(), "leaseToken": "lease-1"}, runner=boom)
        self.assertFalse(ok)
        self.assertEqual(self.srv.results[0][2]["status"], "failed")
        self.assertTrue(self.nothing_left())

    def test_a_refused_download_is_reported(self):
        api = self.serve(audio_status=500)
        ok, _ = self.run_job(api, {"job": job(), "leaseToken": "lease-1"})
        self.assertFalse(ok)
        self.assertEqual(self.srv.results[0][2]["error"]["code"], "voice_transfer_failed")
        self.assertTrue(self.nothing_left())

    def test_an_unreachable_server_while_posting_does_not_keep_the_recording(self):
        api = self.serve()
        srv = self.srv

        def runner(cfg, cfg_path, audio, out):
            srv.close()                                  # the server goes away while the recording is transcribed
            return self.ok_runner(cfg, cfg_path, audio, out)
        self.srv = None
        ok, logged = self.run_job(api, {"job": job(), "leaseToken": "lease-1"}, runner=runner)
        self.assertFalse(ok)
        self.assertTrue(self.nothing_left())
        self.assertNotIn(SECRET_TEXT, logged)


class ChildProcess(Base):
    """run_voice starts the transcriber as a child with a time limit; the child here is a stub (no GPU)."""

    def with_child(self, code):
        orig = worker.voice_command
        worker.voice_command = lambda cfg_path, audio, out: [sys.executable, "-X", "utf8", "-c", code, str(out)]
        self.addCleanup(lambda: setattr(worker, "voice_command", orig))
        d = self.root / "voice" / "vm_x"
        d.mkdir(parents=True)
        (d / "audio.ogg").write_bytes(AUDIO)
        return worker.run_voice(self.cfg, "cfg.json", d / "audio.ogg", d / "result.json")

    def test_a_result_file_with_text_is_the_transcript(self):
        res, err = self.with_child("import sys,json;open(sys.argv[1],'w',encoding='utf-8').write(json.dumps({'text':'שלום','language':'he','duration_s':1.0,'model':'large-v3'}))")
        self.assertIsNone(err)
        self.assertEqual(res["text"], "שלום")

    def test_a_hang_ends_at_the_time_limit(self):
        self.cfg["voice"]["timeout_s"] = 1
        res, err = self.with_child("import time;time.sleep(30)")
        self.assertIsNone(res)
        self.assertEqual(err["code"], "voice_timeout")

    def test_a_crash_without_a_result_is_a_failure(self):
        res, err = self.with_child("import os;os._exit(3)")
        self.assertIsNone(res)
        self.assertEqual(err["code"], "voice_asr_failed")

    def test_the_childs_own_error_is_passed_on(self):
        res, err = self.with_child("import sys,json;open(sys.argv[1],'w').write(json.dumps({'error':{'code':'voice_no_speech','message':'no speech'}}));sys.exit(1)")
        self.assertEqual(err, {"code": "voice_no_speech", "message": "no speech"})

    def test_a_timeout_through_the_whole_handler_posts_a_failure_and_deletes(self):
        self.cfg["voice"]["timeout_s"] = 1
        orig = worker.voice_command
        worker.voice_command = lambda cfg_path, audio, out: [sys.executable, "-c", "import time;time.sleep(30)"]
        self.addCleanup(lambda: setattr(worker, "voice_command", orig))
        api = self.serve()
        with redirect_stdout(io.StringIO()):
            ok = worker.handle_voice(api, self.cfg, "cfg.json", {"job": job(), "leaseToken": "lease-1"})
        self.assertFalse(ok)
        self.assertEqual(self.srv.results[0][2]["error"]["code"], "voice_timeout")
        self.assertTrue(self.nothing_left())

    def test_the_real_command_runs_only_the_workers_own_module(self):
        cmd = worker.voice_command("c.json", "a.ogg", "o.json")
        self.assertEqual(cmd[:5], [sys.executable, "-X", "utf8", "-m", "dana_pipeline.voice"])


class Polling(Base):
    def test_a_waiting_recording_is_taken(self):
        api = self.serve(jobs=[job()])
        orig = worker.run_voice
        worker.run_voice = self.ok_runner
        self.addCleanup(lambda: setattr(worker, "run_voice", orig))
        with redirect_stdout(io.StringIO()):
            self.assertTrue(worker.poll_voice(api, self.cfg, "cfg.json"))
            self.assertFalse(worker.poll_voice(api, self.cfg, "cfg.json"))      # 204: nothing waits
        self.assertEqual(len(self.srv.results), 1)

    def test_an_older_server_without_the_route_is_ignored_silently(self):
        api = self.serve(lease_status=404)
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertFalse(worker.poll_voice(api, self.cfg, "cfg.json"))
        self.assertEqual(buf.getvalue(), "")

    def test_another_refusal_is_logged_without_details(self):
        api = self.serve(lease_status=503)
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertFalse(worker.poll_voice(api, self.cfg, "cfg.json"))
        self.assertIn("503", buf.getvalue())

    def test_the_main_loop_asks_for_voice_before_an_edit_job(self):
        src = (ROOT / "worker.py").read_text(encoding="utf-8")
        main = src[src.index("def main():"):]
        self.assertLess(main.index("poll_voice(api, cfg, a.config)"), main.index('"/api/dana/worker/lease"'))


class Leftovers(Base):
    def test_recordings_left_by_a_crash_are_deleted_at_start_and_at_housekeeping(self):
        for k in ("vm_one11", "vm_two22"):
            d = self.root / "voice" / k
            d.mkdir(parents=True)
            (d / "audio.ogg").write_bytes(AUDIO)
            (d / "result.json").write_text("{}", encoding="utf-8")
        self.assertEqual(worker.purge_voice(self.cfg), 2)
        self.assertTrue(self.nothing_left())
        (self.root / "voice" / "vm_three").mkdir(parents=True)
        (self.root / "voice" / "vm_three" / "audio.ogg").write_bytes(AUDIO)
        worker.housekeeping(self.cfg)
        self.assertTrue(self.nothing_left())

    def test_main_purges_before_it_talks_to_the_server(self):
        src = (ROOT / "worker.py").read_text(encoding="utf-8")
        main = src[src.index("def main():"):]
        self.assertLess(main.index("single_instance(cfg)"), main.index("purge_voice(cfg)"))
        self.assertLess(main.index("purge_voice(cfg)"), main.index("hello(api, cfg, a.once)"))


class SingleInstance(Base):
    CHILD = ("import sys;sys.path.insert(0, sys.argv[1]);import worker;"
             "print('LOCKED' if worker.single_instance({'paths': {'work_root': sys.argv[2]}}) else 'REFUSED')")

    def child(self):
        return subprocess.run([sys.executable, "-X", "utf8", "-c", self.CHILD, str(ROOT), str(self.root)], capture_output=True, text=True, timeout=60).stdout.strip()

    def test_a_second_worker_on_the_same_work_root_is_refused(self):
        self.assertTrue(worker.single_instance(self.cfg))
        self.assertEqual(self.child(), "REFUSED")

    def test_a_lock_file_left_by_a_dead_worker_does_not_block_a_start(self):
        self.assertEqual(self.child(), "LOCKED")            # that process is gone now; its lock file is still on disk
        self.assertTrue((self.root / "worker.lock").exists())
        self.assertTrue(worker.single_instance(self.cfg))
        worker.release_instance()
        self.assertEqual(self.child(), "LOCKED")

    def main_with(self, argv_extra=()):
        orig_load, orig_argv = worker.load_config, sys.argv
        worker.load_config = lambda p: {**self.cfg, "token_env": "DANA_TEST_VOICE_TOKEN", "server_url": "http://127.0.0.1:9", "worker_id": "w"}
        os.environ["DANA_TEST_VOICE_TOKEN"] = TOKEN
        sys.argv = ["worker.py", "--config", "x.json", *argv_extra]
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                return worker.main(), buf.getvalue()
        finally:
            worker.load_config, sys.argv = orig_load, orig_argv
            os.environ.pop("DANA_TEST_VOICE_TOKEN", None)

    def test_main_exits_cleanly_when_another_worker_holds_the_lock(self):
        holder = subprocess.Popen([sys.executable, "-X", "utf8", "-c", self.CHILD + ";sys.stdout.flush();import time;time.sleep(20)", str(ROOT), str(self.root)], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), "LOCKED")
            code, logged = self.main_with()
            self.assertEqual(code, 0)
            self.assertIn("another worker already runs", logged)
        finally:
            holder.kill()
            holder.wait()

    def test_the_stop_file_is_respected_before_anything_else(self):
        (self.root / "STOP").write_text("", encoding="utf-8")
        (self.root / "voice" / "vm_left1").mkdir(parents=True)
        code, logged = self.main_with()
        self.assertEqual(code, 0)
        self.assertIn("STOP file present", logged)
        self.assertFalse((self.root / "worker.lock").exists())          # a held worker takes no lock and talks to no server


if __name__ == "__main__":
    unittest.main()
