"""Narration from an approved script, and dubbing, through ElevenLabs - PREPARED, NOT ACTIVE.

Nothing in this module runs by itself and nothing here has ever called the provider. A request is sent only when ALL of
these hold: the worker's configuration enables it (`tts.enabled`), the API key is present in the worker's environment
(`ELEVENLABS_API_KEY`), and the job carries the owner's explicit approval of the text and of a cost ceiling.

- The key lives only in the environment of the editing computer. It is never written to a file, a log, a job, a package
  or the panel; the panel only learns whether a key is present.
- The text is a SCRIPT. It is stored and shown as a script, never as a quotation of the people in the footage.
- A voice is chosen from the provider's voices. Cloning a person's voice is not offered here; dubbing is requested with
  voice cloning switched OFF unless the owner records the speaker's explicit permission.
- Hebrew is supported only by the newer models, so the model is always named in the request (the provider's default
  model does not list Hebrew).

Rates and limits below were read from the provider's public pages on 2026-11-16 and must be checked again before the
owner approves a cost; the estimate says so.
"""
import json
import os
import urllib.error
import urllib.request

from .core import PipelineError

API = "https://api.elevenlabs.io"
KEY_ENV = "ELEVENLABS_API_KEY"
HEBREW_MODELS = {"eleven_v3": 0.08, "eleven_v4": 0.08, "eleven_v4_turbo": 0.04}     # USD per 1,000 characters (API price page, read 2026-11-16)
DUBBING_USD_PER_MIN = {"v1": 0.50, "v2": 2.20}
MAX_CHARS = 5000
READ_ON = "2026-11-16"


def status(cfg):
    """What the panel may know: whether the connection is switched on and whether a key is present. Never the key."""
    t = cfg.get("tts") or {}
    key = bool(os.environ.get(KEY_ENV))
    on = bool(t.get("enabled"))
    return {"provider": "ElevenLabs", "enabled": on, "key_present": key, "active": on and key, "model": t.get("model") or "eleven_v3",
            "state": "active" if on and key else "prepared_not_active",
            "missing": [x for x, ok in (("מפתח API בסביבת מחשב העריכה (ELEVENLABS_API_KEY)", key), ("הפעלה בהגדרות העובד (tts.enabled)", on)) if not ok],
            "never_called": True if not (on and key) else None}


def estimate(text, model="eleven_v3", takes=1):
    """Cost of generating `text` - arithmetic only, no request is made."""
    n = len(text or "")
    rate = HEBREW_MODELS.get(model)
    if rate is None:
        raise PipelineError("tts_model_unsupported", f"הדגם {model} אינו ברשימת הדגמים שתומכים בעברית")
    usd = round(n / 1000 * rate * max(1, int(takes)), 4)
    return {"characters": n, "model": model, "usd_per_1000_chars": rate, "takes": max(1, int(takes)), "estimated_usd": usd, "within_request_limit": n <= MAX_CHARS,
            "basis": f"מחירון ה-API של ElevenLabs כפי שנקרא ב-{READ_ON}; יש לאמת מול הדף העדכני לפני אישור. נדרש מסלול בתשלום: המסלול החינמי אסור לשימוש מסחרי."}


def _approved(cfg, approval, est):
    st = status(cfg)
    if not st["active"]:
        raise PipelineError("tts_not_active", "חיבור ElevenLabs אינו פעיל: " + "; ".join(st["missing"]), False)
    if not isinstance(approval, dict) or not approval.get("by") or not isinstance(approval.get("max_usd"), (int, float)):
        raise PipelineError("tts_not_approved", "יצירת קריינות בתשלום דורשת אישור מפורש של הבעלים לטקסט ולתקרת עלות", False)
    if est["estimated_usd"] > float(approval["max_usd"]):
        raise PipelineError("tts_over_budget", f"העלות המוערכת ({est['estimated_usd']}$) גבוהה מהתקרה שאושרה ({approval['max_usd']}$)", False)


def synthesize(cfg, text, voice_id, out_path, approval, model=None):
    """ONE paid request for ONE approved script. Returns the record for the package. Not called without an approval."""
    model = model or (cfg.get("tts") or {}).get("model") or "eleven_v3"
    est = estimate(text, model)
    _approved(cfg, approval, est)
    if not est["within_request_limit"]:
        raise PipelineError("tts_text_too_long", f"הטקסט ארוך מ-{MAX_CHARS} תווים", False)
    req = urllib.request.Request(f"{API}/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128", method="POST",
                                 data=json.dumps({"text": text, "model_id": model, "language_code": "he"}).encode("utf-8"),
                                 headers={"xi-api-key": os.environ[KEY_ENV], "Content-Type": "application/json", "Accept": "audio/mpeg"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r, open(out_path, "wb") as f:
            f.write(r.read())
    except urllib.error.HTTPError as e:           # the provider's message is kept; the key is never part of it
        raise PipelineError("tts_failed", f"ElevenLabs החזיר {e.code}", e.code >= 500, detail=e.read()[:500].decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError) as e:
        raise PipelineError("tts_failed", f"לא ניתן היה להגיע ל-ElevenLabs: {type(e).__name__}", True)
    return {"provider": "ElevenLabs", "model": model, "voice_id": voice_id, "characters": est["characters"], "estimated_usd": est["estimated_usd"], "approved_by": approval["by"],
            "approved_max_usd": approval["max_usd"], "text_is": "script", "file": str(out_path)}


def voices(cfg):
    """The provider's voices with their ready-made preview links. A read-only request; made only when the connection is active."""
    if not status(cfg)["active"]:
        raise PipelineError("tts_not_active", "חיבור ElevenLabs אינו פעיל", False)
    req = urllib.request.Request(f"{API}/v2/voices?page_size=50", headers={"xi-api-key": os.environ[KEY_ENV]})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read().decode("utf-8"))
    return [{"voice_id": v.get("voice_id"), "name": v.get("name"), "preview_url": v.get("preview_url"), "labels": v.get("labels")} for v in data.get("voices") or []]
