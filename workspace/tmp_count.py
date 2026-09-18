import glob, json, datetime
from zoneinfo import ZoneInfo

bangkok = ZoneInfo("Asia/Bangkok")
start = datetime.datetime(2026, 5, 8, 0, 0, 0, tzinfo=bangkok)
end = datetime.datetime(2026, 5, 9, 0, 0, 0, tzinfo=bangkok)
line1 = "I\'m sorry, I don\'t have enough information to answer this question."
line2 = "Please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance."
count = 0

for p in glob.glob(r"C:/Users/admin/.openclaw/agents/main/sessions/*.jsonl"):
    if p.endswith(".checkpoint"):
        continue
    try:
        with open(p, "r", encoding="utf-8") as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except Exception:
                    continue

                if obj.get("role") != "assistant":
                    continue

                txt = obj.get("content")
                text = ""
                if isinstance(txt, str):
                    text = txt
                elif isinstance(txt, list):
                    parts = []
                    for it in txt:
                        if isinstance(it, dict):
                            t = it.get("text")
                            if isinstance(t, str):
                                parts.append(t)
                    text = "\n".join(parts)

                if line1 in text and line2 in text:
                    ts = obj.get("timestamp") or obj.get("time") or obj.get("createdAt") or obj.get("created_at")
                    if not ts:
                        continue

                    dt = None
                    if isinstance(ts, (int, float)):
                        dt = datetime.datetime.fromtimestamp(ts / 1000 if ts > 1e12 else ts, tz=datetime.timezone.utc)
                    elif isinstance(ts, str):
                        s = ts.strip()
                        if s.endswith("Z"):
                            s = s[:-1] + "+00:00"
                        try:
                            dt = datetime.datetime.fromisoformat(s)
                        except Exception:
                            dt = None
                        if dt and dt.tzinfo is None:
                            dt = dt.replace(tzinfo=datetime.timezone.utc)

                    if not dt:
                        continue

                    local = dt.astimezone(bangkok)
                    if start <= local < end:
                        count += 1
    except Exception:
        pass

print(count)
