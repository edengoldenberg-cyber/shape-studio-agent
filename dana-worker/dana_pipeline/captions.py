# -*- coding: utf-8 -*-
"""Caption cards: match to the transcript, time them, render PNGs, composite.

PNG compositing only. The .webm caption layer is never produced or used.
The cards are drawn by the locally customized renderer of the ai-video-editor skill
(pinned by sha256 in the worker configuration); this module only calls it.
"""
import html
import importlib.util
import math
from pathlib import Path

from .core import PipelineError, run, tool
from .judgement import norm

STRETCHED = 0.60                 # a first word longer than this spans a pause (Whisper artefact)
ONSET_DB, ONSET_HOLD = -28.0, 0.06


def match_cards(cards, words, homophones=None):
    """Match each card's words to transcript words, in order, by text.
    Returns (spans, skipped). Raises when a card cannot be found — never guesses."""
    pos, spans, skipped = 0, [], []
    for n, c in enumerate(cards, 1):
        want = [norm(t, homophones) for t in c["text"].split()]
        want = [t for t in want if t]
        if not want:
            raise PipelineError("judgement_invalid", f"card {n} has no words")
        start = pos
        while pos < len(words) and norm(words[pos]["word"], homophones) != want[0]:
            pos += 1
        got = words[pos:pos + len(want)]
        if [norm(w["word"], homophones) for w in got] != want:
            heard = " ".join(w["word"] for w in words[start:start + 6])
            raise PipelineError("caption_text_mismatch",
                                f"card {n} '{c['text']}' is not in the audio at this point (heard: {heard})",
                                detail={"card": n, "text": c["text"], "heard": heard})
        skipped += words[start:pos]
        spans.append(got)
        pos += len(want)
    skipped += words[pos:]
    return spans, skipped


def envelope_onset(wav, t0, t1):
    """First time in [t0, t1] after which the level stays above ONSET_DB."""
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(str(wav))
    if x.ndim > 1:
        x = x.mean(axis=1)
    win, need, db = int(0.01 * sr), int(ONSET_HOLD / 0.01), []
    for i in range(int(t0 * sr), int(t1 * sr), win):
        seg = x[i:i + win]
        if len(seg) == 0:
            break
        db.append(20 * np.log10(np.sqrt((seg ** 2).mean()) + 1e-9))
    # The stamp of a stretched word starts in the tail of the previous word. Find the
    # pause first (level below the threshold), then the first sustained sound after it.
    quiet = next((k for k in range(len(db) - need) if all(v <= ONSET_DB for v in db[k:k + need])), None)
    if quiet is None:
        return None                       # no pause inside the stamp: keep the stamped start
    for k in range(quiet, len(db) - need):
        if all(v > ONSET_DB for v in db[k:k + need]):
            return round(t0 + k * 0.01, 3)
    return None


def time_cards(cards, spans, fps, hold_after, total_dur, wav=None):
    """Card times on the timeline. A card starts on the frame of its first word, ends
    no earlier than its last word (tail >= 0), never shares a frame with the next card,
    and does not stay up through a pause."""
    frame = 1.0 / fps
    fl = lambda t: round(math.floor(round(t / frame, 6)) * frame, 3)
    ce = lambda t: round(math.ceil(round(t / frame, 6)) * frame, 3)
    starts, notes = [], []
    for n, got in enumerate(spans, 1):
        first, s = got[0], got[0]["start"]
        if wav is not None and first["end"] - first["start"] > STRETCHED:
            on = envelope_onset(wav, max(first["start"], 0), first["end"])
            if on is not None:
                notes.append(f"card {n}: first word stamped {first['start']:.2f}-{first['end']:.2f}, "
                             f"audible onset {on:.2f} — card starts at the onset")
                s = on
        starts.append(max(s, 0.0))
    out, prev_end = [], 0.0
    for n, (c, got) in enumerate(zip(cards, spans)):
        last_end = got[-1]["end"]
        start = 0.0 if n == 0 and starts[n] < frame else fl(starts[n])
        start = max(start, prev_end)
        end = ce(last_end + 0.001)
        if n + 1 < len(cards):
            end = max(end, min(fl(starts[n + 1]), ce(last_end + hold_after)))
        else:
            end = min(ce(last_end + hold_after), fl(total_dur))
            end = max(end, min(ce(last_end + 0.001), fl(total_dur)))
        if end <= start:
            end = round(start + frame, 3)
        out.append({"i": n + 1, "start": start, "dur": round(end - start - 0.001, 3),
                    "plain": c["text"], "highlight": c.get("highlight") or [],
                    "first_word_audio_s": round(starts[n], 3), "last_word_end_audio_s": round(last_end, 3)})
        prev_end = end
    return out, notes


def card_html(text, highlight, style):
    """Plain text -> escaped HTML. Content can never become markup."""
    out = html.escape(text)
    for h in sorted(set(highlight or []), key=len, reverse=True):
        esc = html.escape(h)
        out = out.replace(esc, f'<span class="hl">{esc}</span>', 1)
    if style["backing"]:
        out = f'<span style="display:inline-block;{style["backing_css"]}">{out}</span>'
    return out


def _renderer(cfg):
    path = cfg["paths"]["caption_renderer"]
    spec = importlib.util.spec_from_file_location("dana_caption_layer", path)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except SystemExit as e:
        raise PipelineError("caption_renderer_load", f"caption renderer refused to load: {e}")
    for name in ("PAGE_HIGHLIGHT", "font_faces", "shoot"):
        if not hasattr(mod, name):
            raise PipelineError("caption_renderer_load", f"caption renderer has no {name} (not the customized version?)")
    return mod


def render_png(cfg, style, items, out_dir, size_key="caption_size", y_key="caption_y_px"):
    """items: [{'name': 'c001', 'text', 'highlight'}] -> out_dir/png/<name>.png"""
    mod = _renderer(cfg)
    faces = mod.font_faces(cfg["paths"]["font_dir"], style["font_family"])
    if not faces:
        raise PipelineError("font_missing", f"no font files in {cfg['paths']['font_dir']}")
    html_dir, png_dir = Path(out_dir) / "html", Path(out_dir) / "png"
    html_dir.mkdir(parents=True, exist_ok=True)
    png_dir.mkdir(parents=True, exist_ok=True)
    for it in items:
        page = mod.PAGE_HIGHLIGHT.format(
            W=style["width"], H=style["height"], faces=faces, top=style[y_key],
            dir=style["direction"], family=style["font_family"], ink=style["caption_ink"],
            size=style[size_key], shadow=style["caption_shadow"], highlight=style["caption_highlight"],
            text=card_html(it["text"], it.get("highlight"), style))
        hp, pp = html_dir / f"{it['name']}.html", png_dir / f"{it['name']}.png"
        hp.write_text(page, encoding="utf-8")
        if pp.exists():
            pp.unlink()
        try:
            mod.shoot(cfg["paths"]["chrome"], str(hp), str(pp), style["width"], style["height"])
        except SystemExit as e:
            raise PipelineError("caption_render", f"Chrome did not render {it['name']}: {str(e)[:300]}", True)
        if not pp.is_file() or pp.stat().st_size < 200:
            raise PipelineError("caption_render", f"empty card image {it['name']}", True)
    return png_dir


def composite(cfg, base, voice, cards, png_dir, out, dur):
    """One encode: base picture + PNG cards (enable windows from the card times) + voice."""
    r = cfg["render"]
    inputs, parts, prev = [], [], "0:v"
    for idx, c in enumerate(cards):
        png = Path(png_dir) / f"c{c['i']:03d}.png"
        if not png.is_file():
            raise PipelineError("caption_render", f"missing card image {png.name}")
        inputs += ["-i", png]
        t0, t1 = c["start"], round(c["start"] + c["dur"], 4)
        parts.append(f"[{prev}][{idx + 2}:v]overlay=format=auto:enable='between(t,{t0},{t1})'[v{idx + 1}]")
        prev = f"v{idx + 1}"
    script = Path(out).with_suffix(".filter.txt")
    script.write_text(";\n".join(parts), encoding="utf-8")
    cmd = [tool(cfg, "ffmpeg"), "-y", "-v", "error", "-i", base, "-i", voice, *inputs,
           "-/filter_complex", script, "-map", f"[{prev}]", "-map", "1:a:0", "-t", f"{dur}",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", str(r["crf"]), "-preset", r["preset"],
           "-maxrate", r["maxrate"], "-bufsize", "40M",
           "-c:a", "aac", "-b:a", r["audio_bitrate"], "-ar", "48000",
           "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
           "-movflags", "+faststart", out]
    run(cmd, "render_failed", timeout=cfg["timeouts"]["ffmpeg_s"])
    return out
