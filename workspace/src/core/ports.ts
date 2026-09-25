/** Các cổng (interface) mà router cần. Cài đặt thật nằm ở src/llm và src/db; test dùng bản giả. */
import type { VisionResult } from "../domain/types";

export interface ContextPack {
  /** 1-2 dòng về khách: ngôn ngữ, episode trước, cờ */
  profile: string;
  /** Sự kiện do CODE ghi (luôn đúng): template đã gửi, ảnh đã nhận... */
  events: string[];
  /** Giá trị khách đã nêu, do CODE trích từ tin nhắn (mã lỗi, phiên bản, số lượng...): còn nguyên dù tin gốc đã rời cửa sổ */
  facts?: string[];
  /** Tóm tắt cuộn do LLM viết — chỉ để hiểu ngữ cảnh, không dùng để ra quyết định */
  summary?: string;
  /** Các tin sau mốc tóm tắt, đã che dữ liệu nhạy cảm */
  recent: { role: "user" | "bot"; text: string }[];
}

export interface ClassifyRequest {
  text: string;
  lang: string;
  context: ContextPack;
  /** Chỉ những template này được phép chọn */
  candidates: { id: string; group: string; gist: string }[];
}

export type ClassifyResult =
  | { action: "template"; template_id: string }
  | { action: "knowledge" }
  | { action: "escalate" }
  | { action: "offtopic" };

export interface TranslateQueryRequest {
  text: string;
  from: string;
  to: string;
  /** Chỉ để hiểu "nó / cái đó" — không được lấy dữ kiện từ đây đưa vào truy vấn */
  context?: ContextPack;
}

export type UnderstandIntent = "question" | "greeting" | "follow_up" | "offtopic" | "unclear";
export type UnderstandFollowUp = "none" | "thanks" | "negative" | "not_receive" | "no_old_email" | "info_provided";

/** SKILL understand: bước đầu của luồng "AI hiểu trước" */
export interface UnderstandRequest {
  text: string;
  /** chữ đọc được từ ảnh khách gửi (nếu có) */
  imageText?: string;
  /** ngôn ngữ chính của kho tri thức (vi | en) */
  knowledgeLang: string;
  /** câu trả lời đã duyệt bot gửi gần nhất trong vụ việc đang mở: để AI nhận ra tin nối tiếp */
  lastAnswer?: { id: string; text: string };
  context?: ContextPack;
}

export interface UnderstandResult {
  language: string;
  intent: UnderstandIntent;
  follow_up: UnderstandFollowUp;
  query_en: string;
  query_kb: string;
}

/** Ứng viên tìm được trong kho. ref = "T:<template id>" | "K:<chunk id>" */
export interface AnswerCandidate {
  ref: string;
  topic: string;
  text: string;
}

export interface SelectRequest {
  text: string;
  queryEn: string;
  lang: string;
  candidates: AnswerCandidate[];
  context?: ContextPack;
}

export interface SelectResult {
  /** một ref trong danh sách ứng viên, hoặc "ESCALATE" | "OFFTOPIC" */
  ref: string;
  reason: string;
}

/** SKILL verify-answer: kiểm duyệt MỘT câu trả lời đã khớp ở FAST PATH */
export interface VerifyRequest {
  text: string;
  queryEn?: string;
  lang: string;
  answer: { id: string; text: string };
  /** Tình huống mà quản trị viên nhắm tới khi soạn câu trả lời này (nhóm, câu mẫu / vấn đề) và cụm từ khoá đã khớp */
  intended?: string;
  matched?: string;
  lastAnswer?: { id: string; text: string };
  facts?: string[];
  /** Ngữ cảnh vụ việc (tóm tắt, các tin gần đây, sự kiện): AI xác nhận câu trả lời theo đúng ngữ cảnh hội thoại, không chỉ tin cuối */
  context?: ContextPack;
}
export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/** SKILL verify-handoff: khối "sao chép gửi hỗ trợ" (core/handoff.ts) có an toàn/trung thực để gửi khách không. */
export interface VerifyHandoffRequest {
  text: string;
  source: { issue: string; userReported: string; unresolvedPoints: string; facts: string[]; steps: string[] };
}

/** SKILL review-eval: AI đánh giá kỳ vọng của bộ câu hỏi mẫu (chỉ gợi ý cho admin) */
export interface ReviewEvalRequest {
  templates: { id: string; group: string; examples: string[]; answer: string }[];
  cases: { n: number; question: string; expected: string; got?: string }[];
}
export interface ReviewEvalItem {
  n: number;
  verdict: "ok" | "better" | "escalate" | "unsure";
  suggested?: string;
  reason?: string;
}

/** SKILL review-overlap: AI phán xét MỘT cặp nội dung bị code cờ chồng lấn (kb/overlap.ts). Chỉ gợi ý cho admin. */
export interface OverlapSide {
  kind: "template" | "chunk";
  id: string;
  doc: string;
  title: string;
  keywords: string[];
  examples: string[];
  text: string;
}
export interface ReviewOverlapRequest {
  a: OverlapSide;
  b: OverlapSide;
  signals: string[];
}
export interface OverlapVerdict {
  /** bản 3 của SKILL thêm complement / supersedes / contradiction; bản 2 chỉ trả 4 loại đầu — code nhận cả hai */
  verdict: "duplicate" | "subset" | "conflict" | "distinct" | "complement" | "supersedes" | "contradiction";
  reason?: string;
  suggestion?: string;
}

/**
 * SKILL intake-draft: văn bản tự do (admin dán vào) -> LOẠI + CÁC TRƯỜNG có cấu trúc, không phải Markdown thô — code render
 * Markdown đúng cú pháp từ các trường này (xem kb/intake.ts), tránh rủi ro AI viết sai YAML/id/response_mode. Không bao giờ
 * được chọn "guide": kiểu dữ liệu chỉ cho hai giá trị, "Hướng dẫn AI làm việc" chỉ sửa được bằng tay.
 */
export interface IntakeDraftRequest {
  rawText: string;
  kindHint?: "templates" | "knowledge";
  /** Nhóm (`group`) đang dùng trong kho template thật — SKILL ưu tiên dùng lại một nhóm có sẵn thay vì bịa nhóm mới, giữ đúng phân loại của dự án. */
  existingGroups?: string[];
}
export interface IntakeDraftResult {
  kind: "templates" | "knowledge";
  slug: string;
  title: string;
  templates: { id: string; group: string; keywords: string[]; examples: string[]; answer_en: string }[];
  knowledge: { lang: string; sections: { heading: string; body: string }[] } | null;
}

export interface GroundedChunk {
  id: string;
  heading: string;
  text: string;
  url?: string;
}

export interface GroundedResult {
  answerable: boolean;
  answer: string;
  cited: string[];
}

export interface SummaryInput {
  /** Bản tóm tắt trước: LLM CẬP NHẬT tại chỗ chứ không viết chồng lên */
  previous?: { issue?: string; user_reported?: string; unresolved_points?: string; exact_facts?: string[]; degraded?: boolean };
  messages: { role: "user" | "bot"; text: string }[];
}

export interface SummaryResult {
  issue: string;
  user_reported: string;
  unresolved_points: string;
  /** Giá trị khách nêu, chép nguyên văn; bên gọi kiểm lại với tin nhắn nguồn (core/summary.ts) */
  exact_facts?: string[];
}

export class LlmUnavailableError extends Error {
  /** badOutput = true: provider vẫn chạy nhưng trả kết quả không đúng schema (không phải quá tải) => nên chuyển người thật, không báo "high traffic". */
  constructor(message = "LLM unavailable", readonly badOutput = false) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

export interface LlmPort {
  /** false = chưa cấu hình gateway/khoá: bot chạy bằng template thuần (tầng 0-1), câu lạ chuyển cho người thật. Không khai báo = luôn sẵn sàng. */
  readonly ready?: boolean;
  /** Luồng "AI hiểu trước": (1) hiểu tin nhắn — ngôn ngữ, ý định, câu truy vấn; (2) chọn ứng viên ĐÚNG trong kết quả tìm kiếm. Đầu ra chưa đáng tin: bên gọi kiểm lại. */
  understand(req: UnderstandRequest): Promise<UnderstandResult>;
  select(req: SelectRequest): Promise<SelectResult>;
  /** FAST PATH: câu trả lời đã khớp có giải quyết đúng câu hỏi không (yes/no). `no` => tin sang nhánh AI/RAG. */
  verify(req: VerifyRequest): Promise<VerifyResult>;
  /** SKILL verify-handoff: khối tóm tắt chuyển hỗ trợ có an toàn/trung thực để gửi khách không (yes/no), trước khi dịch và gửi. */
  verifyHandoff(req: VerifyHandoffRequest): Promise<VerifyResult>;
  classify(req: ClassifyRequest): Promise<ClassifyResult>;
  /** standalone: câu hỏi đã viết lại theo ngữ cảnh (nếu có) để LLM hiểu câu hỏi nối tiếp; câu gốc của khách vẫn là `question`. */
  /** verifyOnly: chỉ cần biết đoạn nào trả lời được (answerable/cited), không cần câu trả lời — model khỏi sinh văn bản sẽ bị bỏ đi */
  grounded(req: { question: string; standalone?: string; verifyOnly?: boolean; lang: string; chunks: GroundedChunk[] }): Promise<GroundedResult>;
  vision(req: { mime: string; base64: string; caption?: string }): Promise<VisionResult>;
  /** SKILL translate-answer: dịch nguyên văn sang `lang`; `from` là ngôn ngữ nguồn (nếu biết). Bên gọi kiểm bản dịch (core/translate.ts). */
  translate(req: { text: string; lang: string; from?: string }): Promise<string>;
  /** SKILL translate-query: câu hỏi của khách (ngôn ngữ `from`) -> câu truy vấn đứng độc lập bằng ngôn ngữ tìm kiếm `to`. Chỉ để TÌM; bên gọi kiểm đầu ra. */
  translateQuery(req: TranslateQueryRequest): Promise<{ query: string }>;
  summarize(req: SummaryInput): Promise<SummaryResult>;
  /** Đánh giá bộ câu hỏi mẫu (Admin Web). Không dùng trong luồng trả lời khách. */
  reviewEval(req: ReviewEvalRequest): Promise<ReviewEvalItem[]>;
  /** SKILL review-overlap: phán xét một cặp nội dung chồng lấn (Admin Web). Không dùng trong luồng trả lời khách. */
  reviewOverlap(req: ReviewOverlapRequest): Promise<OverlapVerdict>;
  /** SKILL intake-draft: trợ lý "Nạp nội dung mới" (Admin Web). Không dùng trong luồng trả lời khách. */
  draftIntake(req: IntakeDraftRequest): Promise<IntakeDraftResult>;
}

/** LLM dùng được ngay bây giờ (đã cấu hình), hoặc undefined => chế độ template thuần. */
export const usableLlm = (l: LlmPort | undefined): LlmPort | undefined => (l && l.ready !== false ? l : undefined);

export interface KnowledgeHit {
  chunkId: string;
  docSlug: string;
  heading: string;
  text: string;
  url?: string;
  score: number;
  /** Ngôn ngữ của đoạn (ghi khi publish). Đoạn publish trước khi có trường này: undefined -> router tự nhận diện */
  lang?: string;
}

export interface KnowledgePort {
  /** queryLang: ngôn ngữ của `query` (nếu biết). Khác ngôn ngữ của đoạn thì từ khoá không phải bằng chứng, chỉ tính điểm vector. */
  search(query: string, k: number, queryLang?: string): Promise<KnowledgeHit[]>;
  /** Các đoạn đang publish theo id (dùng khi khách trả lời câu hỏi lại). Đoạn không còn thì bỏ qua. */
  byIds?(ids: string[]): Promise<KnowledgeHit[]>;
}
