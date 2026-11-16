# Dana — fixes after the round-4 acceptance run (2026-11-16)

Not deployed. Publishing and real notifications are off. Test data and test approvals only (`שחקן בדיקה (Claude) — לא הבעלים`).
The number of correction rounds was NOT raised.

## What was wrong and what was changed

| # | Fault found in the acceptance run | Change | Where |
|---|---|---|---|
| 1 | The reviewer asked for a highlight the skill had switched off, and for a cover text on a story; the editor "added" them every round | One statement of the rules IN FORCE goes to the planner, the editor and the reviewer. The criterion becomes "not applicable" (neither met nor failed). A finding that asks for the opposite is recorded with the reason and never sent to the editor | `effective.py`, `editorial.py`, `judgement.py`, `story.py`, `review.py` |
| 2 | Captions ran over the full-frame animation scene and repeated its text | Cards are cut at the edges of the words the scene shows; a card whose words are all in the scene is not drawn over it. A card with any other word stays drawn | `motion.isolate_scene_words`, `motion.cards_in_scenes`, `run.py` |
| 3 | A spelling fix came back in the next round | Choices already made stay allowed, are given to the editor, and are put back by code if a revision drops them (reported). Only orthographic variants of the SAME word; nothing is chosen between different words | `effective.keep_spellings`, `run.py` |
| 4 | "בלי מוזיקת רקע" was listed as an unsupported capability | A prohibition in an area the worker never adds anything to (music, sound effects, B-roll, transition effects) is an active rule, checked in every version against what was actually put into the file | `services/dana_skills.js`, `skillgen.report` |
| 5 | 17 cards under 0.5 s; joins were made and then undone | The words are divided by MEASURED line width (same words, same order), considering every division of a run of speech. A card that still flashes by stays reported, with the measured reason, as a decision for the owner | `captions.regroup/text_px`, `run.py`, `editorial.py` |
| 6 | All 4 rounds were used on findings that could not be fixed | A finding the editor was asked about and did not fix is not sent again, even restated; an identical revision stops the loop. The reason is stored and shown | `effective.exhausted_after/same_edit`, `run.py`, page |

Diagnosis for 5: at caption size 96–100 on ONE line the reel's safe zone allows a centred line of 620 px (about 11
characters), and the speech is continuous (no gaps to borrow time from). In the reel no other division of the words
helps (14 short cards before, 14 after); in the story (960 px) one card remains. It is a real conflict between size,
"one line only" and the safe width — a decision for the owner: smaller captions, two lines, or accept.

## Acceptance: path and quality are reported separately

`scripts/dana_e2e_round4.cjs` now prints three things:
- **PATH** — did every step of the flow do what it should (checks A–E and the regression checks R);
- **QUALITY GATE** — a MEASURED violation of a mandatory skill rule in a delivered file fails the acceptance
  (a model assessment alone, with no measurement behind it, does not);
- **PRODUCT** — what Dana's final review says about each output, as it is.

A measured mandatory-rule violation also sets the final review to "נדרש תיקון נוסף" (`review.final`).

## Tests

| Suite | Result |
|---|---|
| Worker unit tests (incl. `test_fixes_round4.py`, 20 new) | 149 / 149 |
| Server Jest, Dana suites (incl. the prohibition test) | 131 / 131 |
| Page check, round-4 screens (desktop + phone) | 43 / 43 on the new data |
| Page check, general | 109 / 109 on the new data |
| Acceptance re-run, affected parts only (`--skip=b,c9`) | PATH 50 / 54, QUALITY GATE pass |

The 4 PATH failures of that re-run: three were stale expectations of the script itself (it still expected "בלי מוזיקת
רקע" to be unsupported) and were corrected; one was real — in the reel two captions that straddled the edge of the
scene were still drawn over it. That was fixed (cards are cut at the scene edges) and the reel alone was produced again
(`scripts/dana_rerun_output.cjs`): the scene words are not drawn, the neighbouring words are.

Not re-run: the full Jest suite and the Barak / Tomer harnesses. Run them before any deploy.

## Before / after on the same clip (data kept side by side)

| | Before (`e2e-round4`) | After (`e2e-round4b`) |
|---|---|---|
| Review rounds per output | 4 (stopped: no progress) | 2 (stopped: nothing left to send) |
| Time per output | ~18.5 min | ~8.5–9.5 min |
| Spelling fix | came back in round 2 | fixed once, stayed |
| Story: "cover is empty" finding | every round, blocking | none; criterion not applicable |
| Text shown twice during the scene | yes | no (reel v2) |
| "בלי מוזיקת רקע" | unsupported | prohibition kept (measured) |

## Still open — needs the owner's eyes or ears

- Both outputs still say "נדרש תיקון נוסף": `sync_lead` (the pipeline's second measurement marks most as suspected false
  positives of the Whisper timestamps), `energy_gate` (words that may not have been said) and `caption_text`
  ("כן" heard with no card, "והמקום / המקום"). None can be settled without listening.
- The 14 short cards in the reel (the size / one line / width conflict above).
- "עם / אם": words that sound the same. The editor chose "אם" by context in the story and it is reported as an item.
  Listening cannot decide between them; whether such a choice should wait for the owner is the owner's call.
- The opening title sits close to the speaker's hair and repeats the caption under it (the reviewer says so; taste).
- Reel v1 of the re-run failed `caption_face_overlap` on one card; reel v2 passed it. Not investigated further.

## Not exercised in a real edit

- "The skill switched highlighting off": in the re-run the model drafted a skill that leaves highlighting on, so this
  case is proven by unit tests only.
- Nobody listened to anything or watched motion.
