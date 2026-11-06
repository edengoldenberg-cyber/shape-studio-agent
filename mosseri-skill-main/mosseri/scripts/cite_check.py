#!/usr/bin/env python3
"""Two guards against made-up Mosseri quotes.

usage:
    python3 cite_check.py reference/doctrine.md                     # doctrine integrity: every principle cited, every citation well-formed
    python3 cite_check.py reference/doctrine.md --urls              # + list a link to every cited post, to verify by hand
    python3 cite_check.py reference/doctrine.md --review review.txt # every dated Mosseri quote in a review must exist in the doctrine

Citation format in the doctrine (quote in double quotes right after the bracket):
    [DD.MM.YYYY · SHORTCODE · m:ss] "verbatim quote"            spoken, single video
    [DD.MM.YYYY · SHORTCODE · slide N · m:ss] "verbatim quote"  spoken, carousel video slide N
    [DD.MM.YYYY · SHORTCODE · slide N] "verbatim quote"         text on slide N
    [DD.MM.YYYY · SHORTCODE · caption] "verbatim quote"         the post caption

The quotes were checked against the full transcripts when the doctrine was built. The transcripts are not shipped;
to verify a quote yourself, open https://www.instagram.com/p/<SHORTCODE>/ and go to the timestamp.
Exit 1 on any failure. Stdlib only.
"""
import argparse, datetime as dt, re, sys

CITE = re.compile(r'\[(\d\d)\.(\d\d)\.(\d{4}) · ([A-Za-z0-9_-]{9,14}) · ([^\]]+)\] "([^"]+)"')
LOC = re.compile(r'(?:slide \d+ · )?\d+:\d\d|slide \d+|caption')
PRINCIPLE = re.compile(r'^- \*\*([A-Z]+-\d+)\.', re.M)
# a Mosseri quote in a review is always attributed with a date (see output-format.md):
#   (מוסרי, 05.11.2025: "Give me a reason...")   or   (Mosseri, 05.11.2025: "Give me a reason...")
QUOTE = re.compile(r'(?:מוסרי|Mosseri)[,،]?\s*(\d\d\.\d\d\.\d{4})\s*:\s*["“]([^"”]+)["”]')


def norm(s):
    s = s.lower().replace('’', "'").replace('‘', "'")
    s = re.sub(r"[^a-z0-9' ]+", ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def check_doctrine(src):
    bad = []
    cites = list(CITE.finditer(src))
    for m in cites:
        dd, mo, yy, sc, loc, _q = m.groups()
        try:
            dt.date(int(yy), int(mo), int(dd))
        except ValueError:
            bad.append(f'{sc}: bad date {dd}.{mo}.{yy}')
        if not LOC.fullmatch(loc.strip()):
            bad.append(f'{sc}: bad location "{loc}"')
    # every principle must carry at least one citation before the next principle starts
    starts = [(m.start(), m.group(1)) for m in PRINCIPLE.finditer(src)]
    for i, (pos, pid) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else src.find('\n## ', pos)
        if not CITE.search(src[pos:end if end > 0 else None]):
            bad.append(f'{pid}: principle without a citation')
    return cites, starts, bad


def main():
    ap = argparse.ArgumentParser(description='Check Mosseri citations: doctrine integrity, and no invented quotes in a review.')
    ap.add_argument('doctrine')
    ap.add_argument('--review', help='a review text file; every dated Mosseri quote in it must appear in the doctrine on that date')
    ap.add_argument('--urls', action='store_true', help='print a link for every cited post')
    a = ap.parse_args()
    src = open(a.doctrine, encoding='utf-8').read()
    cites, principles, bad = check_doctrine(src)
    posts = sorted({m.group(4) for m in cites})
    print(f'{a.doctrine}: {len(principles)} principles · {len(cites)} citations · {len(posts)} distinct posts')
    if a.urls:
        for sc in posts:
            print(f'  https://www.instagram.com/p/{sc}/')
    if a.review:
        corpus = ' | '.join(norm(m.group(6)) for m in cites)
        rev = open(a.review, encoding='utf-8').read()
        checked = 0
        dated = {}
        for m in cites:
            dated.setdefault(f'{m.group(1)}.{m.group(2)}.{m.group(3)}', []).append(norm(m.group(6)))
        for date, q in QUOTE.findall(rev):
            checked += 1
            if norm(q) not in corpus:
                bad.append(f'review quote not in doctrine: "{q[:70]}"')
            elif not any(norm(q) in t for t in dated.get(date, [])):
                bad.append(f'review quote exists but not on {date}: "{q[:70]}"')
        print(f'{a.review}: {checked} attributed Mosseri quotes checked against the doctrine')
    for b in bad:
        print('  FAIL', b)
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
