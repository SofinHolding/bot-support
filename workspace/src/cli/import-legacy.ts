/**
 * Sinh khung kho template (content/templates/*.md) từ luật cũ. Chạy MỘT LẦN khi chuyển hệ thống.
 * Sau đó content/ là nguồn sự thật, sửa trực tiếp; script `parity` vẫn đối chiếu với legacy/ để chắc chắn
 * không câu trả lời cố định nào bị thiếu hoặc sai lệch.
 *
 *   npx tsx src/cli/import-legacy.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { extractAgentsExtras, extractImageReaderExtras, extractLegacyAnswers } from "./legacy-parse";
import { templatesToMarkdown } from "../core/templates";
import { normalize } from "../core/text";
import {
  ESCALATE_TEMPLATE_ID, GREETING_RETURNING_ID, GREETING_TEMPLATE_ID, HIGH_TRAFFIC_TEMPLATE_ID,
  IMAGE_COVER_SECRET_ID, IMAGE_UNREADABLE_ID, SECURITY_TEMPLATE_ID, THANKS_TEMPLATE_ID,
  type Template,
} from "../domain/types";

const AGENTS = "legacy/AGENTS.md";
const SKILL = "legacy/skills/interlink-support/SKILL.md";
const IMAGE_SKILL = "legacy/skills/image-reader/SKILL.md";
const OUT = "content/templates";

function blank(id: string, group: string, answer: string, extra: Partial<Template> = {}): Template {
  return {
    id, group, response_mode: "EXACT_TEMPLATE", priority: 0,
    match: { keywords: [], exact: [], examples: [], image_types: [], rules: [], requires: [], excludes: [], overrides_context: false },
    answers: { en: answer }, follow_up: {}, sets_context: { status: "pending" }, ...extra,
  };
}

const uniq = (a: string[]) => [...new Set(a.map((s) => s.trim()).filter(Boolean))];
const multiword = (kw: string[]) => uniq(kw).filter((k) => normalize(k).includes(" ")).slice(0, 8);

// --- AGENTS.md FAST-PATH ---------------------------------------------------
const FP_META: Record<string, { id: string; group: string; issue: string }> = {
  "FP-1": { id: GREETING_TEMPLATE_ID, group: "Greeting", issue: "greeting" },
  "FP-2": { id: "fp-2-withdraw", group: "Withdraw", issue: "withdraw availability" },
  "FP-3": { id: "fp-3-listing-tge", group: "Listing", issue: "listing / TGE / convert question" },
  "FP-4": { id: "fp-4-itlg-burn", group: "Burn", issue: "ITLG reduced / burn question" },
  "FP-5": { id: "fp-5-how-to-kyc", group: "KYC", issue: "how to do KYC" },
  "FP-5b": { id: "fp-5b-kyc-email-queue", group: "KYC", issue: "kyc notification email pending" },
  "FP-6": { id: "fp-6-kyc-slow", group: "KYC", issue: "KYC verification delayed while waiting in curator queue" },
  "FP-6b": { id: "fp-6b-kyc-review-long", group: "KYC", issue: "KYC review taking long" },
  "FP-7": { id: "fp-7-change-email", group: "Account", issue: "Change email address" },
  "FP-8": { id: "fp-8-forgot-id", group: "Account", issue: "forgot ID" },
  "FP-9": { id: "fp-9-delete-account", group: "Account", issue: "delete account" },
  "FP-10": { id: "fp-10-change-id", group: "Account", issue: "change ID" },
  "FP-11": { id: "fp-11-ambassador", group: "Ambassador", issue: "ambassador program" },
  "FP-11b": { id: "fp-11b-campaign-10m-nft", group: "Campaign", issue: "Campaign 10M NFT not received" },
  "FP-12": { id: ESCALATE_TEMPLATE_ID, group: "Escalate", issue: "escalated to support" },
};

// --- SKILL.md ---------------------------------------------------------------
const SKILL_META: [needle: string, id: string, group: string][] = [
  ['Sau template "đổi email"', "email-old-email-required", "FollowUp"],
  ['Sau template "Got verification email', THANKS_TEMPLATE_ID, "FollowUp"],
  ["ITLG → ITL conversion", "itlg-to-itl-conversion", "Tokens"],
  ["Cách recover ITLG", "itlg-recover-after-burn", "Tokens"],
  ["giảm 50%", "itlg-mining-reduced-50", "Tokens"],
  ["Cách kiếm thêm ITLG", "itlg-earn-more", "Tokens"],
  ["Mine đều nhưng vẫn bị burn", "itlg-burn-despite-mining", "Tokens"],
  ["M03", "weekly-reward-schedule", "Tokens"],
  ["Cách login", "how-to-login", "Account"],
  ["S03", "face-scan-black-screen", "Account"],
  ["S04", "forgot-login-id", "Account"],
  ["O03", "twin-account", "Account"],
  ["Hướng dẫn đăng ký", "how-to-sign-up", "Account"],
  ["Đã match curator", "kyc-matched-not-verified", "KYC"],
  ["Cách tạo ví", "wallet-create", "Wallet"],
  ["Cách check seedphrase", "wallet-check-seedphrase", "Wallet"],
  ["Cách connect social", "wallet-connect-social", "Wallet"],
  ["Cách apply visa card", "wallet-visa-card", "Wallet"],
  ["Cách check địa chỉ ví", "wallet-address", "Wallet"],
  ["Swap A→B", "wallet-swap-token-missing", "Wallet"],
  ["Reset ví", "wallet-reset-lost", "Wallet"],
  ["Tạo group", "group-mining-create", "GroupMining"],
  ["Referral code", "referral-code", "Account"],
  ["OTP qua email", "otp-email", "Account"],
  ["OTP qua Telegram", "otp-telegram", "Account"],
  ["G01", "game-slime-cloud", "Game"],
  ["G03", "game-upgrade-max", "Game"],
  ["Câu hỏi CHUNG", "whitepaper-general", "FAQ"],
  ["HCS không cộng ở Ví", "hcs-wallet-not-added", "HCS"],
  ["Hỏi công thức HCS", "hcs-formula", "HCS"],
  ["HCS thấp", "hcs-low", "HCS"],
  ["Liên kết nhiều ví", "hcs-multiple-wallets", "HCS"],
];

/** Trigger escalate: mỗi nhóm dùng chung câu FP-12, nhưng gắn mã lỗi/PIC theo support-cases-training.md. */
const ESCALATION_TRIGGERS: { id: string; keywords: string[]; ticket: Template["ticket"]; required_info: string[] }[] = [
  { id: "esc-wallet-create", keywords: ["creating wallet failed", "wallet creation error", "tạo ví lỗi", "wallet error", "failed to create wallet", "lỗi tạo ví"], ticket: { category: "wallet" }, required_info: ["Interlink ID", "screenshot lỗi", "thời điểm lỗi"] },
  { id: "esc-token-missing", keywords: ["faucet not added", "faucet chưa cộng", "token chưa về", "token not received", "missing token", "ITL chưa về", "ITLG chưa về"], ticket: { category: "token" }, required_info: ["Interlink ID", "screenshot", "thời điểm"] },
  { id: "esc-swap", keywords: ["swap fail", "swap error", "swap không được", "swap stuck"], ticket: { error_code: "SWAP", pic: "Quang", category: "wallet" }, required_info: ["screenshot", "wallet address"] },
  { id: "esc-mining-bug", keywords: ["mining bug", "không cộng ITLG", "HHP reset"], ticket: { error_code: "M01", pic: "Quang", category: "mining" }, required_info: ["Interlink ID", "screenshot HHP/ITLG", "thời gian bị lỗi", "số lần xảy ra"] },
  { id: "esc-weekly-reward", keywords: ["weekly reward chưa nhận"], ticket: { error_code: "M03", pic: "Minh", category: "mining" }, required_info: ["Interlink ID", "screenshot", "thời gian"] },
  { id: "esc-login-fail", keywords: ["login fail", "face verify fail"], ticket: { error_code: "S02", pic: "Quang", category: "login" }, required_info: ["video scan mặt", "lỗi hiển thị"] },
  { id: "esc-forgot-password", keywords: ["quên password", "forgot password", "password reset"], ticket: { error_code: "S01", pic: "Quang", category: "login" }, required_info: ["ảnh chân dung (chị Thuỷ test trước khi Quang reset)"] },
  { id: "esc-game-bug", keywords: ["score not added", "điểm chưa cộng", "submit fail"], ticket: { error_code: "G02", pic: "Minh", category: "game" }, required_info: ["video", "thời gian"] },
  { id: "esc-hcs-app", keywords: ["HCS not added", "HCS không cộng", "HCS không tăng"], ticket: { error_code: "HCS", pic: "Quang", category: "hcs" }, required_info: ["Interlink ID", "screenshot"] },
];

function main() {
  if (!process.argv.includes("--force")) {
    console.error("content/ hiện là nguồn sự thật và có thể đã được chỉnh tay. Script này sẽ GHI ĐÈ content/templates/*.md.\nChạy lại với --force nếu bạn thực sự muốn sinh lại từ legacy/.");
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  const agents = extractLegacyAnswers(AGENTS);
  const skill = extractLegacyAnswers(SKILL);
  const extras = extractAgentsExtras(AGENTS);
  const imgExtras = extractImageReaderExtras(IMAGE_SKILL);

  const fast: Template[] = [];
  let order = 0;
  for (const a of agents) {
    const key = /^(FP-\d+b?)\./.exec(a.heading)?.[1];
    const meta = key ? FP_META[key] : undefined;
    if (!key || !meta) continue;
    const t = blank(meta.id, meta.group, a.text, {
      priority: 900 - 10 * order++,
      sets_context: { issue: meta.issue, status: "pending" },
      source: `AGENTS.md#${key}`,
    });
    t.match.keywords = uniq(a.keywords);
    t.match.examples = multiword(a.keywords);
    fast.push(t);
  }
  const byId = (id: string) => fast.find((t) => t.id === id)!;

  // --- FP-1: chào hỏi chỉ khớp khi CẢ tin nhắn là lời chào ---
  const g = byId(GREETING_TEMPLATE_ID);
  g.match.exact = ["hi", "hello", "hey", "start", "/start", "chào"];
  g.match.keywords = [];
  g.match.examples = [];
  g.sets_context = { status: "none" };
  g.follow_up = {};

  // --- FP-4 burn: "not burn" -> escalate (M02, PIC Quang) ---
  const burn = byId("fp-4-itlg-burn");
  burn.follow_up = { negative: "ESCALATE" };
  burn.ticket = { error_code: "M02", pic: "Quang", category: "mining" };

  // --- FP-5b: email KYC / màn hình queue. Ghi đè mọi ngữ cảnh cũ ---
  const k5b = byId("fp-5b-kyc-email-queue");
  k5b.priority = 990;
  k5b.match = {
    ...k5b.match,
    keywords: [],
    exact: [],
    examples: [
      "I got the verification email but the app is still in the queue",
      "got mail but in app still waiting",
      "nhận email xác minh nhưng app vẫn chờ",
      "quá trình xác minh đã sẵn sàng nhưng app vẫn pending",
      "email says upload verification documents but app shows nothing",
    ],
    image_types: ["kyc_email", "kyc_queue_screen"],
    rules: [{ all: ["mentions_kyc_email_received", "still_waiting"] }],
    overrides_context: true,
  };
  k5b.follow_up = { more_images: k5b.id, negative: "ESCALATE", thanks: THANKS_TEMPLATE_ID };

  // --- FP-6: KYC chậm. KHÔNG khớp nếu đã nhắc email KYC (FP-5b) hoặc đã xong level 1 / muốn tăng tốc (FP-6b) ---
  const k6 = byId("fp-6-kyc-slow");
  k6.match.excludes = ["mentions_kyc_email_received", "completed_level_1", "wants_speed_up", "mentions_duration_with_kyc"];

  // --- FP-6b ---
  const k6b = byId("fp-6b-kyc-review-long");
  k6b.match.keywords = uniq([
    "completed level 1", "finished level 1", "done step 1", "passed stage 1", "level 1 done", "first KYC done",
    "hoàn thành level 1", "hoàn tất KYC lần đầu", "hoàn tất thủ tục KYC lần đầu", "xong bước 1", "qua level 1",
    "waiting for next step", "next stage", "level 2", "stage 2", "bước tiếp theo", "chưa nhận được bước tiếp theo", "chưa hoàn tất lần thứ hai",
    "KYC pending", "still KYC pending", "still pending KYC", "KYC review takes long", "KYC review taking long", "KYC too long",
    "hồ sơ KYC đang xem xét", "KYC lâu quá", "quá trình KYC lâu", "tại sao KYC lâu",
    "speed up KYC", "speed up verification", "faster KYC", "expedite KYC", "push KYC faster",
    "đẩy nhanh KYC", "đẩy nhanh xác minh", "KYC nhanh hơn", "muốn nhanh KYC",
  ]);
  k6b.match.examples = ["my KYC review is taking too long", "I finished level 1 what is next", "how can I speed up my verification", "KYC đang xem xét 20 ngày rồi"];
  k6b.match.rules = [{ all: ["mentions_kyc", "mentions_duration"] }];

  // --- FP-11b ---
  const k11 = byId("fp-11b-campaign-10m-nft");
  k11.match.keywords = ["do you not own this nft"];
  k11.match.examples = ["I completed the 10M campaign but did not receive my NFT", "chưa nhận được NFT campaign 10M", "it says do you not own this NFT"];
  k11.match.rules = [{ all: ["mentions_campaign_10m", "nft_not_received"] }];

  // --- FP-12: câu escalate chung (không tự khớp; các trigger bên dưới dùng lại câu này) ---
  const esc = byId(ESCALATE_TEMPLATE_ID);
  esc.match = { keywords: [], exact: [], examples: [], image_types: [], rules: [], requires: [], excludes: [], overrides_context: false };
  esc.sets_context = { issue: "escalated to support", status: "none" };
  esc.priority = 0;

  // --- FP-8 "forgot ID" KHÁC S04 "forgot login ID" (SKILL.md ghi rõ): loại trừ để không nuốt mục S04 ---
  byId("fp-8-forgot-id").match.excludes = [{ any: ["login id", "quên login id"] }];

  // --- FP-7: sau khi bảo đổi email, "không còn email cũ" ---
  byId("fp-7-change-email").follow_up = { no_old_email: "email-old-email-required" };

  const escTriggers: Template[] = ESCALATION_TRIGGERS.map((e, i) =>
    blank(e.id, "Escalate", "", {
      priority: 760 - i,
      answers: {},
      answer_from: ESCALATE_TEMPLATE_ID,
      sets_context: { issue: e.ticket?.category ? `${e.ticket.category} issue (escalated)` : "escalated", status: "none" },
      ticket: e.ticket,
      required_info: e.required_info,
      match: { keywords: e.keywords, exact: [], examples: multiword(e.keywords), image_types: [], rules: [], requires: [], excludes: [], overrides_context: false },
      source: "AGENTS.md#FP-12",
    }),
  );
  const errorImage = blank("esc-app-error-image", "Escalate", "", {
    priority: 750,
    answers: {},
    answer_from: ESCALATE_TEMPLATE_ID,
    sets_context: { issue: "app error from screenshot", status: "none" },
    ticket: { category: "app-error" },
    required_info: ["screenshot lỗi", "thời điểm", "bước đang thao tác"],
    match: { keywords: [], exact: [], examples: [], image_types: ["error_dialog"], rules: [], requires: [], excludes: [], overrides_context: false },
    source: "AGENTS.md#FP-12 (ảnh báo lỗi trong app)",
  });

  // --- SKILL ---
  const seenText = new Map<string, string>(); // text -> id
  for (const t of fast) seenText.set(t.answers.en!, t.id);
  const skillTemplates: Template[] = [];
  let sOrder = 0;
  for (const a of skill) {
    const meta = SKILL_META.find(([needle]) => a.heading.includes(needle));
    if (!meta) {
      // Mục trùng câu trả lời với FAST-PATH (KYC email, escalate chung): đã được khai báo tường minh ở trên.
      if (!seenText.get(a.text)) console.warn("SKILL: không có id cho mục:", a.heading);
      continue;
    }
    const [, id, group] = meta;
    const dup = seenText.get(a.text);
    if (dup && id !== THANKS_TEMPLATE_ID) continue;
    let keywords = uniq(a.keywords);
    if (!keywords.length) keywords = uniq([...a.heading.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));
    const isFollowUp = group === "FollowUp";
    const t = blank(id, group, a.text, {
      priority: isFollowUp ? 0 : 500 - sOrder++,
      sets_context: id === THANKS_TEMPLATE_ID ? { status: "resolved" } : { issue: a.heading.replace(/\s*\(.*$/, "").replace(/^[A-Z]\d\d — /, ""), status: isFollowUp ? "none" : "pending" },
      source: `SKILL.md L${a.line}`,
    });
    if (!isFollowUp) {
      t.match.keywords = keywords;
      t.match.examples = multiword(keywords);
    }
    seenText.set(a.text, id);
    skillTemplates.push(t);
  }
  const sk = (id: string) => skillTemplates.find((t) => t.id === id)!;

  // Follow-up gắn vào template gốc
  sk("otp-email").follow_up = { not_receive: "ESCALATE", negative: "ESCALATE" };
  sk("weekly-reward-schedule").ticket = { error_code: "M03", pic: "Minh", category: "mining" };
  sk("weekly-reward-schedule").follow_up = { negative: "ESCALATE" };
  sk("wallet-swap-token-missing").follow_up = { info_provided: "ESCALATE" };
  sk("wallet-swap-token-missing").ticket = { error_code: "SWAP", pic: "Quang", category: "wallet" };
  sk("forgot-login-id").follow_up = { info_provided: "ESCALATE" };
  // Từ khoá "forgot ID" trong ngoặc của SKILL.md chỉ là ghi chú phân biệt với FP-8, không phải từ khoá của S04.
  sk("forgot-login-id").match.keywords = sk("forgot-login-id").match.keywords.filter((k) => !/^forgot ID$/i.test(k));
  sk("forgot-login-id").match.rules = [{ all: ["mentions_forgot", "mentions_login_id"] }];
  sk("forgot-login-id").match.examples = sk("forgot-login-id").match.examples.filter((k) => !/^forgot ID$/i.test(k));
  sk("forgot-login-id").ticket = { error_code: "S04", pic: "Anh Đạt", category: "login" };
  sk("face-scan-black-screen").ticket = { error_code: "S03", category: "login" };
  sk("game-slime-cloud").ticket = { error_code: "G01", category: "game" };
  sk("game-upgrade-max").ticket = { error_code: "G03", category: "game" };
  sk("twin-account").ticket = { error_code: "O03", category: "account" };
  // Ghi chú: "ITLG → ITL conversion" của SKILL trùng từ khoá với FP-3 (convert ITLG). AGENTS.md quy định FAST-PATH được
  // khớp trước, nên mục này chỉ đạt được bằng câu chữ tiếng Việt; giữ lại đủ nội dung, ưu tiên thấp hơn FP-3.
  sk("itlg-to-itl-conversion").match.keywords = sk("itlg-to-itl-conversion").match.keywords.filter((k) => !/^convert ITLG to ITL$/i.test(k));

  // --- Câu hệ thống ---
  const sys: Template[] = [];
  const x = (key: string) => extras.find((e) => e.key === key)!.text;
  sys.push(blank(SECURITY_TEMPLATE_ID, "Security", x("fp-0"), { response_mode: "SECURITY_RULE", sets_context: { issue: "security-alert-key-leak", status: "none" }, source: "AGENTS.md#FP-0" }));
  sys.push(blank("fp-0-owner-notice", "Security", x("fp-0-owner-notice"), { response_mode: "SECURITY_RULE", sets_context: { status: "none" }, source: "AGENTS.md#FP-0 (thông báo cho owner)" }));
  sys.push(blank("admin-console-moved", "System", "Admin Console đã chuyển sang web: {URL}\nXem Hội thoại (thay /contexts) và Usage (thay /usage) trên trang quản trị.", { sets_context: { status: "none" }, source: "mới (thay lệnh /contexts, /usage)" }));
  sys.push(blank(GREETING_RETURNING_ID, "Greeting", x("greeting-returning"), { sets_context: { status: "none" }, source: "AGENTS.md#Lời chào" }));
  sys.push(blank(HIGH_TRAFFIC_TEMPLATE_ID, "System", x("high-traffic"), { sets_context: { status: "none" }, source: "AGENTS.md#Error Handling" }));
  for (const [k, id] of [["image-unreadable", IMAGE_UNREADABLE_ID], ["image-cover-secret", IMAGE_COVER_SECRET_ID]] as const) {
    const e = imgExtras.find((i) => i.key === k)!;
    sys.push(blank(id, "Image", e.text, { sets_context: { status: "none" }, source: "image-reader/SKILL.md" }));
  }
  for (const level of ["1", "2", "3", "4", "5", "6", "7plus"]) {
    sys.push(blank(`antispam-${level}`, "AntiSpam", x(`antispam-${level}`), { response_mode: "SECURITY_RULE", sets_context: { status: "none" }, source: "AGENTS.md#Anti-Spam" }));
  }

  const write = (name: string, list: Template[]) => writeFileSync(`${OUT}/${name}.md`, templatesToMarkdown(list), "utf8");
  write("fast-path", [...fast, ...escTriggers, errorImage]);
  const groups = new Map<string, Template[]>();
  for (const t of skillTemplates) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
  for (const [gname, list] of groups) write(gname.toLowerCase(), list);
  write("system", sys);
  console.log(`Đã ghi: fast-path (${fast.length + escTriggers.length + 1}), ${[...groups].map(([g, l]) => `${g}(${l.length})`).join(", ")}, system (${sys.length})`);
}

main();
