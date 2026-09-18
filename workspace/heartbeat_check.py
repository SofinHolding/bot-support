import os, glob, json, re, datetime
from collections import Counter
from pathlib import Path

TZ = datetime.timezone(datetime.timedelta(hours=7))
now = datetime.datetime(2026,8,24,0,0,11,tzinfo=TZ)
workspace = Path(r'C:/Users/admin/.openclaw/workspace')

# last week Mon-Sun in Asia/Bangkok
start = (now.date() - datetime.timedelta(days=7))
end = now.date()
conv_path = workspace/'memory'/'conversations'/f'{now:%Y-%m}.md'
text = conv_path.read_text(encoding='utf-8') if conv_path.exists() else ''

# Split rough log entries by headings/bullets/timestamps; fallback line scan
last_week_text = text
# Try to filter lines containing dates in last week if present
lines=[]
for line in text.splitlines():
    m = re.search(r'(2026-08-(?:1[7-9]|2[0-3]))', line)
    if m:
        lines.append(line)
# If too sparse, use whole current month (best-effort; month currently only through today)
scan = '\n'.join(lines) if len(lines) > 10 else text

# Count conversations: headings or markers; fallback occurrences of User:/Q:
conv_count = 0
patterns = [r'^##\s+', r'^###\s+', r'^- \[', r'\bUser\s*:', r'\bQ\s*:']
for pat in patterns:
    n = len(re.findall(pat, scan, flags=re.M|re.I))
    conv_count = max(conv_count, n)
if conv_count == 0 and scan.strip():
    conv_count = len([l for l in scan.splitlines() if l.strip().startswith('-')])

issue_keywords = {
    'KYC / verification': ['kyc','verification','verify','curator','document review','queue'],
    'Wallet / wallet creation': ['wallet','creating wallet failed','wallet creation','create wallet'],
    'Withdraw / listing / TGE': ['withdraw','rút tiền','when list','tge','listed','exchange'],
    'Burn / ITLG reduction': ['burn','reduce','decreased','mất itlg','bị trừ'],
    'Login / password / OTP': ['login','password','otp','forgot id','forgot password'],
    'Token / faucet / mining rewards': ['faucet','token not received','itlg chưa','itl chưa','mining','reward','hhp'],
    'Swap': ['swap'],
    'Ambassador': ['ambassador','đại sứ'],
}
counts=Counter()
low=scan.lower()
for name, kws in issue_keywords.items():
    counts[name]=sum(low.count(k) for k in kws)
top3=[(k,v) for k,v in counts.most_common(3) if v>0]
new_q = scan.count('⚠️')
unresolved = scan.count('❌') + scan.count('⏳') + len(re.findall(r'\bunresolved\b|\bpending\b', scan, flags=re.I))

# cleanup
cleanup=[]
for folder, field, days in [('antispam','last_seen',30),('contexts','updated_at',7)]:
    for p in (workspace/'memory'/folder).glob('*.json'):
        try:
            data=json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            continue
        if folder=='contexts':
            keys=set(data.keys())
            if keys <= {'language'} or data.get('status')=='language_preference_only':
                continue
        val=data.get(field)
        if not val:
            continue
        try:
            dt=datetime.datetime.fromisoformat(str(val).replace('Z','+00:00'))
            if dt.tzinfo is None: dt=dt.replace(tzinfo=TZ)
            dt=dt.astimezone(TZ)
        except Exception:
            continue
        if dt < now - datetime.timedelta(days=days):
            try:
                p.unlink()
                cleanup.append(str(p.relative_to(workspace)))
            except Exception as e:
                cleanup.append(f'FAILED {p.relative_to(workspace)}: {e}')

# whitepaper health
wp=workspace/'memory'/'whitepaper-data.md'
wp_status='missing'
if wp.exists():
    wpt=wp.read_text(encoding='utf-8', errors='ignore')[:5000]
    m=re.search(r'Last synced[:\s-]+([^\n]+)', wpt, flags=re.I)
    if m:
        raw=m.group(1).strip()
        dm=re.search(r'(20\d{2}-\d{2}-\d{2})', raw)
        if dm:
            d=datetime.date.fromisoformat(dm.group(1))
            age=(now.date()-d).days
            wp_status=f'Last synced {d.isoformat()} ({age} days ago)'
        else:
            wp_status=f'Last synced present but date unparsed: {raw}'
    else:
        wp_status='Last synced marker not found'

summary = f'''\n\n## Heartbeat Weekly Summary — {now.date().isoformat()}\n- Period covered: {start.isoformat()} → {(end-datetime.timedelta(days=1)).isoformat()} (Asia/Bangkok)\n- Total conversations last week: {conv_count}\n- Top 3 common issues: {', '.join([f'{k} ({v})' for k,v in top3]) if top3 else 'No clear issue keywords found'}\n- ⚠️ new questions not in skill: {new_q}\n- ❌/⏳ unresolved cases: {unresolved}\n- Memory cleanup: deleted {len(cleanup)} stale files\n- Whitepaper sync health: {wp_status}\n'''
mem=workspace/'MEMORY.md'
old=mem.read_text(encoding='utf-8') if mem.exists() else '# MEMORY.md\n'
marker=f'## Heartbeat Weekly Summary — {now.date().isoformat()}'
if marker not in old:
    mem.write_text(old.rstrip()+summary+'\n', encoding='utf-8')
print(summary.strip())
if new_q>10:
    print('ADMIN_NOTICE: Many ⚠️ new questions found; admin should update interlink-support skill.')
if 'days ago' in wp_status:
    age=int(re.search(r'\((\d+) days ago\)', wp_status).group(1))
    if age>2:
        print('ADMIN_NOTICE: Whitepaper sync older than 2 days; cron may have failed.')
