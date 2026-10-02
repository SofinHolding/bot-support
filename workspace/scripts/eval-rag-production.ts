import { readFileSync, writeFileSync } from "node:fs";
import { buildKnowledgeSearchPlans, fuseKnowledgeRanks } from "../src/core/router";
import { PythonKnowledge } from "../src/kb/python-knowledge";
import { ProviderChain } from "../src/llm/chain";
import { LlmClient } from "../src/llm/client";
import { OpenAICompatProvider } from "../src/llm/openai-compat";
import { loadSkills } from "../src/llm/skills";

type EvalCase = {
  id: string;
  split: "dev" | "holdout";
  query: string;
  expected_document_ids: string[];
  language: string;
  category: string;
  difficulty: string;
};

const argv = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) argv.set(process.argv[i]!, process.argv[i + 1] ?? "");
const split = argv.get("--split") ?? "holdout";
const outFile = argv.get("--json-out");
const workers = Math.max(1, Math.min(8, Number(argv.get("--workers") ?? "1") || 1));
const retrievalOnly = (argv.get("--mode") ?? "full") === "retrieval";
const limit = Math.max(0, Number(argv.get("--limit") ?? "0") || 0);
if (!new Set(["dev", "holdout", "all"]).has(split)) throw new Error("--split phải là dev|holdout|all");

let cases = readFileSync("content/eval/rag-natural-golden.jsonl", "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as EvalCase)
  .filter((row) => split === "all" || row.split === split);
if (limit) cases = cases.slice(0, limit);

const llmBaseUrl = (process.env.LLM_BASE_URL ?? "").replace("host.docker.internal", "127.0.0.1");
if (!llmBaseUrl || !process.env.LLM_API_KEY) throw new Error("Thiếu LLM_BASE_URL/LLM_API_KEY");
if (!process.env.INTERNAL_SERVICE_TOKEN) throw new Error("Thiếu INTERNAL_SERVICE_TOKEN");

const provider = new OpenAICompatProvider({
  baseUrl: llmBaseUrl,
  apiKey: process.env.LLM_API_KEY,
  models: {
    fast: process.env.LLM_MODEL_FAST || "cx/gpt-5.6-sol",
    strong: process.env.LLM_MODEL_STRONG || "cx/gpt-5.5",
    intake: process.env.LLM_MODEL_FAST || "cx/gpt-5.6-sol",
  },
  timeoutMs: 60_000,
}, "eval-live");
const llm = new LlmClient(new ProviderChain([provider], { failureThreshold: 1000 }), loadSkills("content"));
const knowledge = new PythonKnowledge({
  baseUrl: process.env.KNOWLEDGE_EVAL_URL || "http://127.0.0.1:3010",
  token: process.env.INTERNAL_SERVICE_TOKEN,
  timeoutMs: 30_000,
});

const started = performance.now();
const evaluate = async (row: EvalCase) => {
  const expected = row.expected_document_ids;
  const understand = await llm.understand({ text: row.query, knowledgeLang: "en" });
  const plans = buildKnowledgeSearchPlans(
    row.query,
    understand.language || row.language,
    understand.query_kb,
    "en",
    understand.query_en,
  );
  const lists = [] as { hits: Awaited<ReturnType<typeof knowledge.search>>; weight: number }[];
  for (const plan of plans) lists.push({ hits: await knowledge.search(plan.q, 20, plan.lang), weight: plan.weight });
  const fused = fuseKnowledgeRanks(lists, 0, 8);
  const slugs = fused.map((hit) => hit.docSlug);
  let picked = "ESCALATE";
  if (!retrievalOnly && fused.length) {
    const selected = await llm.select({
      text: row.query,
      queryEn: understand.query_en,
      lang: understand.language || row.language,
      candidates: fused.map((hit) => ({ ref: `K:${hit.chunkId}`, topic: hit.heading, text: hit.text })),
    });
    picked = fused.find((hit) => `K:${hit.chunkId}` === selected.ref)?.docSlug ?? selected.ref;
  }
  return {
    id: row.id,
    category: row.category,
    query: row.query,
    expected,
    query_en: understand.query_en,
    query_kb: understand.query_kb,
    hits: slugs,
    picked,
  };
};

const details: Record<string, unknown>[] = new Array(cases.length);
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(workers, cases.length) }, async () => {
  while (true) {
    const i = cursor++;
    if (i >= cases.length) return;
    details[i] = await evaluate(cases[i]!);
  }
}));

let answerable = 0;
let retrievalTop1 = 0;
let recall5 = 0;
let selectedCorrect = 0;
let noAnswer = 0;
let predictedNoAnswer = 0;
let trueNoAnswer = 0;
for (let i = 0; i < cases.length; i++) {
  const expected = cases[i]!.expected_document_ids;
  const row = details[i]!;
  const slugs = row.hits as string[];
  const expectedAnswerable = expected.length > 0;
  if (expectedAnswerable) {
    answerable++;
    if (expected.includes(slugs[0] ?? "")) retrievalTop1++;
    if (slugs.slice(0, 5).some((slug) => expected.includes(slug))) recall5++;
    if (!retrievalOnly && expected.includes(String(row.picked))) selectedCorrect++;
  } else {
    noAnswer++;
  }
  if (!retrievalOnly) {
    const isNoAnswer = row.picked === "ESCALATE" || row.picked === "OFFTOPIC";
    if (isNoAnswer) predictedNoAnswer++;
    if (!expectedAnswerable && isNoAnswer) trueNoAnswer++;
  }
}

const precisionNoAnswer = retrievalOnly ? null : predictedNoAnswer ? trueNoAnswer / predictedNoAnswer : noAnswer ? 0 : 1;
const recallNoAnswer = retrievalOnly ? null : noAnswer ? trueNoAnswer / noAnswer : 1;
const metrics = {
  split,
  cases: cases.length,
  answerable_cases: answerable,
  no_answer_cases: noAnswer,
  retrieval_top1: answerable ? retrievalTop1 / answerable : 1,
  retrieval_recall_at_5: answerable ? recall5 / answerable : 1,
  selected_accuracy: retrievalOnly ? null : answerable ? selectedCorrect / answerable : 1,
  no_answer_precision: precisionNoAnswer,
  no_answer_recall: recallNoAnswer,
  wall_seconds: (performance.now() - started) / 1000,
};
const output = { metrics, failures: details.filter((row) => {
  const expected = row.expected as string[];
  return expected.length
    ? retrievalOnly ? !(row.hits as string[]).slice(0, 5).some((slug) => expected.includes(slug)) : !expected.includes(String(row.picked))
    : !retrievalOnly && !["ESCALATE", "OFFTOPIC"].includes(String(row.picked));
}) };
if (outFile) writeFileSync(outFile, JSON.stringify(output, null, 2));
if (outFile) writeFileSync(outFile.replace(/\.json$/i, "-details.json"), JSON.stringify(details, null, 2));
console.log(JSON.stringify(output, null, 2));
