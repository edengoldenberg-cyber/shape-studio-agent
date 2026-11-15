# -*- coding: utf-8 -*-
"""Assemble Dana's instruction bundle from the installed ig-* skills.

    python -X utf8 build_bundle.py            write bundle.md + bundle.manifest.json
    python -X utf8 build_bundle.py --check    exit 1 when an installed skill changed since the build

How the skills reach Dana
  The Claude adapter runs with no tools and with skills disabled, so it cannot load a
  skill by itself. Instead THIS trusted script reads the installed skill files, takes
  only the named sections that apply to choosing and captioning a segment, removes every
  line that refers to tools, scores, files or other skills, appends the local rules
  (local_rules.md), and writes one bundle. The bundle is reviewed and committed; the
  worker loads the committed file and verifies its hash. The model never sees the skill
  folder and never gets file access.

What is deliberately left out: hook/human scoring, the 165 wpm timing estimates, voice
inference, numbered-example figures, posting, engagement routines, hashtags tools.
"""
import argparse
import hashlib
import json
import re
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILLS = Path.home() / ".claude" / "skills"
VERSION = "1.1.0"

# (skill, heading, keep-only regex or None)
SECTIONS = [
    ("ig-repurpose", "## Extract, do not summarise", None),
    ("ig-repurpose", "## Then build the week", r"stands completely on its own|has not seen the source|actual footage|Cut on the sentence"),
    ("ig-reel", "## The shape", r"decided in the first two seconds|HOOK|THE STAKE|THE PAYOFF|15 to 45 seconds|Under 7 seconds"),
    ("ig-reel", "## On-screen text is a separate script", r"Six words or fewer|hook card is up at frame 1|Burn in captions"),
    ("ig-reel", "## Rules that make the difference", r"One idea per Reel|Cut the intro|One ask at the end|Never fabricate"),
    ("ig-caption", "## First, decide which job this caption has", None),
    ("ig-caption", "## The shape", None),
    ("ig-caption", "## Rules", r"No link in the caption|One ask\.|Emoji as punctuation"),
]
# Lines that must never reach the model: tools, scores, files, other skills, invented figures.
DROP = re.compile(r"[Pp]ython|\.py\b|\.json\b|~/|/ig-|hookscore|[Ss]core|wpm|voice\.md|swipe|log\.md|\$\d|[Hh]ashtag|"
                  r"[Ll]inter|formula|\bREADY\b|Local setup|Running the tools")


def section(text, heading):
    lines = text.replace("\r\n", "\n").split("\n")
    try:
        i = next(k for k, l in enumerate(lines) if l.strip() == heading)
    except StopIteration:
        raise SystemExit(f"heading not found: {heading}")
    j = next((k for k in range(i + 1, len(lines)) if lines[k].startswith("## ")), len(lines))
    return lines[i + 1:j]


def paragraphs(lines):
    out, cur, fence = [], [], False
    for l in lines:
        if l.strip().startswith("```"):
            fence = not fence
            cur.append(l)
            continue
        if not l.strip() and not fence:
            if cur:
                out.append(cur)
            cur = []
        else:
            cur.append(l)
    if cur:
        out.append(cur)
    return out


def build():
    sources, chunks = {}, []
    for skill, heading, keep in SECTIONS:
        p = SKILLS / skill / "SKILL.md"
        raw = p.read_bytes()
        sources[skill] = {"path": f"~/.claude/skills/{skill}/SKILL.md", "sha256": hashlib.sha256(raw).hexdigest()}
        kept = []
        for para in paragraphs(section(raw.decode("utf-8"), heading)):
            if para[0].lstrip().startswith(("- ", "* ")):
                units = []                                   # judge list items one by one (with their continuation lines)
                for l in para:
                    if l.lstrip().startswith(("- ", "* ")) or not units:
                        units.append([l])
                    else:
                        units[-1].append(l)
            else:
                units = [para]                               # paragraphs, tables and code blocks stay whole
            for u in units:
                text = "\n".join(u)
                if DROP.search(text):
                    continue
                if keep and not re.search(keep, text):
                    continue
                kept.append(text)
        if kept:
            chunks.append(f"### From {skill} — {heading.lstrip('# ')}\n\n" + "\n\n".join(kept))
    local = (HERE / "local_rules.md").read_text(encoding="utf-8").replace("\r\n", "\n").strip()
    bundle = ("<!-- Dana instruction bundle v" + VERSION + ". Built by build_bundle.py from the installed ig-* skills. "
              "Review before committing. -->\n\n"
              "## Local rules (take precedence over everything below)\n\n" + local + "\n\n"
              "## Guidance extracted from the installed Instagram skills\n\n"
              "The examples in the skills are English and about other businesses; use the principle, never the example text or its figures.\n\n"
              + "\n\n".join(chunks) + "\n")
    sources["local_rules"] = {"path": "dana-worker/instructions/local_rules.md",
                              "sha256": hashlib.sha256((HERE / "local_rules.md").read_bytes().replace(b"\r\n", b"\n")).hexdigest()}
    # Skill scripts the worker is allowed to RUN (measurements only). Pinned by hash: a changed script is not run.
    tools = {rel: hashlib.sha256((SKILLS / rel).read_bytes()).hexdigest() for rel in ("ig-caption/caption.py", "ig-human/detect.py")}
    manifest = {"version": VERSION, "built": date.today().isoformat(), "bundle_sha256": hashlib.sha256(bundle.encode("utf-8")).hexdigest(),
                "sections": [[s, h] for s, h, _ in SECTIONS], "sources": sources, "tools": tools}
    return bundle, manifest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    bundle, manifest = build()
    man_p = HERE / "bundle.manifest.json"
    if a.check:
        old = json.loads(man_p.read_text(encoding="utf-8"))
        changed = [k for k, v in manifest["sources"].items() if old["sources"].get(k, {}).get("sha256") != v["sha256"]]
        if changed or old["bundle_sha256"] != manifest["bundle_sha256"]:
            print("instruction sources changed since the bundle was built:", ", ".join(changed) or "(bundle text)")
            print("review the skills, rebuild, review the diff of bundle.md, and commit.")
            return 1
        print(f"bundle v{old['version']} is up to date ({old['bundle_sha256'][:12]}…)")
        return 0
    (HERE / "bundle.md").write_text(bundle, encoding="utf-8", newline="\n")
    man_p.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote bundle.md ({len(bundle)} chars) and bundle.manifest.json — review the bundle before committing")
    return 0


if __name__ == "__main__":
    sys.exit(main())
