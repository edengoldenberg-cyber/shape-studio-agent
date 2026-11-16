# -*- coding: utf-8 -*-
"""Dana's review as a rating by category, from FIXED criteria (a versioned rubric).

Every category lists the same criteria for every video and every version, so two versions can be
compared. Each criterion says how it was decided:
    measured   code measured it on the finished file
    frames     seen in a few still frames
    model      a model's assessment of text (transcript, plan) and stills — not listening, not motion
    human      only the owner can decide it; it is listed as "not checked", never given a mark
A criterion that could not be decided is "not_checked". A category's rating is simply how many of its
decided criteria are met; a category with nothing decided is "לא נבדק". No number is invented, and no
rating predicts how a video will perform on Instagram.

Improvements are listed by importance and split into technical defects and creative preferences;
`can_apply` says whether Dana can make the change herself inside the approved rules.
"""
RUBRIC_VERSION = "dana-review-2026-11-15.1"

CATEGORIES = [("message", "מסר"), ("opening", "פתיחה"), ("structure", "מבנה"), ("pace", "קצב"), ("captions", "כתוביות"),
              ("sync", "סנכרון"), ("framing", "פריימינג"), ("zooms", "זומים"), ("graphics", "גרפיקה"), ("color", "צבע"),
              ("sound", "סאונד"), ("cover", "קאבר")]

# (id, category, criterion, source). source: ("record", check id) | ("criterion", acceptance id) | ("fact", name) | ("human",)
CRITERIA = [
    ("M1", "message", "לסרטון מסר אחד ברור", ("criterion", "A15")),
    ("M2", "message", "הסרטון מובן למי שלא ראה את שאר ההקלטה", ("criterion", "A7")),
    ("M3", "message", "הקפשן אומר רק מה שנאמר בסרטון או עובדות מאומתות", ("criterion", "A8")),
    ("O1", "opening", "הסרטון נפתח בתחילת משפט ולא באמצע מחשבה", ("criterion", "A5")),
    ("O2", "opening", "המילים בשלוש השניות הראשונות נותנות סיבה להמשיך לצפות", ("criterion", "A16")),
    ("O3", "opening", "הדיבור מתחיל בתוך השנייה הראשונה", ("fact", "first_word")),
    ("S1", "structure", "הסרטון מסתיים במחשבה שלמה", ("criterion", "A6")),
    ("S2", "structure", "סדר החלקים הגיוני: פתיחה, גוף וסיום", ("criterion", "A17")),
    ("S3", "structure", "חיתוכים בין חלקים לא נופלים בתוך מילה", ("fact", "cut_joins")),
    ("S4", "structure", "תחילת הסרטון וסופו לא חותכים מילה", ("record", "clip_boundary")),
    ("P1", "pace", "אין חלק שחוזר על עצמו או שאינו משרת את המסר", ("criterion", "A18")),
    ("P2", "pace", "אין שתיקה ארוכה מ-1.2 שניות בתוך הסרטון", ("fact", "longest_pause")),
    ("K1", "captions", "הכתוביות הן המילים שנאמרו, באותו סדר", ("criterion", "A1")),
    ("K2", "captions", "כל כתובית בתוך הפריים ובתוך האזור הבטוח", ("fact", "caption_geometry")),
    ("K3", "captions", "הכתוביות לא מכסות את הפנים", ("record", "caption_face_overlap")),
    ("K4", "captions", "כל כתובית על המסך מספיק זמן לקריאה", ("criterion", "A13")),
    ("K5", "captions", "ההדגשה סלקטיבית ועל המילים שנושאות את המסר", ("criterion", "A10")),
    ("K6", "captions", "בפריימים שנבדקו הכתובית קריאה", ("criterion", "A11")),
    ("Y1", "sync", "כל כתובית מופיעה עם המילה שלה (עד 120ms)", ("record", "sync_lead")),
    ("Y2", "sync", "אין כתובית למילה שלא נשמעת", ("record", "sync_not_found")),
    ("Y3", "sync", "אף כתובית לא נעלמת לפני סוף המילה", ("record", "sync_tail")),
    ("Y4", "sync", "מה שמופיע בפועל על המסך תואם את התזמון המתוכנן", ("record", "cards_in_motion")),
    ("F1", "framing", "הקובץ אנכי 1080×1920 ותקין טכנית", ("record", "output_file")),
    ("F2", "framing", "הפנים בתוך הפריים בכל הפריימים שנדגמו", ("fact", "face_inside")),
    ("F3", "framing", "הקומפוזיציה נעימה לעין בתנועה", ("human",)),
    ("Z1", "zooms", "הפנים לא נחתכות בזמן אף זום", ("record", "zoom_face_inside")),
    ("Z2", "zooms", "לכל זום יש רגע מפתח ונימוק רשום (לא במרווחים קבועים)", ("fact", "zoom_reasons")),
    ("Z3", "zooms", "תחושת התנועה של הזום טבעית", ("human",)),
    ("G1", "graphics", "כל רכיב גרפי נמצא בסרטון, באזור הבטוח ולא על הפנים", ("record", "graphics_rendered")),
    ("G2", "graphics", "טקסט הגרפיקה הוא ציטוט מדויק ממה שנאמר", ("fact", "graphics_exact")),
    ("C1", "color", "בהירות הפנים / הפריים בטווח העבודה", ("fact", "color_exposure")),
    ("C2", "color", "אין סטיית צבע באזורים הניטרליים", ("fact", "color_cast")),
    ("C3", "color", "גוון העור נשמר אחרי התיקון", ("fact", "color_skin")),
    ("C4", "color", "המראה הכללי נכון לעין", ("human",)),
    ("A1", "sound", "עוצמה ביעד (‎-14 LUFS ±0.5) בלי חריגת פיק", ("record", "loudness")),
    ("A2", "sound", "יחס דיבור/רעש רקע מספק", ("fact", "sound_snr")),
    ("A3", "sound", "הקול נשמע טבעי ונקי בהאזנה", ("human",)),
    ("V1", "cover", "טקסט הקאבר הוא ציטוט מדויק מהסרטון", ("fact", "cover_quote")),
    ("V2", "cover", "הקאבר מייצג את המסר", ("criterion", "A9")),
    ("V3", "cover", "הקאבר והקפשן לא נוקבים בשם של אדם פרטי", ("criterion", "A14")),
]
BASIS_HE = {"measured": "נמדד", "frames": "פריימים בודדים", "model": "הערכת מודל", "human": "דורש אותך", "none": "—"}
TECHNICAL = {"sync", "framing", "sound", "color"}          # a miss here is a technical defect; elsewhere it is content / style


def _row(cid, cat, text, status, basis, note="", time_s=None, evidence=None):
    return {"id": cid, "category": cat, "criterion": text, "status": status, "basis": basis, "note": str(note or "")[:400],
            "time_s": time_s, "evidence": evidence}


def _from_record(r):
    if r is None:
        return "not_checked", "measured", "הבדיקה לא רצה בגרסה הזו"
    st = {"pass": "met", "warn": "met", "info": "na", "fail": "not_met", "review": "not_met"}.get(r["status"], "not_checked")
    return st, "measured", r["summary"]


def _fact(name, f):
    """Facts measured by the pipeline (f) → (status, basis, note, time_s)."""
    if name == "first_word":
        t = f.get("first_word_s")
        return ("not_checked", "measured", "לא נמדד", None) if t is None else \
            ("met" if t <= 1.0 else "not_met", "measured", f"המילה הראשונה נשמעת ב-{t:.2f}s", t)
    if name == "cut_joins":
        j = f.get("cut_joins")
        return ("not_checked", "measured", "לא נמדד", None) if j is None else \
            ("not_met" if j["bad"] else "met", "measured", j["note"], None)
    if name == "longest_pause":
        p = f.get("longest_pause")
        return ("not_checked", "measured", "לא נמדד", None) if p is None else \
            ("met" if p["s"] <= 1.2 else "not_met", "measured", f"השתיקה הארוכה ביותר בין מילים: {p['s']:.2f}s (ב-{p['at_s']:.1f}s)", p["at_s"])
    if name == "caption_geometry":
        if f.get("captions_added") is False:
            return "na", "measured", f.get("captions_note") or "הכתוביות צרובות במקור — דנה לא הוסיפה שכבת כתוביות ואינה יכולה למדוד או לשנות אותן", None
        rs = [f["records"].get("caption_width"), f["records"].get("safe_zone")]
        if not all(rs):
            return "not_checked", "measured", "לא נמדד", None
        bad = [r for r in rs if r["status"] == "fail"]
        return ("not_met" if bad else "met", "measured", " · ".join(r["summary"] for r in (bad or rs)), None)
    if name == "face_inside":
        fi = f.get("face_inside")
        return ("not_checked", "frames", "לא נמדד מיקום פנים", None) if fi is None else \
            ("met" if not fi["bad"] else "not_met", "frames",
             f"פנים זוהו ב-{fi['found']} מתוך {fi['frames']} פריימים שנדגמו" + (f"; חתוכות או חסרות ב: {', '.join(str(t) + 's' for t in fi['bad'])}" if fi["bad"] else ""),
             fi["bad"][0] if fi["bad"] else None)
    if name == "zoom_reasons":
        z = f.get("zooms")
        if z is None:
            return "not_checked", "measured", "לא נמדד", None
        if not z:
            return "na", "measured", "הסרטון נערך בלי זומים", None
        missing = [x for x in z if not str(x.get("reason") or "").strip()]
        return ("not_met" if missing else "met", "measured", f"{len(z)} זומים, לכל אחד זמן, עוצמה ונימוק" if not missing else f"{len(missing)} זומים בלי נימוק", None)
    if name == "graphics_exact":
        g = f.get("graphics")
        if g is None:
            return "not_checked", "measured", "לא נמדד", None
        if not g:
            return "na", "measured", "הסרטון נערך בלי מואושן גרפיק", None
        bad = [x for x in g if not x.get("quote_is_exact")]
        return ("not_met" if bad else "met", "measured", "כל טקסט גרפי אומת מול התמלול של הקטעים שנבחרו", g[0].get("tl_start_s"))
    if name.startswith("color_"):
        c = f.get("color")
        if not c or not c.get("measured_before"):
            return "not_checked", "measured", "הצבע לא נמדד בגרסה הזו", None
        m = c.get("measured_after") or c["measured_before"]
        L = c["limits"]
        if name == "color_exposure":
            face = (m.get("face") or {}).get("luma")
            ref, lo, hi = (face, L["face_luma_low"], L["face_luma_high"]) if face is not None else (m["luma_p50"], L["frame_luma_low"], L["frame_luma_high"])
            return ("met" if lo - 0.02 <= ref <= hi + 0.02 else "not_met", "measured",
                    f"{'בהירות הפנים' if face is not None else 'בהירות חציונית'} {ref:.2f} (טווח {lo:.2f}–{hi:.2f})" + (" אחרי התיקון" if c.get("applied") else ""), None)
        if name == "color_cast":
            neu = m.get("neutral_rgb")
            if not neu:
                return "not_checked", "measured", "אין מספיק אזורים ניטרליים בתמונה כדי למדוד סטיית צבע", None
            avg = sum(neu) / 3
            worst = max(abs(x - avg) / avg for x in neu)
            return ("met" if worst < L["cast_threshold"] + 0.01 else "not_met", "measured", f"סטייה מרבית של ערוץ באזורים הניטרליים: {worst * 100:.0f}%", None)
        if name == "color_skin":
            if not c.get("applied"):
                return "na", "measured", "לא בוצע תיקון צבע — אין מה להשוות", None
            return "met", "measured", c.get("skin_guard") or "", None
    if name == "sound_snr":
        a = f.get("audio")
        if not a or not a.get("measured_before"):
            return "not_checked", "measured", "רעש הרקע לא נמדד בגרסה הזו", None
        m = a.get("measured_after") or a["measured_before"]
        if m.get("snr_db") is None:
            return "not_checked", "measured", f"הדיבור רצוף ({m.get('gap_seconds', 0)} שניות של רווחים) — רעש הרקע לא ניתן למדידה בנפרד מהקול", None
        ok = m["snr_db"] >= a["limits"]["snr_target_db"] - 6
        return ("met" if ok else "not_met", "measured", f"יחס דיבור/רעש {m['snr_db']:.0f}dB ברווחים שבין המילים, רעש רקע {m['room_tone_db']}dB" + (" אחרי ניקוי" if a.get("applied") else ""), None)
    if name == "cover_quote":
        if not f.get("cover_text"):
            return "na", "measured", "לקאבר אין שכבת טקסט", None
        c = f["criteria"].get("A3")
        return ("not_checked", "measured", "לא נבדק", None) if not c or c.get("met") is None else \
            ("met" if c["met"] else "not_met", "measured", c.get("note") or "", None)
    return "not_checked", "none", "לא נבדק", None


LEVELS = [(1.0, "תקין"), (0.5, "דורש שיפור"), (0.0, "בעייתי")]   # share of the decided criteria that are met


def build(f):
    """f: {"kind", "records": {id: rec}, "criteria": {acceptance id: row}, "findings": [...], facts…} → the review."""
    rows = []
    for cid, cat, text, src in CRITERIA:
        if src[0] == "record":
            st, basis, note = _from_record(f["records"].get(src[1]))
            if src[1] in ("zoom_face_inside",) and f.get("zooms") == []:
                st, note = "na", "הסרטון נערך בלי זומים"
            if src[1] == "graphics_rendered" and f.get("graphics") == []:
                st, note = "na", "הסרטון נערך בלי מואושן גרפיק"
            if src[1] in ("caption_face_overlap", "sync_lead", "sync_not_found", "sync_tail", "cards_in_motion") and f.get("captions_added") is False:
                st, note = "na", f.get("captions_note") or "הכתוביות צרובות במקור — אין שכבת כתוביות של דנה למדוד"
            rows.append(_row(cid, cat, text, st, basis, note))
        elif src[0] == "criterion":
            c = f["criteria"].get(src[1])
            if c is None or c.get("met") is None:
                rows.append(_row(cid, cat, text, "not_checked", "none", (c or {}).get("note") or "לא נבדק בגרסה הזו"))
            else:
                basis = {"check": "measured", "skill": "measured", "reviewer": "model"}.get(c.get("decided_by"), "model")
                st = "met" if c["met"] else "not_met"
                if f.get("captions_added") is False and src[1] in ("A10", "A11", "A13"):
                    st, c = ("na", dict(c, note="הכתוביות צרובות במקור")) if f.get("kind") != "review_only" else (st, c)
                rows.append(_row(cid, cat, text, st, basis, c.get("note")))
        elif src[0] == "fact":
            st, basis, note, t = _fact(src[1], f)
            rows.append(_row(cid, cat, text, st, basis, note, t))
        else:
            rows.append(_row(cid, cat, text, "not_checked", "human", "רק צפייה או האזנה שלך יכולה להכריע"))
    cats = []
    for key, label in CATEGORIES:
        mine = [r for r in rows if r["category"] == key]
        met, miss = sum(r["status"] == "met" for r in mine), sum(r["status"] == "not_met" for r in mine)
        decided = met + miss
        level = "לא נבדק" if not decided else next(name for th, name in LEVELS if met / decided >= th)
        cats.append({"key": key, "label": label, "level": level, "met": met, "decided": decided,
                     "not_checked": sum(r["status"] == "not_checked" for r in mine), "not_applicable": sum(r["status"] == "na" for r in mine),
                     "criteria": mine})
    return {"rubric_version": RUBRIC_VERSION, "kind": f.get("kind") or "edit", "categories": cats,
            "improvements": improvements(rows, f),
            "legend": {"basis": BASIS_HE, "levels": [n for _, n in LEVELS] + ["לא נבדק"]},
            "note": "הדירוג סופר כמה מהקריטריונים הקבועים שנבדקו מתקיימים. קריטריון שלא נבדק מסומן כך ואינו נספר. "
                    "הדירוג אינו ציון איכות כולל ואינו הבטחה לביצועים באינסטגרם.",
            "perception": f.get("perception") or "מדידות על הקובץ; הערכת מודל על תמלול ופריימים בודדים — המודל לא שמע את האודיו ולא צפה בתנועה."}


def improvements(rows, f):
    """What to improve, most important first. importance 1 = technical defect, 2 = content, 3 = preference."""
    out, seen = [], set()
    for x in f.get("findings") or []:
        key = (x.get("asset"), x.get("card"), x.get("problem"))
        if key in seen:
            continue
        seen.add(key)
        can = x.get("fix") in ("caption", "cover", "cards", "highlight", "spelling", "segment") and f.get("kind") != "review_only"
        blocking = x.get("severity") == "blocking"
        out.append({"id": "f:" + str(x.get("id")), "importance": 2 if blocking else 3, "kind": "content_decision" if x.get("fix") == "owner" else
                    ("technical_defect" if x.get("source", "").startswith(("check", "skill")) and blocking else "creative_preference"),
                    "category": {"caption": "message", "cover": "cover", "card": "captions", "highlight": "captions", "segment_start": "opening",
                                 "segment_end": "structure", "frame": "framing"}.get(x.get("asset"), "message"),
                    "problem": x.get("problem"), "correction": x.get("correction"), "evidence": x.get("evidence"), "time_s": x.get("time_s"),
                    "card": x.get("card"), "can_apply": can, "how": "דנה תתקן בגרסה הבאה" if can else "דורש החלטה שלך"})
    for r in rows:
        if r["status"] != "not_met" or any(o.get("criterion_id") == r["id"] for o in out):
            continue
        tech = r["category"] in TECHNICAL or r["basis"] == "measured"
        can, how = APPLY.get(r["id"], (False, "דורש החלטה שלך או חומר גלם אחר"))
        if f.get("kind") == "review_only" and r["id"] in BURNED_LOCKED and f.get("burned_in_text"):
            can, how = False, "הכתוביות צרובות בקובץ שהעלית — דנה לא יכולה לשנות אותן; נדרש חומר בלי כתוביות"
        out.append({"id": "c:" + r["id"], "criterion_id": r["id"], "importance": 1 if tech else 2,
                    "kind": "technical_defect" if tech else "creative_preference", "category": r["category"], "problem": r["criterion"] + " — לא מתקיים",
                    "correction": how, "evidence": r["note"], "time_s": r["time_s"], "card": None, "can_apply": can, "how": how})
    out.sort(key=lambda o: (o["importance"], not o["can_apply"]))
    return out


# criteria Dana can act on by herself in the next version, and how
APPLY = {
    "A1": (True, "נרמול עוצמה ליעד"), "A2": (True, "ניקוי רעש רקע עדין, עם בדיקה שהדיבור לא נפגע"),
    "C1": (True, "תיקון חשיפה עדין לפי המדידה"), "C2": (True, "תיקון חלקי של איזון לבן, עם שמירת גוון עור"),
    "K2": (True, "חלוקה מחדש של הכתובית או שתי שורות"), "K3": (True, "הזזת הכתוביות מהפנים"), "K4": (True, "איחוד כרטיסים קצרים"),
    "Y1": (True, "יישור הכתוביות למילים באודיו הסופי"), "Y3": (True, "הארכת הכתובית עד סוף המילה"), "Z1": (True, "הקטנת הזום או ביטולו"),
    "G1": (True, "הזזת הגרפיקה או הסרתה"), "O3": (True, "קיצור השקט בתחילת הסרטון"), "P2": (False, "קיצור שתיקה משנה את החיתוך — דורש אישור שלך"),
}
BURNED_LOCKED = {"K2", "K3", "K4", "K5", "K6", "Y1", "Y2", "Y3", "Y4"}


def compare(prev, cur):
    """Category levels of two reviews made with the SAME rubric, side by side. None when the rubrics differ."""
    if not prev or not cur or prev.get("rubric_version") != cur.get("rubric_version"):
        return None
    a = {c["key"]: c for c in prev["categories"]}
    return [{"key": c["key"], "label": c["label"], "before": {"level": a[c["key"]]["level"], "met": a[c["key"]]["met"], "decided": a[c["key"]]["decided"]},
             "after": {"level": c["level"], "met": c["met"], "decided": c["decided"]}} for c in cur["categories"] if c["key"] in a]


# ── "הביקורת הסופית של דנה": the last word on ONE delivered file ────────────────────────────────────
REVIEW_SKILL = {"name": "dana-review", "version": RUBRIC_VERSION, "what": "הקריטריונים הקבועים של הביקורת (12 קטגוריות)"}


def final(dana_review, skill_report, provenance, review_items, records, previous, target, base_skill):
    """Built AFTER the last correction round, from what was measured and assessed on the delivered file.

    It never adds a judgement of its own: it gathers the category review, the compliance with the skills that were
    applied, the coverage (how much was actually decided), what changed since the previous version, and ONE statement:
    does the edit need another fix, or is it ready for the owner to watch. That statement follows from failed mandatory
    checks and open items — never from a score. It is not an approval, and it says nothing about performance."""
    rows = [c for cat in dana_review["categories"] for c in cat["criteria"]]
    decided = [r for r in rows if r["status"] in ("met", "not_met")]
    by = lambda basis: {"met": sum(1 for r in decided if r["basis"] == basis and r["status"] == "met"), "decided": sum(1 for r in decided if r["basis"] == basis)}
    coverage = {"criteria": len(rows), "decided": len(decided), "met": sum(1 for r in decided if r["status"] == "met"),
                "not_checked": sum(1 for r in rows if r["status"] == "not_checked"), "not_applicable": sum(1 for r in rows if r["status"] == "na"),
                "measured": by("measured"), "frames": by("frames"), "model": by("model"),
                "human_only": [r["criterion"] for r in rows if r["basis"] == "human"],
                "note": "הסיכום סופר רק קריטריונים שנבדקו. מה שדורש האזנה או צפייה בתנועה אינו נספר ואין לו ציון."}
    failed = [r for r in records if r["status"] in ("fail", "review")]
    imps = dana_review.get("improvements") or []
    fixable = [i for i in imps if i.get("can_apply") and i.get("importance") == 1]
    sk = (skill_report or {}).get("summary")
    if failed or fixable:
        verdict, vtext = "needs_fix", "נדרש תיקון נוסף לפני צפייה"
    elif review_items:
        verdict, vtext = "needs_owner", "מוכן לצפייה שלך — עם פריטים שרק את/ה יכול/ה להכריע"
    else:
        verdict, vtext = "ready_for_viewing", "מוכן לצפייה שלך"
    reasons = ([f"בדיקה אוטומטית נכשלה: {r['id']} — {r['summary']}"[:260] for r in failed[:6]]
               + [f"שיפור טכני שדנה עוד יכולה ליישם: {i['problem']}"[:260] for i in fixable[:4]]
               + ([f"{len(review_items)} פריטים פתוחים שדורשים צפייה או האזנה שלך"] if review_items else []))
    if sk and not sk["fully_applied"]:
        reasons.append(f"הסקילים לא יושמו במלואם: {sk['applied']} כללים יושמו, {sk['not_followed']} לא יושמו, {sk['unsupported']} לא נתמכים, {sk['not_checked']} לא נבדקו")
    worked = [{"category": c["label"], "what": f"{c['met']} מתוך {c['decided']} קריטריונים שנבדקו מתקיימים"} for c in dana_review["categories"] if c["decided"] and c["met"] == c["decided"]]
    needs = [{"category": next(c["label"] for c in dana_review["categories"] if c["key"] == r["category"]), "criterion": r["criterion"], "evidence": r["note"],
              "time_s": r.get("time_s"), "basis": r["basis"]} for r in rows if r["status"] == "not_met"]
    needs += [{"category": "כללי הסקיל", "criterion": x["text"], "evidence": x["note"], "time_s": None, "basis": "model", "skill": x.get("skill")}
              for x in (skill_report or {}).get("rules") or [] if x["status"] == "not_followed"]
    unchecked = [{"criterion": r["criterion"], "why": "דורש צפייה או האזנה שלך" if r["basis"] == "human" else r["note"]} for r in rows if r["status"] == "not_checked"]
    unchecked += [{"criterion": x["text"], "why": x["note"], "skill": x.get("skill")} for x in (skill_report or {}).get("rules") or [] if x["status"] == "not_checked"]
    skills = [dict(REVIEW_SKILL, role="סקיל הביקורת")]
    if base_skill:
        skills.append({"name": base_skill.get("name"), "version": base_skill.get("version"), "role": "כללי העריכה הבסיסיים"})
    for x in ((skill_report or {}).get("skill") or {}).get("skills") or []:
        skills.append({"name": x.get("name"), "version": x.get("version"), "role": "סקיל מהספרייה" + (" (טיוטה בבדיקה)" if x.get("status") == "draft_test" else ""), "id": x.get("id")})
    return {"title": "הביקורת הסופית של דנה", "target": target, "reviewed_at": (provenance or {}).get("reviewed_at"), "file_sha256": (provenance or {}).get("final_sha256"),
            "on_delivered_file": (provenance or {}).get("on_delivered_file"), "rounds": (provenance or {}).get("review_rounds"),
            "skills": skills, "rubric_version": dana_review["rubric_version"],
            "categories": [{k: c[k] for k in ("key", "label", "level", "met", "decided", "not_checked")} for c in dana_review["categories"]],
            "skill_compliance": ({"summary": sk, "params_as_in_skill": sum(1 for x in skill_report["params"] if x["applied"]), "params_total": len(skill_report["params"]),
                                  "criteria_met": sum(1 for x in skill_report["criteria"] if x["met"] is True), "criteria_total": len(skill_report["criteria"])} if skill_report else None),
            "coverage": coverage, "summary": f"{coverage['met']} מתוך {coverage['decided']} קריטריונים שנבדקו מתקיימים; {coverage['not_checked']} לא נבדקו"
                                              + (f"; מכללי הסקילים יושמו {sk['applied']} מתוך {sk['applied'] + sk['not_followed'] + sk['not_applicable'] + sk['not_checked']} שנתמכים" if sk else ""),
            "worked": worked, "needs_improvement": needs, "not_checked": unchecked, "verdict": verdict, "verdict_text": vtext, "verdict_reasons": reasons,
            "verdict_basis": "נקבע לפי בדיקות אוטומטיות שנכשלו ופריטים פתוחים — לא לפי הדירוג לבדו.",
            "changes": changes(previous, dana_review),
            "limits": ["הערכת מודל נעשתה על תמלול ופריימים בודדים ויכולה להשתנות בין הרצות", "איש לא האזין לאודיו ולא צפה בתנועה",
                       "הדירוג אינו אישור פרסום ואינו מבטיח ביצועים באינסטגרם", "כל שינוי בסרטון הופך את הביקורת הזו ללא עדכנית"]}


def changes(previous, current):
    """Why a rating differs from the previous version's: criterion by criterion, with the same rubric. None when not comparable."""
    if not previous or previous.get("rubric_version") != current["rubric_version"]:
        return None
    before = {c["id"]: c["status"] for c in previous.get("criteria") or []}
    HE = {"met": "מתקיים", "not_met": "לא מתקיים", "not_checked": "לא נבדק", "na": "לא רלוונטי"}
    out = []
    for cat in current["categories"]:
        for c in cat["criteria"]:
            b = before.get(c["id"])
            if b and b != c["status"]:
                out.append({"category": cat["label"], "criterion": c["criterion"], "before": HE.get(b, b), "after": HE.get(c["status"], c["status"]),
                            "why": c["note"], "basis": c["basis"]})
    levels = {c["key"]: c for c in previous.get("categories") or []}
    return {"criteria": out, "categories": [{"label": c["label"], "before": levels[c["key"]]["level"], "after": c["level"]} for c in current["categories"]
                                             if c["key"] in levels and levels[c["key"]]["level"] != c["level"]],
            "note": "אותם קריטריונים בשתי הגרסאות. שינוי בקריטריון של הערכת מודל יכול לנבוע גם מהבדל בין הרצות, לא רק מהסרטון." if out else "אין שינוי באף קריטריון מול הגרסה הקודמת."}


def compact(dana_review):
    """What the next version needs in order to explain a change: every criterion's status, and the category levels."""
    return {"rubric_version": dana_review["rubric_version"],
            "categories": [{k: c[k] for k in ("key", "label", "level", "met", "decided")} for c in dana_review["categories"]],
            "criteria": [{"id": c["id"], "status": c["status"]} for cat in dana_review["categories"] for c in cat["criteria"]]}


def timeline(segments, dur, shift, cards, zooms, graphics, skill, audio_clean, target):
    """ONE timeline of the edit: for every stretch of the video - what is in the picture, which skill is responsible,
    how long, the text on screen, the sound, where the assets come from and how the stretch begins."""
    owner = lambda domain, fallback: next((r.get("skill") or (skill or {}).get("name") for r in (skill or {}).get("rules") or [] if r["domain"] == domain), fallback)
    BASE = "כללי העריכה הבסיסיים"
    scenes = sorted([g for g in graphics if g.get("layer") == "replaces_picture"], key=lambda g: g["tl_start_s"])
    cuts = sorted({0.0, round(dur, 3)} | {round(min(max(s["tl_in_s"] + shift, 0.0), dur), 3) for s in segments}
                  | {round(g["tl_start_s"], 3) for g in scenes} | {round(g["tl_end_s"], 3) for g in scenes})
    spans = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a < 0.04:
            continue
        mid = (a + b) / 2
        sc = next((g for g in scenes if g["tl_start_s"] <= mid < g["tl_end_s"]), None)
        seg = next((s for s in segments if s["tl_in_s"] + shift - 0.02 <= mid < s["tl_out_s"] + shift + 0.02), segments[-1])
        text = " ".join(c["plain"] for c in cards if a - 0.05 <= c["start"] + c["dur"] / 2 < b + 0.05)
        prev_scene = bool(spans) and spans[-1]["picture"] == "animation_scene"
        new_part = bool(spans) and spans[-1].get("part") != seg["n"]
        spans.append({
            "t0": a, "t1": b, "seconds": round(b - a, 2), "part": seg["n"],
            "picture": "animation_scene" if sc else "footage",
            "picture_label": f"קטע אנימציה במסך מלא: \"{sc['text']}\"" if sc else f"צילום מהמקור (חלק {seg['n']}, {seg['source_in_s']:.1f}–{seg['source_out_s']:.1f} שנ׳ בהקלטה)",
            "skill": owner("animation", BASE) if sc else owner("structure", owner("opening", BASE)),
            "text": text, "text_layer": "כתוביות" + (" + טקסט הסצנה" if sc else ""),
            "audio": "קול הדוברת מההקלטה — נמשך ברצף" + (", אחרי ניקוי רעש עדין" if (audio_clean or {}).get("applied") else "") + ", מנורמל לעוצמת היעד",
            "assets": "נוצר ב-HyperFrames מהמילים שנאמרו; אין נכס חיצוני" if sc else "קובץ המקור שהעלית",
            "transition_in": "פתיחת הסרטון" if not spans else "חיתוך ישר לסצנה (הקול ממשיך)" if sc else "חיתוך ישר חזרה לצילום" if prev_scene
                             else ("כרטיס סטורי חדש" if target == "story" else "חיתוך ישר בין חלקים, מעבר קול של 25ms") if new_part else "המשך רציף"})
    events = [{"t0": z["tl_t_s"], "t1": z["hold_until_s"], "kind": "zoom", "label": f"זום ×{z['scale']}", "layer": "on_footage", "skill": owner("zooms", BASE), "why": z.get("reason")} for z in zooms]
    events += [{"t0": g["tl_start_s"], "t1": g["tl_end_s"], "kind": g["kind"], "label": f"{g['label']}: \"{g['text']}\"", "layer": g["layer"], "id": g["id"],
                "skill": owner("motion_graphics", BASE), "why": g.get("reason"), "assets": "נוצר ב-HyperFrames מהמילים שנאמרו"} for g in graphics if g.get("layer") != "replaces_picture"]
    return {"spans": spans, "events": sorted(events, key=lambda e: e["t0"]), "duration": round(dur, 3),
            "note": "תוכנית עריכה אחת: כל הסקילים שנבחרו מוזגו לפני התכנון, ולכן אין שכבה שדורסת אחרת. 'על הצילום' = גרפיקה מעל הדוברת; 'מחליף את הצילום' = קטע אנימציה במסך מלא."}
