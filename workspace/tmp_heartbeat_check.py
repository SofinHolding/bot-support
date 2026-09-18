import os, re, json, datetime
from pathlib import Path
from collections import Counter

base = Path(r"C:/Users/admin/.openclaw/workspace")
now = datetime.datetime(2026, 7, 13, 0, 0, 19, tzinfo=datetime.timezone(datetime.timedelta(hours=7)))

# Read conversation log
log = base / "memory/conversations/2026-07.md"
text = log.read_text(encoding="utf-8") if log.exists() else ""
parts = re.split(r"\n---\n", text)
entries = []
for part in parts:
    m = re.search(r"- \*\*Vấn đề\*\*: (.*?)\n- \*\*Phân loại\*\*: (.*?)\n- \*\*Ngôn ngữ\*\*: (.*?)\n- \*\*Đã giải quyết\*\*: (.*?)\n", part, re.S)
    if not m:
        continue
    issue, category, lang, resolved = m.groups()
    entries.append({"issue": issue, "category": category, "lang": lang, "resolved": resolved, "raw": part})

cat = Counter(e["category"] for e in entries)
new_questions = sum("⚠️" in e["raw"] for e in entries)
unresolved = sum(("⏳" in e["resolved"]) or ("❌" in e["resolved"]) for e in entries)

# Cleanup antispam
anti_deleted = 0
antidir = base / "memory/antispam"
if antidir.exists():
    for p in antidir.glob("*.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            ls = data.get("last_seen")
            if not isinstance(ls, str):
                continue
            dt = datetime.datetime.fromisoformat(ls.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=now.tzinfo)
            if now - dt.astimezone(now.tzinfo) > datetime.timedelta(days=30):
                p.unlink(missing_ok=True)
                anti_deleted += 1
        except Exception:
            pass

# Cleanup contexts
ctx_deleted = 0
ctxdir = base / "memory/contexts"
if ctxdir.exists():
    for p in ctxdir.glob("*.json"):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            if data.get("status") == "language_preference_only":
                continue
            if set(data.keys()) == {"language"}:
                continue
            ua = data.get("updated_at")
            if not isinstance(ua, str):
                continue
            dt = datetime.datetime.fromisoformat(ua.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=now.tzinfo)
            if now - dt.astimezone(now.tzinfo) > datetime.timedelta(days=7):
                p.unlink(missing_ok=True)
                ctx_deleted += 1
        except Exception:
            pass

# Whitepaper sync
wp = (base / "memory/whitepaper-data.md").read_text(encoding="utf-8") if (base / "memory/whitepaper-data.md").exists() else ""
m = re.search(r"Last synced:\s*(\d{4}-\d{2}-\d{2})", wp)
last_sync = m.group(1) if m else None

print(json.dumps({
    "total": len(entries),
    "top3": cat.most_common(3),
    "new_questions": new_questions,
    "unresolved": unresolved,
    "anti_deleted": anti_deleted,
    "ctx_deleted": ctx_deleted,
    "last_sync": last_sync,
}, ensure_ascii=False))
