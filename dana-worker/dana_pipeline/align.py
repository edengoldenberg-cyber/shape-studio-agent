# -*- coding: utf-8 -*-
"""Alignment of caption cards to the FINAL spoken words, with an uncertainty.

Why Whisper word starts are not enough: faster-whisper derives word times from
cross-attention, and a word that follows a pause absorbs the pause — its stamp begins
where the previous word ended. The word is spoken somewhere INSIDE the stamped interval,
usually at its end. Word ENDS are not affected.

Reference used here, from tools already installed:
  1. Whisper interval of the word (which word, and the window it was spoken in).
  2. Silero VAD (neural speech detector shipped with faster-whisper): speech segments.
     A segment that begins inside the interval marks where speech resumes after a pause.
  3. Level envelope: first sustained sound after a quiet stretch inside the interval.
The onset is taken from (2). (3) is an independent second measurement: their distance
is reported as the uncertainty. With no pause inside the interval the Whisper start is
used as is. Nothing here changes or relaxes the locked sync check — it produces a
separate, reviewable record.
"""
import wave

import numpy as np

ONSET_DB, ONSET_HOLD = -28.0, 0.06
MIN_PAUSE_S = 0.15            # a VAD gap shorter than this is not treated as a pause


class Alignment:
    def __init__(self, wav16k, min_silence_ms=100):
        with wave.open(str(wav16k), "r") as wf:
            self.sr, nch = wf.getframerate(), wf.getnchannels()
            x = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)
        if nch == 2:
            x = x[::2]
        self.x = x.astype(np.float32) / 32768.0
        from faster_whisper import vad
        ts = vad.get_speech_timestamps(self.x, vad.VadOptions(min_silence_duration_ms=min_silence_ms, speech_pad_ms=0,
                                                              min_speech_duration_ms=60))
        self.speech = [(t["start"] / self.sr, t["end"] / self.sr) for t in ts]
        win = int(0.01 * self.sr)
        n = len(self.x) // win
        fr = self.x[:n * win].reshape(n, win)
        self.db = 20 * np.log10(np.sqrt((fr ** 2).mean(axis=1)) + 1e-9)

    def envelope_onset(self, t0, t1):
        """First sustained sound after a quiet stretch inside [t0, t1]; None when there is no quiet stretch."""
        need = int(ONSET_HOLD / 0.01)
        a, b = max(0, int(t0 / 0.01)), min(len(self.db), int(t1 / 0.01))
        seg = self.db[a:b]
        quiet = next((k for k in range(len(seg) - need) if (seg[k:k + need] <= ONSET_DB).all()), None)
        if quiet is None:
            return None
        for k in range(quiet, len(seg) - need):
            if (seg[k:k + need] > ONSET_DB).all():
                return round(t0 + k * 0.01, 3)
        return None

    def onset(self, word):
        """Reference onset of one heard word: {t, uncertainty_s, method, evidence}."""
        ws, we = word["start"], word["end"]
        ev = {"whisper_start": ws, "whisper_end": we, "whisper_word_s": round(we - ws, 3)}
        prev_end = max((e for s, e in self.speech if e <= ws + 0.05), default=None)
        for s, e in self.speech:
            if ws + 0.05 < s < we:                              # speech resumes inside the stamp
                gap = s - max([pe for ps, pe in self.speech if pe <= s] or [0.0])
                if gap < MIN_PAUSE_S:
                    continue
                env = self.envelope_onset(max(0.0, ws - 0.05), we)
                ev.update(vad_onset=round(s, 3), envelope_onset=env, silence_before_s=round(gap, 3),
                          silence_inside_stamp_s=round(s - ws, 3))
                unc = abs(s - env) if env is not None else 0.10
                return {"t": round(s, 3), "uncertainty_s": round(max(unc, 0.02), 3),
                        "method": "vad+envelope" if env is not None else "vad", "evidence": ev}
        if ws < 0.06 and self.speech and self.speech[0][0] < we:   # the clip starts before the first word
            s = self.speech[0][0]
            ev.update(vad_onset=round(s, 3))
            return {"t": round(s, 3), "uncertainty_s": 0.05, "method": "vad", "evidence": ev}
        ev["prev_speech_end"] = prev_end
        return {"t": ws, "uncertainty_s": 0.05, "method": "whisper", "evidence": ev}
