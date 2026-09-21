/** Nạp lần đầu (template, tri thức, predicate, admin, bộ câu hỏi mẫu). Idempotent. */
import { createServices } from "../app";
import { loadConfig } from "../config";

const svc = await createServices(loadConfig(), "seed", { seed: true });
console.log(`kb_version=${svc.live.version}, template=${svc.live.index.templates.length}, admin=${(await svc.ops.listAdmins()).length}`);
await svc.close();
