import json, glob, datetime
from pathlib import Path
TZ = datetime.timezone(datetime.timedelta(hours=7))
day = datetime.date(2026, 9, 14)
line1 = "I'm sorry, I don't have enough information to answer this question."
line2 = "Please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance."
count = 0
for p in glob.glob(r'C:/Users/admin/.openclaw/agents/main/sessions/*.jsonl'):
    if '.checkpoint' in Path(p).name:
        continue
    with open(p, 'r', encoding='utf-8', errors='ignore') as f:
        for s in f:
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
            if role is None and isinstance(obj.get('message'), dict):
                role = obj['message'].get('role')
            if role is None and isinstance(obj.get('author'), dict):
                role = obj['author'].get('role')
            if role != 'assistant':
                continue
            texts = []
            def collect(x):
                if isinstance(x, str):
                    texts.append(x)
                elif isinstance(x, dict):
                    if isinstance(x.get('text'), str): texts.append(x['text'])
                    c = x.get('content')
                    if isinstance(c, str): texts.append(c)
                    elif isinstance(c, list):
                        for it in c: collect(it)
                elif isinstance(x, list):
                    for it in x: collect(it)
            collect(obj.get('text'))
            collect(obj.get('content'))
            collect(obj.get('message'))
            text = '\n'.join(texts)
            if line1 in text and line2 in text:
                count += 1
print(count)
