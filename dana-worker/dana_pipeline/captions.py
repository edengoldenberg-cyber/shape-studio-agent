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
import difflib

from .judgement import canon, strip


def match_cards(cards, words, groups=None):
    """Match each card's words to transcript words, in order, by text. Words of one
    homophone group match each other (spelling is a separate, textual review item).
    Returns (spans, skipped). Raises when a card cannot be found — never guesses."""
    pos, spans, skipped = 0, [], []
    for n, c in enumerate(cards, 1):
        want = [t for t in (canon(t, groups) for t in c["text"].split()) if t]
        if not want:
            raise PipelineError("judgement_invalid", f"card {n} has no words")
        start = pos
        while pos < len(words) and canon(words[pos]["word"], groups) != want[0]:
            pos += 1
        got = words[pos:pos + len(want)]
        if [canon(w["word"], groups) for w in got] != want:
            heard = " ".join(w["word"] for w in words[start:start + 6])
            raise PipelineError("caption_text_mismatch",
                                f"card {n} '{c['text']}' is not in the audio at this point (heard: {heard})",
                                detail={"card": n, "text": c["text"], "heard": heard})
        skipped.append({"before_card": n, "words": words[start:pos]}) if pos > start else None
        spans.append(got)
        pos += len(want)
    if pos < len(words):
        skipped.append({"before_card": None, "words": words[pos:]})
    return spans, skipped


def align_cards(cards, heard, groups=None):
    """Map every card to the words heard in the FINAL audio.

    The cards were already proven to be the exact words of the source transcript
    (match_cards). A second transcription of the cut audio can write the same speech
    differently ("איך שהוא" / "איכשהו"), so this mapping is a sequence alignment, not an
    equality test. Every difference is returned in `diffs` and becomes a TEXT review item;
    it is never hidden and never treated as a timing matter.
    Returns (spans, diffs). Raises when the audio clearly says something else."""
    toks = [(n, t) for n, c in enumerate(cards) for t in c["text"].split() if canon(t, groups)]
    a, b = [canon(t, groups) for _, t in toks], [canon(w["word"], groups) for w in heard]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    if sm.ratio() < 0.75:
        raise PipelineError("caption_text_mismatch", f"the final audio does not match the captions (similarity {sm.ratio():.2f})")
    idx, diffs = {n: [] for n in range(len(cards))}, []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                n, shown = toks[i1 + k]
                idx[n].append(j1 + k)
                if strip(shown) != strip(heard[j1 + k]["word"]):
                    diffs.append({"card": n + 1, "shown": strip(shown), "heard": strip(heard[j1 + k]["word"]), "kind": "homophone",
                                  "t0": heard[j1 + k]["start"], "t1": heard[j1 + k]["end"]})
        elif tag == "replace":
            for k in range(i1, i2):
                idx[toks[k][0]].append(j1 + min(j2 - j1 - 1, (k - i1) * (j2 - j1) // (i2 - i1)))
            diffs.append({"card": toks[i1][0] + 1, "shown": " ".join(strip(t) for _, t in toks[i1:i2]),
                          "heard": " ".join(strip(w["word"]) for w in heard[j1:j2]), "kind": "asr_variance",
                          "t0": heard[j1]["start"], "t1": heard[j2 - 1]["end"]})
        elif tag == "delete":
            diffs.append({"card": toks[i1][0] + 1, "shown": " ".join(strip(t) for _, t in toks[i1:i2]), "heard": "",
                          "kind": "not_heard", "t0": None, "t1": None})
        else:
            n = toks[min(i1, len(toks) - 1)][0]
            diffs.append({"card": n + 1, "shown": "", "heard": " ".join(strip(w["word"]) for w in heard[j1:j2]),
                          "kind": "extra_heard", "t0": heard[j1]["start"], "t1": heard[j2 - 1]["end"]})
    spans = []
    for n in range(len(cards)):
        if idx[n]:
            spans.append(heard[min(idx[n]):max(idx[n]) + 1])
        else:                                   # nothing heard for this card: place it between its neighbours
            before = max((max(v) for m, v in idx.items() if m < n and v), default=None)
            after = min((min(v) for m, v in idx.items() if m > n and v), default=None)
            t0 = heard[before]["end"] if before is not None else 0.0
            t1 = heard[after]["start"] if after is not None else t0 + 0.5
            spans.append([{"word": "", "start": t0, "end": max(t1, t0 + 0.2), "probability": 0.0, "synthetic": True}])
    return spans, diffs


def time_cards(cards, spans, fps, hold_after, total_dur, align=None):
    """Card times on the timeline. A card starts on the frame of its first word's reference
    onset (align.Alignment; the Whisper start when no alignment is given), ends no earlier
    than its last word (tail >= 0), never shares a frame with the next card, and does not
    stay up through a pause."""
    frame = 1.0 / fps
    fl = lambda t: round(math.floor(round(t / frame, 6)) * frame, 3)
    ce = lambda t: round(math.ceil(round(t / frame, 6)) * frame, 3)
    refs = []
    for got in spans:
        refs.append(align.onset(got[0]) if align is not None else
                    {"t": got[0]["start"], "uncertainty_s": 0.05, "method": "whisper", "evidence": {}})
    starts = [max(r["t"], 0.0) for r in refs]
    out, prev_end = [], 0.0
    for n, (c, got) in enumerate(zip(cards, spans)):
        last_end = got[-1]["end"]
        start = 0.0 if n == 0 and starts[n] < frame else fl(starts[n])
        start = max(start, prev_end)
        end = ce(last_end + 0.002)
        if n + 1 < len(cards):
            end = max(end, min(fl(starts[n + 1]), ce(last_end + hold_after)))
        else:
            end = max(min(ce(last_end + hold_after), fl(total_dur)), min(ce(last_end + 0.002), fl(total_dur)))
        if end <= start:
            end = round(start + frame, 3)
        out.append({"i": n + 1, "start": start, "dur": round(end - start - 0.001, 3),
                    "plain": c["text"], "highlight": c.get("highlight") or [],
                    "first_word_audio_s": round(starts[n], 3), "last_word_end_audio_s": round(last_end, 3),
                    "onset": refs[n]})
        prev_end = end
    return out


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
    script.unlink(missing_ok=True)
    return out
