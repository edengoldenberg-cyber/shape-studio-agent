"""Several source files in one project.

The files are brought to ONE working file ("the joined source"): each is conformed to the picture size and frame rate of
the first one and they are put one after the other. Everything the pipeline already does - transcription, planning,
cutting, captions, checks - then works on that one file unchanged. A MAP is kept, so that every moment of the result can
be traced back to its file and to the time inside that file, and so the owner's marks (per file) can be applied.

The uploaded files themselves are never changed.
"""
from pathlib import Path

from .core import PipelineError, probe, run, tool


def join(cfg, style, work, sources):
    """sources: [{"id", "path", "name", "marks"}] in order. -> (joined path, source_map). One source -> (its own path, map)."""
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    probes = []
    for s in sources:
        try:
            probes.append(probe(cfg, s["path"]))
        except PipelineError as e:
            raise PipelineError("source_unreadable", f"הקובץ \"{s['name']}\" אינו וידאו שניתן לקרוא — יש להסיר או להחליף אותו", False, e.detail)
    if len(sources) == 1:
        return Path(sources[0]["path"]), [{"id": sources[0]["id"], "name": sources[0]["name"], "v_in": 0.0, "v_out": round(probes[0]["duration"], 3),
                                           "duration": round(probes[0]["duration"], 3), "marks": sources[0].get("marks") or []}]
    W, H, fps = probes[0]["display_width"], probes[0]["display_height"], style["fps"]
    W, H = W - W % 2, H - H % 2
    ff, parts, smap, t = tool(cfg, "ffmpeg"), [], [], 0.0
    for s, sp in zip(sources, probes):
        out = work / f"conformed_{s['id']}.mp4"
        vf = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={fps},setsar=1,format=yuv420p"
        cmd = [ff, "-y", "-v", "error", "-i", s["path"]]
        if not sp["has_audio"]:                  # a silent clip gets a silent track, so every part has the same streams
            cmd += ["-f", "lavfi", "-t", f"{sp['duration']:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
        cmd += ["-map", "0:v:0", "-map", "0:a:0" if sp["has_audio"] else "1:a:0", "-vf", vf, "-af", "aresample=48000,aformat=channel_layouts=stereo",
                "-c:v", "libx264", "-crf", "14", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", "-shortest", out]
        run(cmd, "source_conform_failed", timeout=cfg["timeouts"]["ffmpeg_s"])
        d = probe(cfg, out)["duration"]
        parts.append(out)
        smap.append({"id": s["id"], "name": s["name"], "v_in": round(t, 3), "v_out": round(t + d, 3), "duration": round(d, 3), "marks": s.get("marks") or [],
                     "had_audio": bool(sp["has_audio"]), "conformed_from": f"{sp['display_width']}x{sp['display_height']}"})
        t += d
    lst = work / "join.txt"
    lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
    joined = work / "joined_source.mp4"
    run([ff, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", joined], "source_join_failed", timeout=cfg["timeouts"]["ffmpeg_s"])
    return joined, smap


def locate(smap, t):
    """A time of the joined source -> {"id", "name", "t"} in its own file."""
    for m in smap:
        if m["v_in"] - 1e-6 <= t <= m["v_out"] + 1e-6:
            return {"id": m["id"], "name": m["name"], "t": round(max(0.0, t - m["v_in"]), 3)}
    m = smap[-1]
    return {"id": m["id"], "name": m["name"], "t": round(max(0.0, t - m["v_in"]), 3)}


def to_joined(smap, source_id, t):
    m = next((x for x in smap if x["id"] == source_id), None)
    return None if m is None else round(m["v_in"] + min(max(float(t), 0.0), m["duration"]), 3)


def ranges(smap):
    """The owner's marks on the joined timeline -> (never, must, boundaries). A part may never cross a boundary between files."""
    never, must = [], []
    for m in smap:
        for k in m.get("marks") or []:
            a, b = m["v_in"] + min(k["from_s"], m["duration"]), m["v_in"] + min(k["to_s"], m["duration"])
            if b - a >= 0.3:
                (never if k["kind"] == "never" else must).append({"from_s": round(a, 3), "to_s": round(b, 3), "source": m["id"], "name": m["name"], "note": k.get("note")})
    return never, must, [m["v_out"] for m in smap[:-1]]


def describe(smap, segments):
    """Every part of the plan with its file and the time inside that file (the edit map). Adds the fields in place."""
    for s in segments:
        a, b = locate(smap, s["source_in_s"] + 0.01), locate(smap, s["source_out_s"] - 0.01)      # WHICH file: looked up just inside the part
        m = next(x for x in smap if x["id"] == a["id"])
        # the times inside the file are exact, so a part that is kept in a later version is the SAME part, to the millisecond
        s.update(source_id=a["id"], source_name=a["name"], file_in_s=round(s["source_in_s"] - m["v_in"], 3), file_out_s=round(s["source_out_s"] - m["v_in"], 3), crosses_files=a["id"] != b["id"])
    return segments


def check_marks(smap, segments):
    """Measured on the plan: nothing marked "never" is used; everything marked "must" is in. -> (record status, text, missing)."""
    never, must, _ = ranges(smap)
    used = [(s["source_in_s"], s["source_out_s"]) for s in segments]
    hit = [n for n in never if any(a < n["to_s"] - 0.05 and b > n["from_s"] + 0.05 for a, b in used)]
    missing = [m for m in must if not any(a <= m["from_s"] + 0.3 and b >= m["to_s"] - 0.3 for a, b in used)
               and sum(max(0.0, min(b, m["to_s"]) - max(a, m["from_s"])) for a, b in used) < 0.8 * (m["to_s"] - m["from_s"])]
    return hit, missing
