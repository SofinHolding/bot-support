import { describe, expect, it, vi } from "vitest";
import type { KnowledgeHit, KnowledgePort } from "../src/core/ports";
import { PythonKnowledge, ShadowKnowledge } from "../src/kb/python-knowledge";

const hit = (id: string): KnowledgeHit => ({ chunkId: id, docSlug: id, heading: "h", text: "body", score: 0.9, lang: "en" });

describe("PythonKnowledge", () => {
  it("map response đúng KnowledgePort và gửi token nội bộ", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer secret");
      return new Response(JSON.stringify([hit("pykv:1")]), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const k = new PythonKnowledge({ baseUrl: "http://python:3010/", token: "secret" });
      expect(await k.search("forgot id", 8, "en")).toEqual([hit("pykv:1")]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("không fallback im lặng khi Python trả lỗi", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    try {
      const k = new PythonKnowledge({ baseUrl: "http://python:3010" });
      await expect(k.search("x", 3)).rejects.toThrow("python knowledge search 503");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("ShadowKnowledge", () => {
  it("luôn trả primary dù shadow khác", async () => {
    const primary: KnowledgePort = { search: async () => [hit("legacy")], byIds: async () => [hit("legacy-id")] };
    const shadow: KnowledgePort = { search: async () => [hit("python")] };
    const logs: unknown[] = [];
    const k = new ShadowKnowledge(primary, shadow, (_msg, extra) => logs.push(extra));
    expect(await k.search("x", 8)).toEqual([hit("legacy")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(logs).toHaveLength(1);
  });
});
