import json, glob, os, re
from collections import Counter
from datetime import datetime, timezone, timedelta, date

bangkok = timezone(timedelta(hours=7))
now = datetime(2026, 7, 6, 0, 2, 0, tzinfo=bangkok)
workspace = r"C:\Users\admin\.openclaw\workspace"
mem_path = os.path.join(workspace, 'MEMORY.md')
conv_files = [
    os.path.join(workspace, 'memory', 'conversations', '2026-06.md'),
    os.path.join(workspace, 'memory', 'conversations', '2026-07.md'),
]
last_week_start = date(2026, 6, 29)
last_week_end = date(2026, 7, 5)

entries = []
current = None
header_re = re.compile(r'^### \[(\d{2}:\d{2})\] .*? — (.*)$')
issue_re = re.compile(r'^- \*\*Phân loại\*\*: (.*)$')
resolved_re = re.compile(r'^- \*\*Đã giải quyết\*\*: (.*)$')
notes_re = re.compile(r'^- \*\*Ghi chú\*\*: (.*)$')

for path in conv_files:
    if not os.path.exists(path):
        continue
    ym = os.path.basename(path).replace('.md','')
    year, month = map(int, ym.split('-'))
    with open(path, 'r', encoding='utf-8') as f:
        for raw in f:
            line = raw.rstrip('\n')
            m = header_re.match(line)
            if m:
                if current:
                    entries.append(current)
                current = {'date': None, 'category': None, 'resolved': '', 'notes': ''}
                hhmm = m.group(1)
                # month-local log; assign date later by continuity heuristic
                current['time'] = hhmm
                current['month'] = month
                current['year'] = year
                continue
            if current is None:
                continue
            m = issue_re.match(line)
            if m:
                current['category'] = m.group(1).strip()
                continue
            m = resolved_re.match(line)
            if m:
                current['resolved'] = m.group(1).strip()
                continue
            m = notes_re.match(line)
            if m:
                current['notes'] = m.group(1).strip()
                continue
        if current:
            entries.append(current)
            current = None

# Assign dates by monotonic-order heuristic within each month file.
# Logs are appended chronologically; when time decreases, advance day.
by_month = {}
for e in entries:
    by_month.setdefault((e['year'], e['month']), []).append(e)

for (year, month), arr in by_month.items():
    day = 1
    prev_minutes = None
    for e in arr:
        hh, mm = map(int, e['time'].split(':'))
        mins = hh*60 + mm
        if prev_minutes is not None and mins < prev_minutes:
            day += 1
        prev_minutes = mins
        try:
            e['date'] = date(year, month, day)
        except ValueError:
            e['date'] = None

week_entries = [e for e in entries if e.get('date') and last_week_start <= e['date'] <= last_week_end]

total = len(week_entries)
cat_counter = Counter((e.get('category') or 'Unknown') for e in week_entries)
# stable top 3: count desc then name asc
common = sorted(cat_counter.items(), key=lambda kv: (-kv[1], kv[0]))[:3]
new_q = sum(1 for e in week_entries if '⚠️' in (e.get('notes') or ''))
unresolved = sum(1 for e in week_entries if ('⏳' in (e.get('resolved') or '') or '❌' in (e.get('resolved') or '')))
pending = sum(1 for e in week_entries if '⏳' in (e.get('resolved') or ''))
failed = sum(1 for e in week_entries if '❌' in (e.get('resolved') or ''))

anti_cutoff = now - timedelta(days=30)
ctx_cutoff = now - timedelta(days=7)
anti_dir = os.path.join(workspace, 'memory', 'antispam')
ctx_dir = os.path.join(workspace, 'memory', 'contexts')
anti_deleted = 0
ctx_deleted = 0

def parse_dt(s):
    if not isinstance(s, str) or not s.strip():
        return None
    s = s.strip().replace('Z', '+00:00')
    try:
        dt = datetime.fromisoformat(s)
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=bangkok)
    return dt.astimezone(bangkok)

for path in glob.glob(os.path.join(anti_dir, '*.json')):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            obj = json.load(f)
        last_seen = parse_dt(obj.get('last_seen'))
        if last_seen and last_seen < anti_cutoff:
            os.remove(path)
            anti_deleted += 1
    except Exception:
        pass

for path in glob.glob(os.path.join(ctx_dir, '*.json')):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            obj = json.load(f)
        keys = set(obj.keys())
        if keys <= {'language'} or obj.get('status') == 'language_preference_only':
            continue
        updated_at = parse_dt(obj.get('updated_at'))
        if updated_at and updated_at < ctx_cutoff:
            os.remove(path)
            ctx_deleted += 1
    except Exception:
        pass

with open(mem_path, 'r', encoding='utf-8') as f:
    memory = f.read()

block = "\n## Weekly heartbeat stats (2026-07-06, Monday)\n"
block += f"- Total conversations last week: **{total}**\n"
block += "- Top 3 most common issues:\n"
for i in range(3):
    if i < len(common):
        block += f"  {i+1}. {common[i][0]}\n"
    else:
        block += f"  {i+1}. N/A\n"
block += f"- Count of ⚠️ new questions not in skill: **{new_q}**\n"
block += f"- Count of ❌/⏳ unresolved cases: **{unresolved}** (⏳: {pending}, ❌: {failed})\n"
if new_q >= 3:
    action = "New unsupported questions increased this week; notify admin Anh Phi to review/update `interlink-support` skill."
else:
    action = f"No major unsupported question trend detected this week ({new_q} new question{'s' if new_q != 1 else ''} logged)."
block += f"- Action note: {action}\n"
block += f"- Cleanup note: Deleted **{anti_deleted}** stale antispam files and **{ctx_deleted}** stale context files during Monday cleanup.\n"

if "## Weekly heartbeat stats (2026-07-06, Monday)" not in memory:
    memory = memory.rstrip() + "\n\n" + block
    with open(mem_path, 'w', encoding='utf-8') as f:
        f.write(memory)

# Whitepaper health
whitepaper_path = os.path.join(workspace, 'memory', 'whitepaper-data.md')
whitepaper_status = 'ok'
last_sync = None
if os.path.exists(whitepaper_path):
    with open(whitepaper_path, 'r', encoding='utf-8') as f:
        for line in f:
            if line.startswith('> Last synced: '):
                last_sync = line[len('> Last synced: '):].strip()
                break
m = re.match(r'(\d{4}-\d{2}-\d{2})', last_sync or '')
if m:
    sync_date = datetime.strptime(m.group(1), '%Y-%m-%d').date()
    delta = (now.date() - sync_date).days
    if delta > 2:
        whitepaper_status = f'stale:{sync_date.isoformat()}'
else:
    whitepaper_status = 'missing'

print(json.dumps({
    'total': total,
    'top3': [c for c,_ in common],
    'new_q': new_q,
    'unresolved': unresolved,
    'pending': pending,
    'failed': failed,
    'anti_deleted': anti_deleted,
    'ctx_deleted': ctx_deleted,
    'whitepaper_status': whitepaper_status
}))
