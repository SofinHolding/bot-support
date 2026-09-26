/** Cấu hình chạy được đổi từ Admin Web, không cần deploy lại. Giá trị mặc định lấy từ các luật/ngưỡng của hệ thống cũ. */
import type { OpsRepo } from "../db/repo-ops";

export interface Settings {
  "router.semantic_confident": number;
  "router.semantic_margin": number;
  "router.semantic_suggest": number;
  "router.mode": "hybrid" | "llm_first"; // hybrid (theo sơ đồ workflow): FAST PATH khi khớp chắc chắn bằng luật/từ khoá — vẫn phải qua AI xác nhận —, còn lại đi AI/RAG. llm_first: mọi tin có chữ đi qua AI (hiểu -> tìm -> AI chọn -> dịch). Không có chế độ trả lời không qua AI.
  "router.tier3_mode": "extractive" | "generative";
  "router.tier3_min_score": number;
  "router.tier3_verify": boolean; // true: LLM phải xác nhận đoạn tri thức TRẢ LỜI ĐƯỢC câu hỏi rồi mới gửi (nguyên văn); không xác nhận được -> chuyển người thật
  "router.knowledge_lang": "vi" | "en"; // ngôn ngữ CHÍNH của kho tri thức: câu hỏi của khách được dịch sang ngôn ngữ này để tìm (SKILL translate-query)
  "router.too_short_max_chars": number;

  "episode.t_gap_minutes": number; // im lặng quá ngưỡng này thì open -> dormant
  "episode.t_abandon_days": number; // dormant quá ngưỡng này thì tự đóng (HEARTBEAT.md: 7 ngày)
  "episode.summary_every_k": number;
  "episode.closed_lookback_days": number;
  "episode.ask_when_unclear": boolean;
  "episode.reopen_window_hours": number; // khách quay lại chủ đề của vụ việc đang tạm lắng trong ngưỡng này thì mở lại vụ việc đó thay vì tạo mới

  "antispam.stale_days": number; // HEARTBEAT.md: xoá antispam không hoạt động > 30 ngày

  "alerts.escalation_daily_threshold": number; // cron cũ: > 100 template escalate/ngày thì báo owner
  "alerts.new_questions_threshold": number; // HEARTBEAT.md: "nhiều câu hỏi mới" thì báo owner cập nhật skill
  "alerts.whitepaper_stale_days": number; // HEARTBEAT.md: sync quá 2 ngày thì báo

  "approval.second_person": boolean; // true: publish luật bảo mật / Hướng dẫn AI / SKILL, đổi quản trị viên, cấu hình bảo vệ cần người thứ hai duyệt. false: người đề xuất (đủ quyền) áp dụng ngay

  "limits.tokens_per_user_day": number; // chống đốt token: vượt thì không gọi LLM cho khách đó trong ngày
  "translation.prewarm_languages": string; // mã ngôn ngữ (ngăn bằng dấu phẩy) dịch sẵn nhóm câu khẩn; cộng thêm mọi ngôn ngữ khách đã dùng
  "translation.urgent_timeout_ms": number; // thời gian chờ tối đa khi phải dịch câu khẩn tại chỗ (chưa có bản dịch sẵn)
  "batching.window_ms": number; // gom tin nhắn liên tiếp (gateway cũ: debounce 2000ms)
  "retention.media_days": number;
}

export const DEFAULT_SETTINGS: Settings = {
  "router.semantic_confident": 0.82,
  "router.semantic_margin": 0.08,
  "router.semantic_suggest": 0.35,
  "router.mode": "hybrid",
  "router.tier3_mode": "generative",
  "router.tier3_min_score": 0.25,
  "router.tier3_verify": true,
  "router.knowledge_lang": "en", // 3 tài liệu tham khảo viết tiếng Anh (audit R5)
  "router.too_short_max_chars": 2,

  "episode.t_gap_minutes": 60,
  "episode.t_abandon_days": 7,
  "episode.summary_every_k": 6,
  "episode.closed_lookback_days": 30,
  "episode.ask_when_unclear": false,
  "episode.reopen_window_hours": 24,

  "antispam.stale_days": 30,

  "alerts.escalation_daily_threshold": 100,
  "alerts.new_questions_threshold": 5,
  "alerts.whitepaper_stale_days": 2,

  "approval.second_person": true,

  "limits.tokens_per_user_day": 200_000,
  "translation.prewarm_languages": "vi,ko,ja,zh,ru,id,th,tr,es,pt,fr,de,ar,hi,fa,uk",
  "translation.urgent_timeout_ms": 8000,
  "batching.window_ms": 2000,
  "retention.media_days": 30,
};

/** Danh sách ngôn ngữ dịch sẵn câu khẩn (setting translation.prewarm_languages). */
export const prewarmLanguages = (s: Settings): string[] => [...new Set(s["translation.prewarm_languages"].split(",").map((x) => x.trim()).filter((x) => /^[a-z]{2}$/.test(x)))];

export class SettingsService {
  private cache: { at: number; value: Settings } | null = null;
  constructor(private readonly ops: OpsRepo, private readonly ttlMs = 10_000, private readonly now: () => number = Date.now) {}

  async get(): Promise<Settings> {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.value;
    const stored = await this.ops.getSettings();
    const merged = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (stored[k] !== undefined && typeof stored[k] === typeof (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k]) merged[k] = stored[k];
    this.cache = { at: this.now(), value: merged as unknown as Settings };
    return this.cache.value;
  }

  invalidate() {
    this.cache = null;
  }
}

/** Kiểm tra giá trị trước khi ghi từ Admin Web. */
export function validateSetting(key: string, value: unknown): string | null {
  const def = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key];
  if (def === undefined) return `khoá cấu hình không tồn tại: ${key}`;
  if (typeof value !== typeof def) return `sai kiểu dữ liệu (cần ${typeof def})`;
  if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) return "giá trị phải là số không âm";
  if (key === "router.tier3_mode" && value !== "extractive" && value !== "generative") return "chỉ nhận extractive | generative";
  if (key === "router.mode" && value !== "hybrid" && value !== "llm_first") return "chỉ nhận hybrid | llm_first";
  if (key === "router.knowledge_lang" && value !== "vi" && value !== "en") return "chỉ nhận vi | en";
  if (key.startsWith("router.semantic") && (value as number) > 1) return "ngưỡng phải trong khoảng 0..1";
  if (key === "translation.prewarm_languages" && !/^\s*([a-z]{2}\s*(,\s*[a-z]{2}\s*)*)?$/.test(value as string)) return "nhập mã ngôn ngữ 2 chữ cái, ngăn bằng dấu phẩy (vd: vi,ko,ja)";
  return null;
}
