import json, pathlib, re, datetime
from collections import Counter

root = pathlib.Path(r'C:\Users\admin\.openclaw\workspace')
conv = root / 'memory' / 'conversations' / '2026-07.md'
text = conv.read_text(encoding='utf-8')
blocks = [b for b in text.split('\n---\n') if b.strip()]
cutoff = datetime.datetime(2026, 7, 6, 0, 0)
now = datetime.datetime(2026, 7, 13, 1, 47)

total = 0
issues = Counter()
newq = 0
unresolved = 0
for b in blocks:
    m = re.search(r'^### \[(\d{2}:\d{2})\] .*$', b, re.M)
    if not m:
        continue
    hh, mm = map(int, m.group(1).split(':'))
    dt = datetime.datetime(2026, 7, 12, hh, mm) if hh >= 12 else datetime.datetime(2026, 7, 13, hh, mm)
    if dt < cutoff or dt > now:
        continue
    total += 1
    m2 = re.search(r'\*\*Phân loại\*\*: (.+)', b)
    issues[m2.group(1).strip() if m2 else 'Other'] += 1
    if '⚠️ CÂU HỎI MỚI' in b:
        newq += 1
    if '⏳' in b or '❌' in b:
        unresolved += 1

now_aware = datetime.datetime(2026, 7, 13, 1, 47, tzinfo=datetime.timezone(datetime.timedelta(hours=7)))
antidel = 0
ctxdel = 0
for p in (root / 'memory' / 'antispam').glob('*.json'):
    try:
        data = json.loads(p.read_text(encoding='utf-8'))
        ls = data.get('last_seen')
        if not ls:
            continue
        dt = datetime.datetime.fromisoformat(ls)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=now_aware.tzinfo)
        if now_aware - dt > datetime.timedelta(days=30):
            p.unlink()
            antidel += 1
    except Exception:
        pass

for p in (root / 'memory' / 'contexts').glob('*.json'):
    try:
        data = json.loads(p.read_text(encoding='utf-8'))
        if set(data.keys()) == {'language'} or data.get('status') == 'language_preference_only':
            continue
        ua = data.get('updated_at')
        if not ua:
            continue
        dt = datetime.datetime.fromisoformat(ua)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=now_aware.tzinfo)
        if now_aware - dt > datetime.timedelta(days=7):
            p.unlink()
            ctxdel += 1
    except Exception:
        pass

print(json.dumps({
    'total': total,
    'top3': issues.most_common(3),
    'newq': newq,
    'unresolved': unresolved,
    'antidel': antidel,
    'ctxdel': ctxdel,
}, ensure_ascii=False), flush=True)
