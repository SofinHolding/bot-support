/**
 * Máy quét CHỒNG LẤN nội dung (code, không LLM): dùng CHÍNH cơ chế tìm kiếm lúc khách hỏi — vector câu mẫu của TemplateIndex
 * và bộ vector đoạn tri thức trong DB, cùng model đang chọn — để tìm các cặp nội dung mà bot có thể lẫn. Nếu bộ tìm kiếm không
 * kéo hai mục vào cùng danh sách ở đây thì lúc khách hỏi nó cũng không kéo được: sót của máy quét và va chạm lúc chạy trùng nhau.
 * Hai cửa vào:
 *  - lúc import (kb/service.ts bước "Trùng và mâu thuẫn"): so bản nháp với kho đang publish;
 *  - quét toàn kho (Admin Web → Template → Quét chồng lấn): so mọi mục với nhau.
 * Chỉ CỜ, không kết luận: giống về chữ chưa chắc cùng một việc. SKILL review-overlap phán xét từng cặp bị cờ; admin quyết.
 * Ngưỡng là CẤU HÌNH ĐỀ XUẤT cần hiệu chỉnh theo dữ liệu thật (điểm xuyên ngôn ngữ thường thấp hơn cùng ngôn ngữ).
 * Tín hiệu từ khoá-nằm-trong-câu chỉ bắt được cùng ngôn ngữ; xuyên ngôn ngữ do vector đa ngữ đảm nhiệm.
 */
import { activeEmbedder, embedTagged, type Embedder } from "../core/embedding";
import type { TemplateIndex } from "../core/template-index";
import { containsPhrase, normalize, wordCount } from "../core/text";
import type { Template } from "../domain/types";
import type { KbRepo } from "../db/repo-kb";
import type { Confusion } from "./routing-check";

export interface OverlapRef {
  kind: "template" | "chunk";
  id: string;
  /** slug tài liệu chứa mục này */
  doc: string;
  title: string;
  lang?: string;
}

/** Gỡ MÁY MÓC một mục khớp cụ thể (đã biết đúng chuỗi) khỏi MỘT template để hết một cặp xung đột — xem `narrowTemplateMatch`. */
export interface NarrowHint {
  templateId: string;
  phrase: string;
}

export interface OverlapPair {
  a: OverlapRef;
  b: OverlapRef;
  /** điểm cao nhất trong các tín hiệu (cosine, hoặc ngưỡng khi chỉ có tín hiệu từ khoá) */
  score: number;
  signals: string[];
  /** hai đoạn tri thức của hai tài liệu gần như trùng: có thể admin định cập nhật nhưng lại tạo tài liệu mới */
  updateHint?: string;
  /** Chỉ có khi tín hiệu mạnh nhất trỏ đúng một cụm của MỘT template — cho phép nút "Gỡ máy móc" thay vì chỉ đọc gợi ý của AI. */
  narrow?: NarrowHint;
  /** Kết quả HỎI THỬ bot (kb/routing-check.ts): những câu của bên này bị trả lời bằng bên kia. Rỗng = chỉ giống chữ, bot vẫn trả lời đúng. */
  confusions?: Confusion[];
}

/** Một mục cần dò: các câu để embed (câu mẫu/từ khoá của template, tiêu đề + đầu đoạn của chunk) và từ khoá để so chuỗi. */
export interface ProbeItem {
  ref: OverlapRef;
  texts: string[];
  keywords: string[];
  /** vector đã có sẵn cho `texts` (cùng thứ tự; thiếu thì lấy texts[0] làm nhãn) — tạo bởi `vectorsModel`. Có thì KHÔNG embed lại. */
  vectors?: number[][];
  vectorsModel?: string;
}

export interface OverlapDeps {
  index: TemplateIndex;
  kb: KbRepo;
  embedder: Embedder;
  /** template id -> slug tài liệu đang publish chứa nó */
  docOf: Map<string, string>;
}

export interface OverlapOptions {
  /** cấu hình đề xuất DEFAULT_OVERLAP_MIN; cần benchmark */
  minScore?: number;
  /** không so với chính tài liệu này (lúc import bản nháp: bản đang publish của cùng slug không phải "mục khác") */
  excludeDoc?: string;
  perProbe?: number;
  maxPairs?: number;
}

export const DEFAULT_OVERLAP_MIN = 0.55;
/** Hai đoạn tri thức khác tài liệu giống tới mức này: nhiều khả năng là một bản cập nhật bị tạo thành tài liệu mới. */
export const UPDATE_HINT_MIN = 0.85;

const meaningfulKeyword = (k: string) => wordCount(normalize(k)) >= 2 || normalize(k).length >= 6;
const templateTitle = (t: Template) => `${t.group} — ${t.match.examples[0] ?? t.match.keywords[0] ?? t.sets_context.issue ?? t.id}`;

export function probesFromTemplates(templates: Template[], doc: string): ProbeItem[] {
  return templates
    .filter((t) => t.response_mode === "EXACT_TEMPLATE")
    .map((t) => ({
      ref: { kind: "template" as const, id: t.id, doc, title: templateTitle(t) },
      texts: [...t.match.examples, ...t.match.keywords].filter((x) => x.trim()),
      keywords: t.match.keywords,
    }));
}

export function probesFromChunks(chunks: { chunkId?: string; index: number; heading: string; text: string; lang?: string }[], doc: string): ProbeItem[] {
  return chunks.map((c) => ({
    ref: { kind: "chunk" as const, id: c.chunkId ?? `${doc}#${c.index}`, doc, title: c.heading, lang: c.lang },
    texts: [`${c.heading}\n${c.text}`.slice(0, 600)],
    keywords: [],
  }));
}

/**
 * Tìm mục trong kho đang publish chồng lấn với các probe. Probe đã mang vector (quét toàn kho: vector câu mẫu trong TemplateIndex,
 * vector đoạn trong kb_chunk_embeddings) thì dùng lại; chỉ embed phần còn thiếu, MỘT lô (bản nháp lúc import: vài chục câu).
 * Lý do: quét toàn kho từng embed lại ~900 câu qua API ngoài -> gateway trả 400 -> hệ thống tự chuyển sang model cục bộ và khoá API.
 */
export async function findOverlaps(deps: OverlapDeps, probes: ProbeItem[], opt: OverlapOptions = {}): Promise<OverlapPair[]> {
  const min = opt.minScore ?? DEFAULT_OVERLAP_MIN;
  const perProbe = opt.perProbe ?? 8;
  const pairs = new Map<string, OverlapPair & { sig: { text: string; score: number }[]; narrowScore: number }>();
  const keyOf = (a: OverlapRef, b: OverlapRef) => [`${a.kind}:${a.id}`, `${b.kind}:${b.id}`].sort().join("|");
  const add = (a: OverlapRef, b: OverlapRef, score: number, signal: string, narrow?: NarrowHint) => {
    if (a.kind === b.kind && a.id === b.id) return;
    if (a.kind === "chunk" && b.kind === "chunk" && a.doc === b.doc) return; // các đoạn của cùng một tài liệu vốn liên quan nhau
    const k = keyOf(a, b);
    const cur = pairs.get(k);
    if (cur) {
      cur.score = Math.max(cur.score, score);
      if (!cur.sig.some((s) => s.text === signal)) cur.sig.push({ text: signal, score });
      if (narrow && score >= cur.narrowScore) {
        cur.narrow = narrow;
        cur.narrowScore = score;
      }
    } else pairs.set(k, { a, b, score, signals: [], sig: [{ text: signal, score }], narrow, narrowScore: narrow ? score : -1 });
  };
  const chunks = await deps.kb.listPublishedChunks();
  const chunkRef = (c: { chunkId: string; docSlug: string; heading: string; lang?: string }): OverlapRef => ({ kind: "chunk", id: c.chunkId, doc: c.docSlug, title: c.heading, lang: c.lang });
  const templateRef = (t: Template): OverlapRef => ({ kind: "template", id: t.id, doc: deps.docOf.get(t.id) ?? "", title: templateTitle(t) });
  const skipDoc = (doc: string) => !!opt.excludeDoc && doc === opt.excludeDoc;

  // 1) Vector: cùng model, cùng cosine, cùng truy vấn pgvector như lúc khách hỏi
  let model = (await activeEmbedder(deps.embedder)).version;
  const flat: { probe: ProbeItem; text: string; vec?: number[] }[] = [];
  for (const p of probes) {
    if (p.vectors?.length && p.vectorsModel === model) {
      p.vectors.forEach((vec, i) => flat.push({ probe: p, text: p.texts[i] ?? p.texts[0] ?? p.ref.title, vec }));
    } else for (const text of p.texts) if (text.trim()) flat.push({ probe: p, text });
  }
  const todo = flat.filter((f) => !f.vec);
  if (todo.length) {
    try {
      const t = await embedTagged(deps.embedder, todo.map((f) => f.text));
      todo.forEach((f, i) => (f.vec = t.vectors[i]));
      if (t.model !== model) {
        // model đổi giữa chừng (API lỗi -> tự chuyển cục bộ): vector tính sẵn của model cũ không so được với vector vừa tính
        for (const f of flat) if (!todo.includes(f)) f.vec = undefined;
        model = t.model;
      }
    } catch {
      /* embedding lỗi: chỉ còn tín hiệu từ khoá (và vector có sẵn) */
    }
  }
  if (flat.some((f) => f.vec)) {
    for (const f of flat) {
      const q = f.vec;
      if (!q) continue;
      // f.text là MỘT chuỗi cụ thể trong match.examples/keywords của probe: nếu probe là template, đây là ứng viên "gỡ máy móc" an toàn
      const selfNarrow: NarrowHint | undefined = f.probe.ref.kind === "template" ? { templateId: f.probe.ref.id, phrase: f.text } : undefined;
      if (deps.index.vectorsModel === model) {
        for (const s of deps.index.suggestVector(q, perProbe, { includeShortcuts: true })) {
          if (s.score < min) continue;
          const t = deps.index.get(s.templateId);
          if (!t) continue;
          const b = templateRef(t);
          if (skipDoc(b.doc)) continue;
          add(f.probe.ref, b, s.score, `"${f.text.slice(0, 60)}" ~ câu mẫu của ${t.id} (${s.score.toFixed(2)})`, selfNarrow);
        }
      }
      for (const h of await deps.kb.searchChunks({ tsQuery: "", embedding: q, embeddingModel: model, limit: perProbe })) {
        const score = h.vectorScore ?? 0;
        if (score < min || skipDoc(h.docSlug)) continue;
        add(f.probe.ref, chunkRef(h), score, `"${f.text.slice(0, 60)}" ~ đoạn "${h.heading}" của ${h.docSlug} (${score.toFixed(2)})`, selfNarrow);
      }
    }
  }

  // 2) Từ khoá nằm trong câu (cùng ngôn ngữ): bắt đúng kiểu `"login fail"` của lối tắt cũ nằm trong tài liệu mới về đăng nhập
  const liveTemplates = deps.index.templates.filter((t) => t.response_mode === "EXACT_TEMPLATE");
  for (const p of probes) {
    const pt = normalize(p.texts.join(" \n "));
    for (const t of liveTemplates) {
      const b = templateRef(t);
      if (skipDoc(b.doc) || (p.ref.kind === "template" && p.ref.id === t.id)) continue;
      for (const k of t.match.keywords) if (meaningfulKeyword(k) && containsPhrase(pt, k)) add(p.ref, b, min, `từ khoá "${k}" của ${t.id} nằm trong "${p.ref.title.slice(0, 60)}"`, { templateId: t.id, phrase: k });
      const tt = normalize([...t.match.examples, ...t.match.keywords].join(" \n "));
      for (const k of p.keywords)
        if (meaningfulKeyword(k) && containsPhrase(tt, k))
          add(p.ref, b, min, `từ khoá "${k}" nằm trong câu mẫu/từ khoá của ${t.id}`, p.ref.kind === "template" ? { templateId: p.ref.id, phrase: k } : undefined);
    }
    if (!p.keywords.length) continue;
    for (const c of chunks) {
      if (skipDoc(c.docSlug) || (p.ref.kind === "chunk" && p.ref.id === c.chunkId)) continue;
      const ct = c.searchText || normalize(`${c.heading} ${c.text}`);
      for (const k of p.keywords) if (meaningfulKeyword(k) && containsPhrase(ct, k)) add(p.ref, chunkRef(c), min, `từ khoá "${k}" nằm trong đoạn "${c.heading}" của ${c.docSlug}`);
    }
  }

  // tín hiệu mạnh nhất đứng đầu (UI chỉ hiện vài dòng đầu)
  const out: OverlapPair[] = [...pairs.values()]
    .sort((x, y) => y.score - x.score)
    .slice(0, opt.maxPairs ?? 200)
    .map(({ sig, narrowScore: _narrowScore, ...p }) => ({ ...p, signals: sig.sort((x, y) => y.score - x.score).map((s) => s.text) }));
  for (const p of out) {
    if (p.a.kind === "chunk" && p.b.kind === "chunk" && p.score >= UPDATE_HINT_MIN) {
      p.updateHint = `Nếu "${p.a.doc}" là bản cập nhật của "${p.b.doc}" (hoặc ngược lại), hãy tạo PHIÊN BẢN MỚI của tài liệu cũ thay vì tài liệu mới: bản cũ sẽ tự archived và không còn được tìm thấy.`;
    }
  }
  return out;
}

/** Quét toàn kho đang publish: mọi template + mọi đoạn tri thức, cặp không lặp. */
export async function scanCorpus(deps: OverlapDeps, opt: OverlapOptions = {}): Promise<OverlapPair[]> {
  const byDoc = new Map<string, Template[]>();
  for (const t of deps.index.templates) {
    const d = deps.docOf.get(t.id) ?? "";
    byDoc.set(d, [...(byDoc.get(d) ?? []), t]);
  }
  const model = (await activeEmbedder(deps.embedder)).version;
  const probes: ProbeItem[] = [];
  // vector câu mẫu đã có trong TemplateIndex (cùng model đang chọn) -> không embed lại
  for (const [doc, ts] of byDoc) {
    for (const p of probesFromTemplates(ts, doc)) {
      const vecs = deps.index.vectorsModel === model ? deps.index.vectorsOf(p.ref.id) : [];
      probes.push(vecs.length ? { ...p, texts: deps.index.get(p.ref.id)?.match.examples ?? p.texts, vectors: vecs, vectorsModel: model } : p);
    }
  }
  // vector đoạn tri thức đã lưu trong kb_chunk_embeddings (đúng model) -> không embed lại; đoạn chưa có vector thì embed
  const chunks = await deps.kb.listPublishedChunks();
  const stored = await deps.kb.listPublishedChunkVectors(model);
  const byChunkDoc = new Map<string, typeof chunks>();
  for (const c of chunks) byChunkDoc.set(c.docSlug, [...(byChunkDoc.get(c.docSlug) ?? []), c]);
  for (const [doc, cs] of byChunkDoc) {
    for (const p of probesFromChunks(cs.map((c, i) => ({ chunkId: c.chunkId, index: i, heading: c.heading, text: c.text, lang: c.lang })), doc)) {
      const v = stored.get(p.ref.id);
      probes.push(v ? { ...p, vectors: [v], vectorsModel: model } : p);
    }
  }
  return findOverlaps(deps, probes, opt);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Gỡ MỘT mục khớp cụ thể (`phrase`, đúng chuỗi đã biết từ `OverlapPair.narrow`) khỏi ĐÚNG MỘT template trong tài liệu
 * markdown (nhiều template/tài liệu, khối `---\n...\n---` mỗi template). Sửa văn bản trực tiếp — không dựng lại từ object
 * đã parse — để giữ nguyên định dạng, comment và mọi template khác nguyên vẹn. Xoá `phrase` ở CẢ `keywords:` lẫn `examples:`
 * nếu có (sự cố thật: `esc-login-fail` liệt kê "login fail" ở cả hai mục).
 * An toàn để tự động áp dụng vì tất toàn bộ đến từ tín hiệu CODE đã biết chính xác (không phải văn xuôi tự do do AI viết).
 */
export function narrowTemplateMatch(md: string, templateId: string, phrase: string): { md: string; removed: number } {
  const blockRe = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/gm;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(md))) {
    const body = m[1] ?? "";
    if (!new RegExp(`^id:\\s*${escapeRegExp(templateId)}\\s*$`, "m").test(body)) continue;
    const linePattern = `^[ \\t]*-[ \\t]+${escapeRegExp(phrase)}[ \\t]*$`;
    const isMatchLine = (line: string) => new RegExp(linePattern, "i").test(line);
    const lines = body.split(/\r?\n/);
    const removed = lines.filter(isMatchLine).length;
    if (!removed) return { md, removed: 0 };
    const cleaned = lines.filter((line) => !isMatchLine(line)).join("\n");
    return { md: md.slice(0, m.index) + `---\n${cleaned}\n---\n` + md.slice(m.index + m[0].length), removed };
  }
  return { md, removed: 0 };
}

/** Vùng thân (sau frontmatter, tới `<!-- next -->` kế tiếp hoặc hết file) của MỘT template theo id. */
function templateBodyRange(md: string, templateId: string): { bodyStart: number; bodyEnd: number } | null {
  const blockRe = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/gm;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(md))) {
    if (!new RegExp(`^id:\\s*${escapeRegExp(templateId)}\\s*$`, "m").test(m[1] ?? "")) continue;
    const bodyStart = m.index + m[0].length;
    const rest = md.slice(bodyStart);
    const nextMarker = /^<!--\s*next\s*-->\s*$/m.exec(rest);
    return { bodyStart, bodyEnd: bodyStart + (nextMarker ? nextMarker.index : rest.length) };
  }
  return null;
}

/**
 * Thay THÂN của một bản dịch (`<!-- answer:{lang} -->`) của MỘT template bằng `newText` — dùng khi admin tự sửa văn xuôi
 * (không phải gỡ một cụm cụ thể như `narrowTemplateMatch`), ví dụ sau khi xem gợi ý AI cho một khung xung đột và viết lại
 * theo ý mình. Chưa có bản dịch ngôn ngữ đó thì chèn thêm (giữ nguyên các bản dịch khác); có rồi thì thay đúng phần đó,
 * mọi template khác trong tài liệu giữ nguyên từng ký tự.
 */
export function replaceTemplateAnswer(md: string, templateId: string, lang: string, newText: string): { md: string; replaced: boolean } {
  const range = templateBodyRange(md, templateId);
  if (!range) return { md, replaced: false };
  const body = md.slice(range.bodyStart, range.bodyEnd);
  const markers = [...body.matchAll(/^<!--\s*answer:([a-zA-Z-]+)\s*-->\s*$/gm)];
  const idx = markers.findIndex((mk) => (mk[1] ?? "").toLowerCase() === lang.toLowerCase());
  const text = newText.trim();
  let newBody: string;
  if (idx === -1) newBody = `<!-- answer:${lang} -->\n${text}\n\n${body.replace(/^\s+/, "")}`;
  else {
    const start = markers[idx]!.index! + markers[idx]![0].length;
    const end = idx + 1 < markers.length ? markers[idx + 1]!.index! : body.length;
    newBody = body.slice(0, start) + `\n${text}\n` + body.slice(end);
  }
  return { md: md.slice(0, range.bodyStart) + newBody + md.slice(range.bodyEnd), replaced: true };
}

/**
 * Thay THÂN của một mục `##`/`###` trong tài liệu tri thức bằng `newText`, phần còn lại giữ nguyên. `heading` khớp theo
 * đúng dòng heading gốc trong Markdown — nếu là mục con (`###`), dùng phần sau dấu "›" trong tiêu đề ghép
 * `"{h2} › {h3}"` mà kb/overlap.ts hiển thị (đơn giản hoá: chưa xử lý trường hợp trùng tiêu đề giữa hai mục `##` khác nhau).
 */
export function replaceChunkSection(md: string, heading: string, newText: string): { md: string; replaced: boolean } {
  const leaf = heading.includes(" › ") ? heading.split(" › ").pop()! : heading;
  const headingRe = /^(#{2,3})[ \t]+(.*?)[ \t]*$/gm;
  const headings = [...md.matchAll(headingRe)].map((m) => ({ index: m.index!, end: m.index! + m[0].length, text: (m[2] ?? "").trim() }));
  const i = headings.findIndex((h) => h.text === leaf);
  if (i === -1) return { md, replaced: false };
  const bodyStart = headings[i]!.end;
  const bodyEnd = i + 1 < headings.length ? headings[i + 1]!.index : md.length;
  return { md: md.slice(0, bodyStart) + `\n\n${newText.trim()}\n` + md.slice(bodyEnd), replaced: true };
}

/**
 * Nhận xét của AI (SKILL review-overlap) cần NGƯỜI quyết: trùng, xung đột, mâu thuẫn trực tiếp, và "có thể thay thế" — dữ liệu
 * mới chỉ thay dữ liệu cũ khi người duyệt xác nhận, không bao giờ vì nhập sau.
 */
export const NEEDS_DECISION: ReadonlySet<string> = new Set(["duplicate", "conflict", "contradiction", "supersedes"]);
