import type { InboundBatch } from "./types";

type Handler = (b: InboundBatch) => Promise<unknown>;

/**
 * Gom các tin liên tiếp của cùng một khách trong một cửa sổ ngắn thành MỘT lượt xử lý
 * (gateway cũ debounce 2000ms; cần cho "2 ảnh KYC cùng lượt chỉ trả 1 reply"),
 * và xử lý tuần tự theo từng khách để không có hai lượt của cùng một người chạy song song.
 */
export class Coalescer {
  private pending = new Map<string, { batch: InboundBatch; timer: ReturnType<typeof setTimeout> }>();
  private chains = new Map<string, Promise<unknown>>();

  constructor(private readonly handler: Handler, private readonly windowMs: () => number, private readonly onError: (e: unknown) => void = () => undefined) {}

  push(b: InboundBatch): void {
    const key = `${b.chatId}:${b.userId}`;
    const cur = this.pending.get(key);
    if (cur) {
      cur.batch.items.push(...b.items);
      cur.batch.isMention ||= b.isMention;
      return;
    }
    const timer = setTimeout(() => this.fire(key), this.windowMs());
    this.pending.set(key, { batch: { ...b, items: [...b.items] }, timer });
  }

  private fire(key: string) {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.handler(p.batch)).catch(this.onError);
    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  /** Xử lý ngay mọi thứ đang chờ và đợi xong (dùng khi tắt dịch vụ và trong test). */
  async flush(): Promise<void> {
    for (const [key, p] of [...this.pending]) {
      clearTimeout(p.timer);
      this.fire(key);
    }
    await Promise.all([...this.chains.values()]);
  }
}
