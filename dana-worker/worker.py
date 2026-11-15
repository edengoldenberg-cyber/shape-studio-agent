# -*- coding: utf-8 -*-
"""Dana local editing worker.

Polls the server (OUTBOUND only — no port is opened on this machine), takes one
editing job at a time, runs the canonical pipeline and uploads the verified artifacts.

    python -X utf8 worker.py --config worker.config.json           # run until stopped
    python -X utf8 worker.py --config worker.config.json --once    # one poll, then exit

Security model
  * The server sends a DECLARATIVE job (source hash, options). The worker never
    executes anything the server sends: the only program it starts is its own
    pipeline (`python -m dana_pipeline.run`) with paths it built itself.
  * The token (env var named by `token_env`) is valid only for /api/dana/worker/*.
  * Every transfer is verified by SHA-256 in both directions.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from dana_pipeline import PIPELINE_VERSION                                   # noqa: E402
from dana_pipeline.core import (FAILURE, REVIEW_REQUIRED, STATE_BY_EXIT, SUCCESS, WAITING, PipelineError,  # noqa: E402
                                load_config, sha256_file, utf8_stdout)

SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{4,80}$")
SAFE_EXT = {"mp4", "mov", "m4v", "webm", "avi", "mkv"}
UPLOAD_ORDER = ["package.json", "checks.json", "captions.json", "editorial.json", "transcript_source.json", "transcript_final.json",
                "cover.jpg", "final.mp4"]
TRANSFER_ATTEMPTS = 3


class Api:
    def __init__(self, base, token, worker_id):
        self.base, self.token, self.worker_id = base.rstrip("/"), token, worker_id

    def _req(self, method, path, body=None, headers=None, data=None, timeout=60):
        h = {"Authorization": f"Bearer {self.token}", **(headers or {})}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            h["Content-Type"] = "application/json"
        return urllib.request.urlopen(urllib.request.Request(self.base + path, data=data, headers=h, method=method), timeout=timeout)

    def call(self, method, path, body=None, headers=None):
        try:
            with self._req(method, path, body, headers) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"error": raw[:200].decode("utf-8", "replace")}

    def download(self, job_id, lease, dest, want_sha):
        """Download to a temp file, verify the hash, then move into place."""
        tmp = dest.with_suffix(dest.suffix + ".part")
        for attempt in range(1, TRANSFER_ATTEMPTS + 1):
            try:
                h = hashlib.sha256()
                with self._req("GET", f"/api/dana/worker/jobs/{job_id}/source", headers={"X-Lease-Token": lease}, timeout=120) as r, \
                        open(tmp, "wb") as f:
                    for chunk in iter(lambda: r.read(1 << 20), b""):
                        f.write(chunk)
                        h.update(chunk)
                if h.hexdigest() == want_sha:
                    os.replace(tmp, dest)
                    return
                err = "hash mismatch after download"
            except (urllib.error.URLError, OSError) as e:
                err = str(e)
            log(f"source download attempt {attempt} failed: {err}")
            time.sleep(2 * attempt)
        tmp.unlink(missing_ok=True)
        raise PipelineError("source_transfer_failed", f"could not download the source intact: {err}", True)

    def upload(self, job_id, lease, name, path):
        sha, size = sha256_file(path), path.stat().st_size
        for attempt in range(1, TRANSFER_ATTEMPTS + 1):
            try:
                with open(path, "rb") as f:
                    with self._req("PUT", f"/api/dana/worker/jobs/{job_id}/artifacts/{name}", data=f, timeout=600, headers={
                            "X-Lease-Token": lease, "X-Content-SHA256": sha, "Content-Length": str(size),
                            "Content-Type": "application/octet-stream"}) as r:
                        if r.status == 200:
                            return {"name": name, "sha256": sha, "bytes": size}
                err = f"HTTP {r.status}"
            except urllib.error.HTTPError as e:
                err = f"HTTP {e.code} {e.read()[:200].decode('utf-8', 'replace')}"
                if e.code in (401, 404, 409):
                    raise PipelineError("lease_lost", f"upload refused: {err}", False)
            except (urllib.error.URLError, OSError) as e:
                err = str(e)
            log(f"upload {name} attempt {attempt} failed: {err}")
            time.sleep(2 * attempt)
        raise PipelineError("artifact_transfer_failed", f"could not upload {name}: {err}", True)


def log(msg):
    print(time.strftime("%H:%M:%S ") + msg, flush=True)


def run_pipeline(cfg, cfg_path, job_dir, source, on_stage):
    """Start the pipeline as a child process and return (state, result). The exit code and
    result.json must agree; anything else is a failure."""
    cmd = [sys.executable, "-X", "utf8", "-m", "dana_pipeline.run", "--config", str(cfg_path),
           "--job-dir", str(job_dir), "--source", str(source)]
    proc = subprocess.Popen(cmd, cwd=str(HERE), stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    tail = []
    for raw in proc.stdout:
        line = raw.decode("utf-8", "replace").rstrip()
        tail = (tail + [line])[-40:]
        if line.startswith("[stage] "):
            on_stage(line[8:])
    code = proc.wait()
    (job_dir / "pipeline.log").write_text("\n".join(tail), encoding="utf-8")
    try:
        result = json.loads((job_dir / "result.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return FAILURE, {"status": FAILURE, "code": "pipeline_no_result", "retryable": True,
                         "message": f"pipeline exited {code} without a result", "detail": "\n".join(tail[-12:])}
    state = STATE_BY_EXIT.get(code)
    if state is None or state != result.get("status"):
        return FAILURE, {"status": FAILURE, "code": "pipeline_exit_mismatch", "retryable": False,
                         "message": f"exit code {code} does not match result status {result.get('status')}"}
    return state, result


STAGE_HE = {"transcribe_check": "האזנה שנייה לבדיקת התמלול", "assemble": "מחבר את החלקים שנבחרו", "measure_picture": "מודד מיקום פנים לכתוביות ולזומים",
            "source": "בודק את קובץ המקור", "transcribe_source": "מתמלל", "judgement": "בוחר קטע וכתוביות",
            "plan": "דנה מתכננת: מסר, קטע ותדריך עריכה", "review": "דנה בודקת את התוצר", "revise": "העורך מתקן לפי הערות דנה",
            "match_cards": "מתאים כתוביות לדיבור", "align": "מיישר כתוביות למילים באודיו הסופי", "render_base": "חותך ומנרמל אודיו", "render_cards": "מרנדר כרטיסי כתוביות",
            "composite": "מרכיב כתוביות", "verify": "בודק סנכרון מול האודיו הסופי", "checks": "מריץ בדיקות", "cover": "מכין קאבר"}


def handle(api, cfg, cfg_path, leased):
    job, lease = leased["job"], leased["leaseToken"]
    jid = job["id"]
    src = job.get("source") or {}
    if not SAFE_ID.match(jid) or src.get("ext") not in SAFE_EXT or not re.fullmatch(r"[0-9a-f]{64}", src.get("sha256", "")):
        api.call("POST", f"/api/dana/worker/jobs/{jid}/fail", {"status": "failure", "code": "job_invalid",
                 "message": "job fields failed validation on the worker", "retryable": False}, {"X-Lease-Token": lease})
        return
    root = Path(cfg["paths"]["work_root"])
    job_dir = root / "jobs" / f"{jid}_a{int(job.get('attempt', 1))}"
    if job_dir.exists():
        shutil.rmtree(job_dir)
    job_dir.mkdir(parents=True)
    options = dict(job.get("options") or {})
    decisions = options.pop("decisions", None)
    (job_dir / "job.json").write_text(json.dumps({"jobId": jid, "projectId": job.get("projectId"), "version": job.get("version"),
                                                  "source": src, "options": options}, ensure_ascii=False), encoding="utf-8")
    if decisions is not None:           # data for the validator, never code
        (job_dir / "decisions.json").write_text(json.dumps(decisions, ensure_ascii=False), encoding="utf-8")

    stop = threading.Event()

    def beat():
        while not stop.wait(20):
            api.call("POST", "/api/dana/worker/heartbeat", {"workerId": api.worker_id, "state": "busy", "jobId": jid,
                                                            "leaseToken": lease, "pipelineVersion": PIPELINE_VERSION})
    threading.Thread(target=beat, daemon=True).start()

    def stage(name):
        base = name.split("_")[0] if name.split("_")[0] in ("composite", "verify") else name
        api.call("POST", f"/api/dana/worker/jobs/{jid}/progress", {"stage": name, "note": STAGE_HE.get(base, name)},
                 {"X-Lease-Token": lease})

    try:
        stage_dir = root / "sources"
        stage_dir.mkdir(parents=True, exist_ok=True)
        source = stage_dir / f"{src['sha256']}.{src['ext']}"
        if not (source.is_file() and sha256_file(source) == src["sha256"]):
            api.call("POST", f"/api/dana/worker/jobs/{jid}/progress", {"stage": "download", "note": "מוריד את קובץ המקור"},
                     {"X-Lease-Token": lease})
            api.download(jid, lease, source, src["sha256"])
        state, result = run_pipeline(cfg, cfg_path, job_dir, source, stage)
        log(f"job {jid}: pipeline → {state} {result.get('code') or ''} {result.get('failed_checks') or ''}")
        if state in (SUCCESS, REVIEW_REQUIRED):
            api.call("POST", f"/api/dana/worker/jobs/{jid}/progress", {"stage": "upload", "note": "מעלה את החבילה"},
                     {"X-Lease-Token": lease})
            sent = []
            for name in UPLOAD_ORDER:
                p = job_dir / "out" / name
                if p.is_file():
                    sent.append(api.upload(jid, lease, name, p))
            code, body = api.call("POST", f"/api/dana/worker/jobs/{jid}/complete", {"status": state, "artifacts": sent},
                                  {"X-Lease-Token": lease})
            if code != 200:
                raise PipelineError("complete_rejected", f"server refused the package: {code} {body}", code >= 500)
        else:
            api.call("POST", f"/api/dana/worker/jobs/{jid}/fail", {
                "status": "waiting" if state == WAITING else "failure", "code": result.get("code"),
                "message": result.get("message"), "retryable": bool(result.get("retryable")),
                "detail": result.get("detail") if isinstance(result.get("detail"), str) else None}, {"X-Lease-Token": lease})
    except PipelineError as e:
        log(f"job {jid}: {e.code}: {e.message}")
        if e.code != "lease_lost":
            api.call("POST", f"/api/dana/worker/jobs/{jid}/fail", {"status": "failure", "code": e.code, "message": e.message,
                                                                    "retryable": bool(e.retryable)}, {"X-Lease-Token": lease})
    finally:
        stop.set()


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(HERE / "worker.config.json"))
    ap.add_argument("--once", action="store_true")
    a = ap.parse_args()
    try:
        cfg = load_config(a.config)
    except PipelineError as e:
        log(f"configuration invalid: {e.message}")
        return 1
    token = os.environ.get(cfg.get("token_env") or "DANA_WORKER_TOKEN", "")
    if len(token) < 24:
        log(f"missing worker token: set the {cfg.get('token_env') or 'DANA_WORKER_TOKEN'} environment variable")
        return 1
    if (Path(cfg["paths"]["work_root"]) / "STOP").exists():
        log("STOP file present — worker does not start (delete the file to allow it)")
        return 0
    api = Api(cfg["server_url"], token, cfg.get("worker_id") or "worker")
    code, body = api.call("POST", "/api/dana/worker/hello", {"workerId": api.worker_id, "pipelineVersion": PIPELINE_VERSION})
    if code != 200:
        log(f"server refused the worker: HTTP {code} {body}")
        return 1
    log(f"worker {api.worker_id} online, pipeline {PIPELINE_VERSION}, server {cfg['server_url']}")
    stop_file = Path(cfg["paths"]["work_root"]) / "STOP"
    while True:
        if stop_file.exists():                      # kill switch: finish nothing new, exit cleanly
            log(f"STOP file present ({stop_file}) — worker exits")
            return 0
        try:
            code, body = api.call("POST", "/api/dana/worker/lease", {"workerId": api.worker_id, "pipelineVersion": PIPELINE_VERSION})
            if code == 200 and body and body.get("job"):
                log(f"job {body['job']['id']} leased (attempt {body['job'].get('attempt')})")
                handle(api, cfg, a.config, body)
                continue
            if code not in (200, 204):
                log(f"lease: HTTP {code} {body}")
        except (urllib.error.URLError, OSError) as e:
            log(f"server unreachable: {e}")        # keep polling; the server shows the worker as offline
        if a.once:
            return 0
        time.sleep(float(cfg.get("poll_seconds", 5)))


if __name__ == "__main__":
    sys.exit(main())
