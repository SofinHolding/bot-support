/** Nội dung đang chạy (đã publish) nạp vào bộ nhớ; tự làm mới khi kb_version đổi, không cần khởi động lại bot. */
import { collectHosts } from "../core/gate";
import { GUIDE_SLUG, parseGuide, type Guide } from "../core/guide";
import { buildIndex } from "../core/bundle";
import { embedTagged, type Embedder } from "../core/embedding";
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
  /** Cặp nội dung đang xung đột CHƯA giải quyết (kb_conflicts mở, AI kết luận xung đột / mâu thuẫn trực tiếp): router không hỏi lại khách giữa chúng */
  conflicts: ReadonlySet<string> = new Set();
  /** Mốc thời gian phần trả lời / nội dung của từng nội dung đổi lần cuối (kb_content_history): nội dung mâu thuẫn thì dùng bên mới hơn */
  answerTimes: ReadonlyMap<string, number> = new Map();
  /** "Hướng dẫn AI làm việc" đang publish (undefined = chưa có): LlmClient đưa các mục liên quan vào prompt */
  guide: Guide | undefined;
  version = -1;
  private checkedAt = 0;
  /** Có ví dụ template chưa có vector (dịch vụ embedding chưa sẵn sàng lúc nạp): thử nạp lại định kỳ thay vì chờ kb_version đổi. */
  private incomplete = false;
  private rebuiltAt = 0;
  private rebuilding: Promise<void> | null = null;
  /** model đã dùng để tạo vector câu mẫu của index hiện tại */
  private builtWith = "";

  constructor(
    private readonly db: Db,
    private readonly kb: KbRepo,
    private readonly ops: OpsRepo,
    private readonly embedder: Embedder,
    private readonly predicatesFile: string,
    private readonly now: () => number = Date.now,
    /** Embedder có dự phòng: model sẽ được dùng ngay bây giờ (không gọi mạng). Không có = embedder.version cố định. */
    private readonly activeModel?: () => Promise<string>,
  ) {}

  /** Gọi trước mỗi lượt xử lý; chỉ truy vấn kb_version nếu đã quá `maxAgeMs` kể từ lần kiểm tra trước. */
  async ensureFresh(maxAgeMs = 5000): Promise<void> {
    if (this.version >= 0 && this.now() - this.checkedAt < maxAgeMs) return;
    const v = await this.ops.kbVersion();
    this.checkedAt = this.now();
    // Embedder có dự phòng: model đang dùng đổi (API ngoài lỗi -> cục bộ, hoặc khôi phục) => dựng lại index với vector của model đó
    const modelChanged = !!this.activeModel && (await this.activeModel()) !== this.builtWith;
    if (v === this.version && !modelChanged && !(this.incomplete && this.now() - this.rebuiltAt > 60_000)) return;
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
    const model = this.activeModel ? await this.activeModel() : this.embedder.version;
    const vectors = await this.exampleVectors(templates, model);
    this.index = new TemplateIndex(templates, this.evaluator, this.embedder, vectors, model);
    this.builtWith = model;

    const texts: string[] = [];
    for (const t of templates) texts.push(...Object.values(t.answers));
    const chunks = await this.db.query<{ text: string; url: string | null }>("SELECT c.text, c.url FROM kb_chunks c JOIN kb_document_versions v ON v.id = c.version_id WHERE v.status = 'published'");
    for (const c of chunks.rows) texts.push(c.text, c.url ?? "");
    this.urlHosts = collectHosts(texts);
    // whitelist bổ sung (cấu hình được bảo vệ) là danh sách hostname trần, không phải URL
    for (const h of (prot.url_whitelist_extra as string[] | undefined) ?? []) this.urlHosts.add(h.toLowerCase());
    this.answerTimes = await this.kb.latestAnswerTimes();
    this.conflicts = new Set((await this.kb.listAllConflicts()).filter((c) => c.verdict === "conflict" || c.verdict === "contradiction").map((c) => [`${c.a.kind}:${c.a.id}`, `${c.b.kind}:${c.b.id}`].sort().join("|")));
    const g = await this.kb.getPublished(GUIDE_SLUG);
    this.guide = g ? parseGuide(g.source_md).guide : undefined;
    this.version = v;
    this.checkedAt = this.rebuiltAt = this.now();
  }

  private async exampleVectors(templates: Template[], model: string) {
    const wanted: { id: string; text: string; hash: string }[] = [];
    for (const t of templates) if (t.response_mode === "EXACT_TEMPLATE") for (const ex of t.match.examples) wanted.push({ id: t.id, text: ex, hash: sha1(ex) });
    const cache = await this.kb.getEmbeddings([...new Set(wanted.map((w) => w.hash))], model);
    const missing = [...new Map(wanted.filter((w) => !cache.has(w.hash)).map((w) => [w.hash, w])).values()];
    if (missing.length) {
      try {
        const t = await embedTagged(this.embedder, missing.map((m) => m.text));
        if (t.model !== model) throw new Error("embedder đổi model giữa chừng"); // giữ cache sạch: không trộn vector của model khác
        const entries = missing.map((m, i) => ({ hash: m.hash, vector: t.vectors[i]! }));
        await this.kb.putEmbeddings(entries, model);
        for (const e of entries) cache.set(e.hash, e.vector);
      } catch {
        // embedding lỗi: chạy không có gợi ý ngữ nghĩa cho các câu chưa có vector (từ khoá/rule vẫn hoạt động)
      }
    }
    this.incomplete = wanted.some((w) => !cache.has(w.hash));
    const out = new Map<string, number[][]>();
    for (const w of wanted) {
      const v = cache.get(w.hash);
      if (v) out.set(w.id, [...(out.get(w.id) ?? []), v]);
    }
    return out;
  }
}

export { buildIndex };
