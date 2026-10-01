/**
 * Embedding theo LỰA CHỌN (Admin Web → Cấu hình → Embedding): đúng MỘT model cho cả kho lẫn câu hỏi, không dự phòng ngầm
 * (bỏ cơ chế tự chuyển/tự khoá 2026-09-30 theo yêu cầu chủ dự án — chọn API ngoài thì MỌI lượt đều gọi API thật, lỗi thì
 * báo lỗi thẳng lên trên). `EmbeddingConfig.lockExternal`/`unlockExternal` vẫn còn (chức năng khoá thủ công của admin),
 * chỉ là không còn gì TỰ ĐỘNG gọi tới nữa.
 * Vector của hai model KHÔNG so sánh được: kho phân vùng theo model, tìm kiếm chỉ dùng bộ vector của model đã embed câu hỏi.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HashEmbedder, type Embedder } from "../src/core/embedding";
import { TemplateIndex } from "../src/core/template-index";
import { migrate, openDb } from "../src/db/db";
import { kbRepo } from "../src/db/repo-kb";
import { opsRepo } from "../src/db/repo-ops";
import { PgKnowledge } from "../src/kb/knowledge-search";
import { LiveContent } from "../src/kb/live-content";
import { seedContent } from "../src/kb/seed";
import { KbService } from "../src/kb/service";
import { loadPredicates } from "../src/core/predicates";
import { EmbeddingConfig } from "../src/llm/embedding-config";
import { SelectedEmbedder, type EmbeddingSelection } from "../src/llm/embedder";
import { SecretBox } from "../src/llm/secret-box";

/** "API ngoài" giả: vector khác hẳn không gian của HashEmbedder; có thể bật/tắt lỗi */
function fakeRemote(state: { down: boolean; calls: number; dims?: number }) {
  return (async (url: string, init?: RequestInit) => {
    state.calls++;
    if (state.down) return new Response("upstream down", { status: 503 });
    const body = JSON.parse(String(init?.body)) as { input: string[]; dimensions?: number };
    const dims = body.dimensions ?? state.dims ?? 8;
    return Response.json({ data: body.input.map((t, index) => ({ index, embedding: Array.from({ length: dims }, (_, i) => ((t.length * (i + 1)) % 7) / 7) })) });
  }) as typeof fetch;
}

const EXT = { url: "http://remote/v1", model: "gemini-embedding-001" };
const GEMINI = "http:gemini-embedding-001";

describe("SelectedEmbedder", () => {
  it("chọn API -> dùng API; chọn cục bộ -> cục bộ, không gọi mạng; chưa cấu hình API -> cục bộ; số chiều nằm trong định danh model", async () => {
    const state = { down: false, calls: 0 };
    const local = new HashEmbedder(16);
    let sel: EmbeddingSelection = { provider: "external", external: EXT };
    const e = new SelectedEmbedder(async () => sel, local, { fetchImpl: fakeRemote(state) });
    const a = await e.embedTagged(["hello"]);
    expect(a.model).toBe(GEMINI);
    expect(a.vectors[0]).toHaveLength(8);
    expect(e.version).toBe(GEMINI);

    sel = { provider: "local", external: EXT };
    const calls = state.calls;
    const b = await e.embedTagged(["hello"]);
    expect(b.model).toBe(local.version);
    expect(b.vectors[0]).toHaveLength(16);
    expect(state.calls).toBe(calls); // đã chọn cục bộ: không đụng API

    sel = { provider: "external", external: null }; // chưa cấu hình API -> cục bộ
    expect((await e.embedTagged(["x"])).model).toBe(local.version);

    const d = new SelectedEmbedder(async () => ({ provider: "external", external: { ...EXT, dimensions: 4 } }), local, { fetchImpl: fakeRemote(state) });
    const t = await d.embedTagged(["x"]);
    expect(t.model).toBe("http:gemini-embedding-001@4");
    expect(t.vectors[0]).toHaveLength(4);
  });

  it("API lỗi -> embedTagged NÉM LỖI THẲNG, không âm thầm đổi sang cục bộ; API sống lại thì lượt sau bình thường ngay, không cần ai mở khoá", async () => {
    const state = { down: true, calls: 0 };
    const local = new HashEmbedder(16);
    const sel: EmbeddingSelection = { provider: "external", external: EXT };
    const e = new SelectedEmbedder(async () => sel, local, { fetchImpl: fakeRemote(state) });
    await expect(e.embedTagged(["a"])).rejects.toThrow(/503|status/);
    await expect(e.embedTagged(["b"])).rejects.toThrow(/503|status/); // lỗi tiếp: vẫn ném lỗi, không tự chuyển cục bộ

    state.down = false;
    const c = await e.embedTagged(["c"]); // API sống lại: dùng ngay bình thường, không cần thao tác nào của admin
    expect(c.model).toBe(GEMINI);
  });
});

describe("EmbeddingConfig (Admin Web)", () => {
  it("lưu URL/khoá/model/số chiều; khoá mã hoá; chuỗi rỗng xoá; không SECRETS_KEY thì từ chối lưu khoá", async () => {
    const db = await openDb("pglite:memory");
    await migrate(db);
    const ops = opsRepo(db);
    const cfg = new EmbeddingConfig(ops, new SecretBox("test-secrets-key-0123456789-abcdefghij"), 0);
    expect(await cfg.resolve()).toBeNull();
    await cfg.save({ baseUrl: "https://platform.beeknoee.com/v1/", apiKey: "sk-abc-123456", model: "gemini-embedding-001", dimensions: 768 }, "owner");
    expect(await cfg.resolve()).toEqual({ baseUrl: "https://platform.beeknoee.com/v1", apiKey: "sk-abc-123456", model: "gemini-embedding-001", dimensions: 768 });
    expect((await ops.getSecret("embedding.api_key"))).not.toContain("sk-abc"); // đã mã hoá
    const v = await cfg.view();
    expect(v).toMatchObject({ configured: true, hasKey: true, canStoreKey: true, dimensions: 768 });
    expect(v.keyHint).not.toContain("abc-123");
    await cfg.save({ dimensions: null, apiKey: "" }, "owner");
    expect(await cfg.resolve()).toEqual({ baseUrl: "https://platform.beeknoee.com/v1", apiKey: undefined, model: "gemini-embedding-001", dimensions: undefined });
    await expect(cfg.save({ baseUrl: "ftp://x" }, "owner")).rejects.toThrow(/http/);
    await expect(cfg.save({ model: "bad model name!" }, "owner")).rejects.toThrow(/model/);
    await cfg.save({ baseUrl: "" }, "owner");
    expect(await cfg.resolve()).toBeNull();
    const noBox = new EmbeddingConfig(ops, null, 0);
    await expect(noBox.save({ apiKey: "k" }, "owner")).rejects.toThrow(/SECRETS_KEY/);
    await db.close();
  });

  it("dùng EMBEDDING_API_KEY làm fallback khi DB chưa lưu secret", async () => {
    const db = await openDb("pglite:memory");
    await migrate(db);
    const ops = opsRepo(db);
    const cfg = new EmbeddingConfig(ops, null, 0, Date.now, "env-embedding-key");
    await cfg.save({ baseUrl: "https://platform.beeknoee.com/v1", model: "openai/text-embedding-3-small", dimensions: 1536 }, "owner");
    expect(await cfg.resolve()).toEqual({
      baseUrl: "https://platform.beeknoee.com/v1",
      apiKey: "env-embedding-key",
      model: "openai/text-embedding-3-small",
      dimensions: 1536,
    });
    await db.close();
  });

  it("lựa chọn model: mặc định API khi đã cấu hình; khoá -> hiệu lực cục bộ, chọn API bị từ chối; mở khoá KHÔNG tự chọn lại API", async () => {
    const db = await openDb("pglite:memory");
    await migrate(db);
    const ops = opsRepo(db);
    const cfg = new EmbeddingConfig(ops, null, 0);
    expect((await cfg.view()).provider).toBe("local"); // chưa cấu hình API thì chỉ có cục bộ
    await expect(cfg.setProvider("external", "admin")).rejects.toThrow(/Chưa cấu hình/);

    await cfg.save({ baseUrl: "http://remote/v1", model: "gemini-embedding-001" }, "owner");
    expect((await cfg.view()).provider).toBe("external");
    expect((await cfg.selection()).external).toMatchObject({ url: "http://remote/v1", model: "gemini-embedding-001" });
    await cfg.setProvider("local", "admin");
    expect(await cfg.view()).toMatchObject({ provider: "local", storedProvider: "local", locked: false });
    await cfg.setProvider("external", "admin");
    expect((await cfg.view()).provider).toBe("external");

    await cfg.lockExternal("embedding status 503", new Date("2026-09-23T01:00:00Z"));
    await cfg.lockExternal("lý do sau bị bỏ qua"); // lặp lại an toàn: giữ lý do và thời điểm đầu tiên
    expect(await cfg.view()).toMatchObject({ provider: "local", storedProvider: "local", locked: true, lockReason: "embedding status 503", lockedAt: "2026-09-23T01:00:00.000Z" });
    expect((await cfg.selection()).provider).toBe("local");
    await expect(cfg.setProvider("external", "admin")).rejects.toThrow(/KHOÁ/);

    await cfg.unlockExternal();
    expect(await cfg.view()).toMatchObject({ provider: "local", locked: false, lockReason: null, lockedAt: null });
    await cfg.setProvider("external", "admin");
    expect((await cfg.view()).provider).toBe("external");
    await db.close();
  });
});

describe("kho tri thức với model được chọn: chỉ đánh chỉ mục cho model đó; API lỗi -> báo lỗi thẳng, KHÔNG tự chuyển cục bộ nữa", () => {
  const state = { down: false, calls: 0 };
  let now = 5_000_000;
  const local = new HashEmbedder(16);
  let db: Awaited<ReturnType<typeof openDb>>;
  let kb: ReturnType<typeof kbRepo>;
  let ops: ReturnType<typeof opsRepo>;
  let cfg: EmbeddingConfig;
  let emb: SelectedEmbedder;
  let live: LiveContent;
  let svc: KbService;
  let search: PgKnowledge;

  beforeAll(async () => {
    db = await openDb("pglite:memory");
    await migrate(db);
    kb = kbRepo(db);
    ops = opsRepo(db);
    cfg = new EmbeddingConfig(ops, null, 0);
    await cfg.save({ baseUrl: "http://remote/v1", model: "gemini-embedding-001" }, "owner"); // đã cấu hình -> mặc định chọn API
    emb = new SelectedEmbedder(() => cfg.selection(), local, { fetchImpl: fakeRemote(state) });
    live = new LiveContent(db, kb, ops, emb, "content/config/predicates.yml", () => now, async () => (await emb.active()).version);
    svc = new KbService({ db, kb, ops, embedder: emb, live, predicatesFallback: () => loadPredicates("content/config/predicates.yml") });
    await seedContent(svc, kb, ops, db, { contentDir: "content", adminIds: [9001], ownerId: 9001 });
    await live.rebuild();
    search = new PgKnowledge(kb, emb);
  });
  afterAll(() => db.close());

  it("publish embed bằng model đang chọn (API); reindex chỉ làm cho model đó, KHÔNG tính vector cho model kia", async () => {
    const chunks = await kb.countChunks();
    expect(chunks).toBeGreaterThan(5);
    const cov = await kb.chunkEmbeddingCoverage();
    expect(cov.find((c) => c.model === GEMINI)?.n).toBe(chunks);
    expect(cov.find((c) => c.model === local.version)).toBeUndefined();
    expect(await svc.reindexChunks(50)).toMatchObject({ updated: 0, remaining: 0, models: [GEMINI] });
    expect((await kb.chunkEmbeddingCoverage()).find((c) => c.model === local.version)).toBeUndefined();
    expect(live.index.vectorsModel).toBe(GEMINI);
  });

  it("admin chọn cục bộ -> reindex đánh chỉ mục toàn bộ bằng cục bộ; tìm kiếm và index câu mẫu dùng đúng bộ vector cục bộ; chọn lại API thì dựng lại", async () => {
    await cfg.setProvider("local", "admin");
    const chunks = await kb.countChunks();
    const r = await svc.reindexChunks(50);
    expect(r.models).toEqual([local.version]);
    expect(r.updated).toBe(chunks);
    expect((await kb.chunkEmbeddingCoverage()).find((c) => c.model === local.version)?.n).toBe(chunks);
    const hits = await search.search("tokenomics vesting schedule", 3, "en");
    expect(hits.length).toBeGreaterThan(0);
    const direct = await new PgKnowledge(kb, local).search("tokenomics vesting schedule", 3, "en"); // đúng bộ vector cục bộ, không so chéo model
    expect(hits.map((h) => h.chunkId)).toEqual(direct.map((h) => h.chunkId));
    now += 1;
    await live.ensureFresh(0);
    expect(live.index.vectorsModel).toBe(local.version);
    expect((await live.index.suggest("how to withdraw my tokens", 3)).length).toBeGreaterThan(0);

    await cfg.setProvider("external", "admin");
    now += 1;
    await live.ensureFresh(0);
    expect(live.index.vectorsModel).toBe(GEMINI);
  });

  it("API lỗi -> KHÔNG tự chuyển/tự khoá; lựa chọn vẫn nguyên là API; search() vẫn có kết quả nhờ lớp dự phòng RIÊNG của tìm kiếm (chỉ khớp từ khoá, không phải của SelectedEmbedder)", async () => {
    expect((await cfg.view()).provider).toBe("external");
    state.down = true;
    await expect(emb.embedTagged(["ping"])).rejects.toThrow(/503|status/); // SelectedEmbedder: báo lỗi thẳng, không đổi model
    expect(await cfg.view()).toMatchObject({ provider: "external", locked: false }); // KHÔNG bị khoá, KHÔNG đổi lựa chọn
    expect(await ops.hasPendingJob("reindex-embeddings")).toBe(false); // không có gì tự xếp việc đánh chỉ mục lại nữa

    // PgKnowledge.search() có lớp dự phòng RIÊNG của chính nó (bắt lỗi embed, chỉ còn khớp từ khoá) — không liên quan gì
    // tới SelectedEmbedder, vẫn hoạt động như cũ, không đổi.
    const hits = await search.search("tokenomics vesting schedule", 3, "en");
    expect(hits.length).toBeGreaterThan(0);

    state.down = false;
    const ping = await emb.embedTagged(["ping"]); // API sống lại: dùng ngay, không cần ai mở khoá
    expect(ping.model).toBe(GEMINI);
  });

  it("index câu mẫu dựng bằng model này nhận câu hỏi embed bằng model khác -> trả rỗng thay vì so sánh vô nghĩa", async () => {
    const stale = new TemplateIndex(live.index.templates, live.evaluator, emb, await TemplateIndex.computeVectors(live.index.templates, local), local.version);
    expect(await stale.suggest("how to withdraw my tokens", 3)).toEqual([]);
  });

  it("embedder thường (không có lựa chọn) vẫn hoạt động như cũ", async () => {
    const e: Embedder = new HashEmbedder(8);
    const idx = new TemplateIndex(live.index.templates, live.evaluator, e, await TemplateIndex.computeVectors(live.index.templates, e));
    expect(idx.vectorsModel).toBe(e.version);
    expect((await idx.suggest("how to withdraw my tokens", 3)).length).toBeGreaterThan(0);
  });
});
