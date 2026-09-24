/**
 * Chuyển template của hệ thống cũ sang "mục hỏi đáp" (src/core/items.ts) — CHỈ dùng lại NỘI DUNG, không giữ cách tổ chức cũ.
 * Hàm thuần: nhận template đang publish, trả về các tài liệu chủ đề + nhật ký mọi chỗ phải đổi để người duyệt xem lại.
 *
 * Luật chuyển (docs/KIEN_TRUC_KIEN_THUC.md, mục "Chuyển dữ liệu cũ"):
 *  - Giữ NGUYÊN id: code, bản dịch đã duyệt, bộ câu kiểm tra đều gọi theo id.
 *  - Câu mẫu (examples) -> cách hỏi (questions). Từ khoá nhiều từ -> cụm nhận biết (phrases). Từ khoá MỘT từ bị bỏ
 *    (nguyên nhân chính của việc trả lời nhầm, vd "ambassador") và ghi vào nhật ký.
 *  - Mục có ít hơn 3 cách hỏi: thêm các cụm từ khoá nhiều từ làm cách hỏi tạm, ghi nhật ký để người duyệt viết lại thành câu.
 *  - Độ ưu tiên số bị bỏ (mọi mục ngang nhau; mục dễ lẫn phải khai báo "khác với").
 *  - Tin nối tiếp (follow_up) -> bước. Template CHỈ tới được qua tin nối tiếp của đúng một template khác (không có điều kiện
 *    khớp, code không gọi theo id) trở thành bước kế tiếp của template đó — id đổi sang "<id>--bN", ghi nhật ký để chép bản dịch.
 *  - Lối tắt chuyển nhân viên (answer_from câu chuyển nhân viên chuẩn) -> kind handoff.
 *  - Luật bảo mật, chống spam, tin do code gửi, template không có điều kiện khớp -> kind system, nội dung giữ nguyên từng chữ.
 *  - answer_from trỏ tới câu trả lời khác (không phải chuyển nhân viên) -> chép nguyên câu trả lời đó vào mục.
 *  - Điều kiện kỹ thuật (exact, rules, requires, excludes, loại ảnh, ghi đè ngữ cảnh) giữ nguyên trong `advanced`.
 */
import { ESCALATE_TEMPLATE_ID, type Template } from "../domain/types";
import { ITEM_TOPICS, type ItemAdvanced, type ItemsDoc, type ItemStep, type KnowledgeItem, type StepTarget } from "../core/items";
import type { FollowUpKind } from "../core/followup";
import { normalize, wordCount } from "../core/text";

/** Nhóm của hệ thống cũ -> chủ đề mới. Nhóm không có ở đây -> "general" (ghi nhật ký). */
export const GROUP_TOPIC: Record<string, string> = {
  Greeting: "greeting",
  FollowUp: "greeting",
  Account: "account",
  KYC: "kyc",
  Tokens: "itlg",
  Burn: "itlg",
  Listing: "itlg",
  Withdraw: "itlg",
  Wallet: "wallet",
  HCS: "hcs",
  Game: "game",
  GroupMining: "mining",
  Ambassador: "programs",
  Campaign: "programs",
  FAQ: "general",
  Escalate: "support",
  AntiSpam: "system",
  Security: "system",
  System: "system",
  Image: "system",
};

/** Nhóm mà mọi template trong đó là tin hệ thống (code gửi, không sửa qua form). */
const SYSTEM_GROUPS = new Set(["AntiSpam", "Security", "System", "Image"]);

export interface MigrationNote {
  id: string;
  /** loại việc người duyệt cần xem: bỏ từ đơn, thêm cách hỏi tạm, gộp bước, đổi id, chép câu trả lời... */
  what: string;
  detail: string;
}

export interface MigrationResult {
  docs: ItemsDoc[];
  notes: MigrationNote[];
  /** id cũ -> id mới (chỉ các template thành bước của mục khác): dùng để chép bản dịch đã duyệt và câu kiểm tra */
  renamed: Record<string, string>;
}

const hasMatch = (t: Template) => !!(t.match.keywords.length || t.match.examples.length || t.match.exact.length || t.match.rules.length || t.match.image_types.length);

export function migrateTemplates(templates: Template[], opts: { titles?: Record<string, string>; codeIds?: Set<string> } = {}): MigrationResult {
  const notes: MigrationNote[] = [];
  const note = (id: string, what: string, detail: string) => notes.push({ id, what, detail });
  const byId = new Map(templates.map((t) => [t.id, t]));
  const codeIds = opts.codeIds ?? new Set<string>();

  // Ai trỏ tới ai qua tin nối tiếp
  const referrers = new Map<string, string[]>();
  for (const t of templates) for (const target of Object.values(t.follow_up)) if (target !== "ESCALATE") referrers.set(target, [...(referrers.get(target) ?? []), t.id]);
  // Template thành bước của mục khác: không có điều kiện khớp, không phải tin hệ thống code gọi, đúng một template trỏ tới
  // (mỗi template chỉ có MỘT bước con; có nhiều ứng viên thì chỉ ứng viên đầu thành bước, còn lại giữ là mục riêng)
  const stepOf = new Map<string, string>();
  const childOf = new Map<string, string>();
  for (const t of templates) {
    const refs = [...new Set(referrers.get(t.id) ?? [])];
    if (refs.length !== 1 || hasMatch(t) || codeIds.has(t.id) || t.response_mode !== "EXACT_TEMPLATE" || t.answer_from || refs[0] === t.id) continue;
    const parent = refs[0]!;
    if (childOf.has(parent)) {
      note(t.id, "không gộp được bước", `${parent} đã có bước kế tiếp là ${childOf.get(parent)}; ${t.id} giữ là mục riêng`);
      continue;
    }
    childOf.set(parent, t.id);
    stepOf.set(t.id, parent);
  }

  const answerOf = (t: Template): Record<string, string> => {
    let cur = t;
    for (let i = 0; i < 5 && cur.answer_from && cur.answer_from !== ESCALATE_TEMPLATE_ID; i++) cur = byId.get(cur.answer_from) ?? cur;
    return { ...cur.answers };
  };

  const renamed: Record<string, string> = {};
  const byTopic = new Map<string, KnowledgeItem[]>();
  const usedPhrases = new Map<string, string>();

  for (const t of templates) {
    if (stepOf.has(t.id)) continue; // đi cùng mục chứa nó
    const isHandoff = t.answer_from === ESCALATE_TEMPLATE_ID && t.id !== ESCALATE_TEMPLATE_ID;
    const isSystem = !isHandoff && (SYSTEM_GROUPS.has(t.group) || t.response_mode !== "EXACT_TEMPLATE" || !hasMatch(t) || t.id === ESCALATE_TEMPLATE_ID);
    const kind: KnowledgeItem["kind"] = isHandoff ? "handoff" : isSystem ? "system" : "answer";
    const topic = GROUP_TOPIC[t.group] ?? "general";
    if (!GROUP_TOPIC[t.group]) note(t.id, "chủ đề", `nhóm cũ "${t.group}" không có trong bảng chuyển, xếp vào "Giới thiệu dự án"`);
    const title = opts.titles?.[t.id] ?? t.sets_context.issue ?? t.id;

    // ---- cách hỏi và cụm nhận biết ----
    const questions = [...t.match.examples];
    const phrases: string[] = [];
    const single: string[] = [];
    for (const k of t.match.keywords) {
      const n = normalize(k);
      if (wordCount(n) < 2) {
        single.push(k);
        continue;
      }
      const owner = usedPhrases.get(n);
      if (owner) {
        note(t.id, "bỏ cụm trùng", `"${k}" đã là cụm nhận biết của ${owner}`);
        continue;
      }
      usedPhrases.set(n, t.id);
      phrases.push(k);
    }
    if (single.length) note(t.id, "bỏ từ khoá một từ", single.map((s) => `"${s}"`).join(", "));
    const codeMatched = !!(t.match.exact.length || t.match.rules.length || t.match.image_types.length);
    if (kind !== "system" && questions.length < 3 && (!codeMatched || questions.length > 0)) {
      const extra = phrases.filter((p) => !questions.some((q) => normalize(q) === normalize(p))).slice(0, 3 - questions.length);
      if (extra.length) {
        questions.push(...extra);
        note(t.id, "cách hỏi tạm", `thêm ${extra.map((e) => `"${e}"`).join(", ")} làm cách hỏi — cần viết lại thành câu khách hay hỏi`);
      }
      if (questions.length < 3) note(t.id, "thiếu cách hỏi", `mới có ${questions.length} cách hỏi — cần bổ sung cho đủ 3`);
    }

    // ---- các bước ----
    const steps: ItemStep[] = [];
    const pushStep = (cur: Template) => {
      const say = cur === t ? (isHandoff ? {} : answerOf(cur)) : answerOf(cur);
      if (cur !== t && cur.answer_from && cur.answer_from !== ESCALATE_TEMPLATE_ID) note(cur.id, "chép câu trả lời", `câu trả lời lấy từ ${cur.answer_from} (hệ thống mới không trỏ sang mục khác)`);
      const next: Partial<Record<FollowUpKind, StepTarget>> = {};
      for (const [k, target] of Object.entries(cur.follow_up)) {
        if (target === "ESCALATE") next[k as FollowUpKind] = "handoff";
        else if (stepOf.get(target) === cur.id) next[k as FollowUpKind] = "next";
        else next[k as FollowUpKind] = target;
      }
      steps.push({ say, ...(Object.keys(next).length ? { next } : {}) });
    };
    pushStep(t);
    // nối các bước con theo chuỗi
    for (let child = childOf.get(t.id), guard = 0; child && guard < 10; child = childOf.get(child), guard++) {
      pushStep(byId.get(child)!);
      renamed[child] = `${t.id}--b${steps.length}`;
      note(child, "thành bước", `thành bước ${steps.length} của ${t.id} (id mới ${renamed[child]}) — chép bản dịch đã duyệt sang id mới`);
    }
    if (isHandoff) steps.length = 0;
    if (!isHandoff && t.answer_from && t.answer_from !== ESCALATE_TEMPLATE_ID) note(t.id, "chép câu trả lời", `câu trả lời lấy từ ${t.answer_from} (hệ thống mới không trỏ sang mục khác)`);

    // ---- điều kiện kỹ thuật giữ nguyên ----
    const adv: ItemAdvanced = {};
    if (t.match.exact.length) adv.exact = t.match.exact;
    if (t.match.rules.length) adv.rules = t.match.rules;
    if (t.match.requires.length) adv.requires = t.match.requires;
    if (t.match.excludes.length) adv.excludes = t.match.excludes;
    if (t.match.image_types.length) adv.image_types = t.match.image_types;
    if (t.match.overrides_context) adv.overrides_context = true;
    if (t.response_mode !== "EXACT_TEMPLATE") adv.response_mode = t.response_mode;
    if (t.sets_context.issue && t.sets_context.issue !== title) adv.issue = t.sets_context.issue;
    const defaultStatus = kind === "answer" ? "pending" : "none";
    if (t.sets_context.status !== defaultStatus) adv.status = t.sets_context.status;

    const handoff = t.ticket || t.required_info?.length ? { category: t.ticket?.category, error_code: t.ticket?.error_code, pic: t.ticket?.pic, ask_customer: t.required_info ?? [] } : undefined;
    const item: KnowledgeItem = {
      id: t.id,
      title,
      kind,
      questions: kind === "system" && !questions.length ? [] : questions,
      phrases,
      distinct_from: [],
      steps,
      ...(handoff ? { handoff } : {}),
      source: t.source ?? "legacy",
      ...(Object.keys(adv).length ? { advanced: adv } : {}),
    };
    byTopic.set(topic, [...(byTopic.get(topic) ?? []), item]);
  }

  const docs = [...byTopic.entries()].map(([topic, items]) => ({ topic, title: ITEM_TOPICS[topic] ?? topic, items }));
  return { docs, notes, renamed };
}
