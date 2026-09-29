/**
 * Chuyển dữ liệu hệ thống cũ trong `memory/` (file phẳng, trước khi viết lại trên Postgres) vào đúng bảng hệ thống hiện tại
 * đang dùng, để TIẾP TỤC dùng chứ không xoá:
 *   memory/antispam/<id>.json     -> bảng `antispam` (đúng 1-1, xem chú thích migrations/001_init.sql)
 *   memory/contexts/<id>.json     -> `users` (ngôn ngữ, mốc thời gian) + một `episodes` LỊCH SỬ (status luôn đóng)
 *   memory/conversations/*.md     -> một `episodes` LỊCH SỬ mỗi mục, có tóm tắt (`summary` jsonb, đúng khuôn EpisodeSummary)
 *
 * KHÔNG BAO GIỜ: hạ thấp/ghi đè dữ liệu MỚI HƠN của user đang sống (chỉ merge theo GREATEST/LEAST hoặc COALESCE), tạo
 * episode ở trạng thái 'open'/'dormant' (mọi episode nhập vào đều đã đóng — không được bot dùng để "tiếp tục" vụ việc cũ),
 * đoán số điện thoại/ID Telegram từ tên hiển thị. Mục trong `conversations/*.md` chỉ có @username (không có ID số) được
 * đối chiếu với `users.username` hiện có; không khớp thì BÁO LẠI, không đoán. Chạy lại nhiều lần an toàn (idempotent, đánh
 * dấu `summary.legacy_key`).
 *
 *   npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/import-legacy-memory.ts [--dir=memory] [--yes]
 * Không có --yes: chỉ đọc, KHÔNG ghi DB, in báo cáo đầy đủ (đủ để xem trước khi quyết định chạy thật).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openDb, iso, type Db } from "../src/db/db";
import { loadConfig } from "../src/config";

/** Vài file cũ có thừa dấu `}` ở cuối (lỗi ghi từ hệ thống cũ) — vẫn đọc được nếu bỏ bớt rồi parse lại. */
function parseLenientJson<T>(raw: string): T {
  let s = raw.trim();
  for (let i = 0; i < 3; i++) {
    try {
      return JSON.parse(s) as T;
    } catch {
      if (!s.endsWith("}")) throw new Error("không phải JSON hợp lệ");
      s = s.slice(0, -1).trimEnd();
    }
  }
  throw new Error("không phải JSON hợp lệ");
}

const arg = (k: string, d?: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const dir = arg("dir", "memory")!;
const write = process.argv.includes("--yes");

interface Report {
  antispam: { total: number; imported: number };
  contexts: { total: number; users: number; episodes: number; languageOnly: number; parseErrors: string[] };
  conversations: {
    entries: number;
    imported: number;
    duplicates: number;
    unlinked: { file: string; who: string; title: string }[];
    noIssue: number;
  };
}

// ---------------------------------------------------------------- antispam

async function importAntispam(db: Db, r: Report) {
  const files = readdirSync(join(dir, "antispam")).filter((f) => f.endsWith(".json"));
  r.antispam.total = files.length;
  for (const f of files) {
    const id = Number(f.replace(/\.json$/, ""));
    if (!Number.isFinite(id)) continue;
    let s: { offtopic_count?: number; blocked_until?: string | null; last_seen?: string };
    try {
      s = JSON.parse(readFileSync(join(dir, "antispam", f), "utf8"));
    } catch {
      continue;
    }
    if (write) {
      // ON CONFLICT DO NOTHING: không đè trạng thái antispam hệ thống MỚI đang theo dõi sống cho user này
      await db.query(
        "INSERT INTO antispam (user_id, offtopic_count, blocked_until, last_seen) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO NOTHING",
        [id, s.offtopic_count ?? 0, s.blocked_until ?? null, s.last_seen ?? new Date().toISOString()],
      );
    }
    r.antispam.imported++;
  }
}

// ---------------------------------------------------------------- contexts

async function upsertUserSafe(db: Db, id: number, patch: { name?: string | null; username?: string | null; language?: string | null; at: string }) {
  if (!write) return;
  // Chỉ điền chỗ còn trống; mốc thời gian merge theo GREATEST/LEAST — không bao giờ hạ thấp dữ liệu user đang sống.
  await db.query(
    `INSERT INTO users (telegram_id, name, username, language, first_seen, last_seen, seen_count)
     VALUES ($1, $2, $3, $4, $5, $5, 0)
     ON CONFLICT (telegram_id) DO UPDATE SET
       name = COALESCE(users.name, EXCLUDED.name), username = COALESCE(users.username, EXCLUDED.username),
       language = COALESCE(users.language, EXCLUDED.language),
       first_seen = LEAST(users.first_seen, EXCLUDED.first_seen), last_seen = GREATEST(users.last_seen, EXCLUDED.last_seen)`,
    [id, patch.name ?? null, patch.username ?? null, patch.language ?? null, patch.at],
  );
}

// Đọc (không ghi) nên chạy cả ở dry-run: báo cáo phản ánh đúng những gì SẼ xảy ra khi thêm --yes.
async function episodeExists(db: Db, userId: number, legacyKey: string): Promise<boolean> {
  const r = await db.query("SELECT 1 FROM episodes WHERE user_id = $1 AND summary->>'legacy_key' = $2 LIMIT 1", [userId, legacyKey]);
  return r.rowCount > 0;
}

async function insertHistoricalEpisode(db: Db, e: {
  userId: number; issue: string; topicGroup?: string | null; status: "resolved" | "escalated";
  openedAt: string; closedAt: string; lastTemplateId?: string | null; lastBotAction?: string | null;
  userReported?: string; unresolvedPoints?: string; modelNote: string; legacyKey: string;
}) {
  if (!write) return;
  const summary = { issue: e.issue.slice(0, 160), user_reported: (e.userReported ?? "").slice(0, 500), unresolved_points: (e.unresolvedPoints ?? "").slice(0, 260), exact_facts: [] as string[], model_note: e.modelNote, imported_from: "legacy", legacy_key: e.legacyKey };
  await db.query(
    `INSERT INTO episodes (user_id, issue, topic_group, status, summary, last_template_id, last_bot_action, opened_at, last_activity_at, closed_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$8,$8)`,
    [e.userId, e.issue.slice(0, 200) || null, e.topicGroup ?? null, e.status, JSON.stringify(summary), e.lastTemplateId ?? null, e.lastBotAction ?? null, e.closedAt],
  );
  void e.openedAt; // giữ tham số cho rõ ý định (mở = đóng, vì chỉ có một mốc thời gian trong dữ liệu cũ), không dùng riêng
}

async function importContexts(db: Db, r: Report) {
  const files = readdirSync(join(dir, "contexts")).filter((f) => f.endsWith(".json"));
  r.contexts.total = files.length;
  for (const f of files) {
    const id = Number(f.replace(/\.json$/, ""));
    if (!Number.isFinite(id)) {
      r.contexts.parseErrors.push(f);
      continue;
    }
    let c: { language?: string; issue?: string; status?: string; last_bot_action?: string; last_matched_section?: string; updated_at?: string };
    try {
      c = parseLenientJson(readFileSync(join(dir, "contexts", f), "utf8"));
    } catch (e) {
      r.contexts.parseErrors.push(`${f}: ${(e as Error).message}`);
      continue;
    }
    const at = c.updated_at && !Number.isNaN(Date.parse(c.updated_at)) ? c.updated_at : new Date().toISOString();
    await upsertUserSafe(db, id, { language: c.language ?? null, at });
    r.contexts.users++;
    if (!c.issue || !c.issue.trim()) {
      r.contexts.languageOnly++;
      continue;
    }
    const legacyKey = `context:${f}`;
    if (await episodeExists(db, id, legacyKey)) {
      continue;
    }
    await insertHistoricalEpisode(db, {
      userId: id, issue: c.issue, status: "resolved", openedAt: at, closedAt: at,
      lastTemplateId: c.last_matched_section ?? null, lastBotAction: c.last_bot_action ?? null,
      unresolvedPoints: c.status === "pending" ? "Chưa rõ đã xử lý xong chưa lúc hệ thống cũ dừng hoạt động." : "",
      modelNote: "Nhập từ memory/contexts (hệ thống cũ, không do AI viết)", legacyKey,
    });
    r.contexts.episodes++;
  }
}

// ---------------------------------------------------------------- conversations/*.md

interface ParsedEntry {
  file: string;
  line: number;
  who: string; // tên hiển thị hoặc @username, để báo cáo
  telegramId: number | null;
  username: string | null;
  date: string | null; // ISO nếu ghép được ngày + giờ
  title: string;
  issue: string;
  category: string | null;
  language: string | null;
  resolved: boolean | null; // null = không rõ (⏳ hoặc không ghi)
  userReported: string;
  note: string;
}

const label = (block: string, ...names: string[]): string => {
  for (const name of names) {
    const m = new RegExp(`^\\s*-\\s*(?:\\*\\*)?${name}(?:\\*\\*)?\\s*(?:\\([^)]*\\))?\\s*:\\s*(.+)$`, "im").exec(block);
    if (m) return m[1]!.trim().replace(/^\*\*|\*\*$/g, "");
  }
  return "";
};

/** Khối dạng phẳng (không heading), mỗi trường một dòng "- Nhãn: giá trị", cách nhau bằng dòng trống. Định dạng tháng 05. */
function parseFlatBlocks(file: string, text: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  const blocks = text.split(/\n\s*\n/);
  let lineNo = 1;
  for (const block of blocks) {
    const startLine = lineNo;
    lineNo += block.split("\n").length + 1;
    if (!/^-\s*(?:\*\*)?Time/im.test(block)) continue;
    const userRaw = label(block, "User");
    const idMatch = /(\d{6,12})/.exec(userRaw);
    const time = label(block, "Time");
    out.push({
      file, line: startLine, who: userRaw, telegramId: idMatch ? Number(idMatch[1]) : null, username: null,
      date: time && !Number.isNaN(Date.parse(time)) ? time : null,
      title: label(block, "Issue"), issue: label(block, "Issue") || label(block, "Q"),
      category: label(block, "Category") || null, language: (label(block, "Language") || "").toLowerCase() || null,
      resolved: /✅|resolved/i.test(label(block, "Status")) ? true : /⏳|pending/i.test(label(block, "Status")) ? null : null,
      userReported: [label(block, "Q"), label(block, "A") && `Bot: ${label(block, "A")}`].filter(Boolean).join(" — "),
      note: label(block, "Note"),
    });
  }
  return out;
}

/** Khối có heading "### [HH:MM] Tên hoặc @username — Tiêu đề", theo sau là các dòng "- **Nhãn**: giá trị". */
function parseHeadingBlocks(file: string, text: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  const lines = text.split("\n");
  let currentDate = ""; // từ heading "## YYYY-MM-DD ..." gần nhất
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const dateM = /^##\s+(\d{4}-\d{2}-\d{2})/.exec(line);
    if (dateM) currentDate = dateM[1]!;
    const headM = /^#{2,3}\s+(?:\[(\d{2}:\d{2})\]\s*)?(\S.*?)\s+—\s+(.+)$/.exec(line);
    if (headM) {
      const [, time, who, title] = headM;
      const startLine = i + 1;
      let j = i + 1;
      const body: string[] = [];
      while (j < lines.length && !/^#{2,3}\s/.test(lines[j]!) && lines[j] !== "---") {
        body.push(lines[j]!);
        j++;
      }
      const block = body.join("\n");
      const uname = /^@(\S+)/.exec(who!.trim());
      // "@8459663158": Telegram không cho username toàn số — đây là ID Telegram bị gõ nhầm có dấu @, không phải username thật.
      const unameIsId = uname && /^\d{6,12}$/.test(uname[1]!);
      const idInBlock = unameIsId ? [uname![1]!] : /(?:\d{6,12})/.exec(label(block, "User", "Telegram ID", "Telegram id"));
      const resolvedRaw = label(block, "Đã giải quyết", "Resolved", "Status");
      const summaryLines = (/-\s*(?:\*\*)?Tóm tắt trao đổi(?:\*\*)?\s*:\s*\n((?:\s+-.*\n?)*)/im.exec(block)?.[1] ?? "").trim();
      out.push({
        file, line: startLine, who: who!.trim(), telegramId: idInBlock ? Number(idInBlock[0]) : null, username: uname && !unameIsId ? uname[1]! : null,
        date: currentDate && time ? `${currentDate}T${time}:00+07:00` : currentDate ? `${currentDate}T00:00:00+07:00` : null,
        title: title!.trim(), issue: label(block, "Vấn đề", "Issue") || title!.trim(),
        category: label(block, "Phân loại", "Category") || null, language: (label(block, "Ngôn ngữ", "Language") || "").toLowerCase() || null,
        resolved: /✅/.test(resolvedRaw) ? true : /⏳/.test(resolvedRaw) ? null : null,
        userReported: summaryLines.replace(/^\s*-\s*/gm, "").replace(/\n+/g, " ").trim(),
        note: label(block, "Ghi chú", "Note"),
      });
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

async function resolveUsername(db: Db, username: string): Promise<number | null> {
  const r = await db.query<{ telegram_id: number }>("SELECT telegram_id FROM users WHERE lower(username) = lower($1) LIMIT 1", [username]);
  return r.rows[0] ? Number(r.rows[0].telegram_id) : null;
}

async function importConversations(db: Db, r: Report) {
  const dirPath = join(dir, "conversations");
  const files = readdirSync(dirPath).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const text = readFileSync(join(dirPath, f), "utf8");
    const entries = [...parseFlatBlocks(f, text), ...parseHeadingBlocks(f, text)];
    for (const e of entries) {
      r.conversations.entries++;
      let userId = e.telegramId;
      if (!userId && e.username) userId = await resolveUsername(db, e.username);
      if (!userId) {
        r.conversations.unlinked.push({ file: `${e.file}:${e.line}`, who: e.who, title: e.title });
        continue;
      }
      if (!e.issue.trim()) {
        r.conversations.noIssue++;
        continue;
      }
      const at = e.date ?? new Date().toISOString();
      await upsertUserSafe(db, userId, { language: e.language, at });
      const legacyKey = `conv:${e.file}:${e.line}`;
      if (await episodeExists(db, userId, legacyKey)) {
        r.conversations.duplicates++;
        continue;
      }
      await insertHistoricalEpisode(db, {
        userId, issue: e.issue, topicGroup: e.category, status: e.resolved === true ? "resolved" : "escalated",
        openedAt: at, closedAt: at, unresolvedPoints: e.note, userReported: e.userReported,
        modelNote: "Nhập từ memory/conversations (hệ thống cũ, tóm tắt do người/bot cũ viết tay, không do AI viết)", legacyKey,
      });
      r.conversations.imported++;
    }
  }
}

async function main() {
  const cfg = loadConfig();
  const db = await openDb(cfg.DATABASE_URL);
  const r: Report = {
    antispam: { total: 0, imported: 0 },
    contexts: { total: 0, users: 0, episodes: 0, languageOnly: 0, parseErrors: [] },
    conversations: { entries: 0, imported: 0, duplicates: 0, unlinked: [], noIssue: 0 },
  };
  try {
    await importAntispam(db, r);
    await importContexts(db, r);
    await importConversations(db, r);
  } finally {
    await db.close();
  }

  console.log(`=== ${write ? "ĐÃ GHI VÀO DATABASE" : "DRY RUN — chưa ghi gì, thêm --yes để ghi thật"} ===\n`);
  console.log(`antispam: ${r.antispam.total} file -> ${r.antispam.imported} dòng (bỏ qua nếu user đã có antispam sống)`);
  console.log(`contexts: ${r.contexts.total} file -> ${r.contexts.users} user, ${r.contexts.episodes} episode lịch sử, ${r.contexts.languageOnly} chỉ có ngôn ngữ (không tạo episode)`);
  if (r.contexts.parseErrors.length) console.log(`  lỗi đọc file (${r.contexts.parseErrors.length}): ${r.contexts.parseErrors.slice(0, 10).join(", ")}${r.contexts.parseErrors.length > 10 ? "…" : ""}`);
  console.log(`conversations: ${r.conversations.entries} mục đọc được -> ${r.conversations.imported} episode lịch sử, ${r.conversations.duplicates} đã có từ trước (bỏ qua), ${r.conversations.noIssue} không có nội dung vấn đề`);
  console.log(`  KHÔNG khớp được với user nào (thiếu ID Telegram, @username không có trong hệ thống mới): ${r.conversations.unlinked.length}`);
  for (const u of r.conversations.unlinked.slice(0, 30)) console.log(`    - ${u.file} — ${u.who} — "${u.title}"`);
  if (r.conversations.unlinked.length > 30) console.log(`    … và ${r.conversations.unlinked.length - 30} mục khác`);
}

await main();
