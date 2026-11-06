#!/usr/bin/env python3
"""OPTIONAL: build your own baseline from your own reels, and test the rubric on your own account.

Without this, the skill still reviews and gives a share direction; it just says honestly that reach
cannot be predicted. With it, the review shows YOUR base rates (what "usual" means for your account).

usage:
    python3 calibrate.py from-csv insights.csv          # Instagram/Meta Business Suite CSV export
    python3 calibrate.py from-graph [--limit 100]       # Instagram Graph API with YOUR token (env vars below)
    python3 calibrate.py check --scores scores.jsonl    # blind rubric scores of past reels -> does it work for you?
    python3 calibrate.py show                           # print the current baseline

Data is written to $MOSSERI_HOME (default ~/.mosseri): reels.jsonl (one line per reel) and baseline.json.
Nothing is uploaded anywhere. Stdlib only.

from-graph env vars (never commit them, never paste them into a chat):
    IG_ACCESS_TOKEN   a token for YOUR Instagram professional account (instagram_basic + instagram_manage_insights,
                      or the Instagram Login scopes instagram_business_basic + instagram_business_manage_insights)
    IG_USER_ID        your Instagram user id (with --host graph.instagram.com you can leave it empty = "me")
    IG_GRAPH_VERSION  optional, default v21.0

Only reels at least --min-age-days old (default 7) are used, so numbers have matured.
"""
import argparse, csv, datetime as dt, json, math, os, random, re, sys, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from estimate import readiness  # noqa: E402

HOME = os.environ.get('MOSSERI_HOME') or os.path.expanduser('~/.mosseri')
SHARE_FLOOR = 0.0005

COLS = {
    'reach': ['reach', 'accounts reached', 'טווח הגעה', 'חשבונות שהושגו', 'הגעה'],
    'shares': ['shares', 'שיתופים'],
    'views': ['views', 'plays', 'צפיות', 'הפעלות'],
    'saves': ['saves', 'saved', 'שמירות'],
    'date': ['publish time', 'published', 'date', 'timestamp', 'זמן פרסום', 'תאריך פרסום', 'תאריך'],
    'type': ['post type', 'media product type', 'type', 'סוג פוסט', 'סוג'],
    'permalink': ['permalink', 'link', 'url', 'קישור קבוע', 'קישור'],
    'caption': ['description', 'caption', 'תיאור', 'כיתוב'],
}


# ── small stats ─────────────────────────────────────────────────────────────
def pct(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    k = (len(xs) - 1) * q
    f = math.floor(k)
    c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)


def ranks(x):
    o = sorted(range(len(x)), key=lambda i: x[i]); r = [0.0] * len(x); i = 0
    while i < len(x):
        j = i
        while j + 1 < len(x) and x[o[j + 1]] == x[o[i]]:
            j += 1
        for k in range(i, j + 1):
            r[o[k]] = (i + j) / 2
        i = j + 1
    return r


def pearson(a, b):
    n = len(a); ma, mb = sum(a) / n, sum(b) / n
    sa = math.sqrt(sum((x - ma) ** 2 for x in a)); sb = math.sqrt(sum((y - mb) ** 2 for y in b))
    return 0.0 if sa == 0 or sb == 0 else sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (sa * sb)


def spearman(a, b):
    return pearson(ranks(a), ranks(b))


def perm_p(a, b, n=5000, seed=7):
    obs = spearman(a, b); rng = random.Random(seed); bb = list(b); hit = 0
    for _ in range(n):
        rng.shuffle(bb)
        if spearman(a, bb) >= obs - 1e-12:
            hit += 1
    return (hit + 1) / (n + 1)


def ols(x, y):
    n = len(x); mx, my = sum(x) / n, sum(y) / n
    sxx = sum((v - mx) ** 2 for v in x)
    b = sum((u - mx) * (v - my) for u, v in zip(x, y)) / sxx if sxx else 0.0
    a = my - b * mx
    sigma = math.sqrt(sum((v - (a + b * u)) ** 2 for u, v in zip(x, y)) / max(1, n - 2))
    return {'a': a, 'b': b, 'sigma': sigma, 'n': n, 'x_mean': mx, 'sxx': sxx}


def sig2(v):
    if v <= 0:
        return v
    d = 2 - int(math.floor(math.log10(abs(v)))) - 1
    return round(v, d)


def lognorm(vals):
    lv = [math.log10(v) for v in vals]
    mu = sum(lv) / len(lv)
    sd = math.sqrt(sum((v - mu) ** 2 for v in lv) / max(1, len(lv) - 1)) or 0.3
    return mu, sd


# ── io ──────────────────────────────────────────────────────────────────────
def shortcode(url):
    m = re.search(r'/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)', url or '')
    return m.group(1) if m else None


def num(v):
    if v is None:
        return None
    s = str(v).replace(',', '').replace('‏', '').strip()
    try:
        return float(s)
    except ValueError:
        return None


def parse_date(s):
    s = (s or '').strip()
    for f in ('%Y-%m-%dT%H:%M:%S%z', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d',
              '%m/%d/%Y %H:%M', '%m/%d/%Y', '%d/%m/%Y %H:%M', '%d/%m/%Y', '%d.%m.%Y %H:%M', '%d.%m.%Y'):
        try:
            d = dt.datetime.strptime(s, f)
            return d.replace(tzinfo=None)
        except ValueError:
            continue
    return None


def save_reels(rows):
    os.makedirs(HOME, exist_ok=True)
    p = os.path.join(HOME, 'reels.jsonl')
    with open(p, 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    return p


def load_reels():
    p = os.path.join(HOME, 'reels.jsonl')
    if not os.path.exists(p):
        sys.exit(f'no {p} yet. Run from-csv or from-graph first.')
    return [json.loads(l) for l in open(p, encoding='utf-8') if l.strip()]


def load_baseline():
    p = os.path.join(HOME, 'baseline.json')
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}


def save_baseline(b):
    os.makedirs(HOME, exist_ok=True)
    p = os.path.join(HOME, 'baseline.json')
    json.dump(b, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    return p


# ── baseline ────────────────────────────────────────────────────────────────
def build_baseline(rows, min_age, source):
    now = dt.datetime.now()
    mature = [r for r in rows if r.get('reach') and r['reach'] > 0
              and (r.get('date') is None or (now - dt.datetime.fromisoformat(r['date'])).days >= min_age)]
    use = [r for r in mature if not r.get('is_trial')]
    trials = [r for r in mature if r.get('is_trial')]
    if len(use) < 5:
        sys.exit(f'only {len(use)} usable feed reels (reach > 0, at least {min_age} days old). Need 5+, ideally 20+.')

    def dist(vals):
        mu, sd = lognorm(vals)
        return {'median': pct(vals, .5), 'p25': pct(vals, .25), 'p75': pct(vals, .75), 'log_mu': mu, 'log_sigma': sd,
                'cuts': [sig2(pct(vals, .25)), sig2(pct(vals, .75))], 'n': len(vals)}
    reach = [r['reach'] for r in use]
    b = load_baseline()
    b.update({'built': now.strftime('%Y-%m-%d'), 'source': source, 'n': len(use), 'min_age_days': min_age,
              'reach': dist(reach)})
    if len(trials) >= 5:
        b['trial'] = dist([r['reach'] for r in trials])
    else:
        b.pop('trial', None)
    sh = [max(SHARE_FLOOR, r['shares'] / r['reach']) for r in use if r.get('shares') is not None]
    if len(sh) >= 5:
        smu, ssd = lognorm(sh)
        b['share_rate'] = {'median': pct(sh, .5), 'p25': pct(sh, .25), 'p75': pct(sh, .75), 'log_mu': smu,
                           'log_sigma': ssd, 'cuts': [round(pct(sh, .25), 4), round(pct(sh, .75), 4)]}
    if len(use) < 15:
        b['warning'] = f'only {len(use)} reels: base rates are rough'
    return b


def report_baseline(b):
    r = b['reach']
    print(f"baseline from {b['n']} reels ({b['source']}, built {b['built']})")
    print(f"  feed reach: median {r['median']:.0f}, p25 {r['p25']:.0f}, p75 {r['p75']:.0f}; bands cut at {r['cuts']}")
    if b.get('trial'):
        t = b['trial']
        print(f"  trial reach ({t['n']} trial reels): median {t['median']:.0f}, bands cut at {t['cuts']}")
    if b.get('share_rate'):
        s = b['share_rate']
        print(f"  shares per reach: median {s['median'] * 100:.2f}%, p25 {s['p25'] * 100:.2f}%, p75 {s['p75'] * 100:.2f}%")
    if b.get('check'):
        c = b['check']
        print(f"  own check: n={c['n']}, score vs reach {c['rho_reach']:+.2f}, vs share rate {c['rho_shares']:+.2f} "
              f"(p {c['p_shares']:.3f}); share model used: {bool(b.get('share_model'))}")
    if b.get('warning'):
        print('  WARNING:', b['warning'])


# ── commands ────────────────────────────────────────────────────────────────
def cmd_from_csv(a):
    overrides = dict(kv.split('=', 1) for kv in (a.col or []))
    with open(a.file, encoding='utf-8-sig', newline='') as f:
        rd = csv.DictReader(f)
        heads = rd.fieldnames or []
        low = {h.strip().lower(): h for h in heads}
        col = {}
        for k, names in COLS.items():
            if k in overrides:
                col[k] = overrides[k]; continue
            col[k] = next((low[n] for n in names if n in low), None)
        if not col['reach']:
            sys.exit(f'no reach column found. Columns: {heads}\nUse --col reach="<column name>".')
        rows = []
        for row in rd:
            t = (row.get(col['type']) or '').lower() if col['type'] else ''
            if t and 'reel' not in t and 'ריל' not in t and 'video' not in t:
                continue
            d = parse_date(row.get(col['date'])) if col['date'] else None
            link = row.get(col['permalink']) if col['permalink'] else None
            rows.append({'shortcode': shortcode(link), 'permalink': link, 'date': d.isoformat() if d else None,
                         'reach': num(row.get(col['reach'])), 'shares': num(row.get(col['shares'])) if col['shares'] else None,
                         'views': num(row.get(col['views'])) if col['views'] else None,
                         'saves': num(row.get(col['saves'])) if col['saves'] else None,
                         'caption': (row.get(col['caption']) or '')[:300] if col['caption'] else ''})
    print(f'read {len(rows)} reels; columns used: { {k: v for k, v in col.items() if v} }')
    save_reels(rows)
    b = build_baseline(rows, a.min_age_days, 'csv')
    print('wrote', save_baseline(b)); report_baseline(b)


def graph_get(host, ver, path, params, token):
    q = urllib.parse.urlencode({**params, 'access_token': token})
    req = urllib.request.Request(f'https://{host}/{ver}/{path}?{q}', headers={'User-Agent': 'mosseri-skill/1.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def cmd_from_graph(a):
    token = os.environ.get('IG_ACCESS_TOKEN')
    if not token:
        sys.exit('שגיאה: לא מוגדר משתנה הסביבה IG_ACCESS_TOKEN. מגדירים אותו בטרמינל (export IG_ACCESS_TOKEN=..., לעולם לא בצ\'אט), יחד עם IG_USER_ID. ההסבר המלא: reference/calibration.md. בלי טוקן אפשר לכייל מקובץ CSV: calibrate.py from-csv')
    host = a.host
    ver = os.environ.get('IG_GRAPH_VERSION', 'v21.0')
    uid = os.environ.get('IG_USER_ID') or ('me' if host == 'graph.instagram.com' else None)
    if not uid:
        sys.exit('שגיאה: לא מוגדר משתנה הסביבה IG_USER_ID (המזהה של החשבון המקצועי שלך באינסטגרם). עם טוקן של Instagram Login מוסיפים --host graph.instagram.com ואז אפשר בלעדיו.')
    fields = 'id,caption,media_type,media_product_type,timestamp,permalink,is_shared_to_feed'
    page = graph_get(host, ver, f'{uid}/media', {'fields': fields, 'limit': 50}, token)
    media = []
    while page and len(media) < a.limit:
        media += [m for m in page.get('data', []) if (m.get('media_product_type') or '').upper() == 'REELS']
        nxt = (page.get('paging') or {}).get('next')
        if not nxt:
            break
        with urllib.request.urlopen(urllib.request.Request(nxt, headers={'User-Agent': 'mosseri-skill/1.0'}), timeout=30) as r:
            page = json.load(r)
    media = media[:a.limit]
    rows = []
    for m in media:
        vals, err = {}, 'empty response'
        for metrics in ('reach,shares,saved,views', 'reach,shares,saved'):
            try:
                ins = graph_get(host, ver, f"{m['id']}/insights", {'metric': metrics}, token)
                vals = {d['name']: (d.get('values') or [{}])[0].get('value', d.get('total_value', {}).get('value'))
                        for d in ins.get('data', [])}
                break
            except Exception as e:  # noqa: BLE001
                err = str(e)
        if not vals:
            print(f"  skip {m.get('permalink')}: insights unavailable ({err[:80]})")
            continue
        d = parse_date(m.get('timestamp'))
        rows.append({'shortcode': shortcode(m.get('permalink')), 'permalink': m.get('permalink'),
                     # trial reels are not shared to the feed; they go to non-followers only and have their own baseline
                     'is_trial': m.get('is_shared_to_feed') is False,
                     'date': d.isoformat() if d else None, 'reach': num(vals.get('reach')), 'shares': num(vals.get('shares')),
                     'views': num(vals.get('views')), 'saves': num(vals.get('saved')), 'caption': (m.get('caption') or '')[:300]})
    print(f"fetched {len(rows)} reels ({sum(r['is_trial'] for r in rows)} trial reels kept separate)")
    save_reels(rows)
    b = build_baseline(rows, a.min_age_days, 'graph')
    print('wrote', save_baseline(b)); report_baseline(b)


def cmd_check(a):
    reels = {r['shortcode']: r for r in load_reels() if r.get('shortcode')}
    pts = []
    for line in open(a.scores, encoding='utf-8'):
        if not line.strip():
            continue
        s = json.loads(line)
        sc = s.get('shortcode') or shortcode(s.get('permalink'))
        r = reels.get(sc)
        if not r or not r.get('reach'):
            continue
        rd = readiness(s['c'], s.get('flags', []))
        sh = max(SHARE_FLOOR, (r.get('shares') or 0) / r['reach'])
        pts.append((rd, r['reach'], sh))
    n = len(pts)
    if n < 8:
        sys.exit(f'only {n} scored reels matched your reels.jsonl. Score at least 15 (ideally 25+) mature reels.')
    x = [p[0] for p in pts]; reach = [p[1] for p in pts]; sh = [p[2] for p in pts]
    rr, rs = spearman(x, reach), spearman(x, sh)
    pr, ps = perm_p(x, reach), perm_p(x, sh)
    print(f'{n} reels. Spearman score vs reach {rr:+.2f} (one-sided p {pr:.3f}); vs shares per reach {rs:+.2f} (p {ps:.3f})')
    print(f'readiness range {min(x):.0f} to {max(x):.0f}')
    # shipping rule: a score-driven share model is used only if it beats the mean in leave-one-out error
    y = [math.log10(v) for v in sh]
    loo_m, loo_b = 0.0, 0.0
    for i in range(n):
        xs, ys = x[:i] + x[i + 1:], y[:i] + y[i + 1:]
        f = ols(xs, ys)
        loo_m += (y[i] - (f['a'] + f['b'] * x[i])) ** 2
        loo_b += (y[i] - sum(ys) / len(ys)) ** 2
    use = n >= 15 and rs > 0 and loo_m < loo_b
    b = load_baseline()
    if not b:
        sys.exit('no baseline.json yet. Run from-csv or from-graph first.')
    b['check'] = {'n': n, 'rho_reach': round(rr, 2), 'rho_shares': round(rs, 2), 'p_reach': round(pr, 3),
                  'p_shares': round(ps, 3), 'loo_mse_model': round(loo_m / n, 4), 'loo_mse_base': round(loo_b / n, 4),
                  'checked': dt.date.today().isoformat()}
    if use:
        b['share_model'] = ols(x, y)
        print('share model: USED (beats the base rate in leave-one-out). The score will move your share bands.')
    else:
        b.pop('share_model', None)
        print('share model: NOT used (n < 15, or it does not beat the base rate). Share bands stay at your base rates.')
    if rr < 0.3:
        print('reach: the score does not predict your reach either. Reach stays at base rates (it always does).')
    print('wrote', save_baseline(b))


def cmd_show(_a):
    b = load_baseline()
    if not b:
        print(f'no baseline in {HOME}. The skill runs without one (review + share direction, no reach numbers).')
        return
    report_baseline(b)


def main():
    ap = argparse.ArgumentParser(description='Build your own Instagram baseline for the mosseri skill (optional).')
    sp = ap.add_subparsers(dest='cmd', required=True)
    c = sp.add_parser('from-csv', help='Instagram / Meta Business Suite CSV export')
    c.add_argument('file'); c.add_argument('--min-age-days', type=int, default=7)
    c.add_argument('--col', action='append', help='override a column name, e.g. --col reach="Accounts reached"')
    g = sp.add_parser('from-graph', help='Instagram Graph API with your own token (env vars)')
    g.add_argument('--limit', type=int, default=100); g.add_argument('--min-age-days', type=int, default=7)
    g.add_argument('--host', default=os.environ.get('IG_GRAPH_HOST', 'graph.facebook.com'),
                   choices=['graph.facebook.com', 'graph.instagram.com'])
    k = sp.add_parser('check', help='test the rubric on your own blind-scored past reels')
    k.add_argument('--scores', required=True, help='JSONL from the blind scorer (rubric.md output format, with shortcode)')
    sp.add_parser('show', help='print the current baseline')
    a = ap.parse_args()
    {'from-csv': cmd_from_csv, 'from-graph': cmd_from_graph, 'check': cmd_check, 'show': cmd_show}[a.cmd](a)


if __name__ == '__main__':
    main()
