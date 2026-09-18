import os, re, json, datetime
from collections import Counter
from zoneinfo import ZoneInfo

workspace = r"C:\Users\admin\.openclaw\workspace"
conv_path = os.path.join(workspace, "memory", "conversations", "2026-07.md")
antispam_dir = os.path.join(workspace, "memory", "antispam")
contexts_dir = os.path.join(workspace, "memory", "contexts")
whitepaper_path = os.path.join(workspace, "memory", "whitepaper-data.md")

now = datetime.datetime(2026, 7, 20, 0, 1, 13, tzinfo=ZoneInfo("Asia/Bangkok"))
today = now.date()
week_start = today - datetime.timedelta(days=7)
week_end = today - datetime.timedelta(days=1)

# Parse conversation logs for last week
entries = []
if os.path.exists(conv_path):
    with open(conv_path, 'r', encoding='utf-8') as f:
        text = f.read()
    blocks = [b.strip() for b in text.split('\n---\n') if b.strip()]
    current_date = datetime.date(2026, 7, 1)
    for block in blocks:
        lines = block.splitlines()
        if not lines:
            continue
        date_line = lines[0].strip()
        mdate = re.match(r'^##\s+(\d{4}-\d{2}-\d{2})$', date_line)
        if mdate:
            current_date = datetime.date.fromisoformat(mdate.group(1))
            continue
        m = re.match(r'^###\s+\[(\d{2}:\d{2})\]\s+(.+?)\s+—\s+(.+)$', date_line)
        if not m:
            continue
        category = None
        unresolved = None
        new_q = False
        for line in lines[1:]:
            s = line.strip()
            if s.startswith('- **Phân loại**:'):
                category = s.split(':',1)[1].strip()
            if '⚠️ CÂU HỎI MỚI' in s:
                new_q = True
            if s.startswith('- **Đã giải quyết**:'):
                val = s.split(':',1)[1].strip()
                unresolved = ('⏳' in val) or ('❌' in val)
        if week_start <= current_date <= week_end:
            entries.append({'date': current_date.isoformat(), 'category': category or 'Other', 'new_q': new_q, 'unresolved': bool(unresolved)})

counts = Counter(e['category'] for e in entries)
top3 = counts.most_common(3)
new_q_count = sum(1 for e in entries if e['new_q'])
unresolved_count = sum(1 for e in entries if e['unresolved'])

# Cleanup antispam
antispam_deleted = 0
if os.path.isdir(antispam_dir):
    for name in os.listdir(antispam_dir):
        if not name.endswith('.json'):
            continue
        path = os.path.join(antispam_dir, name)
        try:
            with open(path, 'r', encoding='utf-8') as f:
                obj = json.load(f)
            last_seen = obj.get('last_seen')
            if not last_seen:
                continue
            dt = datetime.datetime.fromisoformat(last_seen.replace('Z', '+00:00'))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=ZoneInfo('Asia/Bangkok'))
            dt = dt.astimezone(ZoneInfo('Asia/Bangkok'))
            if dt.date() < (today - datetime.timedelta(days=30)):
                os.remove(path)
                antispam_deleted += 1
        except Exception:
            continue

# Cleanup contexts
context_deleted = 0
if os.path.isdir(contexts_dir):
    for name in os.listdir(contexts_dir):
        if not name.endswith('.json'):
            continue
        path = os.path.join(contexts_dir, name)
        try:
            with open(path, 'r', encoding='utf-8') as f:
                obj = json.load(f)
            keys = set(obj.keys())
            if keys <= {'language'}:
                continue
            if obj.get('status') == 'language_preference_only':
                continue
            updated_at = obj.get('updated_at')
            if not updated_at:
                continue
            dt = datetime.datetime.fromisoformat(updated_at.replace('Z', '+00:00'))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=ZoneInfo('Asia/Bangkok'))
            dt = dt.astimezone(ZoneInfo('Asia/Bangkok'))
            if dt.date() < (today - datetime.timedelta(days=7)):
                os.remove(path)
                context_deleted += 1
        except Exception:
            continue

# Whitepaper check
last_synced = None
if os.path.exists(whitepaper_path):
    with open(whitepaper_path, 'r', encoding='utf-8') as f:
        for _ in range(20):
            line = f.readline()
            if not line:
                break
            m = re.search(r'Last synced:\s*(\d{4}-\d{2}-\d{2})', line)
            if m:
                last_synced = m.group(1)
                break

result = {
    'week_start': week_start.isoformat(),
    'week_end': week_end.isoformat(),
    'total': len(entries),
    'top3': top3,
    'new_q_count': new_q_count,
    'unresolved_count': unresolved_count,
    'antispam_deleted': antispam_deleted,
    'context_deleted': context_deleted,
    'last_synced': last_synced,
}
print(json.dumps(result, ensure_ascii=False))
