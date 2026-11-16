"""The rules that are actually in force for ONE job - what the style, the approved skills and the target decided.

The planner, the editor and the reviewer are all given the same statement, so that nobody asks for something the job
cannot contain (a highlight the skill switched off, a cover text on a target that has none) and no correction round is
spent on a request that can never be met. A finding that contradicts a rule in force is not passed on; it is recorded
with the reason, so nothing is hidden.

Also here: what one revision may not undo (spelling choices already made), and when a finding stops being sent to the
editor (one attempt; a second one only when the first changed something).
"""
import re

HEB = "֐-׿"


def build(style, tspec, target, skill=None):
    """-> {"highlight", "cover_text", "post_caption", "lines" (for the model), "notes" (Hebrew, for the owner), "na" {criterion id: note}}"""
    who = f"הסקיל \"{skill['name']}\"" if skill and "highlight_enabled" in ((skill.get("param_sources") or {})) else "סגנון הפרויקט"
    eff = {"highlight": bool(style.get("highlight_enabled", True)) and bool(style.get("captions_enabled", True)),
           "cover_text": bool(tspec.get("cover_text", True)) and bool(style.get("captions_enabled", True)),
           "post_caption": bool(tspec.get("post_caption", True)), "target": target, "lines": [], "notes": [], "na": {}}
    if not eff["highlight"]:
        eff["lines"].append("Highlighting (a second colour on chosen words) is SWITCHED OFF for this job by the approved style. Cards carry no highlight. "
                            "Do not plan, add or request a highlight, and do not report its absence.")
        eff["notes"].append(f"הדגשה בצבע שני כבויה בגרסה הזו ({who}). לא נדרשת הדגשה ולא נבדקת.")
        eff["na"]["A10"] = f"לא רלוונטי: הדגשה בצבע כבויה ({who})"
    if not eff["cover_text"]:
        why = "ליעד סטורי אין קאבר עם טקסט" if target == "story" else "לקאבר אין שכבת טקסט בגרסה הזו"
        eff["lines"].append("This output has NO cover text (the target defines none). The cover text stays empty. Do not plan, write or request a cover "
                            "quotation, and do not report the empty cover text.")
        eff["notes"].append(why + ". לא נדרש ציטוט לקאבר ולא נבדק.")
        eff["na"]["A3"] = eff["na"]["A9"] = "לא רלוונטי: " + why
    return eff


def not_applicable(finding, eff):
    """A reviewer finding that asks for something a rule in force excludes -> the reason (Hebrew), else None."""
    if not eff:
        return None
    asset, fix = finding.get("asset"), finding.get("fix")
    text = f"{finding.get('problem', '')} {finding.get('correction', '')}"
    if not eff["highlight"] and (asset == "highlight" or fix == "highlight" or (re.search("הדגש", text) and re.search("צהוב|צבע", text))):
        return eff["notes"][0] if eff["notes"] else "הדגשה כבויה"
    if not eff["cover_text"] and (asset == "cover" or fix == "cover") and re.search("ריק|ציטוט|טקסט|חסר", text):
        return next((n for n in eff["notes"] if "קאבר" in n), "אין קאבר עם טקסט")
    return None


# ── spelling choices are kept from one revision to the next ─────────────────
def keep_spellings(new_dec, kept):
    """`kept`: the orthography choices earlier rounds made ({"heard", "shown", "reason"}; the same speech, written in the form the
    second transcription wrote). A revision that wrote the earlier form again is put back - in the card texts and in "spelling".
    Returns the list of choices that had to be restored. Only whole words are replaced; nothing else in a card changes."""
    restored = []
    have = {(s["heard"], s["shown"]) for s in new_dec.get("spelling") or []}
    for s in kept or []:
        pat = re.compile(rf"(?<![{HEB}]){re.escape(s['heard'])}(?![{HEB}])")
        touched = False
        for c in new_dec.get("cards") or []:
            if pat.search(c["text"]):
                c["text"] = pat.sub(s["shown"], c["text"])
                c["highlight"] = [pat.sub(s["shown"], h) for h in c.get("highlight") or []]
                touched = True
        cov = new_dec.get("cover") or {}
        if cov.get("text") and pat.search(cov["text"]):
            cov["text"], touched = pat.sub(s["shown"], cov["text"]), True
        if (s["heard"], s["shown"]) not in have:
            new_dec.setdefault("spelling", []).append(dict(s))
            have.add((s["heard"], s["shown"]))
        if touched:
            restored.append(f"'{s['heard']}' → '{s['shown']}'")
    return restored


# ── one attempt per finding ─────────────────────────────────────────────────
def topic(f):
    """What a finding is ABOUT, stable across rounds (the reviewer gives a restated finding a new id)."""
    return (f["source"], f["key"]) if f["source"] != "reviewer" else ("reviewer", f["asset"], f["fix"])


def exhausted_after(sent_prev, verification):
    """Topics the editor was asked about and did not fix: {topic: reason}. They are not sent again."""
    by_id, out = {f["id"]: f for f in sent_prev or []}, {}
    for v in verification or []:
        f = by_id.get(v["id"])
        if f is not None and v["status"] == "not_fixed":
            said = v.get("editor_said") or "העורך לא דיווח מה עשה"
            out[topic(f)] = (f"נשלחה לעורך פעם אחת ולא נפתרה. העורך דיווח: \"{said}\". "
                             + (f"הבדיקה מצאה: \"{v['evidence']}\"." if v.get("evidence") else "המדידה החוזרת מצאה שהבעיה נשארה."))[:500]
    return out


def same_edit(a, b):
    """Did a revision change anything the viewer or the owner would see?"""
    pick = lambda d: ([(c["text"], tuple(c.get("highlight") or [])) for c in d.get("cards") or []], (d.get("cover") or {}).get("text"),
                      (d.get("caption") or {}).get("text"), (d.get("caption") or {}).get("cta"), (d.get("segment") or {}).get("in_s"), (d.get("segment") or {}).get("out_s"))
    return pick(a) == pick(b)
