/**
 * Duyệt xung đột dữ liệu qua Telegram (trang Notion "Hướng dẫn xử lý xung đột dữ liệu" mục 4-7). Telegram chỉ là giao diện:
 * nguồn sự thật là bảng ingest_conflicts (Admin Web đọc cùng bảng). Admin BẤM NÚT là chính; chỉ "Gộp / nhập lại" cần gõ chữ,
 * qua force-reply (mục 5 của Notion): bot hỏi lại đúng một tin ("Nhập nội dung đúng"), admin trả lời đúng tin đó, bot khớp
 * bằng `prompt_message_id`, soạn note (SKILL knowledge-ingest, đúng chủ đề đang xung đột) rồi gửi bản xem trước kèm nút
 * Xác nhận/Huỷ — chưa ghi gì cho tới khi admin xác nhận. Nội dung quá dài (hiếm, Telegram tự giới hạn ~4096 ký tự) thì báo
 * dùng Admin Web.
 * Bảo vệ: chỉ nhận nút/tin trả lời từ Telegram id của admin/owner; người bấm đầu tiên thắng (claimDecision nguyên tử); luôn
 * trả lời answerCallbackQuery; sửa tin gốc bỏ nút và ghi ai quyết định gì. Không ai trả lời: nhắc lại sau 24 giờ, không bao
 * giờ tự duyệt.
 */
import type { AdminTextReply, CallbackPress, Channel, InlineButton } from "../bot/types";
import { usableLlm, type LlmPort, type VaultDraftNote } from "../core/ports";
import type { OpsRepo } from "../db/repo-ops";
import type { ConflictRow, VaultRepo } from "../db/repo-vault";
import { decisionLabel } from "./decide";
import { renderTaxonomyForPrompt } from "./ingest";
import { sectionsToBody } from "./note";
import { TYPE_LABEL } from "./notification-file";
import { vaultPaths } from "./paths";
import { defaultTaxonomyMd, parseTaxonomy } from "./taxonomy";
import { existsSync, readFileSync } from "node:fs";

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
  /** Cần cho "Gộp / nhập lại" (gọi SKILL knowledge-ingest) và đọc taxonomy. Thiếu thì nút này báo lỗi rõ, các nút khác vẫn chạy. */
  llm?: LlmPort;
  vaultDir?: string;
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

async function requireAdmin(d: Pick<TelegramFlowDeps, "ops">, telegramId: number) {
  const admin = await d.ops.getAdmin(telegramId);
  return admin && (admin.role === "admin" || admin.role === "owner") ? admin : null;
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
      // Một admin gửi lỗi (vd chưa từng chat với bot: "chat not found") không được chặn tin tới các admin còn lại.
      try {
        const r = await d.channel.sendButtons(chatId, text, rows);
        if (r.messageId) messages.push({ chatId, messageId: r.messageId });
      } catch (e) {
        d.log("warn", "vault-conflict-notify: không gửi được cho một admin", { chatId, err: (e as Error).message });
      }
    }
    await d.repo.markConflictSent(c.id, messages, now, reminder);
    if (reminder) reminded++;
    else sent++;
  }
  return { sent, reminded };
}

const ACT = /^c(\d{1,12}):([a-z]|o|m|x|x1|back)$/;
const MERGE_CB = /^cm(\d{1,12}):(ok|cancel)$/;
const MIN_MERGE_CHARS = 10;

function taxonomyOf(vaultDir: string) {
  const p = vaultPaths(vaultDir).taxonomy;
  return parseTaxonomy(existsSync(p) ? readFileSync(p, "utf8") : defaultTaxonomyMd());
}

/** Bắt đầu "Gộp / nhập lại": gửi tin ép trả lời, ghi lại để khớp khi admin gõ chữ. Không hỗ trợ force-reply -> báo dùng Admin Web. */
async function startMergePrompt(d: TelegramFlowDeps, c: ConflictRow, chatId: number, adminId: number) {
  const webLink = `${d.adminWebUrl.replace(/\/$/, "")}/#/kb/conflicts`;
  if (!d.channel.sendForceReply) {
    await d.channel.send(chatId, `Gộp / nhập lại cho xung đột #${c.id}: mở Admin Web để nhập nội dung đúng và xem trước.\n${webLink}`).catch(() => undefined);
    return;
  }
  const topic = c.candidates.find((x) => !x.old)?.title ?? c.versionGroup;
  const prompt = `✏️ Gộp / nhập lại cho xung đột #${c.id} — ${topic}\n\nTrả lời (reply) TIN NÀY bằng nội dung đúng, đầy đủ (như bạn sẽ trả lời khách). Bot sẽ soạn thành mục tri thức để bạn xem trước rồi mới ghi.\n\nNội dung quá dài thì dùng Admin Web: ${webLink}`;
  const r = await d.channel.sendForceReply(chatId, prompt);
  if (!r.messageId) return;
  await d.repo.createMergePrompt(c.id, chatId, adminId, r.messageId);
}

/** Admin vừa trả lời tin "Gộp / nhập lại". false = tin này không khớp prompt nào (không phải của luồng vault). */
export async function handleMergeTextReply(d: TelegramFlowDeps, r: AdminTextReply): Promise<boolean> {
  const prompt = await d.repo.mergePromptByReply(r.chatId, r.replyToMessageId);
  if (!prompt) return false;
  const admin = await requireAdmin(d, r.fromId);
  if (!admin) return true; // im lặng: tin trả lời không phải từ admin/owner, không phải của luồng này
  const send = (t: string) => d.channel.send(r.chatId, t).catch(() => undefined);

  const c = await d.repo.getConflict(prompt.conflictId);
  if (!c || c.status === "deciding" || c.status === "resolved") {
    await d.repo.resolveMergePrompt(prompt.id, "cancelled");
    await send(`Xung đột #${prompt.conflictId} không còn ở trạng thái chờ chọn (đã được xử lý). Không cần nhập lại.`);
    return true;
  }
  if (r.text.length < MIN_MERGE_CHARS) {
    await send(`Nội dung quá ngắn. Trả lời lại đúng tin trên với câu trả lời đầy đủ cho chủ đề "${c.candidates.find((x) => !x.old)?.title ?? c.versionGroup}".`);
    return true; // vẫn "awaiting_text": admin trả lời lại đúng tin gốc là được
  }
  const llm = usableLlm(d.llm);
  if (!llm) {
    await send("Chưa cấu hình AI nên chưa soạn được nội dung. Dùng Admin Web hoặc báo kỹ thuật viên.");
    return true;
  }
  let note: VaultDraftNote;
  try {
    const tax = taxonomyOf(d.vaultDir ?? "knowledge");
    const draft = await llm.draftVaultNotes({
      sourceFile: "admin (gộp xung đột qua Telegram)", taxonomy: renderTaxonomyForPrompt(tax), existingGroups: await d.repo.activeGroups(), fixedVersionGroup: c.versionGroup,
      units: [{ id: "U1", ref: `Admin nhập lại qua Telegram cho xung đột #${c.id}`, text: r.text }],
    });
    const n = draft.notes[0];
    if (!n) throw new Error("AI không soạn được note từ nội dung này");
    if (!tax.categories.some((x) => x.key === n.category)) throw new Error(`AI xếp vào nhóm "${n.category}" không có trong taxonomy — viết rõ chủ đề hơn hoặc dùng Admin Web`);
    note = { ...n, version_group: c.versionGroup, units: ["U1"] };
  } catch (e) {
    d.log("warn", "vault merge (Telegram): AI soạn note lỗi", { conflictId: c.id, err: (e as Error).message });
    await send(`Chưa soạn được nội dung (${(e as Error).message}). Trả lời lại đúng tin trên, viết rõ hơn, hoặc dùng Admin Web.`);
    return true;
  }
  const body = sectionsToBody(note.sections);
  const preview = `Xem trước nội dung sẽ dùng cho xung đột #${c.id}:\n\n${note.title}\n\n${body}\n\nKhách sẽ nhận nguyên văn phần này (dịch sang ngôn ngữ của khách).`;
  const rows: InlineButton[][] = [[{ text: "Xác nhận gộp", data: `cm${prompt.id}:ok` }, { text: "Huỷ", data: `cm${prompt.id}:cancel` }]];
  const sent = d.channel.sendButtons ? await d.channel.sendButtons(r.chatId, preview, rows) : await d.channel.send(r.chatId, `${preview}\n\n(kênh không hỗ trợ nút — dùng Admin Web để xác nhận)`);
  if (!sent.messageId) return true;
  await d.repo.setMergePromptDraft(prompt.id, sent.messageId, note as unknown as Record<string, unknown>);
  return true;
}

/** Admin bấm Xác nhận/Huỷ trên bản xem trước "Gộp / nhập lại". */
export async function handleMergeConfirmCallback(d: TelegramFlowDeps, p: CallbackPress): Promise<boolean> {
  const m = MERGE_CB.exec(p.data);
  if (!m) return false;
  const answer = (t: string) => (d.channel.answerCallback ? d.channel.answerCallback(p.id, t).catch(() => undefined) : Promise.resolve());
  const admin = await requireAdmin(d, p.fromId);
  if (!admin) {
    await answer("Bạn không có quyền duyệt xung đột dữ liệu.");
    return true;
  }
  const promptId = Number(m[1]);
  const act = m[2]!;
  const prompt = await d.repo.getMergePrompt(promptId);
  if (!prompt || prompt.status !== "awaiting_confirm" || !prompt.draftNote) {
    await answer("Bản xem trước này đã hết hạn hoặc đã xử lý.");
    return true;
  }
  const edit = (text: string, rows: InlineButton[][] = []) =>
    p.chatId !== null && p.messageId !== null && d.channel.editMessage ? d.channel.editMessage(p.chatId, p.messageId, text, rows).catch(() => undefined) : Promise.resolve();

  if (act === "cancel") {
    await d.repo.resolveMergePrompt(promptId, "cancelled");
    await edit("Đã huỷ gộp / nhập lại. Xem lại xung đột ở tin phía trên hoặc trên Admin Web.");
    await answer("Đã huỷ.");
    return true;
  }
  const by = `${admin.name ?? p.fromName ?? "admin"}#${p.fromId}`;
  const claimed = await d.repo.claimDecision(prompt.conflictId, "merge", { note: prompt.draftNote }, by, d.now());
  if (!claimed) {
    const cur = await d.repo.getConflict(prompt.conflictId);
    await d.repo.resolveMergePrompt(promptId, "cancelled");
    await edit(`Xung đột #${prompt.conflictId} đã được xử lý bởi ${cur?.decidedBy ?? "người khác"} trước khi bạn xác nhận.`);
    await answer(`Đã được xử lý bởi ${cur?.decidedBy ?? "người khác"}.`);
    return true;
  }
  await d.enqueue("vault-decide", { conflictId: prompt.conflictId }, { dedupeKey: `vault-decide:${prompt.conflictId}` });
  await d.ops.audit(by, "vault.decide", String(prompt.conflictId), { via: "telegram-merge" }, { decision: "merge" });
  await d.repo.resolveMergePrompt(promptId, "done");
  await edit("✅ Đã gộp. Nội dung sẽ dùng được sau khi đánh chỉ mục (vài phút).");
  await answer("Đã ghi nhận: Gộp / nhập lại.");
  await markMessagesDecided(d, claimed);
  return true;
}

/** Một lần admin bấm nút trong tin xung đột. Luôn trả lời answerCallback để nút không bị treo. */
export async function handleConflictCallback(d: TelegramFlowDeps, p: CallbackPress): Promise<boolean> {
  const m = ACT.exec(p.data);
  if (!m) return false;
  const answer = (t: string) => (d.channel.answerCallback ? d.channel.answerCallback(p.id, t).catch(() => undefined) : Promise.resolve());
  const admin = await requireAdmin(d, p.fromId);
  if (!admin) {
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
    if (p.chatId === null) return true;
    await answer("Trả lời tin bot vừa gửi bằng nội dung đúng.");
    await startMergePrompt(d, c, p.chatId, p.fromId);
    return true;
  }
  if (act === "x") {
    // Bỏ các phương án mới: hỏi lại một lần. Áp dụng cho TẤT CẢ phương án mới đang có trong xung đột này (không chỉ một mục).
    await answer("Lựa chọn này bỏ TẤT CẢ phương án mới của xung đột — bấm xác nhận nếu chắc chắn.");
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
