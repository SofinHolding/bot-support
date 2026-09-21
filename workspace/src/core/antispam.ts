/** Bậc thang chặn off-topic (AGENTS.md > Anti-Spam & Cooldown). Hàm thuần, không I/O. */
export interface AntispamState {
  offtopic_count: number;
  blocked_until: Date | null;
  last_seen: Date;
}

export interface OfftopicOutcome {
  state: AntispamState;
  level: number;
  templateId: string;
  blockMs: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Thời gian chặn theo lần vi phạm thứ n (n>=7 => 24h). Lần 1-2 chỉ cảnh báo. */
export function blockDurationMs(n: number): number {
  if (n <= 2) return 0;
  if (n === 3) return MIN;
  if (n === 4) return 10 * MIN;
  if (n === 5) return 30 * MIN;
  if (n === 6) return HOUR;
  return 24 * HOUR;
}

export function antispamTemplateId(n: number): string {
  return n >= 7 ? "antispam-7plus" : `antispam-${n}`;
}

export function newAntispamState(now: Date): AntispamState {
  return { offtopic_count: 0, blocked_until: null, last_seen: now };
}

export function isBlocked(s: AntispamState, now: Date): boolean {
  return !!s.blocked_until && s.blocked_until.getTime() > now.getTime();
}

/** Có một khoản chặn đã hết hạn cần ghi nhận "tự động mở chặn". */
export function blockJustExpired(s: AntispamState, now: Date): boolean {
  return !!s.blocked_until && s.blocked_until.getTime() <= now.getTime();
}

export function applyOfftopic(s: AntispamState, now: Date): OfftopicOutcome {
  const level = s.offtopic_count + 1;
  const blockMs = blockDurationMs(level);
  return {
    level,
    blockMs,
    templateId: antispamTemplateId(level),
    state: {
      offtopic_count: level,
      blocked_until: blockMs ? new Date(now.getTime() + blockMs) : null,
      last_seen: now,
    },
  };
}
