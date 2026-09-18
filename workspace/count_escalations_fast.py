import json, os, datetime
root = r'C:\Users\admin\.openclaw\agents\main\sessions'
TZ = datetime.timezone(datetime.timedelta(hours=7))
day = datetime.date(2026, 9, 14)
line1 = "I'm sorry, I don't have enough information to answer this question."
line2 = "Please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance."
count = 0
for fn in os.listdir(root):
    if not fn.endswith('.jsonl') or '.checkpoint' in fn:
        continue
    p = os.path.join(root, fn)
    try:
        f = open(p, 'r', encoding='utf-8', errors='ignore')
    except Exception:
        continue
    with f:
        for s in f:
            if line1 not in s or line2 not in s or 'assistant' not in s:
                continue
            try:
                obj = json.loads(s)
            except Exception:
                continue
            ts = obj.get('timestamp') or obj.get('createdAt') or obj.get('time') or obj.get('ts')
            dt = None
            if isinstance(ts, (int, float)):
                dt = datetime.datetime.fromtimestamp(ts/1000 if ts > 1e12 else ts, TZ)
            elif isinstance(ts, str):
                try:
                    d = datetime.datetime.fromisoformat(ts.replace('Z', '+00:00'))
                    if d.tzinfo is None:
                        d = d.replace(tzinfo=datetime.timezone.utc)
                    dt = d.astimezone(TZ)
                except Exception:
                    pass
            if dt is None or dt.date() != day:
                continue
            role = obj.get('role')
            if role is None and isinstance(obj.get('message'), dict): role = obj['message'].get('role')
            if role is None and isinstance(obj.get('author'), dict): role = obj['author'].get('role')
            if role == 'assistant':
                count += 1
print(count)
