/**
 * Xuất TOÀN BỘ nội dung đang publish (câu trả lời soạn sẵn, đoạn tài liệu tri thức, hướng dẫn AI) + kết quả phân loại
 * xung đột bằng CÁC PHƯƠNG PHÁP CÓ SẴN trong dự án, ra một file JSON để dựng file rà soát gửi người dùng. CHỈ ĐỌC, không gọi AI.
 *
 * Phương pháp (đều là code, không tốn phí AI):
 *  - máy quét chồng lấn (kb/overlap.ts `scanCorpus`): cặp nội dung giống nhau, mọi loại cặp;
 *  - hỏi thử bot (kb/routing-check.ts `findConfusions`): câu của mục này bị bot trả lời bằng mục khác / hai mục khớp ngang hàng;
 *  - trùng từ khoá giữa hai template (cùng cụm, đã chuẩn hoá) — như bước 3 lúc kiểm tra bản nháp (kb/service.ts);
 *  - trùng nguyên văn câu trả lời giữa hai template;
 *  - hai đoạn tài liệu gần như trùng nguyên văn (`updateHint`, điểm ≥ 0.85).
 *
 *   EMBEDDING_URL=http://localhost:8081/v1 DATABASE_URL=... npx tsx scripts/export-content-review.ts [--out=file.json]
 */
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config";
import { normalize } from "../src/core/text";
import { openDb } from "../src/db/db";
import { kbRepo } from "../src/db/repo-kb";
import { opsRepo } from "../src/db/repo-ops";
import { evalSettings } from "../src/kb/eval";
import { LiveContent } from "../src/kb/live-content";
import { scanCorpus } from "../src/kb/overlap";
import { confusionsOf, describeConfusion, findConfusions } from "../src/kb/routing-check";
import { EmbeddingConfig } from "../src/llm/embedding-config";
import { createEmbedder, SelectedEmbedder } from "../src/llm/embedder";
import { SecretBox } from "../src/llm/secret-box";
import { GUIDE_SLUG } from "../src/core/guide";
import { TEMPLATE_TITLES } from "./lib/template-titles";

const outPath = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? ".staging/content-review-data.json";

async function main() {
  const cfg = loadConfig();
  const db = await openDb(cfg.DATABASE_URL);
  const kb = kbRepo(db);
  const ops = opsRepo(db);
  const embedding = new EmbeddingConfig(ops, cfg.SECRETS_KEY ? new SecretBox(cfg.SECRETS_KEY) : null);
  const embedder = new SelectedEmbedder(() => embedding.selection(), createEmbedder(cfg), { log: () => undefined, onExternalFailure: async () => undefined });
  const live = new LiveContent(db, kb, ops, embedder, `${cfg.CONTENT_DIR}/config/predicates.yml`, Date.now, async () => (await embedder.active()).version);
  await live.rebuild();
  const index = live.index;

  const rows = await kb.loadPublishedTemplateRows();
  const docOf = new Map(rows.map((r) => [r.template.id, r.docSlug]));
  const docs = await kb.listDocuments();
  const docTitle = new Map(docs.map((d) => [d.slug, d.title]));
  const chunks = await kb.listPublishedChunks();
  const titleOf = (id: string) => TEMPLATE_TITLES[id] ?? index.get(id)?.sets_context.issue ?? id;

  // ---- nội dung
  const templates = index.templates.map((t) => ({
    id: t.id,
    doc: docOf.get(t.id) ?? "",
    group: t.group,
    title: titleOf(t.id),
    mode: t.response_mode,
    priority: t.priority,
    exact: t.match.exact,
    keywords: t.match.keywords,
    examples: t.match.examples,
    hasRules: t.match.rules.length > 0,
    imageTypes: t.match.image_types,
    answer: index.resolveAnswerSource(t).answers.en ?? "",
    sharedAnswerFrom: t.answer_from ? titleOf(t.answer_from) : null,
    followUp: Object.entries(t.follow_up).map(([k, v]) => ({ kind: k, target: v === "ESCALATE" ? "ESCALATE" : titleOf(v) })),
    ticket: t.ticket ?? null,
    requiredInfo: t.required_info ?? [],
  }));
  const chunkRows = chunks.map((c) => ({ id: c.chunkId, doc: c.docSlug, docTitle: docTitle.get(c.docSlug) ?? c.docSlug, heading: c.heading, text: c.text, url: c.url ?? "" }));
  const guide = await kb.getPublished(GUIDE_SLUG);

  // ---- phương pháp 1 + 2: máy quét chồng lấn + hỏi thử bot
  const pairs = await scanCorpus({ index, kb, embedder, docOf }, { maxPairs: 5000 });
  const chunkSides = [...new Map(pairs.flatMap((p) => [p.a, p.b]).filter((r) => r.kind === "chunk").map((r) => [r.id, { ref: r, heading: r.title }])).values()];
  const confusions = await findConfusions(index, live.evaluator, embedder, evalSettings(live.urlHosts), { docOf, chunks: chunkSides });

  // ---- phương pháp 3 + 4: trùng từ khoá / trùng nguyên văn câu trả lời giữa hai template
  const keyOf = (a: string, b: string) => [a, b].sort().join("|");
  const sharedKeywords = new Map<string, string[]>();
  const sameAnswer = new Set<string>();
  const matchable = index.templates.filter((t) => t.response_mode === "EXACT_TEMPLATE");
  for (let i = 0; i < matchable.length; i++)
    for (let j = i + 1; j < matchable.length; j++) {
      const a = matchable[i]!;
      const b = matchable[j]!;
      const kb2 = new Set([...b.match.keywords, ...b.match.exact].map(normalize));
      const shared = [...a.match.keywords, ...a.match.exact].filter((k) => kb2.has(normalize(k)));
      if (shared.length) sharedKeywords.set(keyOf(a.id, b.id), shared);
      const ansA = normalize(index.resolveAnswerSource(a).answers.en ?? "");
      if (ansA && ansA === normalize(index.resolveAnswerSource(b).answers.en ?? "")) sameAnswer.add(keyOf(a.id, b.id));
    }

  const pairOut = pairs.map((p) => {
    const cs = confusionsOf(p, confusions);
    const k = p.a.kind === "template" && p.b.kind === "template" ? keyOf(p.a.id, p.b.id) : "";
    return {
      a: p.a,
      b: p.b,
      score: p.score,
      signals: p.signals,
      confusions: cs.map((c) => ({ kind: c.kind, phrase: c.phrase, owner: c.owner.id, got: c.got, text: describeConfusion(c, titleOf) })),
      sharedKeywords: k ? sharedKeywords.get(k) ?? [] : [],
      sameAnswer: k ? sameAnswer.has(k) : false,
      nearVerbatim: !!p.updateHint,
    };
  });
  // cặp trùng từ khoá / trùng câu trả lời mà máy quét không xếp thành cặp: vẫn phải có trong danh sách
  const seen = new Set(pairOut.filter((p) => p.a.kind === "template" && p.b.kind === "template").map((p) => keyOf(p.a.id, p.b.id)));
  for (const k of new Set([...sharedKeywords.keys(), ...sameAnswer])) {
    if (seen.has(k)) continue;
    const [a, b] = k.split("|") as [string, string];
    pairOut.push({
      a: { kind: "template", id: a, doc: docOf.get(a) ?? "", title: titleOf(a) },
      b: { kind: "template", id: b, doc: docOf.get(b) ?? "", title: titleOf(b) },
      score: 0,
      signals: [],
      confusions: [],
      sharedKeywords: sharedKeywords.get(k) ?? [],
      sameAnswer: sameAnswer.has(k),
      nearVerbatim: false,
    });
  }

  writeFileSync(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), model: index.vectorsModel, templates, chunks: chunkRows, guide: guide ? { version: guide.version, md: guide.source_md } : null, docs: docs.map((d) => ({ slug: d.slug, title: d.title, kind: d.kind })), pairs: pairOut }, null, 1),
    "utf8",
  );
  const n = (f: (p: (typeof pairOut)[number]) => boolean) => pairOut.filter(f).length;
  console.log(`ghi ${outPath}: ${templates.length} template, ${chunkRows.length} đoạn, ${pairOut.length} cặp`);
  console.log(`  bot trả lời nhầm / mơ hồ: ${n((p) => p.confusions.length > 0)} · trùng từ khoá: ${n((p) => p.sharedKeywords.length > 0)} · trùng nguyên văn câu trả lời: ${n((p) => p.sameAnswer)} · đoạn tài liệu gần trùng nguyên văn: ${n((p) => p.nearVerbatim)}`);
  await db.close();
}
main().catch((e) => {
  console.error("lỗi:", e);
  process.exit(1);
});
