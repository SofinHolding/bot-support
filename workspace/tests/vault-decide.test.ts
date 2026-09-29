import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmPort, VaultDraftNote } from "../src/core/ports";
import { migrate, openDb, type Db } from "../src/db/db";
import { vaultRepo, type VaultRepo } from "../src/db/repo-vault";
import { applyDecision } from "../src/vault/decide";
import { readIndex, readQueue } from "../src/vault/index-file";
import { runIngest, type VaultJobDeps } from "../src/vault/ingest";
import { absPath } from "../src/vault/paths";
import { VaultStore } from "../src/vault/store";
import { fakeLlm } from "./helpers";

let db: Db;
let repo: VaultRepo;
let root: string;
let rawDir: string;

beforeEach(async () => {
  db = await openDb("pglite:memory");
  await migrate(db);
  repo = vaultRepo(db);
  root = mkdtempSync(join(tmpdir(), "vault-"));
  rawDir = mkdtempSync(join(tmpdir(), "raw-"));
});
afterEach(async () => db.close());

const draft = (unit: string, fact: string): VaultDraftNote => ({
  title: `Phí: ${fact}`, category: "wallet", tags: [], lang_source: "vi", version_group: "phi", related: [], summary: fact, keywords: ["phí"],
  canonical_title: "Fee", canonical_summary: fact, canonical_keywords: ["fee"], sections: [{ heading: "", body: fact }], units: [unit],
});

// mọi cặp khác nhau đều mâu thuẫn
const llm = (notes: (units: string[]) => VaultDraftNote[]): LlmPort =>
  fakeLlm({
    draftVaultNotes: async (r) => ({ notes: notes(r.units.map((u) => u.id)), unmatched: [] }),
    compareVaultNotes: async (r) => ({ results: r.pairs.map((p) => ({ pair: p.id, verdict: "contradiction" as const, reason: "khác phí" })) }),
  });

const deps = (l: LlmPort, at: string): VaultJobDeps => ({
  store: VaultStore.open(root, repo), repo, llm: l, rawDir, now: () => new Date(at), log: () => undefined, enqueue: async () => true,
});

/** Bản cũ phi-001 (2%) đang dùng; lượt mới có hai phương án mâu thuẫn A = phi-002 (1.5%), B = phi-003 (3%). */
async function setup() {
  writeFileSync(join(rawDir, "old.txt"), "x");
  await runIngest(deps(llm((u) => [draft(u[0]!, "Fee is 2%.")]), "2026-08-01T00:00:00Z"), await repo.createBatch("old.txt", "old.txt", null));
  writeFileSync(join(rawDir, "new.txt"), "a\n\nb");
  await runIngest(deps(llm((u) => [draft(u[0]!, "Fee is 1.5%."), draft(u[0]!, "Fee is 3%.")]), "2026-09-28T00:00:00Z"), await repo.createBatch("new.txt", "new.txt", null));
  const [c] = await repo.listConflicts(["open"]);
  expect(c!.candidates.map((x) => [x.label, x.noteId])).toEqual([["A", "phi-002"], ["B", "phi-003"], ["O", "phi-001"]]);
  return c!;
}

const decide = async (id: number, decision: string, payload: Record<string, unknown> | null = null) => {
  expect(await repo.claimDecision(id, decision, payload, "admin#1", new Date("2026-09-28T01:00:00Z"))).not.toBeNull();
  return applyDecision(deps(llm(() => []), "2026-09-28T01:00:00Z"), id);
};
const status = async (id: string) => (await repo.getNote(id))?.status;
const pathOf = (id: string) => readIndex(VaultStore.open(root, repo).paths).notes.find((e) => e.id === id)?.path;
const queued = () => readQueue(VaultStore.open(root, repo).paths).map((j) => `${j.action}:${j.note_id}`);

describe("áp dụng quyết định xung đột (Notion mục 6)", () => {
  it("Giữ A: A confirmed vào notes/, B và bản cũ superseded vào _archive/; upsert A, remove bản cũ", async () => {
    const c = await setup();
    const r = await decide(c.id, "a");
    expect(r).toMatchObject({ confirmed: ["phi-002"], archived: ["phi-003", "phi-001"] });
    expect([await status("phi-002"), await status("phi-003"), await status("phi-001")]).toEqual(["confirmed", "superseded", "superseded"]);
    expect(pathOf("phi-002")).toBe("notes/wallet/phi-002.md");
    expect(pathOf("phi-001")).toBe("_archive/phi-001.md");
    expect(existsSync(join(root, "notes/wallet/phi-001.md"))).toBe(false);
    expect(queued().slice(-2)).toEqual(["upsert:phi-002", "remove:phi-001"]);
    const n = await VaultStore.open(root, repo).read("phi-002");
    expect(n?.meta).toMatchObject({ supersedes: "phi-001", conflict_ref: null });
    expect((await repo.getConflict(c.id))?.status).toBe("resolved");
    expect(readFileSync(absPath(VaultStore.open(root, repo).paths, c.notificationFile!), "utf8")).toContain("status: da-xu-ly");
  });

  it("Giữ bản cũ: bản cũ không đổi, A và B superseded, không có việc index mới", async () => {
    const c = await setup();
    const before = queued().length;
    await decide(c.id, "old");
    expect([await status("phi-001"), await status("phi-002"), await status("phi-003")]).toEqual(["confirmed", "superseded", "superseded"]);
    expect(queued().length).toBe(before);
  });

  it("Bỏ cả hai: A, B superseded, bản cũ giữ nguyên", async () => {
    const c = await setup();
    await decide(c.id, "drop_all");
    expect([await status("phi-001"), await status("phi-002"), await status("phi-003")]).toEqual(["confirmed", "superseded", "superseded"]);
  });

  it("Gộp: note mới confirmed thay thế A, B và bản cũ", async () => {
    const c = await setup();
    const r = await decide(c.id, "merge", { note: draft("U1", "Fee is 1.8%.") });
    expect(r.confirmed).toEqual(["phi-004"]);
    expect([await status("phi-001"), await status("phi-002"), await status("phi-003"), await status("phi-004")]).toEqual(["superseded", "superseded", "superseded", "confirmed"]);
    const n = await VaultStore.open(root, repo).read("phi-004");
    expect(n?.meta.supersedes).toEqual(["phi-002", "phi-003", "phi-001"]);
    expect(n?.body).toBe("Fee is 1.8%.");
    expect(queued().slice(-2)).toEqual(["upsert:phi-004", "remove:phi-001"]);
  });

  it("người bấm đầu tiên thắng: lần bấm thứ hai bị từ chối", async () => {
    const c = await setup();
    expect(await repo.claimDecision(c.id, "a", null, "admin#1", new Date())).not.toBeNull();
    expect(await repo.claimDecision(c.id, "b", null, "admin#2", new Date())).toBeNull();
    expect((await repo.getConflict(c.id))?.decidedBy).toBe("admin#1");
  });

  it("note đổ vào xung đột sau lúc bấm: không bị quyết định thay, mở xung đột mới", async () => {
    const c = await setup();
    expect(await repo.claimDecision(c.id, "a", null, "admin#1", new Date())).not.toBeNull();
    writeFileSync(join(rawDir, "late.txt"), "x");
    await runIngest(deps(llm((u) => [draft(u[0]!, "Fee is 5%.")]), "2026-09-28T00:30:00Z"), await repo.createBatch("late.txt", "late.txt", null));
    const r = await applyDecision(deps(llm(() => []), "2026-09-28T01:00:00Z"), c.id);
    expect(await status("phi-004")).toBe("awaiting_approval");
    expect(r.reopened).not.toBeNull();
    const again = await repo.getConflict(r.reopened!);
    expect(again!.candidates.map((x) => [x.label, x.noteId, !!x.old])).toEqual([["A", "phi-004", false], ["O", "phi-002", true]]);
  });

  it("ứng viên đổ vào GIỮA LÚC applyDecision đang chạy (sau lần đọc đầu, trước lúc kết luận): vẫn được mở lại, không bị coi là đã xử lý xong", async () => {
    const c = await setup();
    expect(await repo.claimDecision(c.id, "a", null, "admin#1", new Date())).not.toBeNull();

    // Mô phỏng job vault-ingest khác chạy chen vào đúng khoảng applyDecision đã đọc xung đột lần đầu nhưng chưa kết luận:
    // lần gọi getConflict ĐẦU TIÊN trả về ảnh chụp cũ (đúng những gì decide.ts thấy khi mới vào hàm), rồi mới chạy race.
    let raced = false;
    const raceRepo: VaultRepo = {
      ...repo,
      getConflict: async (id: number) => {
        const row = await repo.getConflict(id);
        if (!raced && id === c.id) {
          raced = true;
          writeFileSync(join(rawDir, "late-race.txt"), "x");
          await runIngest(deps(llm((u) => [draft(u[0]!, "Fee is 9%.")]), "2026-09-28T00:45:00Z"), await repo.createBatch("late-race.txt", "late-race.txt", null));
        }
        return row;
      },
    };
    const r = await applyDecision({ ...deps(llm(() => []), "2026-09-28T01:00:00Z"), repo: raceRepo }, c.id);
    expect(raced).toBe(true);

    // Trước khi sửa: report.reopened là null, xung đột bị đóng, note đến muộn kẹt vĩnh viễn ở awaiting_approval.
    expect(r.reopened).not.toBeNull();
    const again = await repo.getConflict(r.reopened!);
    expect(again!.candidates.map((x) => x.label)).toContain("A");
    expect((await repo.getConflict(c.id))?.status).toBe("resolved");
    // Xung đột gốc vẫn ghi "đã xử lý" bình thường cho quyết định "a" — chỉ ứng viên đến muộn mới cần mở lại riêng.
    expect(await status("phi-002")).toBe("confirmed");
  });
});
