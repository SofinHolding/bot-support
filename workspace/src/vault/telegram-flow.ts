/**
 * Duyệt xung đột dữ liệu qua Telegram (trang Notion "Hướng dẫn xử lý xung đột dữ liệu" mục 4-7). Telegram chỉ là giao diện:
 * nguồn sự thật là bảng ingest_conflicts (Admin Web đọc cùng bảng). Admin BẤM NÚT là chính; "Gộp / nhập lại" chuyển sang
 * Admin Web (cần xem trước nội dung AI soạn, và nội dung dài không vừa một tin Telegram).
 * Bảo vệ: chỉ nhận nút từ Telegram id của admin/owner; người bấm đầu tiên thắng (claimDecision nguyên tử); luôn trả lời
 * answerCallbackQuery; sửa tin gốc bỏ nút và ghi ai quyết định gì. Không ai trả lời: nhắc lại sau 24 giờ, không bao giờ tự duyệt.
 */
import type { CallbackPress, Channel, InlineButton } from "../bot/types";
import type { OpsRepo } from "../db/repo-ops";
import type { ConflictRow, VaultRepo } from "../db/repo-vault";
import { decisionLabel } from "./decide";
import { TYPE_LABEL } from "./notification-file";

const MAX_MESSAGE = 4096;
const SIDE_CHARS = 600;
export const REMIND_AFTER_MS = 24 * 3600_000;

export interface TelegramFlowDeps {
  repo: VaultRepo;
  ops: OpsRepo;
  channel: Channel;
  adminWebUrl: string;
  now: () => Date;
  enqueue: (type: string, payload: Record<string, unknown>, opts?: { dedupeKey?: string }) => Promise<boolean>;
  log: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
}

const fmtDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

/** Nội dung tin (chữ thuần, không parse_mode) + nút. `callback_data` chỉ mang mã ngắn: c<id>:<lựa chọn>. */
export function conflictMessage(c: ConflictRow, adminWebUrl: string, header = ""): { text: string; rows: InlineButton[][] } {
  const news = c.candidates.filter((x) => !x.old);
  const old = c.candidates.find((x) => x.old);
  const build = (side: number) =>
    [
      `${header}⚠️ Xung đột #${c.id} · CHẶN`,
      `Chủ đề: ${news[0]?.title ?? c.versionGroup} · ${TYPE_LABEL[c.type]}`,
      `Tệp: ${[...new Set(news.map((x) => x.sourceFile))].join(", ")}`,
      "",
      ...news.flatMap((x) => [`${x.label} · ${x.sourceRefs.join("; ") || "không rõ vị trí"}`, `"${cut(x.excerpt, side)}"`, ""]),
      old ? `Đang dùng: bản cũ (nạp ${fmtDay(old.ingestedAt)})\n"${cut(old.excerpt, side)}"` : "Chưa mục nào trong nhóm này được dùng để trả lời.",
      c.reasons.length ? `\nKhác nhau: ${c.reasons.join(" ")}` : "",
      `\nXem đầy đủ trên Admin Web: ${adminWebUrl.replace(/\/$/, "")}/#/kb/conflicts`,
    ].join("\n");
  let side = SIDE_CHARS;
  let text = build(side);
  while (text.length > MAX_MESSAGE && side > 80) text = build((side -= 80));
  const keep = news.map((x) => ({ text: `Giữ ${x.label}`, data: `c${c.id}:${x.label.toLowerCase()}` }));
  const rows: InlineButton[][] = [];
  for (let i = 0; i < keep.length; i += 3) rows.push(keep.slice(i, i + 3));
  rows.push([...(old ? [{ text: "Giữ bản cũ", data: `c${c.id}:o` }] : []), { text: "Gộp / nhập lại", data: `c${c.id}:m` }]);
  rows.push([{ text: "Bỏ các phương án mới", data: `c${c.id}:x` }]);
  return { text: text.slice(0, MAX_MESSAGE), rows };
}

async function adminChats(ops: OpsRepo): Promise<number[]> {
  return (await ops.listAdmins()).filter((a) => a.role === "admin" || a.role === "owner").map((a) => a.telegram_id);
}

/** Tin gốc sau khi đã có quyết định: bỏ nút, ghi ai chọn gì. */
export async function markMessagesDecided(d: Pick<TelegramFlowDeps, "channel" | "adminWebUrl" | "log">, c: ConflictRow) {
  if (!d.channel.editMessage || !c.telegramMessages.length) return;
  const { text } = conflictMessage(c, d.adminWebUrl);
  const footer = `\n\n✅ ${c.decidedBy ?? "?"} đã chọn: ${decisionLabel(c.decision ?? "")}`;
  for (const m of c.telegramMessages) {
    await d.channel.editMessage(m.chatId, m.messageId, `${text.slice(0, MAX_MESSAGE - footer.length)}${footer}`, []).catch((e: Error) => d.log("warn", "không sửa được tin xung đột", { err: e.message }));
  }
}

/**
 * Job `vault-conflict-notify` (xếp sau mỗi lượt nạp có xung đột + cron hằng giờ để nhắc):
 *   - xung đột "open" (mới hoặc vừa gộp thêm nội dung): gửi cho mọi admin/owner; tin cũ của xung đột đó bị bỏ nút;
 *   - xung đột "sent" quá 24 giờ chưa ai chọn: nhắc lại (tin mới), không tự duyệt.
 * Gửi lỗi: để job thử lại theo cơ chế sẵn có (failJob, quá 5 lần vào danh sách hỏng hẳn trên Admin Web).
 */
export async function notifyConflicts(d: TelegramFlowDeps): Promise<{ sent: number; reminded: number; skipped?: string }> {
  if (!d.channel.sendButtons) return { sent: 0, reminded: 0, skipped: "kênh không hỗ trợ nút bấm" };
  const chats = await adminChats(d.ops);
  if (!chats.length) return { sent: 0, reminded: 0, skipped: "chưa có admin nào" };
  const now = d.now();
  let sent = 0;
  let reminded = 0;
  for (const c of await d.repo.listConflicts(["open", "sent"], 200)) {
    const due = c.status === "open" || (c.lastNotifiedAt !== null && now.getTime() - c.lastNotifiedAt.getTime() >= REMIND_AFTER_MS);
    if (!due) continue;
    const reminder = c.status === "sent";
    // tin cũ (trước khi xung đột được gộp thêm / trước lần nhắc) không còn nút để không ai bấm vào nội dung đã cũ
    if (d.channel.editMessage)
      for (const m of c.telegramMessages)
        await d.channel.editMessage(m.chatId, m.messageId, `Xung đột #${c.id} đã có tin mới hơn bên dưới.`, []).catch(() => undefined);
    const { text, rows } = conflictMessage(c, d.adminWebUrl, reminder ? `🔔 Nhắc lại lần ${c.remindCount + 1} (chưa ai chọn)\n` : "");
    const messages: { chatId: number; messageId: number }[] = [];
    for (const chatId of chats) {
      const r = await d.channel.sendButtons(chatId, text, rows);
      if (r.messageId) messages.push({ chatId, messageId: r.messageId });
    }
    await d.repo.markConflictSent(c.id, messages, now, reminder);
    if (reminder) reminded++;
    else sent++;
  }
  return { sent, reminded };
}

const ACT = /^c(\d{1,12}):([a-z]|o|m|x|x1|back)$/;

/** Một lần admin bấm nút. Luôn trả lời answerCallback để nút không bị treo. */
export async function handleConflictCallback(d: TelegramFlowDeps, p: CallbackPress): Promise<boolean> {
  const m = ACT.exec(p.data);
  if (!m) return false;
  const answer = (t: string) => (d.channel.answerCallback ? d.channel.answerCallback(p.id, t).catch(() => undefined) : Promise.resolve());
  const admin = await d.ops.getAdmin(p.fromId);
  if (!admin || (admin.role !== "admin" && admin.role !== "owner")) {
    await answer("Bạn không có quyền duyệt xung đột dữ liệu.");
    return true;
  }
  const id = Number(m[1]);
  const act = m[2]!;
  const c = await d.repo.getConflict(id);
  if (!c) {
    await answer("Không tìm thấy xung đột này.");
    return true;
  }
  if (c.status === "deciding" || c.status === "resolved") {
    await answer(`Đã được xử lý bởi ${c.decidedBy ?? "người khác"}.`);
    return true;
  }
  const edit = (rows: InlineButton[][]) =>
    p.chatId !== null && p.messageId !== null && d.channel.editMessage ? d.channel.editMessage(p.chatId, p.messageId, conflictMessage(c, d.adminWebUrl).text, rows).catch(() => undefined) : Promise.resolve();

  if (act === "m") {
    await answer("Nhập nội dung đúng trên Admin Web để xem trước rồi xác nhận.");
    if (p.chatId !== null) await d.channel.send(p.chatId, `Gộp / nhập lại cho xung đột #${c.id}: mở Admin Web, tab Xung đột dữ liệu, bấm "Gộp / nhập lại" để nhập nội dung đúng và xem trước.\n${d.adminWebUrl.replace(/\/$/, "")}/#/kb/conflicts`).catch(() => undefined);
    return true;
  }
  if (act === "x") {
    // Bỏ các phương án mới: hỏi lại một lần
    await answer("Bấm xác nhận để bỏ các phương án mới.");
    await edit([[{ text: "Xác nhận bỏ các phương án mới", data: `c${c.id}:x1` }, { text: "Huỷ", data: `c${c.id}:back` }]]);
    return true;
  }
  if (act === "back") {
    await answer("Đã huỷ.");
    await edit(conflictMessage(c, d.adminWebUrl).rows);
    return true;
  }
  const decision = act === "o" ? "old" : act === "x1" ? "drop_all" : act;
  const valid = decision === "old" ? c.candidates.some((x) => x.old) : decision === "drop_all" || c.candidates.some((x) => !x.old && x.label.toLowerCase() === decision);
  if (!valid) {
    await answer("Lựa chọn này không còn trong xung đột. Xem lại trên Admin Web.");
    return true;
  }
  const by = `${admin.name ?? p.fromName ?? "admin"}#${p.fromId}`;
  const claimed = await d.repo.claimDecision(id, decision, null, by, d.now());
  if (!claimed) {
    const cur = await d.repo.getConflict(id);
    await answer(`Đã được xử lý bởi ${cur?.decidedBy ?? "người khác"}.`);
    return true;
  }
  await d.enqueue("vault-decide", { conflictId: id }, { dedupeKey: `vault-decide:${id}` });
  await d.ops.audit(by, "vault.decide", String(id), { candidates: c.candidates.map((x) => x.noteId) }, { decision, via: "telegram" });
  await answer(`Đã ghi nhận: ${decisionLabel(decision)}.`);
  await markMessagesDecided(d, claimed);
  return true;
}
