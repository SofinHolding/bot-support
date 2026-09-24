/**
 * Chạy thử "Đánh giá câu mẫu bằng AI" (như nút trên Admin Web) không cần đăng nhập: LLM thật, DB tạm.
 *   npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/eval-review.ts [--scope=failures|all]
 */
import { loadPredicates } from "../src/core/predicates";
import { migrate, openDb } from "../src/db/db";
import { kbRepo } from "../src/db/repo-kb";
import { opsRepo } from "../src/db/repo-ops";
import { evalSettings, runEval } from "../src/kb/eval";
import { LiveContent } from "../src/kb/live-content";
import { seedContent } from "../src/kb/seed";
import { KbService } from "../src/kb/service";
import { ProviderChain } from "../src/llm/chain";
import { LlmClient } from "../src/llm/client";
import { createEmbedder } from "../src/llm/embedder";
import { OpenAICompatProvider } from "../src/llm/openai-compat";
import { loadSkills } from "../src/llm/skills";

const env = process.env;
const scope = process.argv.find((a) => a.startsWith("--scope="))?.slice(8) ?? "failures";
async function main() {
  const db = await openDb("pglite:memory");
  await migrate(db);
  const kb = kbRepo(db), ops = opsRepo(db);
  const embedder = createEmbedder({ EMBEDDING_URL: env.EMBEDDING_URL, EMBEDDING_MODEL: env.EMBEDDING_MODEL });
  const models = { fast: String(env.LLM_MODEL_FAST).split(/\s/)[0]!, strong: String(env.LLM_MODEL_STRONG).split(/\s/)[0]! };
  const modelsAll = { ...models, intake: models.fast };
  const chain = new ProviderChain([new OpenAICompatProvider(async () => ({ baseUrl: env.LLM_BASE_URL!, apiKey: env.LLM_API_KEY!, models: modelsAll }), "gateway")], {});
  const live = new LiveContent(db, kb, ops, embedder, "content/config/predicates.yml");
  const llm = new LlmClient(chain, loadSkills("content"));
  const svc = new KbService({ db, kb, ops, embedder, live, predicatesFallback: () => loadPredicates("content/config/predicates.yml") });
  await seedContent(svc, kb, ops, db, { contentDir: "content", adminIds: [9001], ownerId: 9001 });
  await live.rebuild();
  const cases = await kb.listEvalCases();
  const off = await runEval(cases, live.index, live.evaluator, evalSettings(live.urlHosts));
  const picked = cases.map((c, i) => ({ c, row: off.rows[i]! })).filter((x) => scope === "all" || !x.row.ok).slice(0, 30);
  const templates = live.index.templates.filter((t) => t.response_mode === "EXACT_TEMPLATE").map((t) => ({ id: t.id, group: t.group, examples: t.match.examples, answer: live.index.resolveAnswerSource(t).answers.en ?? "" }));
  const t0 = Date.now();
  const review = await llm.reviewEval({ templates, cases: picked.map((x, i) => ({ n: i + 1, question: x.c.question, expected: x.c.expected_template_id ?? "ESCALATE", got: x.row.got })) });
  console.log(`${picked.length} câu · ${Date.now() - t0} ms\n`);
  for (const [i, x] of picked.entries()) {
    const r = review.find((y) => y.n === i + 1);
    console.log(`#${i + 1} "${x.c.question}"\n   kỳ vọng ${x.c.expected_template_id ?? "ESCALATE"} · tầng 0-1 ${x.row.got} · AI: ${r?.verdict ?? "?"}${r?.suggested ? ` → ${r.suggested}` : ""}${r?.reason ? ` — ${r.reason}` : ""}`);
  }
  await db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
