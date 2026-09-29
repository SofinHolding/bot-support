import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InlineButton } from "../src/bot/types";
import type { VaultDraftNote } from "../src/core/ports";
import { migrate, openDb, type Db } from "../src/db/db";
import { opsRepo, type OpsRepo } from "../src/db/repo-ops";
import { vaultRepo, type VaultRepo } from "../src/db/repo-vault";
import { runIngest } from "../src/vault/ingest";
import { VaultStore } from "../src/vault/store";
import { conflictMessage, handleConflictCallback, handleMergeConfirmCallback, handleMergeTextReply, notifyConflicts, REMIND_AFTER_MS, type TelegramFlowDeps } from "../src/vault/telegram-flow";
import { FakeChannel, fakeLlm } from "./helpers";
import { mkdtempSync as mkTempDir } from "node:fs";

class TgChannel extends FakeChannel {
  buttons: { chatId: number; text: string; rows: InlineButton[][]; messageId: number }[] = [];
  edits: { chatId: number; messageId: number; text: string; rows: InlineButton[][] }[] = [];
  answers: { id: string; text?: string }[] = [];
  forceReplies: { chatId: number; text: string; messageId: number }[] = [];
  private seq = 5000;
  async sendButtons(chatId: number, text: string, rows: InlineButton[][]) {
    const messageId = this.seq++;
    this.buttons.push({ chatId, text, rows, messageId });
    return { messageId };
  }
  async sendForceReply(chatId: number, text: string) {
    const messageId = this.seq++;
    this.forceReplies.push({ chatId, text, messageId });
    return { messageId };
  }
  async editMessage(chatId: number, messageId: number, text: string, rows: InlineButton[][] = []) {
    this.edits.push({ chatId, messageId, text, rows });
  }
  async answerCallback(id: string, text?: string) {
    this.answers.push({ id, text });
  }
}

let db: Db;
let repo: VaultRepo;
let ops: OpsRepo;
let ch: TgChannel;
let now: Date;
let enqueued: string[];

beforeEach(async () => {
  db = await openDb("pglite:memory");
  await migrate(db);
  repo = vaultRepo(db);
  ops = opsRepo(db);
  await ops.upsertAdmin(1, "owner", "Chủ");
  await ops.upsertAdmin(2, "admin", "Hà");
  await ops.upsertAdmin(3, "viewer", "Xem");
  ch = new TgChannel();
  now = new Date("2026-09-28T03:00:00Z");
  enqueued = [];
});
afterEach(async () => db.close());

const vaultDir = mkTempDir(join(tmpdir(), "vault-taxonomy-"));
const deps = (over: Partial<TelegramFlowDeps> = {}): TelegramFlowDeps => ({
  repo, ops, channel: ch, adminWebUrl: "https://admin.example.test", now: () => now, log: () => undefined, enqueue: async (t) => (enqueued.push(t), true), llm: fakeLlm(), vaultDir, ...over,
});

async function conflict(excerpt = "Hoàn tiền trong 3-5 ngày làm việc.") {
  const root = mkdtempSync(join(tmpdir(), "vault-"));
  const raw = mkdtempSync(join(tmpdir(), "raw-"));
  writeFileSync(join(raw, "chinh-sach.xlsx.txt"), "x");
  const note = (u: string, body: string): VaultDraftNote => ({
    title: "Thời gian hoàn tiền", category: "wallet", tags: [], lang_source: "vi", version_group: "hoan-tien", related: [], summary: body, keywords: ["hoàn tiền"],
    canonical_title: "Refund time", canonical_summary: body, canonical_keywords: ["refund"], sections: [{ heading: "", body }], units: [u],
  });
  const llm = fakeLlm({
    draftVaultNotes: async (r) => ({ notes: [note(r.units[0]!.id, excerpt), note(r.units[0]!.id, "Hoàn tiền trong 7 ngày làm việc.")], unmatched: [] }),
    compareVaultNotes: async (r) => ({ results: r.pairs.map((p) => ({ pair: p.id, verdict: "contradiction" as const, reason: "Một bên ghi 3-5 ngày, bên kia ghi 7 ngày." })) }),
  });
  await runIngest({ store: VaultStore.open(root, repo), repo, llm, rawDir: raw, now: () => now, log: () => undefined, enqueue: async () => true }, await repo.createBatch("chinh-sach.xlsx.txt", "chinh-sach.xlsx.txt", null));
  return (await repo.listConflicts(["open"]))[0]!;
}

const press = (fromId: number, data: string, messageId = 5000) => handleConflictCallback(deps(), { id: `cb${Math.random()}`, fromId, fromName: null, chatId: fromId, messageId, data });

describe("tin xung đột gửi admin", () => {
  it("nội dung theo mẫu Notion, nút mang mã ngắn (≤ 64 byte), không vượt 4096 ký tự", async () => {
    const c = await conflict("Hoàn tiền ".repeat(900));
    const { text, rows } = conflictMessage(c, "https://admin.example.test");
    expect(text).toContain(`⚠️ Xung đột #${c.id} · CHẶN`);
    expect(text).toContain("Chưa mục nào trong nhóm này được dùng để trả lời.");
    expect(text).toContain("https://admin.example.test/#/kb/conflicts");
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(rows.flat().map((b) => b.data)).toEqual([`c${c.id}:a`, `c${c.id}:b`, `c${c.id}:m`, `c${c.id}:x`]);
    expect(rows.flat().every((b) => Buffer.byteLength(b.data) <= 64)).toBe(true);
  });

  it("gửi cho admin/owner (không gửi viewer), không gửi lại; quá 24 giờ thì nhắc, tin cũ bị bỏ nút", async () => {
    const c = await conflict();
    expect(await notifyConflicts(deps())).toEqual({ sent: 1, reminded: 0 });
    expect(ch.buttons.map((b) => b.chatId).sort()).toEqual([1, 2]);
    expect((await repo.getConflict(c.id))?.status).toBe("sent");
    expect(await notifyConflicts(deps())).toEqual({ sent: 0, reminded: 0 });

    now = new Date(now.getTime() + REMIND_AFTER_MS);
    expect(await notifyConflicts(deps())).toEqual({ sent: 0, reminded: 1 });
    expect(ch.buttons.at(-1)!.text).toContain("Nhắc lại lần 1");
    expect(ch.edits.filter((e) => e.rows.length === 0)).toHaveLength(2);
    expect((await repo.getConflict(c.id))?.remindCount).toBe(1);
  });

  it("một admin gửi lỗi (vd chưa từng chat với bot) không chặn tin tới admin còn lại", async () => {
    const c = await conflict();
    const failing = ch.sendButtons.bind(ch);
    ch.sendButtons = async (chatId, text, rows) => {
      if (chatId === 1) throw new Error("Bad Request: chat not found");
      return failing(chatId, text, rows);
    };
    expect(await notifyConflicts(deps())).toEqual({ sent: 1, reminded: 0 });
    expect(ch.buttons.map((b) => b.chatId)).toEqual([2]);
    expect((await repo.getConflict(c.id))?.status).toBe("sent");
    expect((await repo.getConflict(c.id))?.telegramMessages).toEqual([{ chatId: 2, messageId: expect.any(Number) }]);
  });
});

describe("admin bấm nút", () => {
  it("chỉ admin/owner; người bấm đầu tiên thắng; tin gốc ghi ai chọn gì và bỏ nút", async () => {
    const c = await conflict();
    await notifyConflicts(deps());
    await press(3, `c${c.id}:a`);
    expect(ch.answers.at(-1)!.text).toContain("không có quyền");
    expect((await repo.getConflict(c.id))?.status).toBe("sent");

    await press(2, `c${c.id}:a`);
    expect(ch.answers.at(-1)!.text).toContain("Giữ phương án A");
    expect(enqueued).toEqual(["vault-decide"]);
    const row = await repo.getConflict(c.id);
    expect(row).toMatchObject({ status: "deciding", decision: "a", decidedBy: "Hà#2" });
    expect(ch.edits.filter((e) => e.text.includes("✅ Hà#2 đã chọn: Giữ phương án A"))).toHaveLength(2);

    await press(1, `c${c.id}:b`);
    expect(ch.answers.at(-1)!.text).toBe("Đã được xử lý bởi Hà#2.");
  });

  it("Bỏ các phương án mới: hỏi lại một lần rồi mới thực hiện; Huỷ trả lại nút", async () => {
    const c = await conflict();
    await notifyConflicts(deps());
    await press(2, `c${c.id}:x`);
    expect(ch.edits.at(-1)!.rows.flat().map((b) => b.data)).toEqual([`c${c.id}:x1`, `c${c.id}:back`]);
    expect((await repo.getConflict(c.id))?.status).toBe("sent");
    await press(2, `c${c.id}:back`);
    expect(ch.edits.at(-1)!.rows.flat().map((b) => b.data)).toContain(`c${c.id}:a`);
    await press(2, `c${c.id}:x1`);
    expect((await repo.getConflict(c.id))?.decision).toBe("drop_all");
  });

  it("Gộp / nhập lại: kênh không hỗ trợ force-reply thì chỉ dẫn sang Admin Web", async () => {
    const c = await conflict();
    (ch as unknown as { sendForceReply?: unknown }).sendForceReply = undefined;
    await press(2, `c${c.id}:m`);
    expect(ch.textsTo(2).at(-1)).toContain("https://admin.example.test/#/kb/conflicts");
    expect((await repo.getConflict(c.id))?.status).toBe("open");
  });

  it("mã nút lạ không phải của xung đột: không xử lý", async () => {
    expect(await press(2, "something-else")).toBe(false);
  });
});

describe("Gộp / nhập lại qua Telegram (force-reply)", () => {
  const reply = (fromId: number, replyToMessageId: number, text: string, chatId = fromId) => handleMergeTextReply(deps(), { fromId, fromName: null, chatId, messageId: 9999, replyToMessageId, text });
  const confirm = (fromId: number, data: string) => handleMergeConfirmCallback(deps(), { id: `cb${Math.random()}`, fromId, fromName: null, chatId: fromId, messageId: 6000, data });

  it("bấm Gộp / nhập lại: gửi force-reply, chưa ghi gì", async () => {
    const c = await conflict();
    await press(2, `c${c.id}:m`);
    expect(ch.forceReplies).toHaveLength(1);
    expect(ch.forceReplies[0]!.chatId).toBe(2);
    expect(ch.forceReplies[0]!.text).toContain(`#${c.id}`);
    expect((await repo.getConflict(c.id))?.status).toBe("open");
  });

  it("trả lời quá ngắn: nhắc gõ lại, vẫn chờ đúng tin đó (không tạo prompt mới)", async () => {
    const c = await conflict();
    await press(2, `c${c.id}:m`);
    const promptId = ch.forceReplies[0]!.messageId;
    expect(await reply(2, promptId, "ok")).toBe(true);
    expect(ch.textsTo(2).at(-1)).toContain("quá ngắn");
    expect(ch.buttons).toHaveLength(0); // chưa gọi AI, chưa có bản xem trước
    // trả lời lại đúng tin cũ vẫn khớp được
    expect(await reply(2, promptId, "Hoàn tiền trong 4 ngày làm việc cho mọi giao dịch.")).toBe(true);
    expect(ch.buttons).toHaveLength(1);
  });

  it("trả lời đủ dài: AI soạn note đúng chủ đề xung đột, gửi bản xem trước kèm nút, CHƯA ghi vào vault", async () => {
    const c = await conflict();
    await press(2, `c${c.id}:m`);
    const promptId = ch.forceReplies[0]!.messageId;
    await reply(2, promptId, "Hoàn tiền trong 4 ngày làm việc cho mọi giao dịch.");
    expect(ch.buttons).toHaveLength(1);
    expect(ch.buttons[0]!.text).toContain("Xem trước");
    expect(ch.buttons[0]!.rows.flat().map((b) => b.data)[0]).toMatch(/^cm\d+:ok$/);
    const row = (await repo.getConflict(c.id))!;
    expect(row.status).toBe("open"); // chưa claim, chưa quyết định
  });

  it("tin trả lời không khớp prompt nào (không phải của luồng vault): trả về false, không đụng gì", async () => {
    expect(await reply(2, 123456, "câu bất kỳ")).toBe(false);
  });

  it("lỗi DB thoáng qua khi đang xử lý tin trả lời: báo lỗi cho admin, vẫn trả về true (không rơi vào pipeline khách)", async () => {
    const c = await conflict();
    await press(2, `c${c.id}:m`);
    const promptId = ch.forceReplies[0]!.messageId;
    // repo.getConflict lỗi ngay sau khi đã xác định đúng là tin trả lời cho prompt này — trước khi sửa, lỗi này bị .catch
    // ở bot/main.ts nuốt mất và biến thành `handled=false`, khiến tin của admin bị đẩy tiếp vào pipeline trả lời khách.
    const brokenRepo: VaultRepo = { ...repo, getConflict: async () => { throw new Error("connection terminated"); } };
    const handled = await handleMergeTextReply({ ...deps(), repo: brokenRepo }, { fromId: 2, fromName: null, chatId: 2, messageId: 9999, replyToMessageId: promptId, text: "Hoàn tiền trong 4 ngày làm việc cho mọi giao dịch." });
    expect(handled).toBe(true);
    expect(ch.textsTo(2).at(-1)).toContain("lỗi");
  });

  it("người đã bị hạ quyền trả lời tin của mình: bị bỏ qua âm thầm", async () => {
    const c = await conflict();
    await press(2, `c${c.id}:m`);
    const promptId = ch.forceReplies[0]!.messageId;
    await ops.upsertAdmin(2, "viewer", "Hà"); // mất quyền admin giữa lúc đang chờ trả lời
    expect(await reply(2, promptId, "Hoàn tiền trong 4 ngày làm việc cho mọi giao dịch.")).toBe(true);
    expect(ch.buttons).toHaveLength(0);
    expect(ch.textsTo(2)).toEqual([]);
  });

  it("Xác nhận: ghi quyết định merge, xếp vault-decide, sửa bản xem trước và tin xung đột gốc", async () => {
    const c = await conflict();
    await notifyConflicts(deps());
    ch.buttons = [];
    await press(2, `c${c.id}:m`);
    await reply(2, ch.forceReplies[0]!.messageId, "Hoàn tiền trong 4 ngày làm việc cho mọi giao dịch.");
    const promptId = Number(/^cm(\d+):ok$/.exec(ch.buttons[0]!.rows.flat()[0]!.data)![1]);

    await confirm(2, `cm${promptId}:ok`);
    expect(enqueued).toEqual(["vault-decide"]);
    const row = (await repo.getConflict(c.id))!;
    expect(row).toMatchObject({ status: "deciding", decision: "merge", decidedBy: "Hà#2" });
    expect(row.decisionPayload?.note).toMatchObject({ version_group: c.versionGroup });
    expect(ch.edits.some((e) => e.text.includes("✅ Đã gộp"))).toBe(true);
    expect(ch.edits.some((e) => e.text.includes("✅ Hà#2 đã chọn: Gộp / nhập lại"))).toBe(true);
  });

  it("Huỷ: không ghi quyết định, prompt kết thúc", async () => {
    const c = await conflict();
    await press(2, `c${c.id}:m`);
    await reply(2, ch.forceReplies[0]!.messageId, "Hoàn tiền trong 4 ngày làm việc cho mọi giao dịch.");
    const promptId = Number(/^cm(\d+):/.exec(ch.buttons[0]!.rows.flat()[0]!.data)![1]);
    await confirm(2, `cm${promptId}:cancel`);
    expect((await repo.getConflict(c.id))?.status).toBe("open");
    expect(ch.edits.some((e) => e.text.includes("Đã huỷ"))).toBe(true);
    // bấm xác nhận sau khi đã huỷ: báo hết hạn, không ghi gì
    await confirm(2, `cm${promptId}:ok`);
    expect(enqueued).toEqual([]);
  });

  it("người khác đã quyết định xung đột trước khi admin xác nhận bản gộp: báo và không ghi đè", async () => {
    const c = await conflict();
    await press(2, `c${c.id}:m`);
    await reply(2, ch.forceReplies[0]!.messageId, "Hoàn tiền trong 4 ngày làm việc cho mọi giao dịch.");
    const promptId = Number(/^cm(\d+):/.exec(ch.buttons[0]!.rows.flat()[0]!.data)![1]);
    await press(1, `c${c.id}:a`); // owner chọn A trước
    await confirm(2, `cm${promptId}:ok`);
    expect(enqueued).toEqual(["vault-decide"]); // đúng 1 lần, từ quyết định của owner
    expect((await repo.getConflict(c.id))?.decidedBy).toBe("Chủ#1");
  });
});
