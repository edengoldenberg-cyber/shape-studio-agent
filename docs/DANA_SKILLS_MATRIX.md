# Dana — integration matrix of the 13 installed ig-* skills

Status on 2026-11-15. "Active" means the skill's content or tool is actually used by a running
component in the Reel workflow and that use was exercised in a local run. An installed folder or a
copied text alone is never counted as a capability.

How a skill can reach Dana at all: the worker's model calls run with no tools and with skills
disabled. A skill therefore contributes in exactly two ways —
(1) selected sections, extracted by `dana-worker/instructions/build_bundle.py` into the versioned,
hash-verified bundle that is appended to the planner/editor system prompt;
(2) a measuring script that the worker executes itself on a text, pinned by hash in the manifest.

| Skill | Responsibility in Dana | Executed by | Input → output | Integration |
|---|---|---|---|---|
| **ig-repurpose** | Choosing stand-alone excerpts from long footage | Planner / editor model call (bundle sections "Extract, do not summarise", "Then build the week") | transcript → segment, message, brief | **Active** (instructions). Its weekly-plan output is not used |
| **ig-reel** | What makes a short video hold: opening, one idea, on-screen text rules | Planner / editor (bundle sections "The shape", "On-screen text", "Rules"); reflected in review criteria A5–A7, A10 | transcript → cards, opening/ending choice | **Active** (instructions only). `hookscore.py` / `beats.py` are **not run**: no Hebrew hook score, durations are 165-wpm estimates |
| **ig-caption** | Caption shape and rules; measurable caption checks | Planner / editor (bundle); **`caption.py --json` executed in the review stage** | caption text → length, first-line window, links, hashtag count (criterion A4) | **Active** (instructions + tool). Hebrew: "one ask" and "concrete hook" are reported UNSUP and are not used |
| **ig-human** | Typographic fingerprints in the caption (invisible characters, em dashes) | **`detect.py --json` executed in the review stage** | caption text → counts → advisory finding | **Active** (measurement only). No "human score" in Hebrew; `humanize.py` is not run |
| **ig-plan** | Weekly content plan and engagement list | — | — | **Deferred.** The calendar in Dana is technical scheduling (a proposed time per package), not content planning |
| **ig-story** | Story sequences and stickers | — | — | **Deferred.** No story output; stickers are not available through an API |
| **ig-carousel** | Carousel copy and slides | — | — | **Deferred.** The skill has no renderer and no RTL guidance |
| **ig-viral** | Reference research in the niche | — | — | **Deferred.** Needs an attended browser session or manual paste |
| **ig-audit** | Reading results of published posts | — | — | **Deferred.** The metrics adapter exists but only against the mock API; no real insights to audit |
| **ig-reply** | Replies to comments on own posts | — | — | **Deferred** (community management is out of scope) |
| **ig-comment** | Comments on other accounts | — | — | **Deferred** |
| **ig-dm** | Direct messages | — | — | **Deferred** |
| **ig-profile** | Profile audit and rewrite | — | — | **Deferred** (one-off, outside the Reel workflow) |

Preserved limits (enforced in `instructions/local_rules.md`, the validators and the tests): no hook /
human / readiness score is produced or used as a gate; no brand voice, audience, offer or price is
invented; reading durations are measured from the rendered file, never estimated from word counts.

Versioning: `dana-worker/instructions/bundle.manifest.json` records the bundle version, the sha256 of
each source skill file and of each executable skill script. A changed bundle is refused; a changed
script is not run (the check is reported as not run, never as passed).
`python -X utf8 dana-worker/instructions/build_bundle.py --check` reports drift from the installed skills.
