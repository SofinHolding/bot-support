/**
 * ProviderChain: thử lần lượt các provider, có circuit breaker và ghi nhận usage.
 * Hết provider -> LlmUnavailableError (router đổi thành thông báo "high traffic" cố định, không lộ lỗi kỹ thuật).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { LlmUnavailableError } from "../core/ports";
import { costOf } from "./prices";
import { LlmBadOutputError, LlmRefusalError, ProviderUnavailableError, type JsonRequest, type JsonResult, type LlmProvider, type Purpose, type Usage } from "./types";

export interface CallRecord {
  purpose: Purpose;
  provider: string;
  model: string | null;
  usage: Usage;
  cost: number;
  latencyMs: number;
  ok: boolean;
  error: string | null;
  messageId: number | null;
  userId: number | null;
}

export interface LlmCallContext {
  messageId: number | null;
  userId: number | null;
}

/** Gắn user/message cho mọi lời gọi LLM phát sinh trong một lượt xử lý (để tính usage theo khách). */
export const llmContext = new AsyncLocalStorage<LlmCallContext>();

interface Breaker {
  failures: number;
  openUntil: number;
}

export interface ChainOptions {
  failureThreshold?: number;
  openMs?: number;
  now?: () => number;
  onCall?: (rec: CallRecord) => void | Promise<void>;
}

export class ProviderChain {
  private readonly breakers = new Map<string, Breaker>();
  private readonly threshold: number;
  private readonly openMs: number;
  private readonly now: () => number;

  constructor(private readonly providers: LlmProvider[], private readonly opts: ChainOptions = {}) {
    this.threshold = opts.failureThreshold ?? 3;
    this.openMs = opts.openMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  get size() {
    return this.providers.length;
  }

  isOpen(name: string): boolean {
    const b = this.breakers.get(name);
    return !!b && b.openUntil > this.now();
  }

  private fail(name: string, retryAfterMs?: number) {
    const b = this.breakers.get(name) ?? { failures: 0, openUntil: 0 };
    b.failures++;
    if (b.failures >= this.threshold || retryAfterMs) b.openUntil = this.now() + (retryAfterMs ?? this.openMs);
    this.breakers.set(name, b);
  }

  private ok(name: string) {
    this.breakers.set(name, { failures: 0, openUntil: 0 });
  }

  private async record(rec: Omit<CallRecord, "messageId" | "userId">) {
    const ctx = llmContext.getStore();
    await this.opts.onCall?.({ ...rec, messageId: ctx?.messageId ?? null, userId: ctx?.userId ?? null });
  }

  async generateJson<T>(req: JsonRequest<T>): Promise<JsonResult<T>> {
    const errors: string[] = [];
    for (const p of this.providers) {
      if (this.isOpen(p.name)) {
        errors.push(`${p.name}: circuit open`);
        continue;
      }
      try {
        const res = await p.generateJson(req);
        this.ok(p.name);
        await this.record({ purpose: req.purpose, provider: res.provider, model: res.model, usage: res.usage, cost: costOf(res.model, res.usage), latencyMs: res.latencyMs, ok: true, error: null });
        return res;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${p.name}: ${msg}`);
        await this.record({ purpose: req.purpose, provider: p.name, model: null, usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, latencyMs: 0, ok: false, error: msg.slice(0, 300) });
        if (e instanceof LlmRefusalError) throw e; // không thử lại chỗ khác
        if (e instanceof ProviderUnavailableError) this.fail(p.name, e.retryAfterMs);
        else if (e instanceof LlmBadOutputError) this.fail(p.name);
        else throw e; // lỗi lập trình: đừng nuốt
      }
    }
    throw new LlmUnavailableError(errors.join(" | ") || "no providers configured");
  }
}
