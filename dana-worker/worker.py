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
SAFE_JOBDIR = re.compile(r"^job_[a-z0-9]{6,40}_a\d{1,2}$")
AUDIO_EXT = {"mp3", "wav", "m4a", "aac", "ogg", "flac"}
UPLOAD_ORDER = ["package.json", "checks.json", "captions.json", "editorial.json", "transcript_source.json", "transcript_final.json",
                "cover.jpg", "compare_frames.jpg", "compare_clip.mp4", "readable_compare.mp4", "story_part_1.mp4", "story_part_2.mp4", "story_part_3.mp4", "story_part_4.mp4", "final.mp4"]
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

    def download(self, job_id, lease, dest, want_sha, what="source"):
        """Download to a temp file, verify the hash, then move into place. `what`: "source" (the project's first file) or
        "files/<sha>" (any other file of the project: a further source, the music, the narration)."""
        tmp = dest.with_suffix(dest.suffix + ".part")
        for attempt in range(1, TRANSFER_ATTEMPTS + 1):
            try:
                h = hashlib.sha256()
                with self._req("GET", f"/api/dana/worker/jobs/{job_id}/{what}", headers={"X-Lease-Token": lease}, timeout=120) as r, \
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


def run_pipeline(cfg, cfg_path, job_dir, source, on_stage, module="dana_pipeline.run"):
    """Start the pipeline as a child process and return (state, result). The exit code and
    result.json must agree; anything else is a failure."""
    cmd = [sys.executable, "-X", "utf8", "-m", module, "--config", str(cfg_path),
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


STAGE_HE = {"join": "מאחד את קובצי המקור לקובץ עבודה אחד", "measure_sources": "מודד תנועה, חדות ושוטים בכל המקורות", "mix": "מערבב קול, קריינות ומוזיקה", "beats": "מזהה פעימות במוזיקה", "readable": "בונה חלופה קריאה לכתוביות להשוואה",
            "choose_skill": "דנה בוחרת סקילים מתאימים מהספרייה", "animation": "מרנדר קטע אנימציה (HyperFrames)",
            "interpret": "דנה קוראת את הבקשה שלך", "graphics": "מרנדר מואושן גרפיק (HyperFrames)", "compare": "מכין לפני/אחרי",
            "transcribe_check": "האזנה שנייה לבדיקת התמלול", "assemble": "מחבר את החלקים שנבחרו", "measure_picture": "מודד מיקום פנים לכתוביות ולזומים",
            "source": "בודק את קובץ המקור", "transcribe_source": "מתמלל", "judgement": "בוחר קטע וכתוביות",
            "plan": "דנה מתכננת: מסר, קטע ותדריך עריכה", "review": "דנה בודקת את התוצר", "revise": "העורך מתקן לפי הערות דנה",
            "match_cards": "מתאים כתוביות לדיבור", "align": "מיישר כתוביות למילים באודיו הסופי", "render_base": "חותך ומנרמל אודיו", "render_cards": "מרנדר כרטיסי כתוביות",
            "composite": "מרכיב כתוביות", "verify": "בודק סנכרון מול האודיו הסופי", "checks": "מריץ בדיקות", "cover": "מכין קאבר"}


def keep_awake(on):
    """While a job is being edited, ask Windows not to put the machine to sleep for being idle (a render looks idle to it:
    no keyboard, no mouse). Nothing in the power settings is changed; the request ends with the job, and the screen may
    still turn off. Returns True when the request was accepted. On 2026-11-16 an idle sleep of 851 s in the middle of a
    job made the server release its lease, and the finished result of that attempt was refused."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
        return bool(ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if on else 0)))
    except Exception:                   # never a reason to fail a job
        return False


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
    # A "review" job looks at a finished video the owner uploaded and edits nothing; anything else is an edit.
    module = "dana_pipeline.review_only" if job.get("type") == "review" else "dana_pipeline.run"
    (job_dir / "job.json").write_text(json.dumps({"jobId": jid, "projectId": job.get("projectId"), "version": job.get("version"), "type": job.get("type") or "edit",
                                                  "source": src, "options": options}, ensure_ascii=False), encoding="utf-8")
    if decisions is not None:           # data for the validator, never code
        (job_dir / "decisions.json").write_text(json.dumps(decisions, ensure_ascii=False), encoding="utf-8")

    stop = threading.Event()

    def beat():
        last = time.time()
        while not stop.wait(20):
            gap, last = time.time() - last, time.time()
            if gap > 90:                # the heartbeat itself stopped: the machine slept (or was frozen) in the middle of the job
                log(f"job {jid}: no heartbeat for {gap:.0f}s — the machine slept or froze; the server may have released the lease")
            try:
                api.call("POST", "/api/dana/worker/heartbeat", {"workerId": api.worker_id, "state": "busy", "jobId": jid,
                                                                "leaseToken": lease, "pipelineVersion": PIPELINE_VERSION})
            except (urllib.error.URLError, OSError) as e:      # one missed beat must not end the heartbeat for the rest of the job
                log(f"job {jid}: heartbeat not delivered ({e}); trying again in 20s")
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
        # every other file the job names: further source videos, the uploaded music and narration. Checked like the source.
        local = {src["sha256"]: str(source)}
        au = options.get("audio") or {}
        more = [(s.get("sha256"), s.get("ext"), SAFE_EXT) for s in options.get("sources") or []] + \
               [((au.get(k) or {}).get("file") or {}).get("sha256") and (au[k]["file"]["sha256"], au[k]["file"].get("ext"), AUDIO_EXT) for k in ("music", "narration")]
        for item in more:
            if not item:
                continue
            sha, ext, allowed = item
            if sha in local:
                continue
            if ext not in allowed or not re.fullmatch(r"[0-9a-f]{64}", sha or ""):
                raise PipelineError("job_invalid", "a file named by the job failed validation on the worker", False)
            dest = stage_dir / f"{sha}.{ext}"
            if not (dest.is_file() and sha256_file(dest) == sha):
                api.call("POST", f"/api/dana/worker/jobs/{jid}/progress", {"stage": "download", "note": "מוריד קבצים נוספים של הפרויקט"}, {"X-Lease-Token": lease})
                api.download(jid, lease, dest, sha, f"files/{sha}")
            local[sha] = str(dest)
        (job_dir / "files.json").write_text(json.dumps(local), encoding="utf-8")
        state, result = run_pipeline(cfg, cfg_path, job_dir, source, stage, module)
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


def housekeeping(cfg):
    """Working copies only. A job's folder (cut pieces, frames, intermediate renders) is removed `keep_job_dirs_days` days
    after it was last touched; everything a job DELIVERED is on the server and is never touched from here. Sources and
    audio files cached for the worker are kept. Returns what was removed, for the log."""
    root, days = Path(cfg["paths"]["work_root"]) / "jobs", float(cfg.get("keep_job_dirs_days", 5))
    removed, freed = 0, 0
    if not root.is_dir() or days <= 0:
        return removed, freed
    limit = time.time() - days * 86400
    for d in root.iterdir():
        try:
            if d.is_dir() and SAFE_JOBDIR.match(d.name) and d.stat().st_mtime < limit:
                size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
                shutil.rmtree(d)
                removed, freed = removed + 1, freed + size
        except OSError:
            continue
    return removed, freed


def disk_state(cfg):
    """Free space where the worker works. Below `min_free_gb` no new job is taken (a render that runs out of disk loses the job)."""
    free = shutil.disk_usage(cfg["paths"]["work_root"]).free / 1e9
    need = float(cfg.get("min_free_gb", 8))
    return {"free_gb": round(free, 1), "min_free_gb": need, "ok": free >= need}


def capabilities(cfg):
    """What this machine can really do right now. Reported to the server at start and shown to the owner as is."""
    paths = cfg.get("paths") or {}
    hf = paths.get("hyperframes") or shutil.which("hyperframes.cmd") or shutil.which("hyperframes")
    return {"content_model": {"enabled": bool(cfg["judgement"]["claude"].get("enabled")) and cfg["judgement"]["adapter"] == "claude", "model": cfg["judgement"]["claude"].get("model")},
            "transcription": {"model": cfg["asr"]["model"], "device": cfg["asr"]["device"], "second_pass": bool(cfg["judgement"].get("second_pass"))},
            "face_detection": bool(paths.get("face_model") and Path(paths["face_model"]).is_file()),
            # prepared, not active: whether the connection is switched on and whether a key is PRESENT on this machine - never the key itself
            "narration_tts": __import__("dana_pipeline.tts", fromlist=["status"]).status(cfg),
            "beat_detection": __import__("importlib.util", fromlist=["find_spec"]).find_spec("librosa") is not None,
            "disk": disk_state(cfg), "keep_job_dirs_days": float(cfg.get("keep_job_dirs_days", 5)),
            "hyperframes": bool(hf), "caption_renderer": bool(paths.get("caption_renderer") and Path(paths["caption_renderer"]).is_file()),
            "max_review_rounds": cfg["editorial"]["max_cycles"], "max_cost_usd": cfg["editorial"]["max_total_cost_usd"], "max_seconds": cfg["editorial"]["max_total_s"]}


def handle_skill(api, cfg, cfg_path, leased):
    """Structure the owner's written instructions into a skill DRAFT (tool-free model call). The result is a draft on the server."""
    sk, h = leased["skill"], {"X-Lease-Token": leased["leaseToken"]}
    sid = str(sk.get("id") or "")
    if not SAFE_ID.match(sid):
        return
    d = Path(cfg["paths"]["work_root"]) / "skills" / sid
    if d.exists():
        shutil.rmtree(d)
    d.mkdir(parents=True)
    (d / "request.json").write_text(json.dumps(sk, ensure_ascii=False), encoding="utf-8")
    try:
        proc = subprocess.run([sys.executable, "-X", "utf8", "-m", "dana_pipeline.skillgen", "--config", str(cfg_path), "--dir", str(d)], cwd=str(HERE), capture_output=True, timeout=900)
        if proc.returncode == 0 and (d / "draft.json").is_file():
            out = json.loads((d / "draft.json").read_text(encoding="utf-8"))
            code, _ = api.call("POST", f"/api/dana/worker/skills/{sid}/draft", {"status": "drafted", "draft": out["draft"], "usage": out.get("usage")}, h)
            log(f"skill {sid}: drafted → HTTP {code}")
            return
        err = json.loads((d / "error.json").read_text(encoding="utf-8")) if (d / "error.json").is_file() else {"code": "skill_draft_failed", "message": f"exited {proc.returncode}"}
    except (subprocess.TimeoutExpired, OSError, ValueError) as e:
        err = {"code": "skill_draft_failed", "message": str(e)[:300]}
    log(f"skill {sid}: {err['code']}: {err['message']}")
    api.call("POST", f"/api/dana/worker/skills/{sid}/draft", {"status": "failed", "error": err}, h)


def handle_reference(api, cfg, cfg_path, leased):
    """Analyse one reference video the owner added (style only). The result is a PROPOSAL stored on the server."""
    ref, lease = leased["reference"], leased["leaseToken"]
    rid = str(ref.get("id") or "")
    h = {"X-Lease-Token": lease}
    if not SAFE_ID.match(rid) or ref.get("ext") not in SAFE_EXT or not re.fullmatch(r"[0-9a-f]{64}", ref.get("sha256", "")):
        api.call("POST", f"/api/dana/worker/references/{rid}/analysis", {"status": "failed", "error": {"code": "reference_invalid", "message": "reference fields failed validation on the worker"}}, h)
        return
    root = Path(cfg["paths"]["work_root"])
    ref_dir = root / "references" / rid
    if ref_dir.exists():
        shutil.rmtree(ref_dir)
    ref_dir.mkdir(parents=True)
    (ref_dir / "reference.json").write_text(json.dumps({k: ref.get(k) for k in ("id", "title", "owner_note", "content_type", "fits_message", "usage_permission", "origin")},
                                                       ensure_ascii=False), encoding="utf-8")
    src = ref_dir / f"source.{ref['ext']}"
    try:
        digest = hashlib.sha256()
        with api._req("GET", f"/api/dana/worker/references/{rid}/file", headers=h, timeout=120) as r, open(src, "wb") as f:
            for chunk in iter(lambda: r.read(1 << 20), b""):
                f.write(chunk)
                digest.update(chunk)
        if digest.hexdigest() != ref["sha256"]:
            raise PipelineError("reference_transfer_failed", "the downloaded reference does not match its hash", True)
        proc = subprocess.run([sys.executable, "-X", "utf8", "-m", "dana_pipeline.reference", "--config", str(cfg_path), "--ref-dir", str(ref_dir),
                               "--source", str(src)], cwd=str(HERE), capture_output=True, timeout=1800)
        out = ref_dir / "analysis.json"
        if proc.returncode == 0 and out.is_file():
            code, body = api.call("POST", f"/api/dana/worker/references/{rid}/analysis",
                                  {"status": "analysed", "analysis": json.loads(out.read_text(encoding="utf-8"))}, h)
            log(f"reference {rid}: analysed → HTTP {code}")
            return
        err = json.loads((ref_dir / "error.json").read_text(encoding="utf-8")) if (ref_dir / "error.json").is_file() else \
            {"code": "reference_analysis_failed", "message": f"analysis exited {proc.returncode}"}
        raise PipelineError(err["code"], err["message"])
    except (PipelineError, urllib.error.URLError, OSError, subprocess.TimeoutExpired) as e:
        code_, msg = (e.code, e.message) if isinstance(e, PipelineError) else ("reference_analysis_failed", str(e)[:300])
        log(f"reference {rid}: {code_}: {msg}")
        api.call("POST", f"/api/dana/worker/references/{rid}/analysis", {"status": "failed", "error": {"code": code_, "message": msg}}, h)
    finally:
        src.unlink(missing_ok=True)                 # the reference file itself is not kept on the editing machine


def hello(api, cfg, once=False, wait_s=30, sleep=time.sleep):
    """Announce the worker. After a power loss the machine can be up before the network or the server is: an unreachable
    server is waited for (the STOP file still ends the wait), it does not end the worker. A server that ANSWERS and refuses
    (wrong token, wrong version) is returned as is and does end it. Returns (code, body), or (None, "stopped" | "unreachable")."""
    stop_file, tries = Path(cfg["paths"]["work_root"]) / "STOP", 0
    while True:
        try:
            return api.call("POST", "/api/dana/worker/hello", {"workerId": api.worker_id, "pipelineVersion": PIPELINE_VERSION, "capabilities": capabilities(cfg)})
        except (urllib.error.URLError, OSError) as e:
            tries += 1
            if tries == 1 or tries % 10 == 0:
                log(f"server unreachable at start ({e}); trying again every {wait_s}s")
            if once:
                return None, "unreachable"
            if stop_file.exists():
                log(f"STOP file present ({stop_file}) — worker exits")
                return None, "stopped"
            sleep(wait_s)


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
    code, body = hello(api, cfg, a.once)
    if code is None:
        return 0 if body == "stopped" else 1
    if code != 200:
        log(f"server refused the worker: HTTP {code} {body}")
        return 1
    log(f"worker {api.worker_id} online, pipeline {PIPELINE_VERSION}, server {cfg['server_url']}")
    stop_file = Path(cfg["paths"]["work_root"]) / "STOP"
    last_housekeeping = 0.0
    while True:
        if stop_file.exists():                      # kill switch: finish nothing new, exit cleanly
            log(f"STOP file present ({stop_file}) — worker exits")
            return 0
        if time.time() - last_housekeeping > 3600:
            last_housekeeping = time.time()
            n_removed, freed = housekeeping(cfg)
            if n_removed:
                log(f"housekeeping: removed {n_removed} job work folders older than {cfg.get('keep_job_dirs_days', 5)} days ({freed / 1e9:.1f} GB); delivered files are on the server and untouched")
        disk = disk_state(cfg)
        if not disk["ok"]:                         # no job is taken while there is no room to finish it; the panel shows why
            log(f"low disk: {disk['free_gb']} GB free, {disk['min_free_gb']} GB needed — not taking jobs")
            try:
                api.call("POST", "/api/dana/worker/heartbeat", {"workerId": api.worker_id, "state": "low_disk", "pipelineVersion": PIPELINE_VERSION, "disk": disk})
            except (urllib.error.URLError, OSError):
                pass
            if a.once:
                return 0
            time.sleep(60)
            continue
        try:
            code, body = api.call("POST", "/api/dana/worker/lease", {"workerId": api.worker_id, "pipelineVersion": PIPELINE_VERSION})
            if code == 200 and body and body.get("job"):
                log(f"job {body['job']['id']} leased (attempt {body['job'].get('attempt')})")
                keep_awake(True)
                try:
                    handle(api, cfg, a.config, body)
                finally:
                    keep_awake(False)
                continue
            if code not in (200, 204):
                log(f"lease: HTTP {code} {body}")
            # no edit is waiting: is there a reference the owner added for analysis? (404 = an older server; ignored)
            rcode, rbody = api.call("POST", "/api/dana/worker/references/lease", {"workerId": api.worker_id})
            if rcode == 200 and rbody and rbody.get("reference"):
                log(f"reference {rbody['reference'].get('id')} leased for analysis")
                handle_reference(api, cfg, a.config, rbody)
                continue
            # … or written instructions waiting to be structured into a skill draft? (404 = an older server; ignored)
            scode, sbody = api.call("POST", "/api/dana/worker/skills/lease", {"workerId": api.worker_id})
            if scode == 200 and sbody and sbody.get("skill"):
                log(f"skill {sbody['skill'].get('id')} leased for drafting")
                handle_skill(api, cfg, a.config, sbody)
                continue
        except (urllib.error.URLError, OSError) as e:
            log(f"server unreachable: {e}")        # keep polling; the server shows the worker as offline
        if a.once:
            return 0
        time.sleep(float(cfg.get("poll_seconds", 5)))


if __name__ == "__main__":
    sys.exit(main())
