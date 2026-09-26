/** Worker: chạy việc định kỳ và việc nền từ hàng đợi Postgres. */
import { isMain } from "../entry";
import { createServices, type Services } from "../app";
import { loadConfig } from "../config";
import type { JobContext } from "./jobs";
import { runDueJobs, scheduleDue } from "./runner";

export function jobContext(svc: Services): JobContext {
  return {
    db: svc.db, conv: svc.conv, kb: svc.kb, ops: svc.ops, settings: svc.settings, kbService: svc.kbService, channel: svc.channel, llm: svc.llm, media: svc.media,
    ownerId: svc.cfg.ownerId, adminWebUrl: svc.cfg.PUBLIC_ADMIN_URL, now: () => new Date(), fetchImpl: fetch, log: svc.log, resolver: svc.resolver, live: svc.live,
  };
}

export async function startWorker(svc: Services, tickMs = 5000) {
  const ctx = jobContext(svc);
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await scheduleDue(ctx);
      await runDueJobs(ctx, 20);
    } catch (e) {
      svc.log("error", "worker tick lỗi", { err: (e as Error).message });
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), tickMs);
  void tick();
  svc.log("info", "worker chạy");
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

if (isMain("worker.js", import.meta.url)) {
  const cfg = loadConfig();
  const svc = await createServices(cfg, "worker");
  const running = await startWorker(svc);
  const shutdown = async () => {
    await running.stop();
    await svc.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
