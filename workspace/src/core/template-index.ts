/**
 * Chỉ mục template trong bộ nhớ: SINH ỨNG VIÊN (candidate generation), không quyết định.
 * Quyết định gửi hay không thuộc về DecisionGate (gate.ts).
 */
import type { ItemDistinctFrom, Template, VisionScreenType } from "../domain/types";
import { ESCALATE_TEMPLATE_ID } from "../domain/types";
import { cosine, embedTagged, type Embedder } from "./embedding";
import { containsPhrase, containsPhraseLoose, normalize } from "./text";
import type { Evaluator } from "./predicates";
import { makeInput } from "./predicates";

export type HitKind = "override" | "exact" | "image" | "rule" | "keyword";

export interface Hit {
  templateId: string;
  kind: HitKind;
  /** độ dài cụm từ khớp (càng dài càng cụ thể) */
  phraseLen: number;
  phrase?: string;
  priority: number;
  /** khớp "lỏng" (xen thêm từ giữa cụm): luôn xếp SAU mọi khớp chặt, dù template kia ưu tiên thấp hơn */
  loose?: boolean;
}

export interface Suggestion {
  templateId: string;
  score: number;
}

export interface CandidateSet {
  hits: Hit[];
  suggestions: Suggestion[]; // xếp hạng ngữ nghĩa, giảm dần
}

export interface IndexInput {
  text: string;
  norm: string;
  imageType?: VisionScreenType;
  lastTemplateId?: string;
}

/** Vector của câu hỏi mẫu đã tính sẵn: templateId -> danh sách vector. */
export type ExampleVectors = Map<string, number[][]>;

export class TemplateIndex {
  private byId = new Map<string, Template>();
  private matchable: Template[];

  constructor(
    readonly templates: Template[],
    private readonly evaluator: Evaluator,
    private readonly embedder?: Embedder,
    private readonly vectors: ExampleVectors = new Map(),
    /** model đã tạo `vectors`; mặc định = embedder.version lúc dựng. Câu hỏi embed bằng model khác thì không so được. */
    readonly vectorsModel: string | undefined = embedder?.version,
  ) {
    for (const t of templates) this.byId.set(t.id, t);
    // SECURITY_RULE và GROUNDED không tham gia khớp template; code gọi chúng theo id.
    this.matchable = templates.filter((t) => t.response_mode === "EXACT_TEMPLATE");
  }

  get(id: string): Template | undefined {
    return this.byId.get(id);
  }

  /** Nội dung đang trong thời gian hiệu lực (theo ngày UTC). Nội dung hết / chưa tới hiệu lực không được đưa làm ứng viên. */
  static isActive(t: Template, now: Date = new Date()): boolean {
    if (!t.valid) return true;
    const today = now.toISOString().slice(0, 10);
    return (!t.valid.from || t.valid.from <= today) && (!t.valid.until || t.valid.until >= today);
  }

  /** Câu trả lời `en` của template (đi qua answer_from nếu có). */
  resolveAnswerSource(t: Template): Template {
    let cur = t;
    for (let i = 0; i < 5 && cur.answer_from; i++) {
      const next = this.byId.get(cur.answer_from);
      if (!next) break;
      cur = next;
    }
    return cur;
  }

  /** Danh mục gọn của mọi template có thể được chọn (gửi cho tầng 2 khi không có ứng viên xác định). */
  catalogue(): { id: string; group: string; gist: string }[] {
    return this.matchable
      .filter((t) => TemplateIndex.isActive(t))
      .filter((t) => t.match.keywords.length || t.match.examples.length || t.match.rules.length || t.match.image_types.length || t.match.exact.length)
      .map((t) => ({ id: t.id, group: t.group, gist: t.match.examples[0] ?? t.match.keywords[0] ?? t.sets_context.issue ?? t.id }));
  }

  /** Tính vector cho mọi câu hỏi mẫu (dùng khi nạp bản publish mới). */
  static async computeVectors(templates: Template[], embedder: Embedder): Promise<ExampleVectors> {
    const out: ExampleVectors = new Map();
    const flat: { id: string; text: string }[] = [];
    for (const t of templates) {
      if (t.response_mode !== "EXACT_TEMPLATE") continue;
      for (const ex of t.match.examples) flat.push({ id: t.id, text: ex });
    }
    if (!flat.length) return out;
    const vecs = await embedder.embed(flat.map((f) => f.text));
    flat.forEach((f, i) => {
      const arr = out.get(f.id) ?? [];
      arr.push(vecs[i]!);
      out.set(f.id, arr);
    });
    return out;
  }

  /** Ứng viên xác định (từ khoá, rule, ảnh, lời chào) chưa qua requires/excludes. */
  hitsFor(inp: IndexInput): Hit[] {
    const hits: Hit[] = [];
    const evalInp = makeInput(inp.text, { imageType: inp.imageType, lastTemplateId: inp.lastTemplateId });
    evalInp.norm = inp.norm;
    for (const t of this.matchable) {
      if (!TemplateIndex.isActive(t)) continue;
      const m = t.match;

      if (m.exact.some((p) => normalize(p) === inp.norm && inp.norm.length > 0)) {
        hits.push({ templateId: t.id, kind: "exact", phraseLen: inp.norm.length, priority: t.priority });
      }
      if (inp.imageType && m.image_types.includes(inp.imageType)) {
        hits.push({ templateId: t.id, kind: m.overrides_context ? "override" : "image", phraseLen: 0, priority: t.priority });
      }
      for (const r of m.rules) {
        if (r.all.length && r.all.every((c) => this.evaluator.evalCondition(c, evalInp))) {
          hits.push({ templateId: t.id, kind: "rule", phraseLen: 1000, priority: t.priority });
          break;
        }
      }
      let best: string | undefined;
      let bestLoose = false;
      for (const k of m.keywords) {
        const strict = containsPhrase(inp.norm, k);
        if (!strict && !containsPhraseLoose(inp.norm, k)) continue;
        // ưu tiên cụm chặt; giữa các cụm cùng loại ưu tiên cụm dài hơn
        if (!best || (bestLoose && strict) || (bestLoose === !strict && normalize(k).length > normalize(best).length)) {
          best = k;
          bestLoose = !strict;
        }
      }
      if (best) hits.push({ templateId: t.id, kind: "keyword", phrase: best, phraseLen: normalize(best).length, priority: t.priority, loose: bestLoose });
    }
    return hits;
  }

  /**
   * Lối tắt chuyển nhân viên: template mà câu trả lời trỏ về câu chung FP-12 (các `esc-*` của luật cũ: một mẫu lỗi cụ thể -> chuyển
   * nhân viên kèm mã lỗi). Chúng CHỈ được là ứng viên khi khớp XÁC ĐỊNH (từ khoá / luật / exact), KHÔNG qua gợi ý ngữ nghĩa —
   * sự cố thật: "I cannot log in" bị hút vào esc-login-fail (câu mẫu "login fail") và thắng tài liệu hướng dẫn nhiều bước.
   */
  isEscalateShortcut(id: string): boolean {
    const t = this.byId.get(id);
    return !!t && t.id !== ESCALATE_TEMPLATE_ID && this.resolveAnswerSource(t).id === ESCALATE_TEMPLATE_ID;
  }

  /**
   * Hai mục hỏi đáp đã được người duyệt khai báo là KHÁC nhau (distinct_from, khai ở bên nào cũng được): trả về lời khai
   * (khác ở điểm nào + câu hỏi lại khách). Chỉ có với mục hỏi đáp (src/core/items.ts); template cũ luôn undefined.
   */
  distinctPair(a: string, b: string): ItemDistinctFrom | undefined {
    return this.byId.get(a)?.item?.distinct_from.find((d) => d.item === b) ?? this.byId.get(b)?.item?.distinct_from.find((d) => d.item === a);
  }

  /** Vector câu mẫu đã tính sẵn của một template (theo thứ tự `match.examples`, model = `vectorsModel`). Máy quét chồng lấn dùng lại, không embed lại. */
  vectorsOf(id: string): number[][] {
    return this.vectors.get(id) ?? [];
  }

  /** Xếp hạng ngữ nghĩa: chỉ để gợi ý ứng viên cho tầng 2, không tự tạo quyền trả lời. */
  async suggest(text: string, k = 5): Promise<Suggestion[]> {
    if (!this.embedder || this.vectors.size === 0 || !text.trim()) return [];
    let q: number[] | undefined;
    try {
      const t = await embedTagged(this.embedder, [text]);
      // Câu hỏi vừa được embed bằng model khác với model của vector câu mẫu -> cosine vô nghĩa, bỏ qua
      // (LiveContent thấy model đang chọn đổi sẽ dựng lại index với vector của model đó).
      if (this.vectorsModel && t.model !== this.vectorsModel) return [];
      q = t.vectors[0];
    } catch {
      return []; // dịch vụ embedding lỗi: bỏ qua gợi ý ngữ nghĩa, các tầng còn lại vẫn chạy
    }
    if (!q) return [];
    return this.suggestVector(q, k);
  }

  /**
   * Xếp hạng theo vector đã tính sẵn (cùng model với `vectorsModel`). Mặc định bỏ lối tắt chuyển nhân viên (xem isEscalateShortcut);
   * máy quét chồng lấn (kb/overlap.ts) bật `includeShortcuts` để vẫn cờ chúng cho admin.
   */
  suggestVector(q: number[], k = 5, opts: { includeShortcuts?: boolean } = {}): Suggestion[] {
    const scored: Suggestion[] = [];
    for (const [id, vecs] of this.vectors) {
      if (!opts.includeShortcuts && this.isEscalateShortcut(id)) continue;
      const tpl = this.byId.get(id);
      if (tpl && !TemplateIndex.isActive(tpl)) continue;
      let best = 0;
      for (const v of vecs) best = Math.max(best, cosine(q, v));
      if (best > 0) scored.push({ templateId: id, score: best });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }
}
