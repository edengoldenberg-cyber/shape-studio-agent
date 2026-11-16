# -*- coding: utf-8 -*-
"""Motion graphics rendered with HyperFrames: an opening title and a key-phrase emphasis.

A graphic is added only when the content plan gives it a role, and its text is always an EXACT
quotation of words spoken in the chosen parts (validated here, like the cover text). Nothing is
added at intervals, for decoration, or with words nobody said.

How it is made: for each graphic this module writes a small HyperFrames project (HTML + a paused
GSAP timeline, the Heebo font file and a vendored GSAP) and renders it with the installed
`hyperframes` CLI as a transparent PNG sequence. The pipeline then overlays the sequence on the
picture in the same ffmpeg pass as the caption cards. (PNG, not WebM: VP9 alpha is broken on this
machine's ffmpeg.) Colours and font come from the caption style of the profile in force.

Checked after rendering: the graphic is inside the working safe zone, does not cover the measured
face, does not collide with the caption band, and is really present in the finished file.
"""
import html
import json
import shutil
from pathlib import Path

from . import judgement
from .core import PipelineError, run

HERE = Path(__file__).resolve().parent
ASSETS = HERE.parent / "motion"
# Two different things, never mixed up:
#   layer "over_picture"      an animated graphic drawn OVER the footage (the speaker stays visible)
#   layer "replaces_picture"  an animation SCENE that takes the whole frame for a few seconds while the voice goes on
# What the scene can be with the tools installed here: animated typography of an exact quotation (HyperFrames renders
# HTML). It is NOT an illustration of what is said - no drawings, characters or generated footage exist in this system.
KINDS = {"hook_title": {"label": "כותרת פתיחה", "min_s": 2.0, "max_s": 3.2, "layer": "over_picture", "words": (2, 6)},
         "key_phrase": {"label": "הדגשת משפט מפתח", "min_s": 1.6, "max_s": 4.0, "layer": "over_picture", "words": (2, 6)},
         "animation_scene": {"label": "קטע אנימציה במסך מלא (טיפוגרפיה מונפשת)", "min_s": 2.0, "max_s": 5.0, "layer": "replaces_picture", "words": (2, 8)}}
MAX_GRAPHICS = 3
SCENE_PROMPT = """   - "animation_scene": a short SCENE that replaces the picture with full-frame animated typography of the quoted words while
     the speaker's voice continues, then cuts back to the speaker. Use it at most once, only for the sentence the whole video
     turns on, and never in the first three seconds. It shows words only: it cannot illustrate, draw or act out anything."""
SIZE, LINE_H, PAD_Y, MAX_W = 62, 1.16, 24, 620          # px on the 1080x1920 frame; MAX_W = the safe width for centred text

SCHEMA_ITEM = {"type": "object", "additionalProperties": False, "required": ["kind", "quote", "at_s", "why"],
               "properties": {"kind": {"type": "string", "enum": sorted(KINDS)}, "quote": {"type": "string"},
                              "at_s": {"type": "number"}, "why": {"type": "string"}}}

PROMPT = """11. "graphics": motion graphics drawn over the picture. NONE is a valid and common answer: add one only when it
   has a job in this video, never for decoration. At most two, never two of the same kind:
   - "hook_title": a short title shown in the first seconds that tells a viewer who watches without sound what the
     video is about. Use it when the spoken opening alone does not make the subject clear.
   - "key_phrase": the one sentence that carries the message, emphasised at the moment it is said.
   "quote" is 2-6 consecutive words copied EXACTLY from a chosen part (never a paraphrase, a summary, a name, a price
   or a claim). "at_s" is the SOURCE time when those words are said. "why" is one short Hebrew sentence naming the
   job the graphic does. Do not repeat the cover quote as a key_phrase unless it is the message itself."""


def _norm(t):
    return judgement.skeleton(judgement.BIDI.sub("", t))


def validate(raw, words, segments, to_tl, total_s, allow_scene=False):
    """The plan's graphics → executable items (timeline times, exact quotes only). Returns (items, dropped)."""
    items, dropped, seen = [], [], set()
    chosen = [(i, _norm(words[i]["word"])) for s in segments for i in range(s["i0"], s["i1"] + 1)]
    for g in (raw or [])[:4]:
        if not isinstance(g, dict) or g.get("kind") not in KINDS:
            continue
        kind, why = g["kind"], str(g.get("why") or "")[:240]
        quote = " ".join(judgement.BIDI.sub("", str(g.get("quote") or "")).split())[:60]
        toks = [_norm(t) for t in quote.split()]
        toks = [t for t in toks if t]
        if kind == "animation_scene" and not allow_scene:
            dropped.append({"kind": kind, "quote": quote, "why": "קטע אנימציה לא התבקש בסקילים שנבחרו ולא בהוראות — לא נוסף"})
            continue
        if kind in seen or len(items) >= MAX_GRAPHICS:
            dropped.append({"kind": kind, "quote": quote, "why": "יותר מגרפיקה אחת מאותו סוג / יותר משתיים בסרטון"})
            continue
        wmin, wmax = KINDS[kind]["words"]
        if not wmin <= len(toks) <= wmax:
            dropped.append({"kind": kind, "quote": quote, "why": f"הטקסט חייב להיות {wmin}–{wmax} מילים רצופות מהסרטון"})
            continue
        hits = [k for k in range(len(chosen) - len(toks) + 1) if [c[1] for c in chosen[k:k + len(toks)]] == toks]
        if not hits:
            dropped.append({"kind": kind, "quote": quote, "why": "הטקסט אינו ציטוט מדויק מהקטעים שנבחרו — לא נוסף"})
            continue
        at = g.get("at_s") if isinstance(g.get("at_s"), (int, float)) else words[chosen[hits[0]][0]]["start"]
        k = min(hits, key=lambda h: abs(words[chosen[h][0]]["start"] - at))
        i0, i1 = chosen[k][0], chosen[k + len(toks) - 1][0]
        s0, tl0 = to_tl(words[i0]["start"])
        s1, tl1 = to_tl(words[i1]["end"])
        if s0 is None or s1 is None or s0 is not s1:
            dropped.append({"kind": kind, "quote": quote, "why": "הציטוט נחתך בין שני חלקים — לא נוסף"})
            continue
        spec = KINDS[kind]
        if kind == "animation_scene" and tl0 < 3.0:
            dropped.append({"kind": kind, "quote": quote, "why": "קטע אנימציה בשלוש השניות הראשונות — הצופה עוד לא ראה את הדוברת"})
            continue
        if kind == "hook_title":
            start = 0.25
            end = min(max(start + spec["min_s"], min(start + spec["max_s"], tl1 + 0.6)), total_s - 0.2)
        else:
            start = max(0.0, tl0 - 0.08)
            end = min(max(tl1 + 0.7, start + spec["min_s"]), start + spec["max_s"], total_s - 0.1)
        if end - start < 1.2:
            dropped.append({"kind": kind, "quote": quote, "why": "אין מספיק זמן להצגה קריאה"})
            continue
        if any(start < x["tl_end_s"] + 0.4 and end > x["tl_start_s"] - 0.4 for x in items):
            dropped.append({"kind": kind, "quote": quote, "why": "חופף לגרפיקה אחרת"})
            continue
        seen.add(kind)
        # the id is stable across versions (kind + source time), so the owner can remove ONE graphic and nothing else moves
        items.append({"id": f"{kind}@{words[i0]['start']:.1f}", "kind": kind, "label": spec["label"], "layer": spec["layer"], "text": quote, "source_t_s": round(words[i0]["start"], 3),
                      "tl_start_s": round(start, 3), "tl_end_s": round(end, 3), "reason": why, "quote_is_exact": True})
    return items, dropped


def shift(items, delta, dur):
    out = []
    for g in items:
        a, b = round(g["tl_start_s"] + delta, 3), round(min(g["tl_end_s"] + delta, dur - 0.05), 3)
        if a >= 0 and b - a >= 1.2:
            out.append(dict(g, tl_start_s=a, tl_end_s=b))
    return out


def lines_of(text):
    """Balanced layout on at most two lines (layout only, same words)."""
    w = text.split()
    if len(text) <= 14 or len(w) < 2:
        return [text]
    k = min(range(1, len(w)), key=lambda k: abs(len(" ".join(w[:k])) - len(" ".join(w[k:]))))
    return [" ".join(w[:k]), " ".join(w[k:])]


SCALES = (1.0, 0.86, 0.72)        # a graphic that does not fit is made smaller before it is given up; never below 72%


def box_height(text, scale=1.0):
    return int(len(lines_of(text)) * int(SIZE * scale) * LINE_H + 2 * PAD_Y + 22)


def place(items, zone, face_boxes_by_item, caption_band, H=1920):
    """Vertical position for every graphic: the upper part of the safe zone, clear of the measured face and of the
    caption band. A graphic with no free place is dropped (recorded), never drawn over a face."""
    placed, dropped = [], []
    for g in items:
        boxes = [b for b in (face_boxes_by_item.get(g["id"]) or []) if b]
        face_top = min((b[1] - 0.35 * b[3] for b in boxes), default=None)
        face_bottom = max((b[1] + b[3] * 1.18 for b in boxes), default=None)
        cands = [zone["top"] + 30, zone["top"] + 4]                  # above the face
        if face_bottom is not None:
            cands.append(int(face_bottom + 40))                      # below the face
        chosen, scale, h = None, 1.0, box_height(g["text"])
        for sc in SCALES:
            hh = box_height(g["text"], sc)
            for y in cands:
                if y < zone["top"] or y + hh > zone["bottom"]:
                    continue
                if face_top is not None and not (y + hh + 24 <= face_top or y >= face_bottom + 24):
                    continue
                if caption_band and y < caption_band[1] + 24 and y + hh > caption_band[0] - 24:
                    continue
                chosen, scale, h = y, sc, hh
                break
            if chosen is not None:
                break
        if chosen is None:
            dropped.append({"kind": g["kind"], "quote": g["text"], "why": "אין מקום פנוי מהפנים ומהכתוביות בתוך האזור הבטוח — הגרפיקה לא נוספה"})
            continue
        placed.append(dict(g, y_px=int(chosen), height_px=h, scale=scale, face_measured=bool(boxes)))
    return placed, dropped


TEMPLATE = """<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8" />
<script src="assets/gsap.min.js"></script>
<style>
@font-face {{ font-family: '{family}'; src: url('assets/fonts/{font_file}'); font-weight: 100 900; }}
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
html, body {{ width: {W}px; height: {H}px; overflow: hidden; background: transparent; }}
#root {{ position: relative; width: {W}px; height: {H}px; }}
#g {{ position: absolute; left: 0; top: {y}px; width: {W}px; display: flex; justify-content: center; }}
#plate {{ display: inline-flex; flex-direction: column; align-items: center; gap: 12px; padding: {pad}px 36px {pad}px; border-radius: 24px;
  background: {plate}; max-width: {max_w}px; }}
.ln {{ display: block; font-family: '{family}'; font-weight: 800; font-size: {size}px; line-height: {lh}; color: {ink}; text-align: center;
  direction: rtl; white-space: nowrap; text-shadow: {shadow}; }}
#bar {{ display: block; width: 100%; height: 8px; border-radius: 8px; background: {accent}; transform-origin: right center; }}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="{dur}" data-width="{W}" data-height="{H}">
  <div id="g" class="clip" data-start="0" data-duration="{dur}" data-track-index="0"><div id="plate">{lines}<span id="bar"></span></div></div>
</div>
<script>
const tl = gsap.timeline({{ paused: true }});
{anim}
window.__timelines['main'] = tl;
tl.seek(0);
</script>
</body>
</html>
"""
ANIM = {
    # the plate rises in, the accent bar draws from the right (reading direction), everything lifts out
    "hook_title": "tl.fromTo('#plate', {{ opacity: 0, y: 26, scale: 0.96 }}, {{ opacity: 1, y: 0, scale: 1, duration: 0.4, ease: 'power2.out' }}, 0);\n"
                  "tl.fromTo('#bar', {{ scaleX: 0 }}, {{ scaleX: 1, duration: 0.45, ease: 'power2.out' }}, 0.15);\n"
                  "tl.to('#plate', {{ opacity: 0, y: -14, duration: 0.33, ease: 'power2.in' }}, {out});",
    # the words land one line after the other, then the bar underlines them
    "key_phrase": "tl.fromTo('#plate', {{ opacity: 0 }}, {{ opacity: 1, duration: 0.2, ease: 'power2.out' }}, 0);\n"
                  "tl.fromTo('.ln', {{ opacity: 0, y: 18 }}, {{ opacity: 1, y: 0, duration: 0.3, ease: 'power3.out', stagger: 0.12 }}, 0.04);\n"
                  "tl.fromTo('#bar', {{ scaleX: 0 }}, {{ scaleX: 1, duration: 0.5, ease: 'power2.out' }}, 0.3);\n"
                  "tl.to('#plate', {{ opacity: 0, duration: 0.3, ease: 'power2.in' }}, {out});",
}


SCENE_TEMPLATE = """<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8" />
<script src="assets/gsap.min.js"></script>
<style>
@font-face {{ font-family: '{family}'; src: url('assets/fonts/{font_file}'); font-weight: 100 900; }}
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
html, body {{ width: {W}px; height: {H}px; overflow: hidden; background: #101116; }}
#root {{ position: relative; width: {W}px; height: {H}px; background: #101116; }}
#glow {{ position: absolute; left: -200px; top: 120px; width: 1480px; height: 900px; border-radius: 50%; background: radial-gradient(closest-side, rgba(255,255,255,0.10), rgba(255,255,255,0)); }}
#stage {{ position: absolute; left: 80px; top: 330px; width: {text_w}px; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; direction: rtl; }}
.w {{ display: block; font-family: '{family}'; font-weight: 900; font-size: {size}px; line-height: 1.08; color: {ink}; white-space: nowrap; }}
.w.hot {{ color: {accent}; }}
#bar {{ display: block; width: 260px; height: 14px; border-radius: 14px; background: {accent}; margin-top: 26px; transform-origin: right center; }}
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="{dur}" data-width="{W}" data-height="{H}">
  <div id="glow" class="clip" data-start="0" data-duration="{dur}" data-track-index="0"></div>
  <div id="stage" class="clip" data-start="0" data-duration="{dur}" data-track-index="1">{lines}<span id="bar"></span></div>
</div>
<script>
const tl = gsap.timeline({{ paused: true }});
tl.fromTo('#glow', {{ scale: 0.8, opacity: 0 }}, {{ scale: 1.1, opacity: 1, duration: {dur}, ease: 'none' }}, 0);
tl.fromTo('.w', {{ opacity: 0, x: 60 }}, {{ opacity: 1, x: 0, duration: 0.34, ease: 'power3.out', stagger: {stagger} }}, 0.12);
tl.fromTo('#bar', {{ scaleX: 0 }}, {{ scaleX: 1, duration: 0.5, ease: 'power2.out' }}, {bar_at});
window.__timelines['main'] = tl;
tl.seek(0);
</script>
</body>
</html>
"""


def scene_lines(text):
    """One or two words per line, in order (layout only). The last line is the accent line."""
    w = text.split()
    per = 1 if len(w) <= 3 else 2
    return [" ".join(w[i:i + per]) for i in range(0, len(w), per)]


def render_scene(cfg, style, g, out_dir):
    """A full-frame animation scene (opaque): the quoted words build up line by line. Returns (frames dir, frame count)."""
    proj = Path(out_dir) / g["id"].replace("@", "_").replace(".", "_")
    if proj.exists():
        shutil.rmtree(proj)
    (proj / "assets" / "fonts").mkdir(parents=True)
    fonts = sorted(Path(cfg["paths"]["font_dir"]).glob("*.ttf")) + sorted(Path(cfg["paths"]["font_dir"]).glob("*.otf"))
    font = next((f for f in fonts if style["font_family"].lower() in f.stem.lower()), fonts[0] if fonts else None)
    if font is None:
        raise PipelineError("font_missing", f"no font file in {cfg['paths']['font_dir']}")
    shutil.copyfile(font, proj / "assets" / "fonts" / font.name)
    shutil.copyfile(ASSETS / "gsap.min.js", proj / "assets" / "gsap.min.js")
    dur = round(g["tl_end_s"] - g["tl_start_s"], 2)
    lines = scene_lines(g["text"])
    longest = max(len(x) for x in lines)
    size = int(min(150, max(84, 920 / max(longest, 1) * 1.55)))          # the widest line fits 920 px
    page = SCENE_TEMPLATE.format(
        W=style["width"], H=style["height"], family=style["font_family"], font_file=font.name, text_w=920, size=size, ink=style["caption_ink"],
        accent=style["caption_highlight"], dur=dur, stagger=round(min(0.28, max(0.12, (dur - 1.2) / max(len(lines), 1))), 2),
        bar_at=round(min(dur - 0.7, 0.3 + 0.28 * len(lines)), 2),
        lines="".join(f'<span class="w{" hot" if n == len(lines) - 1 else ""}">{html.escape(x)}</span>' for n, x in enumerate(lines)))
    (proj / "index.html").write_text(page, encoding="utf-8")
    (proj / "meta.json").write_text(json.dumps({"id": "scene", "name": "dana-animation-scene"}), encoding="utf-8")
    (proj / "hyperframes.json").write_text(json.dumps({"paths": {"assets": "assets"}, "authoringSkill": "hyperframes"}), encoding="utf-8")
    frames = proj / "frames"
    run([cli(cfg), "render", str(proj), "--format", "png-sequence", "-o", str(frames), "--fps", str(style["fps"]), "--quiet", "--skill=hyperframes"],
        "hyperframes_render_failed", timeout=int(cfg["timeouts"].get("hyperframes_s", 420)), cwd=str(proj))
    n = len(list(frames.glob("frame_*.png")))
    if n < int(dur * style["fps"]) - 2:
        raise PipelineError("hyperframes_render_failed", f"HyperFrames wrote {n} frames for a {dur}s scene", True)
    return frames, n


def apply_scenes(cfg, base, scenes, out, fps, timeout):
    """Put the animation scenes INTO the picture track: for their seconds the scene replaces the footage (a hard cut in and
    out); the sound is untouched. Captions are composited later, on top, like on any other part of the video."""
    inputs, parts, prev = [], [], "0:v"
    for n, g in enumerate(scenes):
        inputs += ["-framerate", str(fps), "-start_number", "1", "-i", Path(g["frames"]) / "frame_%06d.png"]
        parts.append(f"[{n + 1}:v]format=yuv420p,setpts=PTS+{g['tl_start_s']}/TB[s{n}]")
        parts.append(f"[{prev}][s{n}]overlay=eof_action=pass:enable='between(t,{g['tl_start_s']},{g['tl_end_s']})'[v{n}]")
        prev = f"v{n}"
    run([tool_ffmpeg(cfg), "-y", "-v", "error", "-i", base, *inputs, "-filter_complex", ";".join(parts), "-map", f"[{prev}]", "-an",
         "-c:v", "libx264", "-crf", "10", "-preset", "medium", "-pix_fmt", "yuv420p", out], "render_failed", timeout=timeout)
    return out


def tool_ffmpeg(cfg):
    return (cfg.get("paths") or {}).get("ffmpeg") or "ffmpeg"


def check_scenes(cfg, final, plain_base, scenes):
    """Is every animation scene really in the finished file - i.e. does the picture differ from the footage there, over the whole frame?"""
    import numpy as np
    from .adjust import read_frames
    from .checks import rec
    problems, rows = [], []
    for g in scenes:
        mid = round((g["tl_start_s"] + g["tl_end_s"]) / 2, 2)
        a, b = read_frames(cfg, final, [mid], width=180)[0], read_frames(cfg, plain_base, [mid], width=180)[0]
        diff = float(np.abs(a - b).mean()) if a is not None and b is not None else 0.0
        before = read_frames(cfg, final, [max(0.0, g["tl_start_s"] - 0.3)], width=180)[0]
        back = float(np.abs(before - read_frames(cfg, plain_base, [max(0.0, g["tl_start_s"] - 0.3)], width=180)[0]).mean()) if before is not None else 1.0
        rows.append({"id": g["id"], "t_s": mid, "frame_diff": round(diff, 4), "footage_before_diff": round(back, 4)})
        if diff < 0.12:
            problems.append(f"קטע האנימציה '{g['text']}' אינו מחליף את התמונה ב-{mid}s")
    return rec("animation_scene_rendered", "fail" if problems else "pass",
               "; ".join(problems) if problems else f"{len(scenes)} קטעי אנימציה מחליפים את הצילום בקובץ הסופי בזמן שנקבע (פריים אמצעי לכל קטע; תחושת התנועה לא נבדקה)", rows=rows)


def cli(cfg):
    exe = (cfg.get("paths") or {}).get("hyperframes") or shutil.which("hyperframes.cmd") or shutil.which("hyperframes")
    if not exe:
        raise PipelineError("hyperframes_missing", "the HyperFrames CLI was not found (paths.hyperframes)")
    return exe


def version(cfg):
    try:
        r = run([cli(cfg), "--version"], "hyperframes_failed", timeout=90, retryable=False)
        return r.stdout.decode("utf-8", "replace").strip().splitlines()[-1][:40]
    except PipelineError:
        return None


def render(cfg, style, g, out_dir):
    """Write the HyperFrames project for one graphic and render it to RGBA frames. Returns the frames folder."""
    proj = Path(out_dir) / g["id"]
    if proj.exists():
        shutil.rmtree(proj)
    (proj / "assets" / "fonts").mkdir(parents=True)
    fonts = sorted(Path(cfg["paths"]["font_dir"]).glob("*.ttf")) + sorted(Path(cfg["paths"]["font_dir"]).glob("*.otf"))
    font = next((f for f in fonts if style["font_family"].lower() in f.stem.lower()), fonts[0] if fonts else None)
    if font is None:
        raise PipelineError("font_missing", f"no font file in {cfg['paths']['font_dir']}")
    shutil.copyfile(font, proj / "assets" / "fonts" / font.name)
    shutil.copyfile(ASSETS / "gsap.min.js", proj / "assets" / "gsap.min.js")
    dur = round(g["tl_end_s"] - g["tl_start_s"], 2)
    page = TEMPLATE.format(
        W=style["width"], H=style["height"], family=style["font_family"], font_file=font.name, y=g["y_px"], pad=PAD_Y, max_w=MAX_W,
        size=int(SIZE * float(g.get("scale") or 1.0)), lh=LINE_H, ink=style["caption_ink"], accent=style["caption_highlight"], plate="rgba(15,16,22,0.78)",
        shadow="0 2px 8px rgba(0,0,0,0.6)", dur=dur,
        lines="".join(f'<span class="ln">{html.escape(ln)}</span>' for ln in lines_of(g["text"])),
        anim=ANIM[g["kind"]].format(out=round(dur - 0.36, 2)))
    (proj / "index.html").write_text(page, encoding="utf-8")
    (proj / "meta.json").write_text(json.dumps({"id": g["id"], "name": f"dana-{g['kind']}"}), encoding="utf-8")
    (proj / "hyperframes.json").write_text(json.dumps({"paths": {"assets": "assets"}, "authoringSkill": "hyperframes"}), encoding="utf-8")
    frames = proj / "frames"
    run([cli(cfg), "render", str(proj), "--format", "png-sequence", "-o", str(frames), "--fps", str(style["fps"]), "--quiet",
         "--skill=hyperframes"], "hyperframes_render_failed", timeout=int(cfg["timeouts"].get("hyperframes_s", 420)), cwd=str(proj))
    n = len(list(frames.glob("frame_*.png")))
    if n < int(dur * style["fps"]) - 2:
        raise PipelineError("hyperframes_render_failed", f"HyperFrames wrote {n} frames for a {dur}s graphic", True)
    return frames, n


def ink_box(frames_dir, n):
    """The drawn area of the graphic at its middle frame (x0, y0, x1, y1) or None."""
    from .checks import _ink_box
    return _ink_box(Path(frames_dir) / f"frame_{max(1, n // 2):06d}.png")[1]


def check(cfg, final, base, items, zone, face_boxes_by_item, W):
    """Is every graphic really in the finished file, inside the safe zone and off the face? Returns one record."""
    import numpy as np
    from .adjust import read_frames
    from .checks import rec
    problems, rows = [], []
    for g in items:
        box = g.get("ink_box")
        mid = round((g["tl_start_s"] + g["tl_end_s"]) / 2, 2)
        row = {"id": g["id"], "kind": g["kind"], "text": g["text"], "t_s": mid, "ink_box": box}
        if not box:
            problems.append(f"{g['label']} '{g['text']}' יצאה ריקה")
            rows.append(row)
            continue
        a, b = read_frames(cfg, final, [mid], width=270)[0], read_frames(cfg, base, [mid], width=270)[0]
        k = 270 / W
        ya, yb, xa, xb = int(box[1] * k), int(box[3] * k) + 1, int(box[0] * k), int(box[2] * k) + 1
        diff = float(np.abs(a[ya:yb, xa:xb] - b[ya:yb, xa:xb]).mean()) if a is not None and b is not None else 0.0
        row["present_diff"] = round(diff, 4)
        if diff < 0.02:
            problems.append(f"{g['label']} '{g['text']}' אינה נראית בקובץ הסופי ב-{mid}s")
        if box[1] < zone["top"] or box[3] > zone["bottom"] or box[0] < zone["left"] or box[2] > W - zone["right_clear"]:
            problems.append(f"{g['label']} חורגת מהאזור הבטוח")
        for fb in [f for f in (face_boxes_by_item.get(g["id"]) or []) if f]:
            if box[1] < fb[1] + fb[3] and box[3] > fb[1] and box[0] < fb[0] + fb[2] and box[2] > fb[0]:
                problems.append(f"{g['label']} מכסה את אזור הפנים שנמדד")
                break
        rows.append(row)
    return rec("graphics_rendered", "fail" if problems else "pass",
               "; ".join(problems) if problems else f"{len(items)} רכיבי גרפיקה נמצאים בקובץ הסופי, בתוך האזור הבטוח ולא על הפנים (פריים אמצעי לכל רכיב)",
               rows=rows)
