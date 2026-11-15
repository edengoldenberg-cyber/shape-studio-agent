---
name: dana-editing
version: 0.1.0
description: The rules Dana edits a short vertical video by - content plan, captions, zooms, cover, caption text, review. Loaded by the worker pipeline (dana_pipeline/story.py) into planning and review, and stamped into every package.
status: built-in defaults. Only items listed under "Owner-approved" are approved by the owner; everything else is a working default that the owner can change.
---

# Dana editing skill

This file is used in three places, and a package records its version and hash:
1. **Planning** - the text below is given to the content planner (message, segments, zooms, cover).
2. **Rendering** - the numbers come from the editing profile (`profiles/*.json`); the renderer reads them.
3. **Review** - the measurable acceptance criteria at the end are checked by code on the finished file.

Installing or editing this file proves nothing. A package proves it by carrying `rules_used` with this
file's hash and by the checks listed under "Measured acceptance".

## Owner-approved (2026-11-15)

- Captions for the current test style: **Heebo Bold, large and prominent, horizontally centred, in the
  centre area of the frame**; they must not hide the face or important information.
- Zooms are chosen for key moments and sentences that strengthen the message, never at fixed intervals
  or to fill a quota. Footage that does not suit a zoom stays without one.
- Several parts of the recording may be joined when that serves the story, keeping context, meaning and
  an understandable flow.
- Nothing is invented: not words the person did not say, not brand details, prices or offers.
- An automatic transcript is never presented as an exact quotation.
- Price, offer and call-to-action appear only when approved in the brand settings.

## Content plan

- One message per video, stated in one sentence, in the speaker's sense.
- Open on the line that makes a stranger want the next sentence. A self-introduction ("I am ...") is
  rarely the strongest opening; it may be left out or moved when the statement stays true and clear.
- Do not name a private person in the caption text or on the cover, even when a name is heard.
- A part starts and ends at sentence or clause boundaries, never inside a word.
- Never join halves of different statements into a claim nobody made; never drop a negation or condition.
- Keep a record: source times of every part, what was left out and why.

## Captions (burned in)

- Exactly the spoken words of the chosen parts, in order. The only edits are the owner's corrections.
- 1-3 words per line, at most two lines per card, broken where a person pauses.
- Highlight only the few words that carry the message.
- Position: the profile's preferred height, moved only as far as needed to stay clear of the measured
  face area and inside the working safe zone.
- A card stays on screen long enough to read (profile: `min_on_screen_s`, `max_chars_per_s`).

## Zooms

- Ease in, then hold. The zoom ends with a cut back to the wide frame at the end of the thought or at the
  next cut. An animated zoom-out is a fault.
- Not in the first two seconds: the viewer needs the wide frame first.
- Centred on the measured face so the face is never cropped.
- Strength: light for emphasis, medium for a turn in the story, strong at most once per video.
- The 4K source is scaled once to the output size at the zoom level, so a zoom does not upscale.

## Cover and caption text

- Cover text is 2-5 words quoted exactly from the video that carry the message. The cover frame is taken
  from the moment those words are said.
- The published cover through the API is a frame WITHOUT the text layer (see docs/DANA_INSTAGRAM_CONTRACT.md).
- The caption text is separate from the transcript. Without an approved brand voice it is a plain draft,
  marked as a draft. No CTA, price or promise that is not in the brand settings.

## Review

- The reviewer reads transcripts, captions and check results and sees a few still frames. It does not
  hear audio and does not see motion; findings say which of these they rest on.
- Automatic faults that code can fix are fixed and re-checked, not passed to the owner.
- What reaches the owner is split into: technical failure, listening doubt, content decision, style preference.

## Measured acceptance (checked by code on the finished file)

| id | criterion | how |
|---|---|---|
| E1 | caption font family, weight and size equal the profile | rendered card pages + style record |
| E2 | every caption inside the working safe zone and the frame | ink box of every card image |
| E3 | captions do not overlap the measured face area | face boxes on sampled frames vs caption band |
| E4 | every card on screen >= `min_on_screen_s` and <= `max_chars_per_s` | frames of the finished file |
| E5 | captions appear with their words (lead <= 120 ms, tail >= 0) | second transcription of the final audio |
| Z1 | no zoom before `zoom_min_start_s`; zooms do not overlap | plan validation |
| Z2 | the face stays inside the frame during every zoom, with margin | face boxes on frames of the finished file |
| Z3 | every zoom has a recorded time, strength, duration and reason | package `zooms` |
| C1 | cuts between parts fall between words | source transcript vs cut times |
| C2 | cover text is an exact quotation from the chosen parts | text match |
| T1 | every low-confidence or disputed word is listed with its time for listening | package `transcript.doubts` |
