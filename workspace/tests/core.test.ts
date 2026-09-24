import { beforeAll, describe, expect, it } from "vitest";
import { applyOfftopic, blockDurationMs, isBlocked, newAntispamState } from "../src/core/antispam";
import { buildIndex, loadContentDir, type ContentBundle } from "../src/core/bundle";
import { detectLanguage, explicitLanguageRequest, resolveLanguage } from "../src/core/language";
import { makeInput } from "../src/core/predicates";
import { detectKeyLeak, maskSensitive } from "../src/core/sanitize";
import { DEFAULT_ROUTER_SETTINGS, route, type RouteContext, type RouterDeps } from "../src/core/router";
import { LlmUnavailableError, type LlmPort } from "../src/core/ports";
import type { VisionResult } from "../src/domain/types";
import { ESCALATE_TEMPLATE_ID } from "../src/domain/types";
import type { TemplateIndex } from "../src/core/template-index";
import { normalize } from "../src/core/text";

let bundle: ContentBundle;
let index: TemplateIndex;
let deps: RouterDeps;

beforeAll(async () => {
  bundle = loadContentDir("content");
  index = await buildIndex(bundle);
  deps = { index, evaluator: bundle.evaluator, settings: { ...DEFAULT_ROUTER_SETTINGS, urlHostWhitelist: new Set(["drive.google.com", "x.com"]) } };
});

async function ask(text: string, opts: { last?: string; vision?: Partial<VisionResult>; image?: boolean; llm?: LlmPort; sticker?: boolean; pendingIssue?: string; parentEscalatedGroup?: string } = {}) {
  const ctx: RouteContext = { lastTemplate: opts.last ? index.get(opts.last) : undefined, pendingIssue: opts.pendingIssue, parentEscalatedGroup: opts.parentEscalatedGroup };
  const vision = opts.vision ? ({ screen_type: "app_screen", error_text: "", has_secret: false, readable: true, ...opts.vision } as VisionResult) : undefined;
  return route({ text, norm: normalize(text), lang: "en", vision, hasImage: !!opts.image || !!vision, isSticker: !!opts.sticker, ctx }, { ...deps, llm: opts.llm });
}
const tpl = (r: Awaited<ReturnType<typeof ask>>) => (r.outcome.kind === "TEMPLATE" ? r.outcome.templateId : r.outcome.kind);

describe("kho nội dung", () => {
  it("nạp sạch, không lỗi cấu trúc", () => {
    const errors = bundle.issues.filter((i) => i.level === "error");
    expect(errors).toEqual([]);
    expect(bundle.templates.length).toBeGreaterThan(60);
  });
});

describe("FP-0: lộ private key / seed phrase", () => {
  it("nhận diện pattern A (lệnh /wallet kiểu scam)", () => {
    expect(detectKeyLeak("/wallet 0xAbCdEf0123456789abcdef0123456789abcdef01")).toBe("A");
    expect(detectKeyLeak("import wallet 0x" + "a".repeat(40))).toBe("A");
    expect(detectKeyLeak("/wallet abandon ability able about above absent absorb abstract absurd abuse access accident")).toBe("A");
  });
  it("nhận diện pattern B (khoá đứng độc lập)", () => {
    expect(detectKeyLeak("0x" + "1".repeat(64))).toBe("B");
    expect(detectKeyLeak("0x" + "a".repeat(40))).toBe("B");
    expect(detectKeyLeak("5J" + "a".repeat(49))).toBe("B");
  });
  it("nhận diện pattern C (seed phrase BIP39)", () => {
    expect(detectKeyLeak("abandon ability able about above absent absorb abstract absurd abuse access accident")).toBe("C");
    expect(detectKeyLeak("my seed is abandon ability able about above absent absorb abstract absurd abuse access accident thanks")).toBe("C");
  });
  it("không báo nhầm câu hỏi bình thường", () => {
    expect(detectKeyLeak("how to withdraw my ITLG please help me with this issue")).toBeNull();
    expect(detectKeyLeak("please check wallet address 0x" + "a".repeat(40) + " for me")).toBeNull();
    expect(detectKeyLeak("KYC pending 20 days")).toBeNull();
  });
  it("seed có dấu phẩy, đánh số hoặc viết hoa vẫn bị phát hiện và che", () => {
    const words = "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ");
    const comma = words.join(", ");
    const numbered = words.map((w, i) => `${i + 1}. ${w}`).join(" ");
    const caps = "Abandon Ability " + words.slice(2).join(" ");
    for (const s of [comma, numbered, caps, "my seed: " + comma + ". please help"]) {
      expect(detectKeyLeak(s), s).toBe("C");
      expect(maskSensitive(s), s).toContain("[REDACTED_SEED]");
      expect(maskSensitive(s)).not.toContain("absorb");
    }
    expect(detectKeyLeak("1. open the app 2. go to wallet 3. press create and wait for the screen")).toBeNull();
  });

  it("che khoá/seed/mật khẩu/số dài trước khi lưu", () => {
    const seed = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    expect(maskSensitive(seed)).toBe("[REDACTED_SEED]");
    expect(maskSensitive("key 0x" + "a".repeat(64))).toBe("key [REDACTED_KEY]");
    expect(maskSensitive("password: hunter2")).toContain("[REDACTED]");
    expect(maskSensitive("my id is 123456789012")).toBe("my id is [NUMBER]");
    expect(maskSensitive("mail a.b@c.com")).toBe("mail [EMAIL]");
  });
});

describe("anti-spam: bậc thang chặn", () => {
  it("1-2 chỉ cảnh báo; 3=1m; 4=10m; 5=30m; 6=1h; 7+=24h", () => {
    const min = 60_000;
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(blockDurationMs)).toEqual([0, 0, min, 10 * min, 30 * min, 60 * min, 24 * 60 * min, 24 * 60 * min]);
  });
  it("chuỗi vi phạm dùng đúng câu cảnh báo và đặt thời điểm hết chặn", () => {
    let s = newAntispamState(new Date(0));
    const now = new Date("2026-01-01T00:00:00Z");
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const o = applyOfftopic(s, now);
      ids.push(o.templateId);
      s = o.state;
    }
    expect(ids).toEqual(["antispam-1", "antispam-2", "antispam-3", "antispam-4", "antispam-5", "antispam-6", "antispam-7plus", "antispam-7plus"]);
    expect(isBlocked(s, now)).toBe(true);
    expect(isBlocked(s, new Date(now.getTime() + 24 * 3600_000 + 1))).toBe(false);
  });
});

describe("ngôn ngữ", () => {
  it("nhận diện theo tin hiện tại", () => {
    expect(detectLanguage("tôi không nhận được email")).toBe("vi");
    expect(detectLanguage("how do I change my email please")).toBe("en");
    expect(detectLanguage("我的账户有问题")).toBe("zh");
    expect(detectLanguage("안녕하세요 도와주세요")).toBe("ko");
    expect(detectLanguage("こんにちは、助けてください")).toBe("ja");
    expect(detectLanguage("помогите пожалуйста")).toBe("ru");
    expect(detectLanguage("مرحبا أحتاج مساعدة")).toBe("ar");
    expect(detectLanguage("ok")).toBeNull();
    expect(detectLanguage("👍")).toBeNull();
  });
  it("tin quá ngắn dùng ngôn ngữ đã lưu, mặc định en", () => {
    expect(resolveLanguage("ok", "vi")).toEqual({ lang: "vi", update: false });
    expect(resolveLanguage("ok", null)).toEqual({ lang: "en", update: false });
  });
  it("đổi ngôn ngữ khi tin mới khác ngôn ngữ đã lưu, và khi khách yêu cầu rõ", () => {
    expect(resolveLanguage("how can I withdraw my tokens", "vi")).toEqual({ lang: "en", update: true });
    expect(explicitLanguageRequest("can you speak Vietnamese?")).toBe("vi");
    expect(explicitLanguageRequest("请用中文")).toBe("zh");
    expect(resolveLanguage("can you speak Vietnamese?", "en")).toEqual({ lang: "vi", update: true });
  });
});

describe("router: FAST-PATH nguyên văn", () => {
  const answerOf = (id: string) => index.get(id)!.answers.en;

  it("FP-1 chỉ khi CẢ tin là lời chào; chào kèm câu hỏi thì trả lời câu hỏi", async () => {
    expect(tpl(await ask("hi"))).toBe("fp-1-greeting");
    expect(tpl(await ask("/start"))).toBe("fp-1-greeting");
    expect(tpl(await ask("hi, how to withdraw?"))).toBe("fp-2-withdraw");
    expect(tpl(await ask("👍", { sticker: true }))).toBe("fp-1-greeting");
  });
  it("lời chào có case đang dở dùng mẫu returning-user", async () => {
    expect(tpl(await ask("hello", { pendingIssue: "Change email address" }))).toBe("greeting-returning");
  });
  it("FP-2..FP-11 khớp đúng theo từ khoá", async () => {
    expect(tpl(await ask("how to withdraw"))).toBe("fp-2-withdraw");
    expect(tpl(await ask("khi nào lên sàn vậy"))).toBe("fp-3-listing-tge");
    expect(tpl(await ask("why ITLG reduce"))).toBe("fp-4-itlg-burn");
    expect(tpl(await ask("làm sao KYC"))).toBe("fp-5-how-to-kyc");
    expect(tpl(await ask("I want to change email"))).toBe("fp-7-change-email");
    expect(tpl(await ask("quên ID"))).toBe("fp-8-forgot-id");
    expect(tpl(await ask("delete account"))).toBe("fp-9-delete-account");
    expect(tpl(await ask("đổi ID được không"))).toBe("fp-10-change-id");
    expect(tpl(await ask("how to become ambassador"))).toBe("fp-11-ambassador");
    expect(answerOf("fp-2-withdraw")).toBe("you can not withdraw now, it will be withdrawn in the future when ITLG token is listed on exchanges and it will be a big surprise");
  });
  it("FP-5b: ảnh email KYC / màn hình queue LUÔN thắng ngữ cảnh cũ và caption", async () => {
    expect(tpl(await ask("", { vision: { screen_type: "kyc_email" } }))).toBe("fp-5b-kyc-email-queue");
    expect(tpl(await ask("still wait", { vision: { screen_type: "kyc_queue_screen" }, last: ESCALATE_TEMPLATE_ID }))).toBe("fp-5b-kyc-email-queue");
    expect(tpl(await ask("Nooo", { vision: { screen_type: "kyc_email" }, last: "fp-5b-kyc-email-queue" }))).toBe("fp-5b-kyc-email-queue");
  });
  it("FP-5b bằng chữ: cần CẢ đã nhận email VÀ app vẫn chờ", async () => {
    expect(tpl(await ask("I got my email but still in queue"))).toBe("fp-5b-kyc-email-queue");
    expect(tpl(await ask("nhận email xác minh rồi mà app vẫn chờ"))).toBe("fp-5b-kyc-email-queue");
  });
  it("FP-6 KHÔNG khớp khi đã nhắc email KYC, đã xong level 1 hoặc muốn tăng tốc", async () => {
    expect(tpl(await ask("kyc slow"))).toBe("fp-6-kyc-slow");
    expect((await ask("KYC slow, I received the verification email")).outcome.kind).not.toBe("TEMPLATE");
    expect(tpl(await ask("I completed level 1 and KYC slow"))).toBe("fp-6b-kyc-review-long");
    expect(tpl(await ask("kyc slow, how to speed up KYC"))).toBe("fp-6b-kyc-review-long");
  });
  it("FP-6b: thời gian chờ + KYC, level 1, tăng tốc", async () => {
    expect(tpl(await ask("KYC pending 20 days"))).toBe("fp-6b-kyc-review-long");
    expect(tpl(await ask("hồ sơ KYC đang xem xét 2 tháng"))).toBe("fp-6b-kyc-review-long");
    expect(tpl(await ask("đẩy nhanh KYC"))).toBe("fp-6b-kyc-review-long");
  });
  it("S04 'forgot login ID' KHÁC FP-8 'forgot ID' (SKILL.md ghi rõ)", async () => {
    expect(tpl(await ask("forgot login ID"))).toBe("forgot-login-id");
    expect(tpl(await ask("I forgot my login ID"))).toBe("forgot-login-id");
    expect(tpl(await ask("forgot ID"))).toBe("fp-8-forgot-id");
    expect(tpl(await ask("quên login"))).toBe("fp-8-forgot-id");
  });
  it("FP-11b: chưa nhận NFT campaign 10M", async () => {
    expect(tpl(await ask("I finished the 10M campaign but did not receive my NFT"))).toBe("fp-11b-campaign-10m-nft");
    expect(tpl(await ask("it says do you not own this NFT"))).toBe("fp-11b-campaign-10m-nft");
  });
  it("FP-12: lỗi hệ thống -> escalate kèm mã lỗi/PIC, cùng câu chung", async () => {
    const r = await ask("creating wallet failed");
    expect(tpl(r)).toBe("esc-wallet-create");
    expect(index.resolveAnswerSource(index.get("esc-wallet-create")!).id).toBe(ESCALATE_TEMPLATE_ID);
    expect(index.get("esc-swap")!.ticket).toMatchObject({ error_code: "SWAP", pic: "Quang" });
    expect(tpl(await ask("swap fail"))).toBe("esc-swap");
    expect(tpl(await ask("login fail"))).toBe("esc-login-fail");
    expect(tpl(await ask("", { vision: { screen_type: "error_dialog", error_text: "Something failed" } }))).toBe("esc-app-error-image");
  });
});

describe("router: follow-up", () => {
  it("sau template burn, 'not burn' -> ESCALATE", async () => {
    const r = await ask("not burn", { last: "fp-4-itlg-burn" });
    expect(r.outcome).toMatchObject({ kind: "ESCALATE", sourceTemplateId: "fp-4-itlg-burn" });
  });
  it("sau đổi email, 'không còn email cũ' -> mẫu riêng", async () => {
    expect(tpl(await ask("không còn email cũ", { last: "fp-7-change-email" }))).toBe("email-old-email-required");
  });
  it("sau OTP email, 'still not receive' -> ESCALATE", async () => {
    expect((await ask("still not receive", { last: "otp-email" })).outcome.kind).toBe("ESCALATE");
    expect((await ask("vẫn không nhận được", { last: "otp-email" })).outcome.kind).toBe("ESCALATE");
  });
  it("sau template KYC-email: thêm ảnh -> gửi lại; hỏi tiếp -> ESCALATE; cảm ơn -> You're welcome", async () => {
    expect(tpl(await ask("", { vision: { screen_type: "kyc_queue_screen" }, last: "fp-5b-kyc-email-queue" }))).toBe("fp-5b-kyc-email-queue");
    expect((await ask("still nothing", { last: "fp-5b-kyc-email-queue" })).outcome.kind).toBe("ESCALATE");
    expect((await ask("Nooo", { last: "fp-5b-kyc-email-queue" })).outcome.kind).toBe("ESCALATE");
    expect(tpl(await ask("okay thank you", { last: "fp-5b-kyc-email-queue" }))).toBe("you-are-welcome");
    expect(tpl(await ask("cảm ơn", { last: "fp-2-withdraw" }))).toBe("you-are-welcome");
  });
  it("cảm ơn kèm câu hỏi mới KHÔNG bị nuốt thành 'You're welcome'", async () => {
    expect(tpl(await ask("thanks, how to withdraw", { last: "fp-4-itlg-burn" }))).toBe("fp-2-withdraw");
  });
  it("khách nói rõ đổi chủ đề thì bỏ qua follow-up", async () => {
    const r = await ask("new question: how to withdraw", { last: "fp-4-itlg-burn" });
    expect(tpl(r)).toBe("fp-2-withdraw");
  });
  it("sau template xin thông tin (swap), khách gửi ảnh/mô tả -> ESCALATE", async () => {
    expect((await ask("here is the screenshot", { last: "wallet-swap-token-missing" })).outcome.kind).toBe("ESCALATE");
  });
  it("khách quay lại chủ đề đã từng escalate -> escalate sớm, không lặp template", async () => {
    const r = await ask("kyc slow", { parentEscalatedGroup: "KYC" });
    expect(r.outcome).toMatchObject({ kind: "ESCALATE" });
  });
});

describe("router: tầng 2, 3 và các đường lỗi", () => {
  const okLlm = (action: string, id?: string): LlmPort => ({
    understand: async (r) => ({ language: "unknown", intent: "question", follow_up: "none", query_en: r.text, query_kb: r.text }),
    select: async () => ({ ref: "ESCALATE", reason: "" }),
    verify: async () => ({ ok: true }),
    verifyHandoff: async () => ({ ok: true }),
    reviewOverlap: async () => ({ verdict: "distinct" as const }),
    draftIntake: async () => ({ kind: "templates", slug: "fake-intake-doc", title: "Fake", templates: [{ id: "fake-intake-tpl", group: "Test", keywords: ["k"], examples: ["e"], answer_en: "a" }], knowledge: null }),
    reviewEval: async () => [],
    classify: async () => (action === "template" ? { action: "template", template_id: id! } : ({ action } as never)),
    grounded: async () => ({ answerable: false, answer: "", cited: [] }),
    vision: async () => { throw new Error("unused"); },
    translate: async (r) => r.text,
    translateQuery: async (r) => ({ query: r.text }),
    summarize: async () => ({ issue: "", user_reported: "", unresolved_points: "" }),
  });

  it("không cấu hình LLM: câu lạ -> ESCALATE (phân vân -> escalate)", async () => {
    expect((await ask("some completely unrelated random statement zebra")).outcome.kind).toBe("ESCALATE");
  });
  it("LLM chỉ được chọn template nằm trong danh sách ứng viên được gửi đi", async () => {
    let sent: string[] = [];
    const llm: LlmPort = { ...okLlm("template"), classify: async (req) => { sent = req.candidates.map((c) => c.id); return { action: "template", template_id: "id-khong-ton-tai" }; } };
    const r = await ask("some strange statement about zebras", { llm });
    expect(sent.length).toBeGreaterThan(30);
    expect(sent).not.toContain("fp-12-escalate");
    expect(r.outcome.kind).toBe("ESCALATE");
  });
  it("LLM chọn template hợp lệ trong danh mục -> dùng đúng template đó", async () => {
    const r = await ask("some strange statement about zebras", { llm: okLlm("template", "fp-2-withdraw") });
    expect(r.outcome).toMatchObject({ kind: "TEMPLATE", templateId: "fp-2-withdraw", tier: 2 });
  });
  it("LLM không được chọn template đã bị loại bởi excludes", async () => {
    const r = await ask("KYC slow, I received the verification email", { llm: okLlm("template", "fp-6-kyc-slow") });
    expect(r.outcome.kind).toBe("ESCALATE");
  });
  it("LLM phân loại off-topic", async () => {
    expect((await ask("what is the weather in Paris", { llm: okLlm("offtopic") })).outcome.kind).toBe("OFFTOPIC");
  });
  it("LLM lỗi/quá tải -> UNAVAILABLE (câu báo mất kết nối cố định), không gửi nội dung trong kho, không lộ lỗi kỹ thuật", async () => {
    const down: LlmPort = { ...okLlm("escalate"), classify: async () => { throw new LlmUnavailableError("429"); } };
    const r = await ask("some strange statement about zebras", { llm: down });
    expect(r.outcome).toMatchObject({ kind: "UNAVAILABLE", tier: 2 });
  });
  const twoChunks = { search: async () => [
    { chunkId: "1", docSlug: "whitepaper", heading: "Listing", text: "Listing date is not announced.", url: "https://x.com/inter_link", score: 0.7 },
    { chunkId: "2", docSlug: "whitepaper", heading: "$ITLG", text: "$ITLG is the Genesis token.", url: "https://x.com/inter_link", score: 0.6 },
  ] };
  const q = { text: "What is $ITLG tokenomics?", norm: normalize("What is $ITLG tokenomics?"), lang: "en", hasImage: false, isSticker: false, ctx: {} };
  it("câu hỏi tri thức: LLM chỉ XÁC NHẬN đoạn trả lời được; khách nhận NGUYÊN VĂN đoạn đó kèm link, không phải chữ của LLM", async () => {
    const llm: LlmPort = { ...okLlm("knowledge"), grounded: async () => ({ answerable: true, answer: "LLM paraphrase that must never be sent", cited: ["2"] }) };
    const r = await route(q, { ...deps, knowledge: twoChunks, llm });
    expect(r.outcome).toMatchObject({ kind: "GROUNDED", mode: "extractive", answer: "$ITLG is the Genesis token.\n\nhttps://x.com/inter_link", sources: [{ chunkId: "2" }] });
  });
  it("điểm truy xuất cao nhưng tài liệu KHÔNG trả lời câu hỏi -> ESCALATE, không gửi đoạn lạc đề", async () => {
    const llm: LlmPort = { ...okLlm("knowledge"), grounded: async () => ({ answerable: false, answer: "", cited: [] }) };
    expect((await route(q, { ...deps, knowledge: twoChunks, llm })).outcome).toMatchObject({ kind: "ESCALATE", tier: 3 });
    const cheat: LlmPort = { ...okLlm("knowledge"), grounded: async () => ({ answerable: true, answer: "made up", cited: ["999"] }) }; // trích đoạn không tồn tại
    expect((await route(q, { ...deps, knowledge: twoChunks, llm: cheat })).outcome.kind).toBe("ESCALATE");
  });
  it("không có LLM để xác nhận -> ESCALATE; chỉ khi admin tắt router.tier3_verify mới gửi đoạn điểm cao nhất", async () => {
    expect((await route(q, { ...deps, knowledge: twoChunks })).outcome.kind).toBe("ESCALATE");
    const r = await route(q, { ...deps, knowledge: twoChunks, settings: { ...deps.settings, tier3Verify: false } });
    expect(r.outcome).toMatchObject({ kind: "GROUNDED", answer: "Listing date is not announced.\n\nhttps://x.com/inter_link" });
  });
  it("LLM xác nhận trả kết quả sai schema -> ESCALATE (không báo mất kết nối); LLM quá tải -> UNAVAILABLE", async () => {
    const bad: LlmPort = { ...okLlm("knowledge"), grounded: async () => { throw new LlmUnavailableError("bad json", true); } };
    expect((await route(q, { ...deps, knowledge: twoChunks, llm: bad })).outcome.kind).toBe("ESCALATE");
    const refused: LlmPort = { ...okLlm("knowledge"), grounded: async () => { throw new Error("refused"); } };
    expect((await route(q, { ...deps, knowledge: twoChunks, llm: refused })).outcome.kind).toBe("ESCALATE");
    const down: LlmPort = { ...okLlm("knowledge"), grounded: async () => { throw new LlmUnavailableError("503"); } };
    expect((await route(q, { ...deps, knowledge: twoChunks, llm: down })).outcome).toMatchObject({ kind: "UNAVAILABLE", tier: 3 });
  });
  it("tri thức không đủ liên quan -> ESCALATE, không tự đoán", async () => {
    const knowledge = { search: async () => [{ chunkId: "1", docSlug: "w", heading: "h", text: "t", score: 0.05 }] };
    const r = await route({ text: "tokenomics of the moon", norm: normalize("tokenomics of the moon"), lang: "en", hasImage: false, isSticker: false, ctx: {} }, { ...deps, knowledge });
    expect(r.outcome.kind).toBe("ESCALATE");
  });
  it("câu sinh có URL ngoài whitelist hoặc dự đoán giá bị chặn", async () => {
    const knowledge = { search: async () => [{ chunkId: "1", docSlug: "w", heading: "h", text: "t", score: 0.9 }] };
    const llm: LlmPort = { ...okLlm("knowledge"), grounded: async () => ({ answerable: true, answer: "ITLG will be worth $5 per ITLG soon, see https://evil.example.com", cited: ["1"] }) };
    const r = await route({ text: "What is $ITLG price", norm: normalize("What is $ITLG price"), lang: "en", hasImage: false, isSticker: false, ctx: {} }, { ...deps, knowledge, llm, settings: { ...deps.settings, tier3Mode: "generative" } });
    expect(r.outcome.kind).toBe("ESCALATE");
  });
});

describe("predicate", () => {
  it("mentions_duration hiểu 'ngày/tháng/days/months'", () => {
    for (const s of ["20 days", "2 months", "2 tháng", "20 ngày", "3 tuần"]) {
      expect(bundle.evaluator.test("mentions_duration", makeInput(s))).toBe(true);
    }
    expect(bundle.evaluator.test("mentions_duration", makeInput("kyc slow"))).toBe(false);
  });
});
