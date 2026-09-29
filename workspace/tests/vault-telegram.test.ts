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
import { conflictMessage, handleConflictCallback, notifyConflicts, REMIND_AFTER_MS, type TelegramFlowDeps } from "../src/vault/telegram-flow";
import { FakeChannel, fakeLlm } from "./helpers";

class TgChannel extends FakeChannel {
  buttons: { chatId: number; text: string; rows: InlineButton[][]; messageId: number }[] = [];
  edits: { chatId: number; messageId: number; text: string; rows: InlineButton[][] }[] = [];
  answers: { id: string; text?: string }[] = [];
  private seq = 5000;
  async sendButtons(chatId: number, text: string, rows: InlineButton[][]) {
    const messageId = this.seq++;
    this.buttons.push({ chatId, text, rows, messageId });
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

const deps = (): TelegramFlowDeps => ({ repo, ops, channel: ch, adminWebUrl: "https://admin.example.test", now: () => now, log: () => undefined, enqueue: async (t) => (enqueued.push(t), true) });

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

  it("Gộp / nhập lại chuyển sang Admin Web", async () => {
    const c = await conflict();
    await press(2, `c${c.id}:m`);
    expect(ch.textsTo(2).at(-1)).toContain("https://admin.example.test/#/kb/conflicts");
    expect((await repo.getConflict(c.id))?.status).toBe("open");
  });

  it("mã nút lạ không phải của xung đột: không xử lý", async () => {
    expect(await press(2, "something-else")).toBe(false);
  });
});
