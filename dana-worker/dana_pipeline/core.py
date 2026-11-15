# -*- coding: utf-8 -*-
"""Shared pieces: explicit states, exit codes, errors, config validation, media helpers."""
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# ── Explicit terminal states ────────────────────────────────────────────────
SUCCESS, FAILURE, REVIEW_REQUIRED, WAITING = "success", "failure", "review_required", "waiting"
EXIT = {SUCCESS: 0, FAILURE: 1, REVIEW_REQUIRED: 2, WAITING: 3}
STATE_BY_EXIT = {v: k for k, v in EXIT.items()}


class PipelineError(Exception):
    """A failure with a machine-readable code. `retryable` tells the worker whether
    running the same job again can help (tool crash) or not (bad input)."""

    def __init__(self, code, message, retryable=False, detail=None):
        super().__init__(message)
        self.code, self.message, self.retryable, self.detail = code, message, retryable, detail


class Waiting(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


# ── Configuration: ONE validated file, no path literals elsewhere ───────────
DEFAULT_STYLE = {
    "fps": 25, "width": 1080, "height": 1920,
    "font_family": "Heebo", "caption_size": 76, "caption_y_px": 1250,
    "caption_ink": "#F5F5F5", "caption_highlight": "#FFFF00",
    "caption_shadow": "2px 3px 10px rgba(0,0,0,0.95), 0 0 20px rgba(0,0,0,0.75)",
    "backing": True, "backing_css": "background:rgba(0,0,0,0.42);padding:8px 26px 14px;border-radius:18px;",
    "highlight_enabled": True,      # yellow is AVAILABLE; a card is highlighted only when the decisions name words
    "caption_max_lines": 1,          # a card may be laid out on this many lines before it is split
    "captions_enabled": True,        # False when the source already carries burned-in captions
    "direction": "rtl",
    "cover_size": 112, "cover_y_px": 960,
}
# Keys a job (per-project override) may change. Anything else in a job is ignored.
STYLE_OVERRIDABLE = {"caption_size", "caption_y_px", "caption_max_lines", "backing", "highlight_enabled", "cover_size", "cover_y_px"}
DEFAULTS = {
    "style": DEFAULT_STYLE,
    "asr": {"model": "large-v3", "device": "cuda", "compute_type": "float16", "language": "he"},
    "audio": {"target_lufs": -14.0, "target_peak_db": -1.5, "lufs_tolerance": 0.5},
    "render": {"crf": 15, "preset": "medium", "maxrate": "20M", "audio_bitrate": "256k"},
    "sync": {"drift_warn_s": 0.080, "drift_fail_s": 0.120, "prob_threshold": 0.80,
             "min_word_dur_s": 0.050, "rms_floor_db": -38.0, "max_fix_attempts": 2},
    "segment": {"min_s": 5.0, "max_s": 90.0},
    "cards": {"max_words": 3, "max_chars": 16, "gap_break_s": 0.35, "hold_after_s": 0.40, "merge_max_chars": 24,
              "min_on_screen_s": 0.50, "max_chars_per_s": 17.0},
    # adapter: what this worker uses. job_adapters_allowed: which adapters a JOB may ask for instead (the server
    # used to send "heuristic" with every upload; a production worker lists only "scripted" here).
    # on_model_failure: "fail" (clear failure, default) or "fallback_marked" (heuristic edit, marked as having NO content judgement).
    "judgement": {"adapter": "heuristic", "job_adapters_allowed": ["heuristic", "scripted", "claude"],
                  "on_model_failure": "fail", "second_pass": True,
                  "claude": {"enabled": False, "model": "claude-sonnet-5-5", "timeout_s": 300, "max_budget_usd": 1.0,
                             "min_s": 12, "max_s": 45}},
    # Words that sound the same in spoken Hebrew. A caption may show either spelling; the choice is a text review item.
    "language": {"homophone_groups": [["אם", "עם"], ["אל", "על"], ["את", "עת"], ["לא", "לו"], ["כל", "קול"]]},
    "alignment": {"vad_min_silence_ms": 100, "agree_ms": 80, "lead_fail_ms": 120},
    # Dana's plan → edit → review loop: at most this many automatic revisions, inside a total budget.
    "editorial": {"max_cycles": 3, "max_total_cost_usd": 2.0, "max_total_s": 1500},
    "timeouts": {"ffmpeg_s": 1800, "chrome_s": 60},
}
REQUIRED_PATHS = ["work_root", "chrome", "caption_renderer", "font_dir", "safe_zone"]


def deep_merge(base, over):
    out = dict(base)
    for k, v in (over or {}).items():
        out[k] = deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def load_config(path):
    """Load and validate the worker configuration. Raises PipelineError(config_invalid)."""
    p = Path(path)
    if not p.is_file():
        raise PipelineError("config_invalid", f"configuration file not found: {p}")
    try:
        user = json.loads(p.read_text(encoding="utf-8"))
    except ValueError as e:
        raise PipelineError("config_invalid", f"configuration is not valid JSON: {e}")
    cfg = deep_merge(DEFAULTS, user)
    problems = []
    paths = cfg.get("paths") or {}
    for key in REQUIRED_PATHS:
        if not paths.get(key):
            problems.append(f"paths.{key} is missing")
    for key in ("chrome", "caption_renderer", "safe_zone"):
        if paths.get(key) and not Path(paths[key]).is_file():
            problems.append(f"paths.{key} does not exist: {paths[key]}")
    if paths.get("font_dir") and not Path(paths["font_dir"]).is_dir():
        problems.append(f"paths.font_dir does not exist: {paths['font_dir']}")
    for d in paths.get("cuda_dll_dirs") or []:
        if not Path(d).is_dir():
            problems.append(f"paths.cuda_dll_dirs entry does not exist: {d}")
    for tool in ("ffmpeg", "ffprobe"):
        exe = paths.get(tool) or tool
        if not (Path(exe).is_file() or shutil.which(exe)):
            problems.append(f"{tool} not found ({exe})")
    want = (cfg.get("caption_renderer_sha256") or "").lower()
    if paths.get("caption_renderer") and Path(paths["caption_renderer"]).is_file():
        got = sha256_file(paths["caption_renderer"])
        if not want:
            problems.append("caption_renderer_sha256 is missing (pin the customized renderer)")
        elif got != want:
            problems.append(f"caption renderer changed: sha256 {got[:12]}… is not the pinned {want[:12]}… "
                            "(restore the backup in dana-worker/vendor or re-pin deliberately)")
    if cfg["judgement"]["adapter"] not in ("heuristic", "scripted", "claude"):
        problems.append("judgement.adapter must be heuristic | scripted | claude")
    cl = cfg["judgement"]["claude"]
    if cl.get("enabled"):
        exe = paths.get("claude_exe")
        if not exe or not Path(exe).is_file():
            problems.append("judgement.claude.enabled needs paths.claude_exe (the Claude CLI executable)")
        if not str(cl.get("model") or "").startswith("claude-"):
            problems.append("judgement.claude.model must be an explicit model id (claude-…), not an alias")
        if not (0 < float(cl.get("max_budget_usd") or 0) <= 5):
            problems.append("judgement.claude.max_budget_usd must be between 0 and 5")
        if not (30 <= int(cl.get("timeout_s") or 0) <= 900):
            problems.append("judgement.claude.timeout_s must be between 30 and 900")
    if problems:
        raise PipelineError("config_invalid", "; ".join(problems))
    Path(paths["work_root"]).mkdir(parents=True, exist_ok=True)
    cfg["_source"] = str(p.resolve())
    return cfg


def tool(cfg, name):
    return (cfg.get("paths") or {}).get(name) or name


def inside(root, candidate):
    """True when `candidate` resolves inside `root` (path validation for job-supplied names)."""
    root, cand = Path(root).resolve(), Path(candidate).resolve()
    return root == cand or root in cand.parents


# ── Media helpers ───────────────────────────────────────────────────────────
def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run(cmd, code, timeout=1800, retryable=True, cwd=None):
    """Run a child process. A non-zero exit ALWAYS raises — exit codes are never dropped."""
    try:
        r = subprocess.run([str(c) for c in cmd], capture_output=True, timeout=timeout, cwd=cwd)
    except subprocess.TimeoutExpired:
        raise PipelineError(code + "_timeout", f"{Path(str(cmd[0])).name} timed out after {timeout}s", retryable)
    except OSError as e:
        raise PipelineError(code + "_spawn", f"cannot start {cmd[0]}: {e}", False)
    if r.returncode != 0:
        err = (r.stderr or b"").decode("utf-8", errors="replace")[-1500:]
        raise PipelineError(code, f"{Path(str(cmd[0])).name} exited {r.returncode}", retryable, detail=err)
    return r


def probe(cfg, path):
    r = run([tool(cfg, "ffprobe"), "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
            "source_unreadable", timeout=120, retryable=False)
    try:
        data = json.loads(r.stdout.decode("utf-8", errors="replace"))
    except ValueError:
        raise PipelineError("source_unreadable", "ffprobe returned no JSON")
    v = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not v:
        raise PipelineError("source_unreadable", "the file has no video stream")
    rot = 0
    for sd in v.get("side_data_list") or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    if not rot and (v.get("tags") or {}).get("rotate"):
        rot = int(v["tags"]["rotate"])
    w, h = int(v["width"]), int(v["height"])
    if abs(rot) in (90, 270):
        w, h = h, w
    num, den = (v.get("r_frame_rate") or "0/1").split("/")
    return {
        "duration": float((data.get("format") or {}).get("duration") or v.get("duration") or 0),
        "display_width": w, "display_height": h, "rotation": rot,
        "codec": v.get("codec_name"), "pix_fmt": v.get("pix_fmt"),
        "full_range": v.get("color_range") == "pc" or str(v.get("pix_fmt", "")).startswith("yuvj"),
        "fps": (float(num) / float(den)) if float(den) else 0.0,
        "has_audio": a is not None, "audio_codec": a.get("codec_name") if a else None,
        "size": int((data.get("format") or {}).get("size") or 0),
        "bit_rate": int((data.get("format") or {}).get("bit_rate") or 0),
    }


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def utf8_stdout():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
