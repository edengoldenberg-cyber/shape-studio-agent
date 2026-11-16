"""When the style rules in force leave captions that flash by, build a READABLE alternative and show it next to the
current result. Nothing is applied and nothing becomes a preference: the owner sees the numbers and a short clip of the
same seconds, and may ask for a version with the alternative (for this project only).

The candidates change ONE thing each: two lines at the same size, or one line at a smaller size. For each, the same
words are divided again (captions.regroup) and the cards that would still flash by are counted from the word times."""
from pathlib import Path

from . import adjust, captions
from .core import run, tool


def _count(cards, spans, c_cfg):
    return captions.regroup(cards, spans, lambda t: False, c_cfg["min_on_screen_s"], c_cfg["max_chars_per_s"], 1, c_cfg["hold_after_s"])[1]["bad_before"]


def alternatives(cfg, style, dec_cards, spans, line_px, max_words_per_line=3):
    """-> {"current": {...}, "alternatives": [{"key", "label", "overrides", "short_cards", "cards"}]} best first."""
    c_cfg, size = cfg["cards"], int(style["caption_size"])
    out = []

    def two_line_fits(st):
        def f(t):
            if len(t) > c_cfg["merge_max_chars"] + 6:
                return False
            if captions.text_px(cfg, st, t) <= line_px:
                return True
            tl = captions.two_lines(t)
            return bool(tl) and all(captions.text_px(cfg, st, ln) <= line_px for ln in tl.split("\n"))
        return f

    cands = []
    if int(style.get("caption_max_lines", 1)) < 2:
        cands.append(("two_lines", f"שתי שורות, באותו גודל ({size})", {"caption_max_lines": 2}, two_line_fits(style), max_words_per_line * 2))
    for pct in (85, 75):
        st2 = dict(style, caption_size=int(size * pct / 100))
        fits = (lambda s: (lambda t: len(t) <= c_cfg["merge_max_chars"] and captions.text_px(cfg, s, t) <= line_px))(st2) if int(style.get("caption_max_lines", 1)) < 2 else two_line_fits(st2)
        cands.append((f"size_{pct}", f"גודל {st2['caption_size']} ({pct}% מהנוכחי), אותו מספר שורות", {"caption_size": st2["caption_size"]}, fits, max_words_per_line * int(style.get("caption_max_lines", 1))))
    for key, label, overrides, fits, max_words in cands:
        cards, stats = captions.regroup(dec_cards, spans, fits, c_cfg["min_on_screen_s"], c_cfg["max_chars_per_s"], max(2, max_words), c_cfg["hold_after_s"])
        out.append({"key": key, "label": label, "overrides": overrides, "short_cards": stats["bad_after"], "cards": cards})
    out.sort(key=lambda a: a["short_cards"])
    return {"current": {"short_cards": _count(dec_cards, spans, c_cfg), "caption_size": size, "max_lines": int(style.get("caption_max_lines", 1)), "line_px": line_px},
            "alternatives": out,
            "basis": "מספר הכרטיסים הקצרים בכל חלופה מחושב מזמני המילים וממדידת רוחב הטקסט, לא מרינדור מלא של הסרטון"}


def preview(cfg, style, alt, voice_words, groups, base, voice, final, dur, comfort_rows, line_px, work, out, fps):
    """A short side-by-side clip of the same seconds: the current result (left) and the alternative (right). Returns [t0, t1]."""
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    span = min(8.0, dur)
    starts = sorted(r["t0"] for r in comfort_rows) or [0.0]
    t0 = max(starts, key=lambda s: sum(1 for x in starts if s <= x < s + span))
    t0 = round(max(0.0, min(t0 - 0.5, dur - span)), 2)
    st = dict(style, **alt["overrides"])
    spans, _ = captions.align_cards(alt["cards"], voice_words, groups)
    timed = captions.time_cards(alt["cards"], spans, fps, cfg["cards"]["hold_after_s"], dur)
    win = []
    for c in timed:
        a, b = max(c["start"], t0), min(c["start"] + c["dur"], t0 + span)
        if b - a > 0.05:
            win.append(dict(c, start=round(a - t0, 3), dur=round(b - a, 3)))
    items = []
    for c in win:
        text = c["plain"]
        if int(st.get("caption_max_lines", 1)) >= 2 and captions.text_px(cfg, st, text) > line_px and captions.two_lines(text):
            text = captions.two_lines(text)
        items.append({"name": f"c{c['i']:03d}", "text": text, "highlight": c["highlight"]})
    png_dir = captions.render_png(cfg, st, items, work / "caps")
    ff = tool(cfg, "ffmpeg")
    run([ff, "-y", "-v", "error", "-ss", f"{t0}", "-t", f"{span}", "-i", base, "-an", "-c:v", "libx264", "-crf", "16", "-preset", "veryfast", "-pix_fmt", "yuv420p", work / "base.mp4"], "compare_failed", timeout=300)
    run([ff, "-y", "-v", "error", "-ss", f"{t0}", "-t", f"{span}", "-i", voice, work / "voice.wav"], "compare_failed", timeout=120)
    captions.composite(cfg, work / "base.mp4", work / "voice.wav", win, png_dir, work / "alt.mp4", span, animation=None, graphics=None, fps=fps)
    run([ff, "-y", "-v", "error", "-ss", f"{t0}", "-t", f"{span}", "-i", final, "-c:v", "libx264", "-crf", "16", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", work / "cur.mp4"], "compare_failed", timeout=300)
    adjust.compare_clip(cfg, work / "cur.mp4", work / "alt.mp4", 0.0, span, out)
    return [t0, round(t0 + span, 2)]
