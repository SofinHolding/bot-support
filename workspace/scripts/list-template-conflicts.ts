/**
 * Liệt kê các cặp TEMPLATE (không tính tài liệu tri thức) đang publish mà bộ quét chồng lấn (kb/overlap.ts) cờ là có thể
 * bị bot nhầm lẫn — dùng ĐÚNG cơ chế tìm kiếm lúc khách hỏi thật (LiveContent/TemplateIndex, cùng embedder đang cấu hình),
 * không gọi AI, không sửa gì. Xuất ra MỘT file Markdown duy nhất, mỗi cặp có ĐẦY ĐỦ nội dung của cả hai template (không
 * phải chỉ id/đoạn trích) để đọc trực tiếp trong một file, không phải tự tra cứu rải rác.
 *
 *   npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/list-template-conflicts.ts [--min=0.55] [--out=path.md]
 */
import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config";
import { openDb } from "../src/db/db";
import { kbRepo } from "../src/db/repo-kb";
import { opsRepo } from "../src/db/repo-ops";
import { LiveContent } from "../src/kb/live-content";
import { EmbeddingConfig } from "../src/llm/embedding-config";
import { createEmbedder, SelectedEmbedder } from "../src/llm/embedder";
import { SecretBox } from "../src/llm/secret-box";
import { scanCorpus, type OverlapPair } from "../src/kb/overlap";
import type { Template } from "../src/domain/types";

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const minScore = Number(arg("min", "0.55"));
const outPath = arg("out", "docs/xung-dot-template-hien-co.md");

const fmtList = (xs: string[] | undefined) => (xs?.length ? xs.map((x) => `  - ${x}`).join("\n") : "  - (không có)");
const fmtAnswers = (t: Template) =>
  t.answer_from
    ? `(dùng chung câu trả lời của \`${t.answer_from}\`)`
    : Object.entries(t.answers)
        .map(([lang, text]) => `**${lang}:**\n\n> ${(text ?? "").split("\n").join("\n> ")}`)
        .join("\n\n");

function renderTemplate(label: string, t: Template, doc: string): string {
  return `#### ${label}) \`${t.id}\` — nhóm "${t.group}" (tài liệu: ${doc})

- response_mode: \`${t.response_mode}\`
- priority: ${t.priority}
${t.answer_from ? `- answer_from: \`${t.answer_from}\`\n` : ""}- từ khoá:
${fmtList(t.match.keywords)}
- câu ví dụ:
${fmtList(t.match.examples)}
${t.ticket ? `- ticket: \`${JSON.stringify(t.ticket)}\`\n` : ""}${Object.keys(t.follow_up ?? {}).length ? `- follow_up: \`${JSON.stringify(t.follow_up)}\`\n` : ""}- sets_context: \`${JSON.stringify(t.sets_context)}\`

${fmtAnswers(t)}
`;
}

async function main() {
  const cfg = loadConfig();
  const db = await openDb(cfg.DATABASE_URL);
  const kb = kbRepo(db);
  const ops = opsRepo(db);

  const secretBox = cfg.SECRETS_KEY ? new SecretBox(cfg.SECRETS_KEY) : null;
  const localEmbedder = createEmbedder(cfg);
  const embedding = new EmbeddingConfig(ops, secretBox);
  const embedder = new SelectedEmbedder(() => embedding.selection(), localEmbedder, { log: () => undefined, onExternalFailure: async () => undefined });

  const live = new LiveContent(db, kb, ops, embedder, `${cfg.CONTENT_DIR}/config/predicates.yml`, Date.now, async () => (await embedder.active()).version);
  await live.rebuild();
  console.log(`đã nạp ${live.index.templates.length} template đang publish, embedder: ${live.index.vectorsModel}`);

  const rows = await kb.loadPublishedTemplateRows();
  const docOf = new Map(rows.map((r) => [r.template.id, r.docSlug]));

  const pairs: OverlapPair[] = await scanCorpus({ index: live.index, kb, embedder, docOf }, { minScore, maxPairs: 500 });
  const templateOnly = pairs.filter((p) => p.a.kind === "template" && p.b.kind === "template");

  const tById = new Map(live.index.templates.map((t) => [t.id, t]));
  const lines: string[] = [];
  lines.push(`# Xung đột giữa các template hiện có`);
  lines.push(``);
  lines.push(`Quét bằng đúng cơ chế tìm kiếm lúc khách hỏi thật (vector câu mẫu + từ khoá-nằm-trong-câu), ngưỡng điểm ${minScore}, model embedding \`${live.index.vectorsModel}\`.`);
  lines.push(`Chỉ liệt kê cặp TEMPLATE — TEMPLATE (không tính tài liệu tri thức). Đây là nội dung ĐANG PUBLISH thật, chưa qua AI đánh giá — bạn đọc và tự quyết định, không có gì bị đổi.`);
  lines.push(``);
  lines.push(`**${templateOnly.length} cặp** được tìm thấy, xếp theo điểm giảm dần (điểm càng cao càng chắc là trùng thật).`);
  lines.push(``);
  lines.push(`## Mục lục (đọc bảng này trước, mở chi tiết cặp nào cần xem)`);
  lines.push(``);
  lines.push(`| # | Điểm | Template A | Template B |`);
  lines.push(`|---|---|---|---|`);
  templateOnly.forEach((p, i) => {
    lines.push(`| [${i + 1}](#cặp-${i + 1}) | ${p.score.toFixed(2)} | \`${p.a.id}\` | \`${p.b.id}\` |`);
  });
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  templateOnly.forEach((p, i) => {
    const a = tById.get(p.a.id);
    const b = tById.get(p.b.id);
    if (!a || !b) return;
    lines.push(`## Cặp ${i + 1} — điểm ${p.score.toFixed(2)}`);
    lines.push(``);
    lines.push(`**Tín hiệu:**`);
    lines.push(fmtList(p.signals));
    lines.push(``);
    lines.push(renderTemplate("A", a, p.a.doc));
    lines.push(``);
    lines.push(renderTemplate("B", b, p.b.doc));
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  });

  writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`đã ghi ${templateOnly.length} cặp vào ${outPath}`);
  await db.close();
}
main().catch((e) => {
  console.error("lỗi:", e);
  process.exit(1);
});
