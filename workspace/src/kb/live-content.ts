/** Nội dung đang chạy (đã publish) nạp vào bộ nhớ; tự làm mới khi kb_version đổi, không cần khởi động lại bot. */
import { collectHosts } from "../core/gate";
import { buildIndex } from "../core/bundle";
import type { Embedder } from "../core/embedding";
import { sha1 } from "../core/knowledge";
import { loadPredicates, makeEvaluator, type Evaluator, type PredicateMap } from "../core/predicates";
import { TemplateIndex } from "../core/template-index";
import type { Template } from "../domain/types";
import type { Db } from "../db/db";
import type { KbRepo } from "../db/repo-kb";
import type { OpsRepo } from "../db/repo-ops";

export class LiveContent {
  index!: TemplateIndex;
  evaluator!: Evaluator;
  predicates!: PredicateMap;
  urlHosts = new Set<string>();
  version = -1;
  private checkedAt = 0;
  private rebuilding: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly kb: KbRepo,
    private readonly ops: OpsRepo,
    private readonly embedder: Embedder,
    private readonly predicatesFile: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Gọi trước mỗi lượt xử lý; chỉ truy vấn kb_version nếu đã quá `maxAgeMs` kể từ lần kiểm tra trước. */
  async ensureFresh(maxAgeMs = 5000): Promise<void> {
    if (this.version >= 0 && this.now() - this.checkedAt < maxAgeMs) return;
    const v = await this.ops.kbVersion();
    this.checkedAt = this.now();
    if (v === this.version) return;
    this.rebuilding ??= this.rebuild(v).finally(() => (this.rebuilding = null));
    await this.rebuilding;
  }

  async rebuild(version?: number): Promise<void> {
    const v = version ?? (await this.ops.kbVersion());
    const templates = await this.kb.loadPublishedTemplates();
    const prot = await this.ops.getProtected();
    const customPredicates = prot.predicates as PredicateMap | undefined;
    this.predicates = customPredicates && Object.keys(customPredicates).length ? customPredicates : loadPredicates(this.predicatesFile);
    this.evaluator = makeEvaluator(this.predicates);
    const vectors = await this.exampleVectors(templates);
    this.index = new TemplateIndex(templates, this.evaluator, this.embedder, vectors);

    const texts: string[] = [];
    for (const t of templates) texts.push(...Object.values(t.answers));
    const chunks = await this.db.query<{ text: string; url: string | null }>("SELECT c.text, c.url FROM kb_chunks c JOIN kb_document_versions v ON v.id = c.version_id WHERE v.status = 'published'");
    for (const c of chunks.rows) texts.push(c.text, c.url ?? "");
    this.urlHosts = collectHosts(texts);
    // whitelist bổ sung (cấu hình được bảo vệ) là danh sách hostname trần, không phải URL
    for (const h of (prot.url_whitelist_extra as string[] | undefined) ?? []) this.urlHosts.add(h.toLowerCase());
    this.version = v;
    this.checkedAt = this.now();
  }

  private async exampleVectors(templates: Template[]) {
    const wanted: { id: string; text: string; hash: string }[] = [];
    for (const t of templates) if (t.response_mode === "EXACT_TEMPLATE") for (const ex of t.match.examples) wanted.push({ id: t.id, text: ex, hash: sha1(ex) });
    const cache = await this.kb.getEmbeddings([...new Set(wanted.map((w) => w.hash))], this.embedder.version);
    const missing = [...new Map(wanted.filter((w) => !cache.has(w.hash)).map((w) => [w.hash, w])).values()];
    if (missing.length) {
      try {
        const vecs = await this.embedder.embed(missing.map((m) => m.text));
        const entries = missing.map((m, i) => ({ hash: m.hash, vector: vecs[i]! }));
        await this.kb.putEmbeddings(entries, this.embedder.version);
        for (const e of entries) cache.set(e.hash, e.vector);
      } catch {
        // embedding lỗi: chạy không có gợi ý ngữ nghĩa cho các câu chưa có vector (từ khoá/rule vẫn hoạt động)
      }
    }
    const out = new Map<string, number[][]>();
    for (const w of wanted) {
      const v = cache.get(w.hash);
      if (v) out.set(w.id, [...(out.get(w.id) ?? []), v]);
    }
    return out;
  }
}

export { buildIndex };
