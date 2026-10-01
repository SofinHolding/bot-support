/**
 * Chuyển template đang publish sang "mục hỏi đáp" (src/kb/migrate-items.ts) — CHỈ GHI FILE, không tạo bản nháp, không publish,
 * không gọi AI. Câu hỏi thử chỉ được embed bằng model cục bộ (không gọi dịch vụ ngoài), và chỉ khi cùng model với vector đã lưu.
 *
 *   DATABASE_URL=postgres://support:support@127.0.0.1:5433/support npx tsx scripts/migrate-to-items.ts [--out=.staging/items]
 *
 * Ghi ra:
 *   <out>/<chủ đề>.yaml   — mỗi chủ đề một tài liệu, nạp vào Admin Web (loại "Mục hỏi đáp") khi đã duyệt
 *   <out>/BAO-CAO.md      — lỗi cần sửa trước khi publish, câu bot sẽ trả lời nhầm giữa các mục, so sánh bộ câu kiểm tra
 *                           với bộ đang chạy, và những gì đã đổi so với bản cũ
 *   <out>/doi-ma.json     — id cũ -> id mới của các template đã thành bước của mục khác (để chép bản dịch, câu kiểm tra)
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { compileItems, itemsDocToYaml, parseItemsDoc } from "../src/core/items";
import { TemplateIndex } from "../src/core/template-index";
import { openDb } from "../src/db/db";
import { kbRepo } from "../src/db/repo-kb";
import { opsRepo } from "../src/db/repo-ops";
import { evalSettings, runEval, type EvalCase } from "../src/kb/eval";
import { LiveContent } from "../src/kb/live-content";
import { migrateTemplates } from "../src/kb/migrate-items";
import { describeConfusion, findConfusions, withExampleCache } from "../src/kb/routing-check";
import { EmbeddingConfig } from "../src/llm/embedding-config";
import { createEmbedder, SelectedEmbedder } from "../src/llm/embedder";
import { SecretBox } from "../src/llm/secret-box";
import type { Template } from "../src/domain/types";
import { TEMPLATE_TITLES } from "./lib/template-titles";

const outDir = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? ".staging/items";

/** Id template mà code lúc chạy gọi thẳng (chuỗi "<id>" trong src/, trừ src/cli): không được gộp thành bước của mục khác. */
function idsReferencedInCode(ids: string[]): Set<string> {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { if (f !== "cli") walk(p); } // src/cli: công cụ nhập dữ liệu một lần, không phải code lúc chạy
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk("src");
  const src = files.map((f) => readFileSync(f, "utf8")).join("\n");
  return new Set(ids.filter((id) => src.includes(`"${id}"`)));
}

async function main() {
  const cfg = loadConfig();
  const db = await openDb(cfg.DATABASE_URL);
  const kb = kbRepo(db);
  const ops = opsRepo(db);
  const secretBox = cfg.SECRETS_KEY ? new SecretBox(cfg.SECRETS_KEY) : null;
  const embedding = new EmbeddingConfig(ops, secretBox);
  const embedder = new SelectedEmbedder(() => embedding.selection(), createEmbedder(cfg), { log: () => undefined });
  const live = new LiveContent(db, kb, ops, embedder, `${cfg.CONTENT_DIR}/config/predicates.yml`, Date.now, async () => (await embedder.active()).version);
  await live.rebuild();

  const docs = await kb.listDocuments();
  const templateDocs = new Set(docs.filter((d) => d.kind === "templates").map((d) => d.slug));
  const rows = (await kb.loadPublishedTemplateRows()).filter((r) => templateDocs.has(r.docSlug));
  const legacy = rows.map((r) => r.template);
  console.log(`đọc ${legacy.length} template đang publish từ ${templateDocs.size} tài liệu`);

  const res = migrateTemplates(legacy, { titles: TEMPLATE_TITLES, codeIds: idsReferencedInCode(legacy.map((t) => t.id)) });
  mkdirSync(outDir, { recursive: true });

  const problems: string[] = [];
  // báo cáo cho người đọc: tên mục thay cho mã
  const titles = new Map(res.docs.flatMap((d) => d.items.map((x) => [x.id, x.title] as const)));
  const readable = (m: string) => m.replace(/[a-z0-9]+(?:-[a-z0-9]+)+/g, (id) => (titles.has(id) ? `"${titles.get(id)}"` : id));
  const compiled: Template[] = [];
  for (const d of res.docs) {
    const yaml = itemsDocToYaml(d);
    writeFileSync(join(outDir, `${d.topic}.yaml`), yaml);
    const back = parseItemsDoc(yaml);
    for (const i of back.issues) problems.push(`- ${i.level === "error" ? "**Lỗi**" : "Nhắc"} — ${d.title}${i.templateId ? `, mục "${d.items.find((x) => x.id === i.templateId)?.title ?? i.templateId}"` : ""}: ${readable(i.message)}`);
    if (back.doc) compiled.push(...compileItems(back.doc));
  }
  writeFileSync(join(outDir, "doi-ma.json"), JSON.stringify(res.renamed, null, 2));

  // Hỏi thử bot trên bộ mục MỚI: vector câu mẫu lấy lại từ bộ đang chạy (cùng câu), không embed lại
  const vecByText = new Map<string, number[]>();
  for (const t of live.index.templates) {
    const vs = live.index.vectorsOf(t.id);
    if (vs.length === t.match.examples.length) t.match.examples.forEach((e, i) => vecByText.set(e, vs[i]!));
  }
  const vectors = new Map<string, number[][]>();
  for (const t of compiled) {
    const vs = t.match.examples.map((e) => vecByText.get(e));
    if (vs.length && vs.every(Boolean)) vectors.set(t.id, vs as number[][]);
  }
  // Câu hỏi thử được embed bằng model CỤC BỘ (không gọi dịch vụ ngoài), và chỉ khi cùng model với vector đã lưu
  const local = createEmbedder(cfg);
  const noEmbed = { version: live.index.vectorsModel ?? "none", embed: async (): Promise<number[][]> => { throw new Error("không embed"); } };
  const qEmbedder = local.version === live.index.vectorsModel ? local : noEmbed;
  if (qEmbedder === noEmbed) console.log(`model cục bộ (${local.version}) khác model của vector đã lưu (${live.index.vectorsModel}): chỉ so bằng luật/cụm từ`);
  const index = new TemplateIndex(compiled, live.evaluator, undefined, vectors, live.index.vectorsModel);
  const chunks = (await kb.listPublishedChunks()).map((c) => ({ ref: { kind: "chunk" as const, id: c.chunkId, doc: c.docSlug, title: c.heading }, heading: c.heading }));
  const confusions = await findConfusions(index, live.evaluator, qEmbedder, evalSettings(), { chunks });
  const titleOf = (id: string) => compiled.find((t) => t.id === id)?.item?.title ?? live.index.get(id)?.sets_context.issue ?? id;

  // Chạy song song trên bộ câu kiểm tra: bộ đang chạy vs bộ mục mới (id đã đổi được quy đổi)
  const cases: EvalCase[] = await kb.listEvalCases();
  const before = await runEval(cases, withExampleCache(live.index, live.evaluator, qEmbedder), live.evaluator);
  const renamedCases = cases.map((c) => ({ ...c, expected_template_id: c.expected_template_id ? (res.renamed[c.expected_template_id] ?? c.expected_template_id) : null }));
  const after = await runEval(renamedCases, withExampleCache(index, live.evaluator, qEmbedder), live.evaluator);
  const pct = (r: { correct: number; total: number }) => (r.total ? `${((r.correct / r.total) * 100).toFixed(1)}%` : "-");
  const worse = after.rows.filter((r, i) => before.rows[i]!.ok && !r.ok);
  const better = after.rows.filter((r, i) => !before.rows[i]!.ok && r.ok);

  const byWhat = new Map<string, string[]>();
  for (const n of res.notes) byWhat.set(n.what, [...(byWhat.get(n.what) ?? []), `- **${titleOf(n.id)}** (${n.id}): ${n.detail}`]);
  const report = [
    "# Chuyển template cũ sang mục hỏi đáp — báo cáo",
    "",
    `Đã chuyển ${legacy.length} template thành ${res.docs.reduce((s, d) => s + d.items.length, 0)} mục trong ${res.docs.length} chủ đề. File YAML nằm cùng thư mục; chưa có gì được nạp vào hệ thống.`,
    "",
    "## 1. Lỗi và nhắc khi kiểm tra từng tài liệu",
    "",
    problems.length ? problems.join("\n") : "Không có.",
    "",
    "## 2. Câu bot sẽ trả lời nhầm giữa các mục mới (phải xử lý trước khi publish)",
    "",
    "Mỗi dòng: xử lý bằng cách gộp hai mục, sửa cách hỏi, hoặc khai báo \"khác với\" kèm câu hỏi lại khách (theo quyết định của khách hàng trong file rà soát).",
    "",
    confusions.length ? confusions.map((c) => `- ${describeConfusion(c, titleOf, "sẽ")}`).join("\n") : "Không có.",
    "",
    "## 3. Chạy thử trên bộ câu kiểm tra (so với bộ đang chạy)",
    "",
    `Bộ đang chạy trả lời đúng ${before.correct}/${before.total} câu (${pct(before)}); bộ mục mới đúng ${after.correct}/${after.total} câu (${pct(after)}). Chỉ đo tầng không dùng AI (luật, cụm từ, so nghĩa): "ESCALATE" ở đây nghĩa là không khớp chắc chắn bằng luật — trong bot thật câu đó đi tiếp qua bước AI chọn câu trả lời, chưa chuyển nhân viên ngay. Câu một từ ("twin", "register"...) cố ý không còn khớp thẳng (từ đơn là nguyên nhân trả lời nhầm).`,
    "",
    `### Câu đang đúng sẽ thành sai (${worse.length})`,
    "",
    worse.length ? worse.map((r) => `- "${r.question}": cần "${titleOf(r.expected)}", bộ mới trả lời "${titleOf(r.got)}"`).join("\n") : "Không có.",
    "",
    `### Câu đang sai sẽ thành đúng (${better.length})`,
    "",
    better.length ? better.map((r) => `- "${r.question}" → "${titleOf(r.expected)}"`).join("\n") : "Không có.",
    "",
    "## 4. Những gì đã đổi so với bản cũ",
    "",
    ...[...byWhat.entries()].flatMap(([what, lines]) => [`### ${what} (${lines.length})`, "", ...lines, ""]),
  ].join("\n");
  writeFileSync(join(outDir, "BAO-CAO.md"), report);
  console.log(`ghi ${res.docs.length} chủ đề vào ${outDir}; ${problems.filter((p) => p.includes("**Lỗi**")).length} lỗi, ${confusions.length} câu trả lời nhầm, ${res.notes.length} ghi chú; câu kiểm tra ${pct(before)} -> ${pct(after)} (${worse.length} câu đúng thành sai)`);
  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
