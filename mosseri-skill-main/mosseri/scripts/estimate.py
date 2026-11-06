#!/usr/bin/env python3
"""Rubric scores -> readiness (0-100) -> verdict, share direction, and (only with your own baseline) reach bands.

usage:
    python3 estimate.py scores.json
    echo '{"c":{"C1":4,"C2":3,"C3":4,"C4":3,"C5":4,"C6":5,"C7":5},"flags":[],"format":"feed"}' | python3 estimate.py -
    python3 estimate.py - --lang en            # English labels
    python3 estimate.py - --baseline path.json # use a specific baseline (default: $MOSSERI_HOME/baseline.json, ~/.mosseri/baseline.json)

input JSON:  {"c": {"C1".."C7": 0-5}, "flags": [...], "format": "feed"|"trial"|"carousel"|"story"|"caption"|"cover"}
             or a list of such objects.
output JSON: readiness, verdict, share direction, reach (base rates from YOUR reels if calibrated, otherwise
             "not predictable"), and an accuracy line that MUST be quoted in the review word for word.

Stdlib only. No network. Reads an optional baseline written by calibrate.py.
"""
import argparse, json, math, os, sys

WEIGHTS = {'C1': 25, 'C2': 20, 'C3': 20, 'C4': 15, 'C5': 10, 'C6': 5, 'C7': 5}
PENALTY = {'wordmark': 15, 'aggregated': 15, 'reupload': 20, 'unpaid_promise': 10, 'ai_slick': 5}
HARD_FLAGS = {'wordmark', 'aggregated', 'reupload'}
CALIBRATED_FORMATS = {'feed', 'trial'}

T = {
    'he': {
        'verdict': {'publish': 'לפרסם', 'fix': 'לתקן קודם', 'shelve': 'לגנוז'},
        'share': {'high': 'הציון מצביע על שיתוף מעל הרגיל שלך', 'mid': 'הציון מצביע על שיתוף בערך ברגיל שלך',
                  'low': 'הציון מצביע על שיתוף חלש. זה התיקון הראשון'},
        'reach_none': 'אי אפשר לנבא חשיפה מהציון. בבדיקה העיוורת הציון לא ניבא חשיפה בכלל.',
        'reach_base': 'אלה שיעורי הבסיס של הרילס שלך עצמך. הציון לא מזיז אותם, כי הוא לא ניבא חשיפה.',
        'no_cal_format': 'אין הערכת חשיפה או שיתוף לפורמט הזה. רק ציון ותיקונים.',
        'reach_labels': ['מתחת לרגיל שלך (פחות מ-{a})', 'בטווח הרגיל שלך (בין {a} ל-{b})', 'פריצה (מעל {b})'],
        'share_labels': ['נמוך (פחות מ-{a} שיתופים לחשיפה)', 'רגיל (בין {a} ל-{b})', 'גבוה (מעל {b})'],
        'acc_default': ('דיוק: בבדיקה עיוורת על 16 רילס של יוצר אחד, הציון לא ניבא חשיפה (מתאם 0.00), '
                        'אבל היה קשור לשיעור השיתוף (מתאם ספירמן בערך 0.5). מדגם קטן של חשבון אחד, '
                        'ולכן כיוון השיתוף הוא רמז ולא תחזית, וחשיפה לא מנובאת בכלל.'),
        'acc_own': ('דיוק בחשבון שלך ({n} רילס שנוקדו עיוור): מתאם הציון עם חשיפה {rr:+.2f}, '
                    'עם שיעור שיתוף {rs:+.2f}. {verdict}'),
        'acc_own_ok': 'הציון מזיז את טווחי השיתוף אצלך.',
        'acc_own_no': 'הקשר חלש מדי, ולכן טווחי השיתוף הם שיעורי הבסיס שלך.',
        'trial_note': 'טריאל מוצג לזרים בלבד, בדרך כלל לקהל קטן. התוצאה רועשת מאוד.',
    },
    'en': {
        'verdict': {'publish': 'publish', 'fix': 'fix first', 'shelve': 'shelve'},
        'share': {'high': 'the score points to above-your-usual sharing', 'mid': 'the score points to roughly your usual sharing',
                  'low': 'the score points to weak sharing. That is the first fix'},
        'reach_none': 'Reach cannot be predicted from the score. In the blind test the score did not predict reach at all.',
        'reach_base': "These are your own reels' base rates. The score does not move them, because it did not predict reach.",
        'no_cal_format': 'No reach or share estimate for this format. Score and fixes only.',
        'reach_labels': ['below your usual (under {a})', 'your usual range ({a} to {b})', 'breakout (over {b})'],
        'share_labels': ['low (under {a} shares per reach)', 'usual ({a} to {b})', 'high (over {b})'],
        'acc_default': ('Accuracy: in a blind test on 16 reels from one creator, the score did not predict reach '
                        '(correlation 0.00) but did relate to share rate (Spearman about 0.5). Small sample, one account, '
                        'so the share direction is a hint, not a forecast, and reach is not predicted at all.'),
        'acc_own': ('Accuracy on your account ({n} blind-scored reels): score vs reach {rr:+.2f}, '
                    'vs share rate {rs:+.2f}. {verdict}'),
        'acc_own_ok': 'The score moves your share bands.',
        'acc_own_no': 'The link is too weak, so share bands are your base rates.',
        'trial_note': 'Trial reels go to non-followers only, usually a small audience. Very noisy.',
    },
}


def readiness(c, flags, weights=WEIGHTS):
    tot = sum(weights.values())
    s = sum(weights[k] * max(0, min(5, int(c.get(k, 0)))) / 5 for k in weights) * 100 / tot
    s -= sum(PENALTY.get(f, 0) for f in flags or [])
    return max(0.0, min(100.0, s))


def verdict(r, flags):
    flags = set(flags or [])
    if flags & HARD_FLAGS or r < 50:
        return 'shelve'
    if r >= 75 and not flags:
        return 'publish'
    return 'fix'


def share_direction(r):
    # heuristic thresholds, taken from where the original single-creator fit crossed that creator's median share rate
    return 'high' if r >= 78 else ('mid' if r >= 60 else 'low')


def phi(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bands(mu, sd, cuts):
    lo, hi = math.log10(cuts[0]), math.log10(cuts[1])
    p_lo = phi((lo - mu) / sd)
    p_hi = 1 - phi((hi - mu) / sd)
    return [p_lo, 1 - p_lo - p_hi, p_hi]


def fmt_n(v):
    if v >= 1000:
        return f'{v / 1000:.1f}K'.replace('.0K', 'K')
    return str(int(round(v)))


def fmt_pct(v):
    return f'{v * 100:.1f}%'.replace('.0%', '%')


def load_baseline(path=None):
    cands = [path] if path else [os.path.join(os.environ.get('MOSSERI_HOME', ''), 'baseline.json')
                                 if os.environ.get('MOSSERI_HOME') else None,
                                 os.path.expanduser('~/.mosseri/baseline.json')]
    for p in cands:
        if p and os.path.exists(p):
            return json.load(open(p, encoding='utf-8'))
    return None


def estimate(inp, base=None, lang='he'):
    L = T[lang]
    fmt = inp.get('format', 'feed')
    flags = inp.get('flags', [])
    r = readiness(inp.get('c', {}), flags)
    v = verdict(r, flags)
    out = {'readiness': round(r, 1), 'verdict': L['verdict'][v], 'verdict_key': v, 'format': fmt,
           'calibrated': bool(base)}
    if fmt not in CALIBRATED_FORMATS:
        out['note'] = L['no_cal_format']
        return out
    out['share_direction'] = L['share'][share_direction(r)]
    if fmt == 'trial':
        out['trial_note'] = L['trial_note']
    key = 'trial' if fmt == 'trial' else 'reach'
    if base and base.get(key):
        m = base[key]
        a, b = m['cuts']
        p = bands(m['log_mu'], m['log_sigma'], m['cuts'])
        out['reach'] = [{'label': lab.format(a=fmt_n(a), b=fmt_n(b)), 'p': round(pp, 2)}
                        for lab, pp in zip(L['reach_labels'], p)]
        out['reach_note'] = L['reach_base']
    else:
        out['reach'] = None
        out['reach_note'] = L['reach_none']
    if fmt == 'feed' and base and base.get('share_rate'):
        s = base['share_rate']
        a, b = s['cuts']
        sm = base.get('share_model')
        if sm:
            mu = sm['a'] + sm['b'] * r
            sd = sm['sigma'] * math.sqrt(1 + 1 / sm['n'] + (r - sm['x_mean']) ** 2 / sm['sxx'])
        else:
            mu, sd = s['log_mu'], s['log_sigma']
        p = bands(mu, sd, s['cuts'])
        out['share_bands'] = [{'label': lab.format(a=fmt_pct(a), b=fmt_pct(b)), 'p': round(pp, 2)}
                              for lab, pp in zip(L['share_labels'], p)]
        # with your own bands, the direction follows the most likely band instead of the fixed thresholds
        out['share_direction'] = L['share'][['low', 'mid', 'high'][max(range(3), key=lambda k: p[k])]]
    chk = (base or {}).get('check')
    if chk:
        out['accuracy'] = L['acc_own'].format(n=chk['n'], rr=chk['rho_reach'], rs=chk['rho_shares'],
                                              verdict=L['acc_own_ok'] if base.get('share_model') else L['acc_own_no'])
    else:
        out['accuracy'] = L['acc_default']
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('src', nargs='?', default='-', help='scores JSON file, or - for stdin')
    ap.add_argument('--lang', choices=['he', 'en'], default=os.environ.get('MOSSERI_LANG', 'he'))
    ap.add_argument('--baseline', help='path to baseline.json from calibrate.py')
    a = ap.parse_args()
    data = json.load(sys.stdin if a.src == '-' else open(a.src, encoding='utf-8'))
    base = load_baseline(a.baseline)
    items = data if isinstance(data, list) else [data]
    res = [estimate(x, base, a.lang) for x in items]
    print(json.dumps(res if isinstance(data, list) else res[0], ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
