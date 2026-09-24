import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HashEmbedder } from "../src/core/embedding";
import { loadPredicates } from "../src/core/predicates";
import { migrate, openDb, type Db } from "../src/db/db";
import { opsRepo } from "../src/db/repo-ops";
import { KbService } from "../src/kb/service";
import { friendlyGatewayError, GatewayConfig, normalizeBaseUrl } from "../src/llm/gateway-config";
import { OpenAICompatProvider } from "../src/llm/openai-compat";
import { SecretBox } from "../src/llm/secret-box";
import { ProviderUnavailableError } from "../src/llm/types";
import { makeWorld, type World } from "./helpers";

describe("SecretBox", () => {
  it("mã hoá khứ hồi; mỗi lần mã hoá ra chuỗi khác; sai khoá hoặc dữ liệu hỏng => null", () => {
    const box = new SecretBox("k".repeat(40));
    const a = box.encrypt("sk-secret");
    expect(a).not.toContain("sk-secret");
    expect(box.encrypt("sk-secret")).not.toBe(a);
    expect(box.decrypt(a)).toBe("sk-secret");
    expect(new SecretBox("z".repeat(40)).decrypt(a)).toBeNull();
    expect(box.decrypt(a.slice(0, -4) + "AAAA")).toBeNull();
    expect(box.decrypt("rác")).toBeNull();
  });
});

describe("GatewayConfig", () => {
  let db: Db;
  const env = { baseUrl: "http://env-gw/v1", apiKey: "env-key", modelFast: "env-fast", modelStrong: "env-strong" };
  beforeAll(async () => {
    db = await openDb("pglite:memory");
    await migrate(db);
  });
  afterAll(async () => db.close());

  it("mặc định lấy từ env; ghi đè trong DB; chuỗi rỗng quay về env", async () => {
    const g = new GatewayConfig(opsRepo(db), env, new SecretBox("k".repeat(40)), 0);
    expect(await g.resolve()).toEqual({ baseUrl: "http://env-gw/v1", apiKey: "env-key", models: { fast: "env-fast", strong: "env-strong", intake: "env-fast" } });
    await g.saveModels({ fast: "  my-fast  " }, "t");
    await g.saveConnection({ baseUrl: "https://gw.example/v1/", apiKey: "web-key" }, "t");
    expect(await g.resolve()).toEqual({ baseUrl: "https://gw.example/v1", apiKey: "web-key", models: { fast: "my-fast", strong: "env-strong", intake: "my-fast" } });
    await g.saveConnection({ apiKey: undefined, baseUrl: "" }, "t"); // undefined = giữ khoá
    expect((await g.resolve())?.apiKey).toBe("web-key");
    await g.saveModels({ fast: "" }, "t");
    await g.saveConnection({ apiKey: "" }, "t");
    expect(await g.resolve()).toEqual({ baseUrl: "http://env-gw/v1", apiKey: "env-key", models: { fast: "env-fast", strong: "env-strong", intake: "env-fast" } });
  });

  it("thiếu URL hoặc model => chưa sẵn sàng; không có SECRETS_KEY thì từ chối lưu khoá", async () => {
    const g = new GatewayConfig(opsRepo(db), { modelFast: "", modelStrong: "" }, null, 0);
    expect(await g.resolve()).toBeNull();
    expect(g.ready).toBe(false);
    await expect(g.saveConnection({ apiKey: "abc" }, "t")).rejects.toThrow(/SECRETS_KEY/);
    await g.saveConnection({ baseUrl: "http://x/v1" }, "t");
    expect(await g.resolve()).toBeNull(); // vẫn thiếu model
    await g.saveModels({ fast: "a", strong: "b" }, "t");
    expect(g.ready).toBe(true);
    expect((await g.view()).canStoreKey).toBe(false);
  });

  it("khoá lưu bằng SECRETS_KEY khác không giải mã được => bỏ qua, dùng khoá trong env, không sập", async () => {
    const ops = opsRepo(db);
    await new GatewayConfig(ops, env, new SecretBox("a".repeat(40)), 0).saveConnection({ apiKey: "web-key" }, "t");
    const g = new GatewayConfig(ops, env, new SecretBox("b".repeat(40)), 0);
    expect((await g.resolve())?.apiKey).toBe("env-key");
  });

  it("chuẩn hoá URL", () => {
    expect(normalizeBaseUrl(" http://localhost:20128/v1/ ")).toBe("http://localhost:20128/v1");
    expect(() => normalizeBaseUrl("localhost:20128")).toThrow();
    expect(() => normalizeBaseUrl("file:///etc/passwd")).toThrow();
  });
});

describe("friendlyGatewayError", () => {
  it("rút câu lỗi người đọc được từ phản hồi lồng nhau của 9router", () => {
    const inner = JSON.stringify({ detail: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account." });
    const raw = "status 400: " + JSON.stringify({ error: { message: "[400]: " + inner, type: "invalid_request_error" } });
    expect(friendlyGatewayError(raw)).toBe("400: The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.");
    expect(friendlyGatewayError('status 401: {"error":"bad key"}')).toBe("401: bad key");
    expect(friendlyGatewayError("connection error")).toBe("connection error");
    expect(friendlyGatewayError("status 502: <html>oops</html>")).toBe("502: <html>oops</html>");
  });
});

describe("OpenAICompatProvider với cấu hình động", () => {
  const req = { tier: "fast" as const, purpose: "classify" as const, system: [{ text: "s" }], user: [{ type: "text" as const, text: "u" }], schema: z.object({ ok: z.boolean() }), maxTokens: 20 };
  const okFetch = (seen: { model?: string }[]) =>
    (async (_u: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
    }) as typeof fetch;

  it("đọc lại cấu hình mỗi lần gọi: đổi model có hiệu lực ngay; chưa cấu hình => ProviderUnavailableError", async () => {
    const seen: { model?: string }[] = [];
    let cfg: { baseUrl: string; models: { fast: string; strong: string; intake: string }; fetchImpl: typeof fetch } | null = null;
    const p = new OpenAICompatProvider(async () => cfg, "gateway");
    await expect(p.generateJson(req)).rejects.toBeInstanceOf(ProviderUnavailableError);
    cfg = { baseUrl: "http://gw/v1", models: { fast: "m1", strong: "s1", intake: "m1" }, fetchImpl: okFetch(seen) };
    await p.generateJson(req);
    cfg = { ...cfg, models: { fast: "m2", strong: "s1", intake: "m2" } };
    await p.generateJson(req);
    expect(seen.map((s) => s.model)).toEqual(["m1", "m2"]);
  });

  it("lỗi từ gateway kèm nội dung để chẩn đoán (vd model không tồn tại)", async () => {
    const f = (async () => new Response('{"error":"model not found"}', { status: 404 })) as unknown as typeof fetch;
    const p = new OpenAICompatProvider({ baseUrl: "http://gw/v1", models: { fast: "x", strong: "y", intake: "x" }, fetchImpl: f });
    await expect(p.generateJson(req)).rejects.toThrow(/404.*model not found/);
  });
});

describe("đổi embedding model: embed lại chunk tri thức", () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld();
  });
  afterAll(async () => w.close());

  it("chunk cũ (model khác) không còn khớp vector; reindex làm chúng khớp lại, chạy lại thì không làm gì", async () => {
    const next = new HashEmbedder(128);
    const svc2 = new KbService({ db: w.db, kb: w.kb, ops: w.ops, embedder: next, live: w.live, predicatesFallback: () => loadPredicates("content/config/predicates.yml") });
    const before = await w.kb.listStaleChunks(next.version, 1000);
    expect(before.length).toBeGreaterThan(0);
    const [q] = await next.embed(["what is the ITL token"]);
    expect((await w.kb.searchChunks({ tsQuery: "", embedding: q, embeddingModel: next.version, limit: 5 })).length).toBe(0);

    const r = await svc2.reindexChunks(8);
    expect(r).toEqual({ updated: before.length, remaining: 0, models: [next.version] });
    expect(await w.kb.listStaleChunks(next.version, 10)).toEqual([]);
    expect((await w.kb.searchChunks({ tsQuery: "", embedding: q, embeddingModel: next.version, limit: 5 })).length).toBeGreaterThan(0);
    expect(await svc2.reindexChunks()).toEqual({ updated: 0, remaining: 0, models: [next.version] });
  });

  it("dịch vụ embedding đang lỗi: không mất dữ liệu, báo còn lại bao nhiêu để lần sau làm tiếp", async () => {
    const down = { version: "http:down", embed: async () => { throw new Error("connection refused"); } };
    const svc3 = new KbService({ db: w.db, kb: w.kb, ops: w.ops, embedder: down, live: w.live, predicatesFallback: () => loadPredicates("content/config/predicates.yml") });
    const r = await svc3.reindexChunks(8);
    expect(r.updated).toBe(0);
    expect(r.remaining).toBeGreaterThan(0);
  });
});
