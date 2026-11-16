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
KINDS = {"hook_title": {"label": "כותרת פתיחה", "min_s": 2.0, "max_s": 3.2},
         "key_phrase": {"label": "הדגשת משפט מפתח", "min_s": 1.6, "max_s": 4.0}}
MAX_GRAPHICS = 2
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


def validate(raw, words, segments, to_tl, total_s):
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
        if kind in seen or len(items) >= MAX_GRAPHICS:
            dropped.append({"kind": kind, "quote": quote, "why": "יותר מגרפיקה אחת מאותו סוג / יותר משתיים בסרטון"})
            continue
        if not 2 <= len(toks) <= 6:
            dropped.append({"kind": kind, "quote": quote, "why": "הטקסט חייב להיות 2–6 מילים רצופות מהסרטון"})
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
        items.append({"id": f"g{len(items) + 1}", "kind": kind, "label": spec["label"], "text": quote, "source_t_s": round(words[i0]["start"], 3),
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


def box_height(text):
    return int(len(lines_of(text)) * SIZE * LINE_H + 2 * PAD_Y + 22)


def place(items, zone, face_boxes_by_item, caption_band, H=1920):
    """Vertical position for every graphic: the upper part of the safe zone, clear of the measured face and of the
    caption band. A graphic with no free place is dropped (recorded), never drawn over a face."""
    placed, dropped = [], []
    for g in items:
        h = box_height(g["text"])
        boxes = [b for b in (face_boxes_by_item.get(g["id"]) or []) if b]
        face_top = min((b[1] - 0.35 * b[3] for b in boxes), default=None)
        face_bottom = max((b[1] + b[3] * 1.18 for b in boxes), default=None)
        cands = [zone["top"] + 30]                                   # above the face
        if face_bottom is not None:
            cands.append(int(face_bottom + 40))                      # below the face
        chosen = None
        for y in cands:
            if y < zone["top"] or y + h > zone["bottom"]:
                continue
            if face_top is not None and not (y + h + 24 <= face_top or y >= face_bottom + 24):
                continue
            if caption_band and y < caption_band[1] + 24 and y + h > caption_band[0] - 24:
                continue
            chosen = y
            break
        if chosen is None:
            dropped.append({"kind": g["kind"], "quote": g["text"], "why": "אין מקום פנוי מהפנים ומהכתוביות בתוך האזור הבטוח — הגרפיקה לא נוספה"})
            continue
        placed.append(dict(g, y_px=int(chosen), height_px=h, face_measured=bool(boxes)))
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
        size=SIZE, lh=LINE_H, ink=style["caption_ink"], accent=style["caption_highlight"], plate="rgba(15,16,22,0.78)",
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
