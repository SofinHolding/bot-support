import type { KnowledgeHit, KnowledgePort } from "../core/ports";

interface PythonKnowledgeConfig {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

function headers(token?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function isHit(x: unknown): x is KnowledgeHit {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.chunkId === "string" &&
    typeof r.docSlug === "string" &&
    typeof r.heading === "string" &&
    typeof r.text === "string" &&
    typeof r.score === "number"
  );
}

/**
 * Adapter giữ nguyên KnowledgePort của Node trong khi Knowledge Governance + retrieval chuyển sang Python.
 * Không fallback ngầm khi đã chọn provider=python: lỗi Python/RAGFlow phải nổi lên để pipeline xử lý theo fail-safe hiện có.
 */
export class PythonKnowledge implements KnowledgePort {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;

  constructor(cfg: PythonKnowledgeConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.token = cfg.token;
    this.timeoutMs = cfg.timeoutMs ?? 15_000;
  }

  async search(query: string, k: number, queryLang?: string): Promise<KnowledgeHit[]> {
    const res = await fetch(`${this.baseUrl}/v1/retrieval/search`, {
      method: "POST",
      headers: headers(this.token),
      body: JSON.stringify({ query, k, queryLang }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`python knowledge search ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error("python knowledge search response invalid");
    return body.filter(isHit).slice(0, k);
  }

  async byIds(ids: string[]): Promise<KnowledgeHit[]> {
    if (!ids.length) return [];
    const res = await fetch(`${this.baseUrl}/v1/retrieval/by-ids`, {
      method: "POST",
      headers: headers(this.token),
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`python knowledge byIds ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error("python knowledge byIds response invalid");
    return body.filter(isHit);
  }
}

/** Shadow không bao giờ ảnh hưởng câu trả lời khách: primary quyết định kết quả, Python chỉ được gọi để so sánh/log. */
export class ShadowKnowledge implements KnowledgePort {
  constructor(
    private readonly primary: KnowledgePort,
    private readonly shadow: KnowledgePort,
    private readonly log: (msg: string, extra?: unknown) => void = () => undefined,
  ) {}

  async search(query: string, k: number, queryLang?: string): Promise<KnowledgeHit[]> {
    const primary = await this.primary.search(query, k, queryLang);
    void this.shadow
      .search(query, k, queryLang)
      .then((candidate) => {
        const oldIds = primary.map((x) => x.chunkId);
        const newIds = candidate.map((x) => x.chunkId);
        this.log("retrieval shadow", {
          query: query.slice(0, 180),
          legacyCount: oldIds.length,
          pythonCount: newIds.length,
          legacyTop: oldIds.slice(0, 5),
          pythonTop: newIds.slice(0, 5),
        });
      })
      .catch((err: unknown) => this.log("retrieval shadow lỗi", { err: err instanceof Error ? err.message : String(err) }));
    return primary;
  }

  async byIds(ids: string[]): Promise<KnowledgeHit[]> {
    return this.primary.byIds ? this.primary.byIds(ids) : [];
  }
}
