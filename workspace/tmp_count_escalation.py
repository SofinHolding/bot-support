import glob
import json
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

base = r"C:/Users/admin/.openclaw/agents/main/sessions"
files = [f for f in glob.glob(base + "/*.jsonl") if not f.endswith('.checkpoint')]

bkk = ZoneInfo("Asia/Bangkok")
now_bkk = datetime.now(timezone.utc).astimezone(bkk)
today = now_bkk.date()

line1 = "I'm sorry, I don't have enough information to answer this question."
line2 = "Please contact our support team directly on Telegram: @interlink_technicalsupport for further assistance."
count = 0

for path in files:
    try:
        with open(path, "r", encoding="utf-8") as f:
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

                ts = obj.get("timestamp") or obj.get("createdAt") or obj.get("time")
                if not ts:
                    continue

                dt = None
                if isinstance(ts, (int, float)):
                    v = float(ts)
                    if v > 1e12:
                        v /= 1000
                    dt = datetime.fromtimestamp(v, tz=timezone.utc)
                elif isinstance(ts, str):
                    s = ts.strip()
                    if s.endswith("Z"):
                        s = s[:-1] + "+00:00"
                    try:
                        dt = datetime.fromisoformat(s)
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                    except Exception:
                        try:
                            v = float(s)
                            if v > 1e12:
                                v /= 1000
                            dt = datetime.fromtimestamp(v, tz=timezone.utc)
                        except Exception:
                            continue

                if dt is None:
                    continue

                if dt.astimezone(bkk).date() != today:
                    continue

                content = obj.get("content")
                text = ""
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    parts = []
                    for it in content:
                        if isinstance(it, str):
                            parts.append(it)
                        elif isinstance(it, dict):
                            t = it.get("text")
                            if isinstance(t, str):
                                parts.append(t)
                    text = "\n".join(parts)
                elif isinstance(content, dict):
                    t = content.get("text")
                    if isinstance(t, str):
                        text = t

                if line1 in text and line2 in text:
                    count += 1
    except Exception:
        pass

if count > 100:
    print(f"🚨 Escalation alert (today): {count} messages sent to @interlink_technicalsupport.")
else:
    print("NO_REPLY")
