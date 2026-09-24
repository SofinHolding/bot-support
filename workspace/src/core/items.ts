/**
 * "Mục hỏi đáp" — đơn vị kiến thức của hệ thống mới (thay cho template soạn tay bằng từ khoá + độ ưu tiên).
 *
 * Mỗi mục là MỘT tình huống của khách: nhiều cách hỏi (questions) → một câu trả lời, có thể nhiều bước (steps), có thể chuyển
 * nhân viên (handoff), và phải khai báo rõ nó KHÁC mục tương tự ở điểm nào (distinct_from) — kèm câu hỏi lại khách khi mơ hồ.
 * Nội dung lưu theo CHỦ ĐỀ: mỗi tài liệu `kind: items` là một file YAML (ItemsDoc) có phiên bản như mọi tài liệu khác.
 *
 * Khi publish, `compileItems` dịch mỗi mục sang cấu trúc Template đang chạy (bước 1 = template `id`, bước n = `id--bn`) nên
 * tìm kiếm, dịch, ticket, hỏi thử bot, kiểm tra hồi quy và hoàn tác dùng lại nguyên vẹn. Phần mới của mục (tên, ngữ cảnh,
 * distinct_from, số bước) đi kèm ở `Template.item` để router dùng khi chọn / hỏi lại khách.
 *
 * Luật bất biến:
 *  - KHÔNG có độ ưu tiên dạng số: mọi mục ngang hàng (priority cố định), cụm nhận biết cụ thể hơn thắng, còn lại để AI chọn.
 *  - Cụm nhận biết (phrases) phải từ 2 từ trở lên — từ đơn chung ("ambassador") từng giành câu hỏi của cả một tài liệu.
 *  - Mục hệ thống (bảo mật, chống spam, quá tải...) do code gửi đúng lúc: giữ nguyên chữ, không sửa qua form.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ESCALATE_TEMPLATE_ID, type Condition, type ItemDistinctFrom, type ParseIssue, type ResponseMode, type Template, type TemplateItemMeta } from "../domain/types";
import type { FollowUpKind } from "./followup";
import { FOLLOW_UP_KINDS } from "./templates";
import { normalize, wordCount } from "./text";

/** Chủ đề cố định (người quản lý chọn trong danh sách, không tự đặt). Khoá là mã, giá trị là tên hiển thị. */
export const ITEM_TOPICS: Record<string, string> = {
  greeting: "Chào hỏi và phản hồi chung",
  account: "Tài khoản và đăng nhập",
  kyc: "KYC (xác minh danh tính)",
  itlg: "ITLG: khai thác, burn, rút tiền, niêm yết",
  wallet: "Ví",
  hcs: "HCS",
  game: "Game và thưởng",
  mining: "Group Mining",
  programs: "Ambassador và Campaign",
  general: "Giới thiệu dự án",
  support: "Chuyển nhân viên hỗ trợ",
  system: "Tin nhắn hệ thống",
};

export type ItemKind = "answer" | "handoff" | "system";
/** Đích của một bước khi khách phản hồi: bước kế tiếp, chuyển nhân viên, hoặc mục khác (`<id>` hay `<id>#<số bước>`). */
export type StepTarget = "next" | "handoff" | string;

export interface ItemStep {
  /** lang -> lời bot gửi. `en` là bản gốc (bắt buộc). */
  say: Record<string, string>;
  /** Khách phản hồi thế nào (loại tin nối tiếp đã có trong followup.ts) -> đi đâu. Không khai báo = xử lý như câu hỏi mới. */
  next?: Partial<Record<FollowUpKind, StepTarget>>;
}

/** Mục tương tự đã xác nhận là KHÁC: `item` (mã), `difference` (khác ở điểm nào), `clarify` (câu hỏi lại khách, tiếng Anh). */
export type DistinctFrom = ItemDistinctFrom;

export interface ItemHandoff {
  category?: string;
  error_code?: string;
  pic?: string;
  /** thông tin cần xin khách, ghi vào ticket */
  ask_customer?: string[];
}

/** Điều kiện kỹ thuật chuyển từ hệ thống cũ (luật KYC, loại ảnh, lời chào khớp nguyên câu...). Chỉ owner sửa. */
export interface ItemAdvanced {
  exact?: string[];
  rules?: { all: Condition[] }[];
  requires?: Condition[];
  excludes?: Condition[];
  image_types?: string[];
  overrides_context?: boolean;
  response_mode?: ResponseMode;
  /** tên vụ việc ghi vào ngữ cảnh (mặc định = title) và trạng thái sau khi gửi (mặc định: answer -> pending, còn lại -> none) */
  issue?: string;
  status?: "pending" | "resolved" | "none";
}

export interface KnowledgeItem {
  id: string;
  title: string;
  kind: ItemKind;
  /** Các cách khách hay hỏi — càng đa dạng càng tốt. Dùng để tìm theo nghĩa. */
  questions: string[];
  /** Cụm chắc chắn để trả lời nhanh không cần AI — tuỳ chọn, mỗi cụm ≥ 2 từ. */
  phrases: string[];
  /** Mục này dùng khi nào (lời thường) */
  applies_when?: string;
  distinct_from: DistinctFrom[];
  steps: ItemStep[];
  handoff?: ItemHandoff;
  source?: string;
  advanced?: ItemAdvanced;
}

export interface ItemsDoc {
  topic: string;
  title: string;
  items: KnowledgeItem[];
}

/** Siêu dữ liệu mục hỏi đáp gắn vào Template đã dịch (router dùng khi chọn / hỏi lại khách). */
export type ItemMeta = TemplateItemMeta;

/** Độ ưu tiên cố định cho MỌI mục: không còn thứ bậc theo số (xem đầu file). */
export const ITEM_PRIORITY = 500;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Hậu tố id của bước sau: "<id>--b2", "<id>--b3"... (id mục không được chứa "--" để không trùng). */
export const stepTemplateId = (itemId: string, stepIndex: number) => (stepIndex === 0 ? itemId : `${itemId}--b${stepIndex + 1}`);

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const strList = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : typeof v === "string" && v.trim() ? [v.trim()] : []);
const say = (v: unknown): Record<string, string> => {
  if (typeof v === "string") return v.trim() ? { en: v.trim() } : {};
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, str(x)]).filter(([, x]) => x));
  return {};
};

/** Đọc một tài liệu chủ đề (YAML). Lỗi cấu trúc trả về trong `issues`, không throw. */
export function parseItemsDoc(src: string): { doc?: ItemsDoc; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(src);
  } catch (e) {
    return { issues: [{ level: "error", message: `YAML không đọc được: ${(e as Error).message.split("\n")[0]}` }] };
  }
  if (!raw || typeof raw !== "object") return { issues: [{ level: "error", message: "tài liệu rỗng hoặc không phải YAML dạng bảng" }] };
  const r = raw as Record<string, unknown>;
  const topic = str(r.topic);
  if (!ITEM_TOPICS[topic]) issues.push({ level: "error", message: `chủ đề "${topic}" không có trong danh sách: ${Object.keys(ITEM_TOPICS).join(", ")}` });
  const items: KnowledgeItem[] = [];
  for (const [i, x] of (Array.isArray(r.items) ? r.items : []).entries()) {
    const o = (x ?? {}) as Record<string, unknown>;
    const kind = (str(o.kind) || "answer") as ItemKind;
    const adv = o.advanced && typeof o.advanced === "object" ? (o.advanced as ItemAdvanced) : undefined;
    const h = o.handoff && typeof o.handoff === "object" ? (o.handoff as Record<string, unknown>) : undefined;
    items.push({
      id: str(o.id) || `muc-${i + 1}`,
      title: str(o.title),
      kind,
      questions: strList(o.questions),
      phrases: strList(o.phrases),
      applies_when: str(o.applies_when) || undefined,
      distinct_from: (Array.isArray(o.distinct_from) ? o.distinct_from : []).map((d) => {
        const dd = (d ?? {}) as Record<string, unknown>;
        return { item: str(dd.item), difference: str(dd.difference), clarify: str(dd.clarify) };
      }),
      steps: (Array.isArray(o.steps) ? o.steps : []).map((s) => {
        const ss = (s ?? {}) as Record<string, unknown>;
        const next = ss.next && typeof ss.next === "object" ? (Object.fromEntries(Object.entries(ss.next as Record<string, unknown>).map(([k, v]) => [k, str(v)])) as ItemStep["next"]) : undefined;
        return { say: say(ss.say), ...(next && Object.keys(next).length ? { next } : {}) };
      }),
      handoff: h ? { category: str(h.category) || undefined, error_code: str(h.error_code) || undefined, pic: str(h.pic) || undefined, ask_customer: strList(h.ask_customer) } : undefined,
      source: str(o.source) || undefined,
      advanced: adv,
    });
  }
  if (!items.length) issues.push({ level: "error", message: "tài liệu chưa có mục hỏi đáp nào (items)" });
  const doc: ItemsDoc = { topic, title: str(r.title) || ITEM_TOPICS[topic] || topic, items };
  issues.push(...validateItemsDoc(doc));
  return { doc, issues };
}

/**
 * Luật cho từng mục, viết để người không rành kỹ thuật đọc hiểu. Luật cần nhìn toàn kho (cụm trùng với tài liệu khác,
 * distinct_from trỏ tới mục ở tài liệu khác, bị bot trả lời nhầm) chạy ở kb/service.ts lúc kiểm tra bản nháp.
 */
export function validateItemsDoc(doc: ItemsDoc): ParseIssue[] {
  const out: ParseIssue[] = [];
  const err = (id: string, message: string) => out.push({ level: "error", templateId: id, message });
  const warn = (id: string, message: string) => out.push({ level: "warning", templateId: id, message });
  const ids = new Set<string>();
  const phraseOwner = new Map<string, string>();
  for (const it of doc.items) {
    if (!ID_RE.test(it.id) || it.id.includes("--")) err(it.id, "mã mục chỉ gồm chữ thường, số, gạch ngang (không có \"--\")");
    if (ids.has(it.id)) err(it.id, "trùng mã mục trong cùng tài liệu");
    ids.add(it.id);
    if (!it.title) err(it.id, "thiếu tên mục");
    if (!["answer", "handoff", "system"].includes(it.kind)) err(it.id, `loại mục không hợp lệ: ${it.kind}`);
    const adv = it.advanced ?? {};
    const hasCodeMatch = !!(adv.exact?.length || adv.rules?.length || adv.image_types?.length);

    if (it.kind !== "handoff" && !it.steps.length) err(it.id, "chưa có câu trả lời (bước 1)");
    for (const [i, s] of it.steps.entries()) {
      if (!s.say.en) err(it.id, `bước ${i + 1} thiếu câu trả lời tiếng Anh (bản gốc)`);
      for (const [kind, target] of Object.entries(s.next ?? {})) {
        if (!(FOLLOW_UP_KINDS as readonly string[]).includes(kind)) err(it.id, `bước ${i + 1}: loại phản hồi không có: ${kind}`);
        if (target === "next" && i === it.steps.length - 1) err(it.id, `bước ${i + 1} trỏ tới "bước kế tiếp" nhưng đây là bước cuối`);
        if (!target) err(it.id, `bước ${i + 1}: thiếu đích cho phản hồi "${kind}"`);
      }
    }
    if (it.kind === "handoff" && it.steps.length) warn(it.id, "mục chuyển nhân viên dùng câu chuyển nhân viên chuẩn — các bước khai báo sẽ bị bỏ qua");

    if (it.kind !== "system") {
      if (!it.questions.length && !hasCodeMatch) err(it.id, "chưa có cách hỏi nào của khách (questions)");
      else if (it.questions.length < 3 && !hasCodeMatch) warn(it.id, `mới có ${it.questions.length} cách hỏi — nên có ít nhất 3 câu khách hay hỏi, diễn đạt khác nhau`);
    }
    for (const p of it.phrases) {
      const n = normalize(p);
      if (wordCount(n) < 2) err(it.id, `cụm nhận biết "${p}" chỉ có một từ — từ đơn khớp cả những câu hỏi về việc khác; dùng cụm ≥ 2 từ hoặc chuyển thành câu hỏi`);
      const owner = phraseOwner.get(n);
      if (owner && owner !== it.id) err(it.id, `cụm nhận biết "${p}" trùng với mục ${owner}`);
      phraseOwner.set(n, it.id);
    }
    for (const d of it.distinct_from) {
      if (!d.item) err(it.id, "khai báo \"khác với mục\" nhưng thiếu mã mục");
      if (d.item === it.id) err(it.id, "không thể khai báo khác với chính nó");
      if (!d.difference) err(it.id, `khác với ${d.item}: thiếu mô tả khác nhau ở điểm nào`);
      if (!d.clarify) err(it.id, `khác với ${d.item}: thiếu câu hỏi lại khách khi không phân biệt được`);
    }
  }
  return out;
}

const compileTarget = (itemId: string, stepIndex: number, target: StepTarget): string | undefined => {
  if (target === "handoff") return "ESCALATE";
  if (target === "next") return stepTemplateId(itemId, stepIndex + 1);
  const m = /^([a-z0-9][a-z0-9-]*)(?:#(\d+))?$/.exec(target);
  if (!m) return undefined;
  return stepTemplateId(m[1]!, m[2] ? Math.max(0, Number(m[2]) - 1) : 0);
};

/**
 * Dịch mục hỏi đáp sang Template đang chạy. Bước 1 mang toàn bộ điều kiện khớp; bước n chỉ tới được qua tin nối tiếp (không
 * có điều kiện khớp nên không bao giờ được tìm thấy bằng câu hỏi). Mục chuyển nhân viên dùng câu chuyển nhân viên chuẩn
 * (answer_from fp-12-escalate — code nhận ra đây là lối tắt chuyển nhân viên, xem core/followup.ts isEscalationTemplate).
 */
export function compileItems(doc: ItemsDoc): Template[] {
  const out: Template[] = [];
  for (const it of doc.items) {
    const adv = it.advanced ?? {};
    const ticket = it.handoff && (it.handoff.category || it.handoff.error_code || it.handoff.pic) ? { category: it.handoff.category, error_code: it.handoff.error_code, pic: it.handoff.pic } : undefined;
    const requiredInfo = it.handoff?.ask_customer?.length ? it.handoff.ask_customer : undefined;
    const context = { issue: adv.issue ?? it.title, status: adv.status ?? (it.kind === "answer" ? ("pending" as const) : ("none" as const)) };
    const steps = it.kind === "handoff" ? [] : it.steps;
    const meta = (step: number): ItemMeta => ({ id: it.id, title: it.title, topic: doc.topic, kind: it.kind, step, steps: Math.max(1, steps.length), applies_when: it.applies_when, distinct_from: it.distinct_from });
    const followUp = (i: number) => {
      const f: Record<string, string> = {};
      for (const [kind, target] of Object.entries(steps[i]?.next ?? {})) {
        const t = target ? compileTarget(it.id, i, target) : undefined;
        if (t) f[kind] = t;
      }
      return f;
    };
    out.push({
      id: it.id,
      group: doc.topic,
      response_mode: adv.response_mode ?? "EXACT_TEMPLATE",
      priority: ITEM_PRIORITY,
      match: {
        keywords: it.phrases,
        exact: adv.exact ?? [],
        examples: it.questions,
        image_types: adv.image_types ?? [],
        rules: adv.rules ?? [],
        requires: adv.requires ?? [],
        excludes: adv.excludes ?? [],
        overrides_context: !!adv.overrides_context,
      },
      answers: it.kind === "handoff" ? {} : { ...(steps[0]?.say ?? {}) },
      ...(it.kind === "handoff" ? { answer_from: ESCALATE_TEMPLATE_ID } : {}),
      follow_up: followUp(0),
      sets_context: context,
      ...(ticket ? { ticket } : {}),
      ...(requiredInfo ? { required_info: requiredInfo } : {}),
      ...(it.source ? { source: it.source } : {}),
      item: meta(0),
    });
    for (let i = 1; i < steps.length; i++) {
      out.push({
        id: stepTemplateId(it.id, i),
        group: doc.topic,
        response_mode: "EXACT_TEMPLATE",
        priority: ITEM_PRIORITY,
        match: { keywords: [], exact: [], examples: [], image_types: [], rules: [], requires: [], excludes: [], overrides_context: false },
        answers: { ...steps[i]!.say },
        follow_up: followUp(i),
        sets_context: context,
        ...(ticket ? { ticket } : {}),
        ...(requiredInfo ? { required_info: requiredInfo } : {}),
        item: meta(i),
      });
    }
  }
  return out;
}

/** Ghi tài liệu chủ đề ra YAML theo thứ tự khoá cố định (bản nháp từ form Admin Web, script chuyển dữ liệu). */
export function itemsDocToYaml(doc: ItemsDoc): string {
  const items = doc.items.map((it) => {
    const o: Record<string, unknown> = { id: it.id, title: it.title, kind: it.kind };
    if (it.questions.length) o.questions = it.questions;
    if (it.phrases.length) o.phrases = it.phrases;
    if (it.applies_when) o.applies_when = it.applies_when;
    if (it.distinct_from.length) o.distinct_from = it.distinct_from;
    if (it.steps.length) o.steps = it.steps.map((s) => ({ say: Object.keys(s.say).length === 1 && s.say.en ? s.say.en : s.say, ...(s.next && Object.keys(s.next).length ? { next: s.next } : {}) }));
    if (it.handoff) o.handoff = Object.fromEntries(Object.entries(it.handoff).filter(([, v]) => (Array.isArray(v) ? v.length : v)));
    if (it.source) o.source = it.source;
    if (it.advanced && Object.keys(it.advanced).length) o.advanced = it.advanced;
    return o;
  });
  return stringifyYaml({ topic: doc.topic, title: doc.title, items }, { lineWidth: 0 });
}
