# Editing references for Dana

What Dana may learn from when she plans and reviews an edit. Text records only — **no media is
committed here**. A reference is something to learn from; its content, music, footage, fonts or
other assets are **never copied** into an edit without a recorded permission.

## Where things live

| Place | What | Who writes it |
|---|---|---|
| `references/editing/examples/` | One JSON record per reference that was reviewed and described (copy `reference.template.json`) | written after the owner added the reference; conclusions marked as observed or hypothesis |
| `references/editing/profiles/` | Proposed editing profiles: measurable parameters derived from references or from the owner's instructions | a proposal only — not a default |
| `references/editing/approved/` | Decisions the owner approved: these, and only these, become standing defaults | copied here after the owner's approval, with who and when |
| `references/editing/rejected/` | What the owner said not to do, with the reason | so it is not proposed again |
| server volume `DATA_DIR/dana/references.json` + `references/files/` | References the owner adds from the studio page (link or file + "what I liked") | the studio page; state `awaiting_analysis` |
| server volume `DATA_DIR/dana/profiles.json` | The profile the owner approved as default (taken from a package that was actually edited with it) | the studio page |
| server volume `DATA_DIR/dana/rules.json` | Standing rules ("כלל קבוע") from the owner's feedback | the studio page |

The repository folders hold the curated, reviewed knowledge. The server volume holds what the
owner adds while working. Nothing moves from "added" to "default" without the owner's approval.

## Status today

- Adding a reference with a note from the studio page: **works** (stored, listed, deletable).
- Analysing a reference and proposing a profile from it: **not implemented**. Every reference shows
  "ממתין לניתוח". No profile here was derived from a reference.
- The only profile in use is the worker's built-in one for the owner's current test style; it
  becomes the approved default only when the owner approves it from a finished package.

## The record of one reference

Use `reference.template.json`. Every field is required unless marked optional; write `null` and
list it under `unknown` rather than guessing.

- **source** — the file name or the link that is available, where it came from, and the **known**
  permission: `unknown` | `own` | `licensed` | `inspiration_only`. Unknown stays unknown.
- **content_type** and **fits_message** — what kind of content it is (testimonial, class moment,
  explanation…) and which messages it suits.
- **owner_note** — what the owner said they liked, in their words.
- **take** — what to take from it, each with example times in the reference and a practical rule
  an editor can execute and a check can measure:
  `pace`, `opening`, `cuts`, `captions`, `emphasis`, `zooms`, `sound`, `cover`.
- **do_not_imitate** — what must not be copied (content, wording, music, assets, another brand's
  identity) and what simply does not fit this studio.
- **hypotheses** — conclusions that were not verified (for example "works because of the fast
  opening"). A hypothesis is never applied as a rule.
- **status** — `awaiting_analysis` | `described` | `owner_approved` | `owner_rejected`, with who
  and when.

## Rules

1. No reference, score, audience insight or "what works" claim is invented. If the owner did not
   supply a reference, the edit proceeds on the rules the owner already approved.
2. Measured observations (cut times, caption size and position, zoom strength) are recorded as
   measurements with the method; impressions are recorded as hypotheses.
3. A package records which skill version, profile version, standing rules and references it was
   edited with (`rules_used`), so it is always possible to tell by which rules a video was made.
