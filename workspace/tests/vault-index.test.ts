import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HashEmbedder, type EmbedOptions, type Embedder } from "../src/core/embedding";
import type { KnowledgePort } from "../src/core/ports";
import { migrate, openDb, type Db } from "../src/db/db";
import { vaultRepo, type VaultRepo } from "../src/db/repo-vault";
import { chunkBody, MAX_TOKENS, tokens } from "../src/vault/chunker";
import { writeCursor } from "../src/vault/index-file";
import { runIndex } from "../src/vault/indexer";
import { relatedLink, type NoteMeta, type VaultNote } from "../src/vault/note";
import { CompositeKnowledge, rrf, VaultKnowledge } from "../src/vault/search";
import { VaultStore } from "../src/vault/store";

/** HashEmbedder đếm số lần gọi và ghi lại task_type đã nhận. */
class CountingEmbedder implements Embedder {
  readonly inner = new HashEmbedder();
  readonly version = this.inner.version;
  calls = 0;
  tasks: string[] = [];
  async embed(texts: string[], opts?: EmbedOptions) {
    this.calls += texts.length;
    if (opts?.taskType) this.tasks.push(opts.taskType);
    return this.inner.embed(texts);
  }
}

let db: Db;
let repo: VaultRepo;
let store: VaultStore;
let emb: CountingEmbedder;

beforeEach(async () => {
  db = await openDb("pglite:memory");
  await migrate(db);
  repo = vaultRepo(db);
  store = VaultStore.open(mkdtempSync(join(tmpdir(), "vault-")), repo);
  emb = new CountingEmbedder();
});
afterEach(async () => db.close());

const meta = (id: string, over: Partial<NoteMeta> = {}): NoteMeta => ({
  id, title: `Note ${id}`, category: "wallet", tags: [], status: "confirmed", lang_source: "vi", source_file: "a.txt", source_refs: [], ingested_at: "2026-09-28T03:00:00.000Z",
  version_group: id, supersedes: null, conflict_ref: null, related: [], summary: "s", keywords: ["k"], canonical_title: `Title ${id}`, canonical_summary: `Summary ${id}`, canonical_keywords: ["k"], ...over,
});

async function put(n: VaultNote, action: "upsert" | "remove" | "update_payload" = "upsert") {
  const e = await store.save(n);
  store.queue([{ action, note_id: n.meta.id, reason: "new", queued_at: "t" }]);
  store.flush();
  return e;
}

const deps = () => ({ store: VaultStore.open(store.paths.root, repo), repo, embedder: emb, log: () => undefined });

describe("chunker", () => {
  it("note ngắn giữ nguyên 1 chunk; heading được bỏ dấu #", async () => {
    expect(await chunkBody("## Thời gian\n\nHoàn tiền trong 3-5 ngày.")).toEqual([{ heading: "Thời gian", text: "Thời gian\n\nHoàn tiền trong 3-5 ngày." }]);
  });

  it("note dài: cắt theo heading, phần quá dài cắt tiếp theo đoạn và vẫn mang heading", async () => {
    const para = (n: number) => `Câu ${n} `.repeat(200).trim() + ".";
    const body = `## Điều kiện\n\n${para(1)}\n\n## Các bước\n\n${para(2)}\n\n${para(3)}\n\n${para(4)}`;
    const cs = await chunkBody(body);
    expect(cs.length).toBeGreaterThanOrEqual(3);
    expect(cs[0]!.heading).toBe("Điều kiện");
    expect(cs.slice(1).every((c) => c.heading === "Các bước")).toBe(true);
    expect(cs.every((c) => tokens(c.text) <= MAX_TOKENS * 1.1)).toBe(true);
  });

  it("đoạn dài không cấu trúc: semantic breakpoint dùng embedForChunking, lỗi thì cắt theo độ dài", async () => {
    const long = Array.from({ length: 80 }, (_, i) => (i < 40 ? `Ví ITLG số ${i} được bảo vệ.` : `Game thưởng lượt ${i} mỗi ngày.`)).join(" ");
    const body = `${long} ${long}`;
    let sentences = 0;
    const cs = await chunkBody(body, async (s) => ((sentences += s.length), new HashEmbedder().embed(s)));
    expect(sentences).toBeGreaterThan(0);
    expect(cs.length).toBeGreaterThan(1);
    const failing = await chunkBody(body, async () => { throw new Error("x"); });
    expect(failing.length).toBeGreaterThan(1);
  });
});

describe("vault-index", () => {
  it("upsert: chunk + tsvector + vector; chạy lại không embed lại (embed mới 0)", async () => {
    await put({ meta: meta("phi-001"), body: "Phí giao dịch là 1.5%." });
    const r1 = await runIndex(deps());
    expect(r1).toMatchObject({ processed: 1, upserted: 1, chunks: 1, embedded: 1 });
    expect(emb.tasks).toContain("RETRIEVAL_DOCUMENT");
    expect(await repo.chunkStats()).toEqual({ chunks: 1, notes: 1, vectors: 1 });

    writeCursor(store.paths, 0); // xoá tiến độ, chạy lại toàn bộ hàng đợi
    const before = emb.calls;
    const r2 = await runIndex(deps());
    expect(r2).toMatchObject({ processed: 1, embedded: 0 });
    expect(emb.calls).toBe(before);
    const cfg = JSON.parse(readFileSync(store.paths.embedConfig, "utf8"));
    expect(cfg).toMatchObject({ model: emb.version, dimension: 384, normalized: true });
  });

  it("note chờ duyệt không có chunk; remove xoá sạch cả chữ lẫn vector", async () => {
    await put({ meta: meta("cho-001", { status: "awaiting_approval" }), body: "Nội dung chờ duyệt." });
    await put({ meta: meta("phi-001"), body: "Phí giao dịch là 1.5%." });
    await runIndex(deps());
    expect(await repo.chunkStats()).toEqual({ chunks: 1, notes: 1, vectors: 1 });

    const n = { meta: meta("phi-001", { status: "superseded" }), body: "Phí giao dịch là 1.5%." };
    await put(n, "remove");
    await runIndex(deps());
    expect(await repo.chunkStats()).toEqual({ chunks: 0, notes: 0, vectors: 0 });
  });

  it("update_payload: đổi trạng thái không gọi API embed", async () => {
    await put({ meta: meta("phi-001", { status: "provisional" }), body: "Phí giao dịch là 1.5%." });
    await runIndex(deps());
    const before = emb.calls;
    await put({ meta: meta("phi-001"), body: "Phí giao dịch là 1.5%." }, "update_payload");
    const r = await runIndex(deps());
    expect(r.embedded).toBe(0);
    expect(emb.calls).toBe(before);
    expect((await db.query<{ status: string }>("SELECT status FROM vault_chunks")).rows[0]?.status).toBe("confirmed");
  });

  it("note bị sửa ngắn đi: chunk thừa bị xoá", async () => {
    const long = ["## A", "x ".repeat(750), "## B", "y ".repeat(750)].join("\n\n");
    await put({ meta: meta("dai-001"), body: long });
    await runIndex(deps());
    expect((await repo.chunkStats()).chunks).toBe(2);
    await put({ meta: meta("dai-001"), body: "Ngắn gọn." });
    await runIndex(deps());
    expect((await repo.chunkStats()).chunks).toBe(1);
  });
});

describe("tìm kiếm vault", () => {
  it("RRF: mục có trong cả hai danh sách lên đầu", () => {
    const out = rrf([["a", "b", "c"], ["c", "d"]], (x) => x);
    expect(out[0]!.item).toBe("c");
  });

  it("tìm theo chữ và vector, lọc trạng thái, mở rộng 1 hop theo related", async () => {
    await put({ meta: meta("phi-001", { related: [relatedLink("rut-001", "Rút tiền")], keywords: ["phí giao dịch"] }), body: "Phí giao dịch khi chuyển ví là 1.5%." });
    await put({ meta: meta("rut-001", { keywords: ["rút tiền"] }), body: "Rút ITLG mất 3-5 ngày làm việc." });
    await put({ meta: meta("cho-001", { status: "awaiting_approval" }), body: "Phí giao dịch khi chuyển ví là 2%." });
    await runIndex(deps());
    const k = new VaultKnowledge(repo, emb);
    emb.tasks = [];
    const hits = await k.search("phí giao dịch chuyển ví", 4, "vi");
    expect(emb.tasks).toEqual(["RETRIEVAL_QUERY"]);
    expect(hits.map((h) => h.chunkId)).toEqual(["v:phi-001#0", "v:rut-001#0"]);
    expect(hits[0]!.score).toBeGreaterThan(0.25);
    expect(hits.some((h) => h.text.includes("2%"))).toBe(false);
    expect((await k.byIds(["v:phi-001#0", "v:cho-001#0", "123"])).map((h) => h.chunkId)).toEqual(["v:phi-001#0"]);

    // bản sao note đổi trạng thái trước khi chỉ mục kịp cập nhật: vẫn bị lọc
    await store.save({ meta: meta("rut-001", { status: "superseded" }), body: "Rút ITLG mất 3-5 ngày làm việc." });
    expect((await k.search("phí giao dịch chuyển ví", 4, "vi")).map((h) => h.chunkId)).toEqual(["v:phi-001#0"]);
  });

  it("gộp với tài liệu cũ: byIds chuyển đúng nguồn theo tiền tố", async () => {
    const legacy: KnowledgePort = {
      search: async () => [{ chunkId: "7", docSlug: "doc", heading: "H", text: "legacy", score: 0.9 }],
      byIds: async (ids) => ids.map((id) => ({ chunkId: id, docSlug: "doc", heading: "H", text: "legacy", score: 1 })),
    };
    const vault: KnowledgePort = { search: async () => [{ chunkId: "v:x#0", docSlug: "vault/x", heading: "X", text: "vault", score: 0.8 }], byIds: async (ids) => ids.map((id) => ({ chunkId: id, docSlug: "vault/x", heading: "X", text: "vault", score: 1 })) };
    const c = new CompositeKnowledge(legacy, vault);
    expect((await c.search("q", 4)).map((h) => h.chunkId).sort()).toEqual(["7", "v:x#0"]);
    expect((await c.byIds(["v:x#0", "7"])).map((h) => h.text)).toEqual(["vault", "legacy"]);
  });
});

describe("chống lẫn task_type", () => {
  const read = (dir: string, match: RegExp) => readdirSync(dir).filter((f) => match.test(f)).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  it("indexer/chunker không gọi embedQuery; search không gọi embedDocument/embedForChunking", () => {
    expect(read("src/vault", /^(indexer|chunker)\.ts$/)).not.toMatch(/embedQuery/);
    expect(read("src/vault", /^search\.ts$/)).not.toMatch(/embedDocument|embedForChunking/);
  });
});
