from pathlib import Path
import re, json, datetime as dt
from collections import Counter

base = Path(r"C:\Users\admin\.openclaw\workspace")
mem = base / "MEMORY.md"
conv = base / "memory" / "conversations" / "2026-06.md"
now = dt.datetime(2026, 6, 15, 0, 5, 13)

text = conv.read_text(encoding="utf-8") if conv.exists() else ""
parts = re.split(r"\n---\n", text)

total = 0
cats = []
newq = 0
unresolved = 0
pending = 0
failed = 0

for part in parts:
    if "### [" not in part:
        continue
    total += 1
    m = re.search(r"\*\*Phân loại\*\*: (.+)", part)
    if m:
        cats.append(m.group(1).strip())
    if "⚠️ CÂU HỎI MỚI" in part:
        newq += 1
    if "⏳ Đang chờ" in part:
        unresolved += 1
        pending += 1
    if "❌" in part:
        unresolved += 1
        failed += 1

cnt = Counter(cats)
top = cnt.most_common(3)
while len(top) < 3:
    top.append(("N/A", 0))

if newq >= 3:
    action = "New unsupported questions increased this week; notify admin Anh Phi to review/update `interlink-support` skill."
elif newq == 0:
    action = "No new unsupported question trend detected from this week’s logged cases."
elif newq == 1:
    action = "No major unsupported question trend detected this week (1 new question logged)."
else:
    action = f"No major unsupported question trend detected this week ({newq} new questions logged)."

append = (
    "\n\n## Weekly heartbeat stats (2026-06-15, Monday)\n"
    f"- Total conversations last week: **{total}**\n"
    "- Top 3 most common issues:\n"
    f"  1. {top[0][0]}\n"
    f"  2. {top[1][0]}\n"
    f"  3. {top[2][0]}\n"
    f"- Count of ⚠️ new questions not in skill: **{newq}**\n"
    f"- Count of ❌/⏳ unresolved cases: **{unresolved}** (⏳: {pending}, ❌: {failed})\n"
    f"- Action note: {action}\n"
)

mem.write_text(mem.read_text(encoding="utf-8") + append, encoding="utf-8")

ant = base / "memory" / "antispam"
ctx = base / "memory" / "contexts"
ant_deleted = 0
ctx_deleted = 0

def parse_ts(value: str):
    s = value.replace("Z", "+00:00")
    if "T" not in s and " " in s:
        s = s.replace(" ", "T", 1)
    t = dt.datetime.fromisoformat(s)
    if t.tzinfo is not None:
        t = t.astimezone(dt.timezone.utc).replace(tzinfo=None)
    return t

for p in ant.glob("*.json"):
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        ls = d.get("last_seen")
        if not ls:
            continue
        t = parse_ts(ls)
        if now - t > dt.timedelta(days=30):
            p.unlink()
            ant_deleted += 1
    except Exception:
        pass

for p in ctx.glob("*.json"):
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        keys = set(d.keys())
        if keys <= {"language"} or (keys <= {"language", "status"} and d.get("status") == "language_preference_only"):
            continue
        if d.get("status") == "language_preference_only":
            continue
        ua = d.get("updated_at")
        if not ua:
            continue
        t = parse_ts(ua)
        if now - t > dt.timedelta(days=7):
            p.unlink()
            ctx_deleted += 1
    except Exception:
        pass

print(json.dumps({
    "total": total,
    "top": [x[0] for x in top],
    "newq": newq,
    "unresolved": unresolved,
    "pending": pending,
    "failed": failed,
    "ant_deleted": ant_deleted,
    "ctx_deleted": ctx_deleted,
}))
