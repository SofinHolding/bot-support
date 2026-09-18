import os, glob, json, datetime
from zoneinfo import ZoneInfo

base = r'C:\Users\admin\.openclaw\agents\main\sessions'
line1 = "I'm sorry, I don't have enough information to answer this question."
line2 = "Please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance."
tz = ZoneInfo('Asia/Bangkok')
today = datetime.datetime(2026, 7, 24, tzinfo=tz).date()
count = 0

for path in glob.glob(os.path.join(base, '*.jsonl')):
    if path.endswith('.checkpoint') or '.checkpoint' in path:
        continue
    with open(path, 'r', encoding='utf-8') as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except Exception:
                continue
            if obj.get('role') != 'assistant':
                continue
            text = obj.get('content')
            if isinstance(text, list):
                parts = []
                for item in text:
                    if isinstance(item, dict) and item.get('type') in ('text', 'output_text') and isinstance(item.get('text'), str):
                        parts.append(item['text'])
                text = '\n'.join(parts)
            if not isinstance(text, str):
                continue
            if line1 not in text or line2 not in text:
                continue
            ts = obj.get('createdAt') or obj.get('timestamp') or obj.get('time') or obj.get('date')
            if not ts or not isinstance(ts, str):
                continue
            try:
                dt = datetime.datetime.fromisoformat(ts.replace('Z', '+00:00'))
            except Exception:
                continue
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=datetime.timezone.utc)
            if dt.astimezone(tz).date() == today:
                count += 1

print(count)
