import { CRONS, dueSlot } from "./schedule";
import { HANDLERS, type JobContext } from "./jobs";

/** Đặt job cho mọi cron đến hạn. Idempotent: nhiều worker cùng chạy vẫn chỉ tạo một job cho mỗi slot. */
export async function scheduleDue(ctx: JobContext): Promise<string[]> {
  const now = ctx.now();
  const created: string[] = [];
  for (const c of CRONS) {
    const slot = dueSlot(c.spec, now);
    if (!slot) continue;
    // `slot` không lặp lại theo thời gian thực, nên "đã từng xếp cho khung giờ này" (kể cả đã xong) là đủ để bỏ qua —
    // không dựa vào dedupe_key còn hiệu lực hay không, vì complete/failJob xoá dedupe_key sau khi xong (xem repo-ops).
    if (await ctx.ops.slotAlreadyQueued(c.name, slot)) continue;
    const ok = await ctx.ops.enqueueJob(c.name, { slot }, { dedupeKey: `${c.name}:${slot}`, maxAttempts: 5 });
    if (ok) created.push(c.name);
  }
  return created;
}

/** Chạy các job đang đến hạn. Lỗi -> retry với backoff; quá số lần -> dead-letter (hiện trên Admin Web). */
export async function runDueJobs(ctx: JobContext, max = 20): Promise<{ ran: number; failed: number }> {
  let ran = 0;
  let failed = 0;
  for (let i = 0; i < max; i++) {
    const job = await ctx.ops.claimJob();
    if (!job) break;
    const handler = HANDLERS[job.type];
    try {
      if (!handler) throw new Error(`không có handler cho job ${job.type}`);
      const result = await handler(ctx, job.payload);
      await ctx.ops.completeJob(job.id);
      if (CRONS.some((c) => c.name === job.type)) await ctx.ops.setCron(job.type, "ok", null, result);
      ran++;
    } catch (e) {
      const msg = (e as Error).message;
      const state = await ctx.ops.failJob(job, msg);
      if (CRONS.some((c) => c.name === job.type)) await ctx.ops.setCron(job.type, state === "dead" ? "dead" : "retrying", msg, null);
      ctx.log(state === "dead" ? "error" : "warn", `job ${job.type} lỗi (${state})`, { err: msg, attempts: job.attempts });
      failed++;
    }
  }
  return { ran, failed };
}
