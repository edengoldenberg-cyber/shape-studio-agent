# -*- coding: utf-8 -*-
"""Transcribe ONE voice message (a member's WhatsApp recording) on the editing machine.

    python -X utf8 -m dana_pipeline.voice --config worker.config.json --audio <file> --out <result.json>

Started by worker.py as a child process with a timeout, so a driver crash or a hang cannot take the worker down.
Whisper large-v3 on the GPU (the only model allowed), language from the worker configuration (Hebrew).

Privacy: this module prints nothing about the content. The transcript is written only to --out, which the worker
reads, sends to the server and deletes together with the audio. Exit code 0 = result.json holds a transcript;
1 = result.json holds {"error": {"code", "message"}}.
"""
import argparse
import json
import os
import sys
from pathlib import Path

from .core import PipelineError, load_config, utf8_stdout


def transcribe_voice(cfg, path):
    a = cfg["asr"]
    for d in (cfg.get("paths") or {}).get("cuda_dll_dirs") or []:          # cublas / cudnn must be on PATH before the import
        if d not in os.environ["PATH"]:
            os.environ["PATH"] = d + os.pathsep + os.environ["PATH"]
    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(a["model"], device=a["device"], compute_type=a["compute_type"])
        segs, info = model.transcribe(str(path), language=a["language"], beam_size=5, vad_filter=True,
                                      vad_parameters={"min_silence_duration_ms": 500}, condition_on_previous_text=False)
        segs = list(segs)
    except Exception as e:                                                  # missing DLL, out of memory, unreadable audio
        raise PipelineError("voice_asr_failed", f"transcription failed: {type(e).__name__}: {str(e)[:200]}", True)
    text = " ".join(s.text.strip() for s in segs if s.text and s.text.strip()).strip()
    if not text:
        raise PipelineError("voice_no_speech", "no speech was recognised in the recording", False)
    dur = sum(max(0.0, s.end - s.start) for s in segs) or 1.0
    w = lambda attr: round(sum(getattr(s, attr) * max(0.0, s.end - s.start) for s in segs) / dur, 4)
    return {"text": text, "language": info.language, "duration_s": round(float(info.duration), 2), "model": a["model"],
            "avg_logprob": w("avg_logprob"), "no_speech_prob": w("no_speech_prob")}


def main():
    utf8_stdout()
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = Path(a.out)
    try:
        cfg = load_config(a.config)
        if not Path(a.audio).is_file():
            raise PipelineError("voice_audio_missing", "the audio file is not there", False)
        out.write_text(json.dumps(transcribe_voice(cfg, a.audio), ensure_ascii=False), encoding="utf-8")
        return 0
    except PipelineError as e:
        out.write_text(json.dumps({"error": {"code": e.code, "message": e.message}}, ensure_ascii=False), encoding="utf-8")
        return 1


if __name__ == "__main__":
    sys.exit(main())
