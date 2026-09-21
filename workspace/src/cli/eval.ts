/** Chạy bộ câu hỏi mẫu qua router (tầng 0-1, không tốn token). Thoát mã 1 nếu độ chính xác < --min. */
import { createServices } from "../app";
import { loadConfig } from "../config";
import { evalSettings, runEval } from "../kb/eval";

const min = Number(process.argv.find((a) => a.startsWith("--min="))?.slice(6) ?? 0);
const svc = await createServices(loadConfig(), "eval");
const cases = await svc.kb.listEvalCases();
const r = await runEval(cases, svc.live.index, svc.live.evaluator, evalSettings(svc.live.urlHosts));
const acc = r.total ? r.correct / r.total : 1;
console.log(`Độ chính xác tầng 0-1 (không LLM): ${r.correct}/${r.total} = ${(acc * 100).toFixed(1)}%`);
for (const f of r.rows.filter((x) => !x.ok).slice(0, 40)) console.log(`  ✗ "${f.question}": mong đợi ${f.expected}, nhận ${f.got}`);
console.log("Các câu sai ở đây sẽ đi tiếp xuống tầng 2 (LLM) khi có LLM; nếu không có LLM chúng được chuyển cho người thật.");
await svc.close();
process.exit(acc < min ? 1 : 0);
