/**
 * Quy tắc tóm tắt cuộn của episode. Bản tóm tắt THAY cho các tin cũ: lượt sau chỉ nạp tóm tắt + vài tin mới nhất,
 * nên mọi thứ cần để tiếp tục vụ việc phải còn trong đây. LLM viết, CODE kiểm:
 *   - che dữ liệu nhạy cảm, cắt theo giới hạn cứng (tóm tắt không phình theo thời gian);
 *   - `exact_facts` chỉ giữ giá trị THẬT SỰ có trong tin nhắn nguồn (hoặc bản tóm tắt trước) — LLM không thêm được số liệu;
 *   - LLM lỗi -> bản dự phòng cắt từ tin nhắn thật, đánh dấu `degraded`, lần tóm tắt sau viết lại.
 * Trạng thái nghiệp vụ vẫn lấy từ `events` do code ghi, không lấy từ đây.
 */
import type { SummaryResult } from "./ports";
import { maskSensitive } from "./sanitize";

export interface EpisodeSummary {
  issue: string;
  user_reported: string;
  unresolved_points: string;
  /** Giá trị khách nêu, chép nguyên văn: thông báo lỗi, số lượng, ngày giờ, phiên bản app, thiết bị... */
  exact_facts: string[];
  /** true = LLM lỗi, đây là bản cắt thô từ tin nhắn; lần tóm tắt sau sẽ viết lại */
  degraded?: boolean;
  model_note: string;
}

export const SUMMARY_LIMITS = { issue: 160, userReported: 500, unresolved: 260, facts: 8, factChars: 120 };

const MODEL_NOTE = "LLM viết; chỉ để hiểu ngữ cảnh, không dùng để quyết định nghiệp vụ";
const DEGRADED_NOTE = "LLM lỗi: bản cắt thô từ tin nhắn của khách, sẽ được viết lại ở lần tóm tắt sau";

const tokensOf = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]+(?:[.,:/-][\p{N}]+)*/gu) ?? [];

/**
 * Một fact được giữ khi: mọi token có chữ số đều xuất hiện trong nguồn (không bịa số liệu)
 * và phần lớn các token còn lại cũng có trong nguồn (cho phép LLM thêm nhãn ngắn kiểu "error:").
 */
export function factSupported(fact: string, sourceTokens: Set<string>): boolean {
  const toks = tokensOf(fact);
  if (!toks.length) return false;
  if (toks.some((t) => /\p{N}/u.test(t) && !sourceTokens.has(t))) return false;
  const found = toks.filter((t) => sourceTokens.has(t)).length;
  return found / toks.length >= 0.6;
}

export function readSummary(raw: unknown): EpisodeSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    issue: str(r.issue),
    user_reported: str(r.user_reported),
    unresolved_points: str(r.unresolved_points),
    exact_facts: Array.isArray(r.exact_facts) ? r.exact_facts.filter((f): f is string => typeof f === "string") : [],
    degraded: r.degraded === true ? true : undefined,
    model_note: str(r.model_note) || MODEL_NOTE,
  };
}

/** Lớp chặn sau LLM. `sources` = các tin nhắn vừa được tóm tắt (đã che). */
export function cleanSummary(out: SummaryResult, sources: string[], prev?: EpisodeSummary): { summary: EpisodeSummary; droppedFacts: string[] } {
  const L = SUMMARY_LIMITS;
  const sourceTokens = new Set(tokensOf([...sources, ...(prev?.exact_facts ?? [])].join("\n")));
  const facts: string[] = [];
  const droppedFacts: string[] = [];
  const seen = new Set<string>();
  for (const f of out.exact_facts ?? []) {
    const fact = maskSensitive(f).replace(/\s+/g, " ").trim().slice(0, L.factChars);
    const key = fact.toLowerCase();
    if (!fact || seen.has(key)) continue;
    seen.add(key);
    if (factSupported(fact, sourceTokens)) facts.push(fact);
    else droppedFacts.push(fact);
  }
  return {
    summary: {
      issue: maskSensitive(out.issue).slice(0, L.issue),
      user_reported: maskSensitive(out.user_reported).slice(0, L.userReported),
      unresolved_points: maskSensitive(out.unresolved_points).slice(0, L.unresolved),
      exact_facts: facts.slice(0, L.facts),
      model_note: MODEL_NOTE,
    },
    droppedFacts,
  };
}

/** LLM không tóm tắt được: giữ bản trước, nối thêm lời khách gần nhất (cắt gọn). Không có chữ nào do model viết. */
export function degradedSummary(prev: EpisodeSummary | undefined, messages: { role: "user" | "bot"; text: string }[]): EpisodeSummary {
  const L = SUMMARY_LIMITS;
  const lines = messages.filter((m) => m.role === "user" && m.text.trim()).map((m) => maskSensitive(m.text).replace(/\s+/g, " ").trim().slice(0, 160));
  const base = prev && !prev.degraded ? prev.user_reported : "";
  const joined = [base, ...lines].filter(Boolean).join(" | ");
  return {
    issue: prev?.issue ?? "",
    user_reported: joined.length > L.userReported ? `…${joined.slice(-(L.userReported - 1))}` : joined, // ưu tiên lời mới nhất
    unresolved_points: prev?.unresolved_points ?? "",
    exact_facts: prev?.exact_facts ?? [],
    degraded: true,
    model_note: DEGRADED_NOTE,
  };
}

/** Dòng tóm tắt đưa vào gói ngữ cảnh gửi LLM. */
export function summaryForContext(s: EpisodeSummary): string {
  return [
    `issue: ${s.issue}`,
    `reported: ${s.user_reported}`,
    `open points: ${s.unresolved_points}`,
    s.exact_facts.length ? `exact values stated by the customer: ${s.exact_facts.join(" · ")}` : "",
    s.degraded ? "(raw fallback summary)" : "",
  ]
    .filter(Boolean)
    .join("; ");
}
