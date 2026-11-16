# Dana — how the editing works, and what is connected (2026-11-16)

Based on the code and on files a run produced, not on skill names. Branch `dana-phase-1a`, pipeline `1.1.0`.
Nothing here is deployed.

## Who does what

| | |
|---|---|
| **What Claude decides** (tool-free calls, JSON only, validated before use) | the content plan: message, opening, which parts of the recording and in what order, zoom moments, cover quote, motion graphics and their job (`story.py`); caption cards, highlights, the post-caption draft (`judgement.py`); the review of the result on text and stills (`editorial.py`); what a free-text request asks to change (`interpret.py`); the style analysis of a reference (`reference.py`); the review of an uploaded edit (`review_only.py`) |
| **What code decides** | every cut point (between words), caption timing from the final audio, caption position off the measured face, zoom focus, whether colour / sound need a correction and how much (`adjust.py`), where a graphic may sit, every check |
| **What renders** | ffmpeg 9.0.1 (cut, scale, zoom, colour, sound, overlay, encode); Chrome headless via the pinned `caption_layer.py` of the `ai-video-editor` skill (caption card PNGs); the HyperFrames CLI 0.9.26 (motion graphics as transparent PNG sequences) |
| **What transcribes** | faster-whisper large-v3 on the GPU, twice (with and without the silence filter) |
| **Where the server is** | it only coordinates: uploads, queue, versions, approvals. It never edits |

## Skills: what is loaded where

The worker's model calls run with tools and skills disabled, so a skill reaches Dana only as reviewed text or as a
script the worker runs itself.

| Stage | Skill material actually used |
|---|---|
| content plan | `dana-worker/skill/dana-editing/SKILL.md` (committed text, hash stamped in every package) |
| cards + post caption | `instructions/bundle.md`: selected sections of the installed `ig-repurpose`, `ig-reel`, `ig-caption` (hash-verified) |
| caption rendering | `ai-video-editor/scripts/caption_layer.py` (sha256 pinned in the worker config) |
| motion graphics | the installed `hyperframes` CLI. The composition is written by `motion.py` following the `hyperframes` skill's contract (one paused GSAP timeline, `class="clip"`, `fromTo`, transparent root, font via `@font-face`). The skill text itself is not loaded at run time |
| review | `ig-caption/caption.py`, `ig-human/detect.py` (measurements only, pinned by hash) |
| in this Claude Code session only | `hyperframes` (read before writing `motion.py`) |

Not used by the pipeline, although installed: `embedded-captions`, `talking-head-recut`, `motion-graphics`,
`hyperframes-registry`, `hyperframes-animation`, `hyperframes-audio`, `media-use`, `general-video`, and the ig-* skills
listed as deferred in `DANA_SKILLS_MATRIX.md`.

## Capability status

| Capability | Status | Evidence |
|---|---|---|
| Zooms | **exists, connected** (was already) | plan → `story.zoom_filter` → face-inside check on frames |
| Animated captions | **exists, connected now** | `captions.ANIMATIONS` (`fade`, `rise`): alpha fade-in + rise in the same ffmpeg pass; the on-screen pixel check understands the fade frames. Word-by-word (karaoke) animation: **missing** |
| Motion graphics | **existed unconnected → connected now** | HyperFrames renders `hook_title` / `key_phrase` to RGBA frames; overlaid in the final encode; check `graphics_rendered` on the finished file. Only exact quotations, only when the plan gives the graphic a job. Explanatory graphics (charts, diagrams): **missing** |
| Colour correction | **was missing in the pipeline → built and connected** | `adjust.plan_color`: measurement → gamma / contrast / channel gains / saturation, skin guard, off switch. ffmpeg filters only; no LUT, no grading tool |
| Sound cleanup | **partly existed (loudness) → cleanup connected** | `adjust.plan_audio`: high-pass + FFT noise reduction only when measured, speech-level guard. Loudness normalisation to −14 LUFS as before. No music, no de-reverb, no de-esser |
| B-roll (cutaways) | **missing** | no cutaway footage exists in any project folder; nothing was built. Needs the owner's footage and a rule for when it may be used |
| DaVinci Resolve | not connected (FCPXML only, manual) | unchanged |

## What Dana checks, and what she cannot

Checked by code on the finished file: caption words against the transcript, caption timing (locked sync rules),
captions inside the frame and the working safe zone and off the face, how long each card is on screen, what is really
on screen frame by frame, the face inside the frame during zooms, graphics present / in the safe zone / off the face,
format, loudness, colour measurements before and after, background noise between words, cuts between words, the
source file unchanged.

Assessed by a model on the transcript and a few stills: message, opening, structure, pace, whether the caption says
only what was said, cover, legibility in the stills.

Not checked by anyone but the owner: how the voice and the cleanup really sound, the feel of zooms and cuts in motion,
whether the colour looks right, whether an automatic transcript is correct (only listening verifies a word), the look
inside the Instagram app, and anything about performance.
