/**
 * Lập lịch việc định kỳ. Mỗi lần "đến hạn" có một khoá slot duy nhất => nhiều worker chạy song song vẫn chỉ enqueue một lần
 * (dedupe_key = `${name}:${slot}`), và một lần worker ngừng không làm mất/dồn việc đã qua.
 */
export type CronSpec =
  | { kind: "every"; minutes: number }
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; at: string; tz: string }
  | { kind: "weekly"; dow: number; at: string; tz: string }; // dow: 0=Chủ nhật ... 6=Thứ bảy

export interface CronDef {
  name: string;
  spec: CronSpec;
  /** legacy: lịch/cron cũ mà mục này thay thế (để đối chiếu) */
  replaces?: string;
}

interface Zoned {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  dow: number;
}

export function zoned(date: Date, tz: string): Zoned {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), hh: Number(get("hour")), mm: Number(get("minute")), dow: dows.indexOf(get("weekday")) };
}

/** Ngày dạng YYYY-MM-DD theo múi giờ. */
export function localDate(date: Date, tz: string): string {
  const z = zoned(date, tz);
  return `${z.y}-${String(z.m).padStart(2, "0")}-${String(z.d).padStart(2, "0")}`;
}

/** Thứ Hai của tuần chứa ngày này (YYYY-MM-DD, theo múi giờ). */
export function mondayOf(date: Date, tz: string): string {
  const z = zoned(date, tz);
  const back = (z.dow + 6) % 7;
  return localDate(new Date(date.getTime() - back * 86_400_000), tz);
}

const parseAt = (at: string) => {
  const [h, m] = at.split(":").map(Number);
  return { h: h!, m: m ?? 0 };
};

/**
 * Slot của lần chạy gần nhất đã đến hạn (<= now), hoặc null nếu chưa có.
 * Lịch ngày/tuần chỉ xét trong vòng 36 giờ / 8 ngày gần nhất để worker khởi động lại không chạy bù việc quá cũ.
 */
export function dueSlot(spec: CronSpec, now: Date): string | null {
  switch (spec.kind) {
    case "every":
      return `e${Math.floor(now.getTime() / (spec.minutes * 60_000))}`;
    case "hourly": {
      const t = new Date(now.getTime() - (now.getUTCMinutes() < spec.minute ? 3600_000 : 0));
      return `h${t.toISOString().slice(0, 13)}`;
    }
    case "daily": {
      const { h, m } = parseAt(spec.at);
      const z = zoned(now, spec.tz);
      const reached = z.hh > h || (z.hh === h && z.mm >= m);
      const day = reached ? localDate(now, spec.tz) : localDate(new Date(now.getTime() - 86_400_000), spec.tz);
      return `d${day}`;
    }
    case "weekly": {
      const { h, m } = parseAt(spec.at);
      const z = zoned(now, spec.tz);
      let back = (z.dow - spec.dow + 7) % 7;
      const reachedToday = z.hh > h || (z.hh === h && z.mm >= m);
      if (back === 0 && !reachedToday) back = 7;
      return `w${localDate(new Date(now.getTime() - back * 86_400_000), spec.tz)}`;
    }
  }
}

const BKK = "Asia/Bangkok";

/** Các cron của hệ thống mới, thay thế 3 cron OpenClaw + việc Heartbeat cũ. */
export const CRONS: CronDef[] = [
  { name: "maintenance", spec: { kind: "every", minutes: 10 }, replaces: "Heartbeat: dọn context bỏ dở (episode dormant/abandoned), hàng đợi kẹt" },
  { name: "reindex-embeddings", spec: { kind: "every", minutes: 10 }, replaces: "(mới) embed lại chunk tri thức khi đổi embedding model hoặc khi dịch vụ embedding từng lỗi lúc publish" },
  { name: "vault-index", spec: { kind: "every", minutes: 5 }, replaces: "(mới) chạy bù hàng đợi index của vault Obsidian và embed bù chunk thiếu vector" },
  { name: "outbox-flush", spec: { kind: "every", minutes: 1 }, replaces: "delivery-queue/failed (1.083 tin lỗi không ai gửi lại)" },
  { name: "usage-aggregate", spec: { kind: "hourly", minute: 5 }, replaces: "cron usage-aggregator-daily `5 * * * *` UTC" },
  { name: "escalation-alert", spec: { kind: "daily", at: "23:59", tz: BKK }, replaces: "cron daily-escalate-threshold-alert 23:59 Asia/Bangkok" },
  { name: "whitepaper-sync", spec: { kind: "daily", at: "03:00", tz: BKK }, replaces: "cron whitepaper-weekly-sync (skill mô tả 03:00 UTC+7 hàng ngày; cron thật chạy hàng tuần và lỗi)" },
  { name: "whitepaper-health", spec: { kind: "daily", at: "09:00", tz: BKK }, replaces: "HEARTBEAT: kiểm tra 'Last synced' hàng ngày" },
  { name: "weekly-stats", spec: { kind: "weekly", dow: 1, at: "00:05", tz: BKK }, replaces: "HEARTBEAT: thống kê tuần + dọn dẹp mỗi thứ Hai" },
  { name: "retention", spec: { kind: "daily", at: "03:30", tz: BKK }, replaces: "session.maintenance.pruneAfter=3d (không được áp dụng): ảnh khách quá hạn lưu" },
  { name: "prewarm-urgent-translations", spec: { kind: "hourly", minute: 20 }, replaces: "(mới) dịch sẵn câu khẩn sang ngôn ngữ của khách; bản dịch còn hợp lệ thì bỏ qua" },
];
