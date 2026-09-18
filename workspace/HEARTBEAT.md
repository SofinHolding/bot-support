# HEARTBEAT.md

## Periodic Tasks

### 📋 Weekly Conversation Stats (Monday)
- If today is Monday: read `memory/conversations/YYYY-MM.md` for the current month
- Summarize in `MEMORY.md`:
  - Total conversations last week
  - Top 3 most common issues
  - Count of ⚠️ new questions not in skill
  - Count of ❌/⏳ unresolved cases
- If there are many ⚠️ new questions → notify admin Anh Phi to update `interlink-support` skill

### 🧹 Weekly Memory Cleanup (Monday)
Memory giờ dùng per-user files (1 file/user). Iterate folder + check mtime:

- **Antispam cleanup:**
  - Duyệt `memory/antispam/*.json`
  - Với mỗi file: nếu `last_seen` older than 30 ngày → delete file
- **Context cleanup:**
  - Duyệt `memory/contexts/*.json`
  - Với mỗi file: nếu `updated_at` older than 7 ngày AND `status != "language_preference_only"` → delete file (abandoned case)
  - Nếu chỉ có `language` (không có case dở) → giữ nguyên (user preference vĩnh viễn)

### 📄 Whitepaper Sync Health Check (Daily)
- Check `memory/whitepaper-data.md` → verify "Last synced" date is today or yesterday
- If last sync is older than 2 days → cron job may have failed → notify admin
- If whitepaper content has major changes → notify admin

### 🧾 KB Health Check (Daily)
- `exec`: `node scripts/kb-lint.mjs`
- Exit code 0 → không làm gì.
- Exit code ≠ 0 → gửi admin Anh Phi (7835139312) qua tool `message` (`{"channel":"telegram","to":"7835139312","text":"..."}`): tiêu đề `⚠️ KB lint failed` + tối đa 5 dòng `ERROR` đầu tiên. KHÔNG tự sửa file KB.
