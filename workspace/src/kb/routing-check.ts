/**
 * Kiểm tra "bot có THẬT SỰ trả lời nhầm không" — bổ sung cho máy quét chồng lấn (kb/overlap.ts).
 *
 * Máy quét chồng lấn chỉ đo ĐỘ GIỐNG CHỮ: đo trên kho thật, 320 cặp template bị cờ nhưng chỉ 1 cặp làm bot trả lời nhầm —
 * phần lớn là hai tình huống khác nhau cùng một chủ đề ("quên mật khẩu" và "quên ID"), bot vẫn phân biệt đúng. Hiện hết cho
 * người dùng thì họ không biết cặp nào đáng sửa. Ở đây hệ thống TỰ HỎI THỬ bot bằng chính các câu của từng mục (câu ví dụ,
 * từ khoá của template; tiêu đề của đoạn tài liệu), qua đúng router tầng 0-1 lúc chạy thật (không gọi AI, không tốn token):
 *  - câu của mục A mà bot trả lời bằng mục B  => nhầm THẬT, chỉ ra đúng câu nào, đúng mục nào;
 *  - câu bot không chắc (đi tiếp xuống AI / chuyển nhân viên) => không phải nhầm sang mục khác, không báo ở đây.
 * Không phát hiện được mâu thuẫn NỘI DUNG khi bot vẫn chọn đúng (hai mục nói hai điều khác nhau) — phần đó do AI phán xét
 * (SKILL review-overlap, verdict "conflict"/"duplicate").
 */
import { embedTagged, type Embedder } from "../core/embedding";
import type { Evaluator } from "../core/predicates";
import type { RouterSettings } from "../core/router";
import { TemplateIndex } from "../core/template-index";
import type { Template } from "../domain/types";
import { outcomeKey, routeOffline } from "./eval";
import type { OverlapPair, OverlapRef } from "./overlap";

export type ProbeSource = "câu ví dụ" | "từ khoá" | "tiêu đề đoạn tài liệu";

export interface Confusion {
  /** câu đã hỏi thử (nguyên văn trong nội dung của `owner`) */
  phrase: string;
  source: ProbeSource;
  /** mục sở hữu câu đó */
  owner: OverlapRef;
  /** template bot đã chọn thay vì `owner` (kind "mơ hồ": template khớp ngang hàng với `owner`) */
  got: string;
  /** "nhầm": bot chắc chắn trả lời bằng `got`. "mơ hồ": `owner` và `got` cùng khớp ngang nhau, luật không tự phân định được, phải nhờ AI đoán. */
  kind: "nhầm" | "mơ hồ";
}

/** Câu để hỏi thử của một template: câu ví dụ trước (giống câu khách thật nhất), rồi từ khoá; bỏ trùng. */
export function templatePhrases(t: Template): { phrase: string; source: ProbeSource }[] {
  const seen = new Set<string>();
  const out: { phrase: string; source: ProbeSource }[] = [];
  const add = (phrase: string, source: ProbeSource) => {
    const k = phrase.trim().toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ phrase: phrase.trim(), source });
  };
  for (const e of t.match.examples) add(e, "câu ví dụ");
  for (const k of [...t.match.exact, ...t.match.keywords]) add(k, "từ khoá");
  return out;
}

/**
 * Bản sao của `index` dùng để HỎI THỬ: câu ví dụ của template đã có vector sẵn trong index (cùng model) nên trả luôn vector
 * đó thay vì gọi dịch vụ embedding — hỏi thử cả kho không bắn hàng trăm lời gọi API (sự cố thật: quét kho embed lại ~900
 * câu qua API ngoài -> gateway trả 400 -> tự chuyển sang model cục bộ và khoá API). Câu không có sẵn mới gọi `embedder`.
 */
export function withExampleCache(index: TemplateIndex, evaluator: Evaluator, embedder: Embedder): TemplateIndex {
  const model = index.vectorsModel ?? embedder.version;
  const cache = new Map<string, number[]>();
  const vectors = new Map<string, number[][]>();
  for (const t of index.templates) {
    const vs = index.vectorsOf(t.id);
    if (!vs.length) continue;
    vectors.set(t.id, vs);
    // chỉ ghép câu ↔ vector khi đủ cặp (thiếu vector ở giữa thì không biết vector nào của câu nào)
    if (vs.length === t.match.examples.length) t.match.examples.forEach((e, i) => cache.set(e, vs[i]!));
  }
  const cached: Embedder = {
    version: model,
    embed: async (texts) => (await cached.embedTagged!(texts)).vectors,
    embedTagged: async (texts) => {
      const missing = texts.filter((x) => !cache.has(x));
      if (missing.length) {
        const r = await embedTagged(embedder, missing);
        if (r.model !== model) return { vectors: [], model: r.model }; // model khác: index tự bỏ qua gợi ý ngữ nghĩa
        missing.forEach((x, i) => cache.set(x, r.vectors[i]!));
      }
      return { vectors: texts.map((x) => cache.get(x)!), model };
    },
  };
  return new TemplateIndex(index.templates, evaluator, cached, vectors, model);
}

/** Tiêu đề lá của đoạn tài liệu ("A › B" -> "B"): gần nhất với câu khách hỏi về đoạn đó. */
export const chunkQuestion = (heading: string) => heading.split(" › ").at(-1)!.trim();

/**
 * Hỏi thử bot bằng các câu của từng template (mặc định: mọi template trả lời theo câu hỏi trong `index`; truyền `onlyIds`
 * để chỉ thử vài mục) và các đoạn tài liệu truyền vào. Trả về đúng những câu bị trả lời bằng MỤC KHÁC.
 */
export async function findConfusions(
  liveIndex: TemplateIndex,
  evaluator: Evaluator,
  embedder: Embedder,
  settings: RouterSettings,
  opts: { onlyIds?: Set<string>; docOf?: Map<string, string>; chunks?: { ref: OverlapRef; heading: string }[] } = {},
): Promise<Confusion[]> {
  const index = withExampleCache(liveIndex, evaluator, embedder);
  const out: Confusion[] = [];
  for (const t of index.templates) {
    if (t.response_mode !== "EXACT_TEMPLATE" || (opts.onlyIds && !opts.onlyIds.has(t.id))) continue;
    const owner: OverlapRef = { kind: "template", id: t.id, doc: opts.docOf?.get(t.id) ?? "", title: t.sets_context.issue ?? t.id };
    for (const { phrase, source } of templatePhrases(t)) {
      const r = await routeOffline(phrase, null, index, evaluator, settings);
      const got = outcomeKey(r.outcome);
      if (got === t.id) continue;
      if (index.get(got)) {
        out.push({ phrase, source, owner, got, kind: "nhầm" });
        continue;
      }
      // Không chọn được: nếu vì mục này KHỚP NGANG HÀNG với mục khác (cổng xếp hạng hoà) thì đó là trùng thật — bot phải nhờ AI đoán.
      const [top, ...rest] = r.trace.ranked;
      if (!top || !r.trace.ranked.some((x) => x.templateId === t.id)) continue;
      const tied = [top, ...rest].filter((x) => x.kind === top.kind && x.priority === top.priority && x.phraseLen === top.phraseLen);
      if (tied.length < 2 || !tied.some((x) => x.templateId === t.id)) continue;
      for (const x of tied) if (x.templateId !== t.id) out.push({ phrase, source, owner, got: x.templateId, kind: "mơ hồ" });
    }
  }
  for (const c of opts.chunks ?? []) {
    const phrase = chunkQuestion(c.heading);
    if (!phrase) continue;
    const got = outcomeKey((await routeOffline(phrase, null, index, evaluator, settings)).outcome);
    // câu hỏi về đoạn tài liệu mà luật chắc chắn trả lời bằng một template => không bao giờ tới được tài liệu
    if (index.get(got)) out.push({ phrase, source: "tiêu đề đoạn tài liệu", owner: c.ref, got, kind: "nhầm" });
  }
  return out;
}

const refKey = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;

/** Những lần nhầm thật giữa hai bên của một cặp (theo cả hai chiều). */
export function confusionsOf(pair: Pick<OverlapPair, "a" | "b">, confusions: Confusion[]): Confusion[] {
  const a = refKey(pair.a);
  const b = refKey(pair.b);
  return confusions.filter((c) => {
    const o = refKey(c.owner);
    const g = `template:${c.got}`;
    return (o === a && g === b) || (o === b && g === a);
  });
}

/** Khoá so sánh hai lần hỏi thử (trước / sau một thay đổi). */
export const confusionKey = (c: Confusion) => `${c.kind}|${c.owner.kind}:${c.owner.id}|${c.got}|${c.phrase.toLowerCase()}`;

/**
 * Một câu tiếng Việt người không rành kỹ thuật đọc hiểu được: câu nào, của mục nào, đang bị trả lời bằng mục nào.
 * `titleOf` trả tên dễ đọc của template; mã (id) để trong ngoặc để tìm đúng mục cần sửa.
 */
export function describeConfusion(c: Confusion, titleOf: (templateId: string) => string, tense: "đang" | "sẽ" = "đang"): string {
  const name = (id: string) => `"${titleOf(id)}" (mã ${id})`;
  const ownerName = c.owner.kind === "template" ? `mục ${name(c.owner.id)}` : `đoạn "${chunkQuestion(c.owner.title)}" của tài liệu ${c.owner.doc}`;
  return c.kind === "nhầm"
    ? `Khách hỏi "${c.phrase}" (${c.source} của ${ownerName}) → bot ${tense} trả lời bằng mục ${name(c.got)}.`
    : `Khách hỏi "${c.phrase}" (${c.source} của ${ownerName}) → khớp ngang hàng với mục ${name(c.got)}, bot ${tense} không tự phân biệt được, phải nhờ AI đoán.`;
}

/** Cách sửa, viết cho người không rành kỹ thuật — dùng chung ở mọi nơi hiện lỗi nhầm. */
export const CONFUSION_FIX_HINT =
  "Cách sửa: nếu hai mục thật ra là một tình huống thì gộp lại; nếu là hai tình huống khác nhau thì bỏ từ khoá quá chung ở mục đang giành câu hỏi, hoặc thêm câu ví dụ cụ thể hơn cho mục bị nhầm.";
