# -*- coding: utf-8 -*-
"""Where the video is meant to go: a Reel or a Story. The target changes the PLAN and the RENDER, not just a label.

            reel                                           story
structure   one continuous video that stands alone         a sequence of 1-4 short cards; each card understood alone
length      12-45 s (worker configuration)                 every card up to 15 s, 60 s in all
opening     a line that makes a stranger stay              the first card names the subject at once
captions    working Reels safe zone (right rail clear)     working Story safe zone (top bar and reply bar clear, full width)
cover       a frame with an exact quotation                none: a story has no cover
post text   a caption draft                                none: a story has no caption
files       final.mp4                                      final.mp4 (all cards in order, for review) + story_part_N.mp4

The numbers of the Story zone and the 15-second card are WORKING DEFINITIONS chosen here. They were not measured against
the Instagram app, and Instagram itself accepts longer story clips; they can be changed in one place.

Producing a file is not publishing it. Publishing a story through the existing connection was never tested:
`publish` below says so, and the server keeps publishing off.
"""
import json
from pathlib import Path

TARGETS = {
    "reel": {
        "label": "ריל", "part_max_s": None, "total_max_s": None, "total_min_s": None, "max_parts": 6, "merge_adjacent": True,
        "cover_text": True, "post_caption": True, "chars_per_line_bonus": 0,
        "publish": "קיים חיבור שנבדק בקריאה בלבד; פרסום כבוי",
        "brief": ("TARGET: an Instagram REEL - one continuous video that stands alone in a feed. A stranger who has never heard of the studio "
                  "must understand it. Open on the line that makes them stay; one message; end on a complete thought. Parts of the recording "
                  "may be joined into one flowing video."),
    },
    "story": {
        "label": "סטורי", "part_max_s": 15.0, "total_max_s": 60.0, "total_min_s": 5.0, "max_parts": 4, "merge_adjacent": False,
        "cover_text": False, "post_caption": False, "chars_per_line_bonus": 4,
        "zone": {"_source": "working definition for a 1080x1920 story: the top 270 px (profile bar) and everything below y=1580 (reply bar) stay "
                            "clear; no action rail on the right. Not measured against the Instagram app.",
                 "frame": {"width": 1080, "height": 1920}, "top": 270, "bottom": 1580, "left": 60, "right_clear": 60, "right_clear_from_y": 0},
        "publish": "לא נבדק: פרסום סטורי דרך החיבור הקיים לא נוסה מעולם. הקבצים מופקים; הפרסום אינו נתמך כרגע",
        "brief": ("TARGET: an Instagram STORY - a SEQUENCE of short cards watched by people who already follow the studio. Plan 1 to 4 parts; "
                  "EVERY part is one story card of at most 15 seconds and must be understood on its own, because a viewer may tap past any "
                  "card. The first card says what this is about at once. Each part is a separate entry in \"segments\" - never one long "
                  "part. Keep the tone of someone talking to people they know. A story has no cover and no caption text."),
    },
}


def of(options):
    t = (options or {}).get("target")
    return t if t in TARGETS else "reel"


def spec(target):
    return TARGETS[target]


def use_zone(cfg, target, job_dir):
    """Point the pipeline's safe zone at the target's zone. The Reels zone is the configured file; the Story zone is written
    into the job folder, so every check and placement reads the same numbers. Returns the zone."""
    z = TARGETS[target].get("zone")
    if not z:
        return json.loads(Path(cfg["paths"]["safe_zone"]).read_text(encoding="utf-8"))
    p = Path(job_dir) / "safe_zone_story.json"
    p.write_text(json.dumps(z, ensure_ascii=False, indent=1), encoding="utf-8")
    cfg["paths"]["safe_zone"] = str(p)
    return z


def limits(cfg, target, duration):
    """(min total, max total, max part) in seconds for this target."""
    c, t = cfg["judgement"]["claude"], TARGETS[target]
    lo = t["total_min_s"] if t["total_min_s"] is not None else min(float(c.get("min_s", 12)), max(cfg["segment"]["min_s"], duration - 0.5))
    hi = t["total_max_s"] if t["total_max_s"] is not None else float(c.get("max_s", 45))
    return lo, hi, t["part_max_s"]
