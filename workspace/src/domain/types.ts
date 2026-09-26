export type ResponseMode = "SECURITY_RULE" | "EXACT_TEMPLATE" | "GROUNDED_GENERATION";

/** Điều kiện dùng trong requires / excludes / rules. */
export type Condition =
  | string // tên predicate trong content/config/predicates.yml
  | { any: string[] } // xuất hiện một trong các cụm từ
  | { regex: string; flags?: string }
  | { image_type: string | string[] }
  | { last_template: string | string[] }; // template bot vừa gửi trong episode

export interface TemplateMatch {
  /** Cụm từ: chỉ cần xuất hiện (khớp theo ranh giới từ) trong tin nhắn. */
  keywords: string[];
  /** Tin nhắn phải BẰNG cụm từ (bỏ dấu câu). Dùng cho lời chào để "hi, how to withdraw" không bị nuốt. */
  exact: string[];
  /** Câu hỏi mẫu, chỉ để xếp hạng ngữ nghĩa (embedding). Không tự tạo ra quyền trả lời. */
  examples: string[];
  /** Loại ảnh do vision nhận diện; khớp là hit (bỏ qua requires). */
  image_types: string[];
  /** Mỗi rule là AND các điều kiện; template hit nếu một rule thoả. */
  rules: { all: Condition[] }[];
  requires: Condition[];
  excludes: Condition[];
  /** Nếu hit thì bỏ qua ngữ cảnh follow-up cũ (FP-5b "HIGHEST PRIORITY OVERRIDE"). */
  overrides_context: boolean;
}

export interface TemplateContext {
  issue?: string;
  status: "pending" | "resolved" | "none";
}

export interface TemplateTicket {
  error_code?: string;
  pic?: string;
  category?: string;
}

export interface Template {
  id: string;
  group: string;
  response_mode: ResponseMode;
  priority: number;
  match: TemplateMatch;
  /** lang -> câu trả lời nguyên văn. `en` là bản gốc. */
  answers: Record<string, string>;
  /** Dùng câu trả lời của template khác (vd các trigger escalate dùng chung FP-12). */
  answer_from?: string;
  /** Loại follow-up -> template id | "ESCALATE". Loại: thanks, negative, more_images, not_receive, no_old_email. */
  follow_up: Record<string, string>;
  sets_context: TemplateContext;
  /** Nếu template này dẫn tới escalate/ticket thì gắn mã lỗi + PIC. */
  ticket?: TemplateTicket;
  /** Thông tin cần xin khách khi escalate (hiển thị trong ticket cho support). */
  required_info?: string[];
  source?: string;
  /** Thời gian hiệu lực (ngày YYYY-MM-DD, tính cả hai đầu). Ngoài khoảng này bot không dùng nội dung. */
  valid?: { from?: string; until?: string };
  /** Nhãn ngắn tiếng Anh (đã duyệt) mô tả hướng dẫn này, dùng trong khối tóm tắt gửi support thay cho id (core/handoff.ts stepLabel) */
  staff_label?: string;
  /** Có khi template được dịch từ "mục hỏi đáp" (src/core/items.ts): tên, ngữ cảnh, bước, mục tương tự đã xác nhận là khác. */
  item?: TemplateItemMeta;
}

/** Một mục tương tự đã được người duyệt xác nhận là KHÁC, kèm câu hỏi lại khách khi không phân biệt được. */
export interface ItemDistinctFrom {
  item: string;
  difference: string;
  clarify: string;
}

export interface TemplateItemMeta {
  id: string;
  title: string;
  topic: string;
  kind: "answer" | "handoff" | "system";
  /** 0 = bước đầu (tìm được bằng câu hỏi); n > 0 = bước sau, chỉ tới được qua tin nối tiếp */
  step: number;
  steps: number;
  applies_when?: string;
  distinct_from: ItemDistinctFrom[];
}

export interface ParseIssue {
  level: "error" | "warning";
  templateId?: string;
  message: string;
}

export type Tier = 0 | 1 | 2 | 3;

export type DecisionKind = "TEMPLATE" | "ESCALATE" | "GROUNDED" | "SECURITY" | "BLOCKED" | "OFFTOPIC" | "IGNORE";

export const ESCALATE_TEMPLATE_ID = "fp-12-escalate";
export const GREETING_TEMPLATE_ID = "fp-1-greeting";
export const GREETING_RETURNING_ID = "greeting-returning";
export const SECURITY_TEMPLATE_ID = "fp-0-security-alert";
export const HIGH_TRAFFIC_TEMPLATE_ID = "high-traffic";
export const THANKS_TEMPLATE_ID = "you-are-welcome";
export const IMAGE_UNREADABLE_ID = "image-unreadable";
export const IMAGE_COVER_SECRET_ID = "image-cover-secret";

export type VisionScreenType =
  | "kyc_email"
  | "kyc_queue_screen"
  | "error_dialog"
  | "app_screen"
  | "unrelated"
  | "unreadable";

export interface VisionResult {
  screen_type: VisionScreenType;
  error_text: string;
  has_secret: boolean;
  readable: boolean;
}
