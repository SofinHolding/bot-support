import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmPort, VaultCompareRequest, VaultDraftNote, VaultDraftRequest } from "../src/core/ports";
import { migrate, openDb, type Db } from "../src/db/db";
import { vaultRepo, type VaultRepo } from "../src/db/repo-vault";
import { readIndex, readQueue } from "../src/vault/index-file";
import { runIngest, UNCHECKED_REASON, type VaultJobDeps } from "../src/vault/ingest";
import { parseNote } from "../src/vault/note";
import { absPath } from "../src/vault/paths";
import { sourceUnits, textUnits } from "../src/vault/source-units";
import { VaultStore } from "../src/vault/store";
import { fakeLlm } from "./helpers";

let db: Db;
let repo: VaultRepo;
let root: string;
let rawDir: string;
let enqueued: string[];

beforeEach(async () => {
  db = await openDb("pglite:memory");
  await migrate(db);
  repo = vaultRepo(db);
  root = mkdtempSync(join(tmpdir(), "vault-"));
  rawDir = mkdtempSync(join(tmpdir(), "raw-"));
  enqueued = [];
});
afterEach(async () => db.close());

/** Note nháp giả: mỗi đơn vị một note, chủ đề/tóm tắt lấy từ bảng `plan` theo đơn vị. */
const note = (unit: string, group: string, fact: string, over: Partial<VaultDraftNote> = {}): VaultDraftNote => ({
  title: `Chủ đề ${group}`, category: "wallet", tags: [], lang_source: "vi", version_group: group, related: [], summary: fact, keywords: [`hỏi về ${group}`],
  canonical_title: group, canonical_summary: fact, canonical_keywords: [group], sections: [{ heading: "", body: fact }], units: [unit], ...over,
});

/** Câu giống nhau khi bỏ số: cùng khung, khác số liệu -> mâu thuẫn */
const skeleton = (s: string) => s.replace(/[^a-z ]/gi, " ").replace(/\s+/g, " ").trim();

function llm(opts: { draft: (r: VaultDraftRequest) => VaultDraftNote[]; compare?: (r: VaultCompareRequest) => Promise<{ results: { pair: string; verdict: "same_meaning" | "scope_difference" | "contradiction"; reason: string }[] }>; unmatched?: (r: VaultDraftRequest) => { unit: string; topic: string; suggested_category: string }[] }): LlmPort {
  return fakeLlm({
    draftVaultNotes: async (r) => ({ notes: opts.draft(r), unmatched: opts.unmatched?.(r) ?? [] }),
    compareVaultNotes: opts.compare ?? (async (r) => ({ results: r.pairs.map((p) => ({ pair: p.id, verdict: p.left.canonicalSummary === p.right.canonicalSummary ? "same_meaning" : skeleton(p.left.canonicalSummary) === skeleton(p.right.canonicalSummary) ? "contradiction" : "scope_difference", reason: `khác số: ${p.left.canonicalSummary} / ${p.right.canonicalSummary}` })) })),
  });
}

function deps(l: LlmPort, at = "2026-09-28T03:00:00Z"): VaultJobDeps {
  return {
    store: VaultStore.open(root, repo), repo, llm: l, rawDir, now: () => new Date(at), log: () => undefined,
    enqueue: async (t) => (enqueued.push(t), true),
  };
}

async function upload(name: string, content: string | Buffer) {
  writeFileSync(join(rawDir, name), content);
  return repo.createBatch(name, name, "test");
}

async function xlsx(rows: string[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("FAQ");
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("tách đơn vị nguồn", () => {
  it("Excel: mỗi dòng một đơn vị, có vị trí sheet/dòng và tên cột", async () => {
    const units = await sourceUnits(await xlsx([["Hỏi", "Đáp"], ["Rút ITLG bao lâu?", "3-5 ngày làm việc"], ["Phí?", "1.5%"]]), "faq.xlsx");
    expect(units).toEqual([
      { id: "U1", ref: "Sheet FAQ, dòng 2", text: "Hỏi: Rút ITLG bao lâu? | Đáp: 3-5 ngày làm việc" },
      { id: "U2", ref: "Sheet FAQ, dòng 3", text: "Hỏi: Phí? | Đáp: 1.5%" },
    ]);
  });

  it("tài liệu có heading: theo heading; không có heading: theo đoạn", () => {
    expect(textUnits("# A\nnội dung a\n## B\nnội dung b").map((u) => u.ref)).toEqual(["A", "B"]);
    expect(textUnits("đoạn một\n\nđoạn hai").map((u) => u.text)).toEqual(["đoạn một\n\nđoạn hai"]);
  });
});

describe("vault-ingest", () => {
  it("không xung đột: note vào notes/, chỉ mục + bản sao DB + hàng đợi upsert, xếp job index", async () => {
    const id = await upload("a.txt", "Phí giao dịch 1.5%.\n\nRút ITLG mất 3-5 ngày.");
    const l = llm({ draft: (r) => [note(r.units[0]!.id, "phi-giao-dich", "Fee is 1.5%.", { related: ["thoi-gian-rut"] }), note(r.units[0]!.id, "thoi-gian-rut", "Withdrawal takes 3-5 days.")] });
    const rep = await runIngest(deps(l), id);

    expect(rep.confirmed.map((n) => n.path)).toEqual(["notes/wallet/phi-giao-dich-001.md", "notes/wallet/thoi-gian-rut-001.md"]);
    expect(rep.pending).toEqual([]);
    const store = VaultStore.open(root, repo);
    const n = parseNote(readFileSync(absPath(store.paths, rep.confirmed[0]!.path), "utf8"));
    expect(n.meta).toMatchObject({ status: "confirmed", source_file: "a.txt", ingested_at: "2026-09-28T03:00:00.000Z", related: ["[[thoi-gian-rut-001|Chủ đề thoi-gian-rut]]"] });
    expect(readIndex(store.paths).notes.map((e) => [e.id, e.status])).toEqual([["phi-giao-dich-001", "confirmed"], ["thoi-gian-rut-001", "confirmed"]]);
    expect(readQueue(store.paths).map((j) => [j.action, j.note_id, j.reason])).toEqual([["upsert", "phi-giao-dich-001", "new"], ["upsert", "thoi-gian-rut-001", "new"]]);
    expect((await repo.getNote("phi-giao-dich-001"))?.status).toBe("confirmed");
    expect((await repo.getBatch(id))?.status).toBe("done");
    expect(enqueued).toEqual(["vault-index"]);
  });

  it("xung đột trong file (A): mọi note liên quan vào _pending/, không index, một xung đột + file thông báo", async () => {
    const id = await upload("faq.xlsx", await xlsx([["Hỏi", "Đáp"], ["Hoàn tiền bao lâu?", "3-5 ngày"], ["Hoàn tiền mấy ngày?", "7 ngày"]]));
    const l = llm({ draft: (r) => [note("U1", "hoan-tien", "Refund in 3-5 days."), note("U2", "hoan-tien", "Refund in 7 days.")] });
    const rep = await runIngest(deps(l), id);

    expect(rep.confirmed).toEqual([]);
    expect(rep.pending.map((n) => n.path)).toEqual(["_pending/hoan-tien-001.md", "_pending/hoan-tien-002.md"]);
    const store = VaultStore.open(root, repo);
    expect(readQueue(store.paths)).toEqual([]);
    const [c] = await repo.listConflicts(["open"]);
    expect(c).toMatchObject({ type: "in_file", versionGroup: "hoan-tien", activeNoteId: null, notificationFile: "_notifications/2026-09-28_hoan-tien_chan.md" });
    expect(c!.candidates.map((x) => [x.label, x.noteId, x.sourceRefs[0]])).toEqual([["A", "hoan-tien-001", "Sheet FAQ, dòng 2"], ["B", "hoan-tien-002", "Sheet FAQ, dòng 3"]]);
    const notif = readFileSync(absPath(store.paths, c!.notificationFile!), "utf8");
    expect(notif).toContain(`conflict_id: ${c!.id}`);
    expect(notif).toContain("Refund in 3-5 days.");
    expect(parseNote(readFileSync(absPath(store.paths, "_pending/hoan-tien-001.md"), "utf8")).meta).toMatchObject({ status: "awaiting_approval", conflict_ref: c!.notificationFile });
    expect(enqueued).toEqual(["vault-conflict-notify"]);
  });

  it("xung đột với bản cũ khác mốc (B1): CHẶN bản mới, bản cũ vẫn dùng", async () => {
    await runIngest(deps(llm({ draft: (r) => [note(r.units[0]!.id, "phi-giao-dich", "Fee is 2%.")] }), "2026-08-01T00:00:00Z"), await upload("old.txt", "Phí 2%"));
    const rep = await runIngest(deps(llm({ draft: (r) => [note(r.units[0]!.id, "phi-giao-dich", "Fee is 1.5%.")] })), await upload("new.txt", "Phí 1.5%"));

    expect(rep.pending.map((n) => n.id)).toEqual(["phi-giao-dich-002"]);
    expect((await repo.getNote("phi-giao-dich-001"))?.status).toBe("confirmed");
    const [c] = await repo.listConflicts(["open"]);
    expect(c).toMatchObject({ type: "version", activeNoteId: "phi-giao-dich-001" });
    expect(c!.candidates.map((x) => [x.label, x.noteId, !!x.old])).toEqual([["A", "phi-giao-dich-002", false], ["O", "phi-giao-dich-001", true]]);
    expect(c!.reasons[0]).toContain("khác số");
  });

  it("cùng mốc thời gian với bản cũ (B2): loại tie", async () => {
    await runIngest(deps(llm({ draft: (r) => [note(r.units[0]!.id, "phi", "Fee is 2%.")] })), await upload("a.txt", "x"));
    await runIngest(deps(llm({ draft: (r) => [note(r.units[0]!.id, "phi", "Fee is 3%.")] })), await upload("b.txt", "y"));
    expect((await repo.listConflicts(["open"]))[0]?.type).toBe("tie");
  });

  it("AI không so được cặp: coi là mâu thuẫn và chặn", async () => {
    await runIngest(deps(llm({ draft: (r) => [note(r.units[0]!.id, "phi", "Fee is 2%.")] }), "2026-08-01T00:00:00Z"), await upload("a.txt", "x"));
    const l = llm({ draft: (r) => [note(r.units[0]!.id, "phi", "Fee is 2 percent, paid monthly.")], compare: async () => { throw new Error("gateway down"); } });
    const rep = await runIngest(deps(l), await upload("b.txt", "y"));
    expect(rep.pending).toHaveLength(1);
    expect((await repo.listConflicts(["open"]))[0]?.reasons).toEqual([UNCHECKED_REASON]);
  });

  it("trùng ý với bản cũ: bỏ qua; khác phạm vi: giữ cả hai và nối related hai chiều", async () => {
    await runIngest(deps(llm({ draft: (r) => [note(r.units[0]!.id, "phi", "Fee is 2%.")] }), "2026-08-01T00:00:00Z"), await upload("a.txt", "x"));
    const same = await runIngest(deps(llm({ draft: (r) => [note(r.units[0]!.id, "phi", "Fee is 2%.")] })), await upload("b.txt", "y"));
    expect(same.confirmed).toEqual([]);
    expect(same.skipped[0]?.reason).toContain("trùng ý");

    const wider = await runIngest(deps(llm({ draft: (r) => [note(r.units[0]!.id, "phi", "Fee applies to transfers only.")] })), await upload("c.txt", "z"));
    expect(wider.confirmed.map((n) => n.id)).toEqual(["phi-002"]);
    expect(wider.relatedUpdated).toBe(1);
    const old = await VaultStore.open(root, repo).read("phi-001");
    expect(old?.meta.related).toEqual(["[[phi-002|Chủ đề phi]]"]);
    expect(readQueue(VaultStore.open(root, repo).paths).filter((j) => j.note_id === "phi-001").map((j) => j.reason)).toEqual(["new", "content_change"]);
  });

  it("category không có trong taxonomy: không tạo note, báo lại để admin quyết", async () => {
    const rep = await runIngest(deps(llm({ draft: (r) => [note(r.units[0]!.id, "la", "x", { category: "khong-co" })] })), await upload("a.txt", "x"));
    expect(rep.confirmed).toEqual([]);
    expect(rep.unmatched).toEqual([{ ref: "Đoạn 1", topic: "Chủ đề la", suggestedCategory: "khong-co" }]);
  });

  it("chủ đề đang có xung đột mở: note mới gộp vào xung đột đó, không được dùng", async () => {
    await runIngest(deps(llm({ draft: () => [note("U1", "hoan-tien", "Refund in 3-5 days."), note("U2", "hoan-tien", "Refund in 7 days.")] })), await upload("a.xlsx", await xlsx([["Hỏi", "Đáp"], ["a", "b"], ["c", "d"]])));
    const rep = await runIngest(deps(llm({ draft: (r) => [note(r.units[0]!.id, "hoan-tien", "Refunds are instant.")] })), await upload("b.txt", "x"));
    expect(rep.pending.map((n) => n.id)).toEqual(["hoan-tien-003"]);
    expect(rep.conflicts[0]).toMatchObject({ extended: true });
    const all = await repo.listConflicts(["open", "sent"]);
    expect(all).toHaveLength(1);
    expect(all[0]!.candidates.map((c) => c.label)).toEqual(["A", "B", "C"]);
  });

  it("chưa cấu hình AI: lượt nạp báo lỗi nói cần làm gì", async () => {
    const id = await upload("a.txt", "x");
    await expect(runIngest(deps({ ...fakeLlm(), ready: false }), id)).rejects.toThrow();
    expect((await repo.getBatch(id))?.error).toContain("Cấu hình");
    expect(existsSync(join(root, "notes"))).toBe(true);
  });
});
