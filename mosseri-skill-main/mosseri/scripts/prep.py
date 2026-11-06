#!/usr/bin/env python3
"""Prepare a finished reel for a mosseri review: duration, 5 frames, an Instagram safe-zone sheet,
and (optionally) a transcript plus what is said in the first 3 seconds.

usage:
    python3 prep.py path/to/reel.mp4 [--out DIR] [--no-transcribe] [--lang he] [--model whisper-1]

Needs: ffmpeg + ffprobe on PATH (macOS: brew install ffmpeg · Ubuntu: sudo apt install ffmpeg ·
Windows: winget install ffmpeg).
Optional: Pillow (pip install pillow) for the safe-zone sheet.
Optional: OPENAI_API_KEY in the environment for a cloud transcript (OpenAI audio API, about $0.006 per minute).
Without a key the script still extracts frames and asks you to paste the script instead.

Writes DIR/prep.json + DIR/frame_*.jpg + DIR/safezones.jpg (default DIR = ./mosseri-prep/<file name>/).
Only the audio track is sent to OpenAI, and only when OPENAI_API_KEY is set and --no-transcribe is not given.
"""
import argparse, json, os, shutil, subprocess, sys, tempfile, urllib.request, uuid


NO_KEY_MSG = ('תמלול דולג: לא מוגדר משתנה הסביבה OPENAI_API_KEY. התמלול רץ רק עם מפתח OpenAI שלך '
              '(export OPENAI_API_KEY=... בטרמינל, לעולם לא בצ\'אט). בלי מפתח: מדביקים את התסריט, או את מה שנאמר, בצ\'אט. '
              'הפריימים ודף אזורי הבטיחות נוצרו כרגיל.')


def need(tool):
    if not shutil.which(tool):
        sys.exit(f'שגיאה: {tool} לא מותקן. מתקינים ffmpeg (במק: brew install ffmpeg · באובונטו: sudo apt install ffmpeg '
                 f'· בווינדוס: winget install ffmpeg), או מדלגים על ההכנה ומדביקים את התסריט בצ\'אט.')


def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout


def probe(path):
    j = json.loads(sh(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]))
    v = next((s for s in j['streams'] if s['codec_type'] == 'video'), {})
    a = any(s['codec_type'] == 'audio' for s in j['streams'])
    return {'duration_s': round(float(j['format']['duration']), 2), 'width': v.get('width'), 'height': v.get('height'),
            'has_audio': a}


def frame(path, t, out):
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-ss', f'{max(0, t):.2f}', '-i', path, '-frames:v', '1', '-q:v', '3', out],
                   check=True)
    return out


def safezone_sheet(frames, out):
    """Draw Instagram safe-zone guides (1080x1920): feed 4:5 crop hides y<285 and y>1635 (red);
    Reels tab: top UI to y=269, caption from y=1248 (blue lines), right buttons x>950 from y~1100 (blue box)."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return None
    tiles = []
    for f in frames:
        im = Image.open(f).convert('RGB').resize((1080, 1920))
        ov = Image.new('RGBA', im.size, (0, 0, 0, 0)); d = ImageDraw.Draw(ov)
        d.rectangle([0, 0, 1080, 285], fill=(255, 0, 80, 70)); d.rectangle([0, 1635, 1080, 1920], fill=(255, 0, 80, 70))
        d.line([0, 1248, 1080, 1248], fill=(0, 200, 255, 255), width=5); d.line([0, 269, 1080, 269], fill=(0, 200, 255, 255), width=5)
        d.rectangle([950, 1100, 1080, 1620], outline=(0, 200, 255, 255), width=4)
        tiles.append(Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB').resize((360, 640)))
    cols = min(len(tiles), 5); rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * 364, rows * 644), (40, 40, 40))
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * 364, (i // cols) * 644))
    sheet.save(out, quality=88)
    return out


def openai_transcribe(audio_path, key, model, lang):
    boundary = uuid.uuid4().hex
    fields = {'model': model, 'response_format': 'json'}
    if lang:
        fields['language'] = lang
    body = b''
    for k, v in fields.items():
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    body += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.m4a"\r\n'
             f'Content-Type: audio/mp4\r\n\r\n').encode() + open(audio_path, 'rb').read() + f'\r\n--{boundary}--\r\n'.encode()
    req = urllib.request.Request('https://api.openai.com/v1/audio/transcriptions', data=body, method='POST',
                                 headers={'Authorization': f'Bearer {key}',
                                          'Content-Type': f'multipart/form-data; boundary={boundary}'})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r).get('text', '').strip()


def transcribe(path, key, model, lang, start=None, dur=None):
    with tempfile.TemporaryDirectory() as td:
        a = os.path.join(td, 'a.m4a')
        cmd = ['ffmpeg', '-y', '-v', 'error']
        if start is not None:
            cmd += ['-ss', str(start)]
        cmd += ['-i', path]
        if dur is not None:
            cmd += ['-t', str(dur)]
        cmd += ['-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '48k', a]
        subprocess.run(cmd, check=True)
        return openai_transcribe(a, key, model, lang)


def main():
    ap = argparse.ArgumentParser(description='Prepare a reel video for a mosseri review (frames, safe zones, transcript).')
    ap.add_argument('video')
    ap.add_argument('--out', help='output folder (default ./mosseri-prep/<file name>)')
    ap.add_argument('--no-transcribe', action='store_true', help='never send audio anywhere')
    ap.add_argument('--lang', default=os.environ.get('MOSSERI_TRANSCRIBE_LANG', ''),
                    help='spoken language hint, e.g. he or en (default: auto-detect)')
    ap.add_argument('--model', default=os.environ.get('MOSSERI_TRANSCRIBE_MODEL', 'whisper-1'),
                    help='OpenAI transcription model (whisper-1, gpt-4o-transcribe, ...)')
    a = ap.parse_args()
    need('ffmpeg'); need('ffprobe')
    if not os.path.exists(a.video):
        sys.exit(f'שגיאה: הקובץ לא נמצא: {a.video}')
    stem = os.path.splitext(os.path.basename(a.video))[0]
    out = a.out or os.path.join(os.getcwd(), 'mosseri-prep', stem)
    os.makedirs(out, exist_ok=True)
    info = probe(a.video)
    d = info['duration_s']
    times = {'first_0.8s': min(0.8, d / 2), 'at_3s': min(3.0, max(0, d - 0.5)), 'third': d / 3,
             'two_thirds': 2 * d / 3, 'end': max(0, d - 0.4)}
    frames = {k: frame(a.video, t, os.path.join(out, f'frame_{k}.jpg')) for k, t in times.items()}
    info['frames'] = frames
    info['vertical_9x16'] = bool(info['width'] and info['height'] and abs(info['height'] / info['width'] - 16 / 9) < 0.05)
    sheet = safezone_sheet(list(frames.values()), os.path.join(out, 'safezones.jpg'))
    info['safezone_sheet'] = sheet or 'skipped (pip install pillow to get it)'
    key = os.environ.get('OPENAI_API_KEY')
    if not info['has_audio']:
        info['transcript'] = None
        info['transcript_note'] = 'no audio track'
    elif a.no_transcribe:
        info['transcript'] = None
        info['transcript_note'] = 'תמלול כבוי (--no-transcribe): מדביקים את התסריט, או את מה שנאמר, בצ\'אט'
    elif not key:
        info['transcript'] = None
        info['transcript_note'] = NO_KEY_MSG
        print(NO_KEY_MSG, file=sys.stderr)
    else:
        try:
            info['transcript'] = transcribe(a.video, key, a.model, a.lang)
            info['first_3s_spoken'] = transcribe(a.video, key, a.model, a.lang, 0, 3.2)
            w = len(info['transcript'].split())
            info['words'] = w
            info['words_per_sec'] = round(w / d, 2) if d else None
        except Exception as e:  # noqa: BLE001
            info['transcript'] = None
            info['transcript_note'] = f'transcription failed ({str(e)[:120]}): paste the script into the chat instead'
    json.dump(info, open(os.path.join(out, 'prep.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(json.dumps(info, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
