/**
 * Ràng buộc chung về ngôn ngữ: kho tri thức bằng tiếng Việt (chính) hoặc tiếng Anh; khách nhắn ngôn ngữ nào nhận ngôn ngữ đó;
 * khách không dùng tiếng Việt TUYỆT ĐỐI không nhận tiếng Việt; bản dịch không được bịa (đổi/thêm số liệu).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResponseResolver } from "../src/bot/resolver";
import { parseKnowledgeDoc, sha1 } from "../src/core/knowledge";
import { detectLanguage, looksVietnamese, sourceLangOf } from "../src/core/language";
import { NETWORK_DISCONNECTED_EN } from "../src/core/fixed-messages";
import { LlmUnavailableError, type GroundedChunk, type KnowledgeHit, type LlmPort } from "../src/core/ports";
import { translationProblems } from "../src/core/translate";
import type { Actor } from "../src/kb/service";
import { IMAGE_COVER_SECRET_ID } from "../src/domain/types";
import { fakeLlm, makeWorld, type World } from "./helpers";

const URL_OK = "https://whitepaper.interlinklabs.ai";
const VI_TEXT = "Lịch vesting: token bị khóa sẽ được mở dần đều trong tối đa 180 tháng, điều này giúp bảo vệ giá.";

describe("looksVietnamese / sourceLangOf", () => {
  it("nhận ra tiếng Việt có dấu, kể cả câu ngắn; không nhầm tiếng Anh, Pháp, Hàn", () => {
    expect(looksVietnamese(VI_TEXT)).toBe(true);
    expect(looksVietnamese("Không được rút tiền")).toBe(true); // ư, ợ, đ: các ký tự chỉ có ở tiếng Việt
    expect(looksVietnamese("Xin chào bạn")).toBe(false); // chỉ có "à": tiếng Pháp/Ý cũng dùng, không đủ bằng chứng (giới hạn của kiểm tra bằng code)
    expect(looksVietnamese("Locked tokens unlock gradually over a maximum of 180 months.")).toBe(false);
    expect(looksVietnamese("Où êtes-vous ? Ça ôte à côté de la fenêtre, très bien.")).toBe(false);
    expect(looksVietnamese("토큰은 최대 180개월 동안 점진적으로 잠금 해제됩니다")).toBe(false);
    expect(looksVietnamese("Cảm ơn")).toBe(false); // quá ngắn để kết luận
  });
  it("một tên riêng có dấu trong đoạn tiếng Anh dài không làm cả đoạn thành tiếng Việt", () => {
    const en = "The ambassador program was proposed by Nguyễn and reviewed by the whole community team over several weeks before launch, with monthly points for every active member.";
    expect(looksVietnamese(en)).toBe(false);
  });
  it("dạng tổ hợp (NFD) cũng được nhận ra", () => {
    expect(looksVietnamese(VI_TEXT.normalize("NFD"))).toBe(true);
  });
  it("sourceLangOf: bằng chứng trong văn bản thắng lời khai; không có gì thì mặc định en", () => {
    expect(sourceLangOf(VI_TEXT, "en")).toBe("vi");
    expect(sourceLangOf("Locked tokens unlock gradually.", "vi")).toBe("vi"); // tin lời khai khi không có bằng chứng ngược lại
    expect(sourceLangOf("Locked tokens unlock gradually over the schedule.")).toBe("en");
    expect(sourceLangOf("ok")).toBe("en");
  });
});

describe("detectLanguage: câu tiếng Anh ngắn toàn từ chuyên ngành vẫn là tiếng Anh", () => {
  it.each(["explain tokenomics vesting schedule", "tokenomics vesting schedule details", "show me the halving schedule"])("%s -> en", (s) => {
    expect(detectLanguage(s)).toBe("en"); // franc xếp các câu này là Hà Lan/Đức
  });
  it("không kéo câu Latin khác về en chỉ vì có một từ vay mượn", () => {
    expect(detectLanguage("kann ich mein account verifizieren bitte")).toBe("de");
    expect(detectLanguage("je voudrais retirer mes jetons dès que possible")).toBe("fr");
    // câu Đức/Bồ có lẫn từ chuyên ngành tiếng Anh vẫn là Đức/Bồ (lỗi từng gặp: bị nhận là en nên khách Đức nhận tiếng Anh)
    expect(detectLanguage("Wie hoch ist das Gesamtangebot von ITLG laut Whitepaper tokenomics?")).toBe("de");
    expect(detectLanguage("Was ist der Preis und wann ist das Listing von ITLG?")).toBe("de");
    expect(detectLanguage("quando será o listing e qual o price do token?")).toBe("pt");
  });
  it("đoạn tri thức tiếng Anh không bao giờ bị gán nhãn ngôn ngữ Latin khác (tránh bị chặn nhầm); chữ viết khác Latin vẫn nhận ra", () => {
    expect(sourceLangOf("Tokenomics\n\nInterLink Token ($ITL) is the main utility token. Total supply is fixed and released gradually through vesting.")).toBe("en");
    expect(sourceLangOf("kann ich mein account verifizieren bitte und danke schön")).toBe("en"); // kho chỉ có vi/en: không đoán nhãn Latin khác
    expect(sourceLangOf("토큰 이코노믹스에 대한 설명입니다")).toBe("ko");
  });
});

describe("translationProblems: bản dịch không được bịa", () => {
  const src = "Token bị khóa được mở dần trong tối đa 180 tháng, mỗi tháng 5,5% và tổng cung là 1.000.000.";
  it("bản dịch trung thành (dấu phân cách số khác kiểu vi/en vẫn khớp) -> đạt", () => {
    expect(translationProblems(src, "Locked tokens unlock gradually over a maximum of 180 months, 5.5% each month, and the total supply is 1,000,000.", "en")).toEqual([]);
  });
  it("đổi, thêm hoặc bớt con số -> bị chặn", () => {
    expect(translationProblems(src, "Locked tokens unlock over a maximum of 240 months, 5.5% each month, total supply 1,000,000.", "en").join(" ")).toContain("con số");
    expect(translationProblems(src, "Locked tokens unlock over a maximum of 180 months, 5.5% each month, total supply 1,000,000 and a 10% bonus.", "en").join(" ")).toContain("con số");
    expect(translationProblems(src, "Locked tokens unlock over a maximum of 180 months.", "en").join(" ")).toContain("con số");
  });
  it("sót tiếng Việt, rỗng, cụt hoặc phình bất thường -> bị chặn", () => {
    expect(translationProblems(src, "Token bị khóa được mở dần trong tối đa 180 tháng, mỗi tháng 5,5% và tổng cung là 1.000.000.", "en").join(" ")).toContain("sót tiếng Việt");
    expect(translationProblems(src, "  ", "en")).toEqual(["bản dịch rỗng"]);
    expect(translationProblems(`${src} ${src}`.replace(/\d/g, "x"), "ok", "en").join(" ")).toContain("độ dài");
    expect(translationProblems("x".repeat(60), "y".repeat(400), "en").join(" ")).toContain("độ dài");
  });
  it("đích là tiếng Việt thì không bị coi là 'sót tiếng Việt'", () => {
    expect(translationProblems("Locked tokens unlock over 180 months.", "Token bị khóa được mở dần trong 180 tháng.", "vi")).toEqual([]);
  });
});

describe("parseKnowledgeDoc: ngôn ngữ của tài liệu", () => {
  const body = `## Lịch vesting\n\n${VI_TEXT}\n\n## Nguồn cung\n\nTổng cung token được công bố trong whitepaper chính thức của dự án.\n`;
  it("lang khai trong frontmatter và ngôn ngữ thật từng đoạn được ghi vào chunk", () => {
    const r = parseKnowledgeDoc(`---\nslug: wp-vi\nlang: vi\nresponse_mode: GROUNDED_GENERATION\n---\n${body}`);
    expect(r.doc!.lang).toBe("vi");
    expect(r.doc!.chunks.every((c) => c.lang === "vi")).toBe(true);
    expect(r.issues.filter((i) => i.level === "warning")).toEqual([]);
  });
  it("không khai lang: tự nhận diện; khai sai (en nhưng nội dung tiếng Việt) -> chunk vẫn là vi + cảnh báo cho người duyệt", () => {
    expect(parseKnowledgeDoc(`---\nslug: wp-vi\n---\n${body}`).doc!.chunks.every((c) => c.lang === "vi")).toBe(true);
    const wrong = parseKnowledgeDoc(`---\nslug: wp-vi\nlang: en\n---\n${body}`);
    expect(wrong.doc!.chunks.every((c) => c.lang === "vi")).toBe(true);
    expect(wrong.issues.find((i) => i.level === "warning")!.message).toContain("khai lang: en");
  });
  it("tài liệu trộn ngôn ngữ mà không khai lang -> cảnh báo; lang sai định dạng -> lỗi", () => {
    const mixed = parseKnowledgeDoc(`---\nslug: mix\n---\n${body}\n## English part\n\nLocked tokens unlock gradually over the whole schedule and the price is protected.\n`);
    expect(mixed.issues.find((i) => i.level === "warning")!.message).toContain("trộn nhiều ngôn ngữ");
    const bad = parseKnowledgeDoc(`---\nslug: bad\nlang: tiếng việt\n---\n${body}`);
    expect(bad.doc).toBeUndefined();
    expect(bad.issues[0]!.message).toContain("lang không hợp lệ");
  });
});

describe("bot: trả lời đúng ngôn ngữ của khách, không bao giờ tiếng Việt cho khách khác", () => {
  let w: World;
  let hits: KnowledgeHit[] = [];
  let translated: { lang: string; text: string }[] = [];
  let translateImpl: (r: { text: string; lang: string }) => string = (r) => r.text;
  const admin: Actor = { id: 9002, role: "admin", label: "admin#9002" };

  const viChunk: KnowledgeHit = { chunkId: "11", docSlug: "wp-vi", heading: "Lịch vesting", text: `${VI_TEXT}`, url: URL_OK, score: 0.7, lang: "vi" };
  const enChunk: KnowledgeHit = { chunkId: "12", docSlug: "wp-en", heading: "Vesting", text: "Vesting schedule: locked tokens unlock gradually over a maximum of 180 months.", url: URL_OK, score: 0.7, lang: "en" };
  const goodEn = `Vesting schedule: locked tokens unlock gradually over a maximum of 180 months, which protects the price.\n\n${URL_OK}`;
  const goodKo = `베스팅 일정: 잠긴 토큰은 최대 180개월에 걸쳐 점진적으로 해제되어 가격을 보호합니다.\n\n${URL_OK}`;

  beforeAll(async () => {
    const llm: LlmPort = fakeLlm({
      classify: async () => ({ action: "knowledge" }),
      // SKILL select-answer: chọn đoạn tri thức tìm được (test này kiểm ngôn ngữ của câu gửi đi, không kiểm việc chọn)
      select: async (r) => ({ ref: r.candidates.find((c) => c.ref.startsWith("K:"))?.ref ?? "ESCALATE", reason: "" }),
      grounded: async (r: { chunks: GroundedChunk[] }) => ({ answerable: true, answer: "never sent", cited: [r.chunks[0]!.id] }),
      translate: async (r) => {
        translated.push(r);
        return translateImpl(r);
      },
    });
    w = await makeWorld({ llm, adminIds: [9001, 9002], ownerId: 9001 });
    (w.pipeline["d"] as { knowledge?: unknown }).knowledge = { search: async () => hits };
  });
  afterAll(() => w.close());

  const clearChunkCache = () => w.db.query("DELETE FROM template_translations WHERE template_id LIKE 'chunk:%'");
  const ask = async (id: number, text: string) => {
    translated = [];
    await clearChunkCache(); // mỗi test mô phỏng một kết quả dịch khác nhau trên cùng đoạn: không dùng lại bản đệm
    await w.say(id, text);
    return w.channel.textsTo(id).at(-1)!;
  };
  const isEscalation = (t: string) => t.includes("@interlink_technicalsupport") && t !== NETWORK_DISCONNECTED_EN; // câu báo mất kết nối cũng có handle này

  it("khách Anh + đoạn tiếng Việt: dịch sang tiếng Anh, giữ nguyên số và link", async () => {
    hits = [viChunk];
    translateImpl = (r) => (r.lang === "en" ? goodEn : goodKo);
    const reply = await ask(7101, "explain tokenomics vesting schedule");
    expect(reply).toBe(goodEn);
    expect(looksVietnamese(reply)).toBe(false);
    expect(translated.map((t) => t.lang)).toEqual(["en"]);
  });
  it("bộ nhớ đệm bản dịch đoạn tri thức: cùng đoạn + cùng ngôn ngữ thì lần sau KHÔNG gọi dịch; bản đệm vẫn bị kiểm lại", async () => {
    hits = [viChunk];
    translateImpl = (r) => (r.lang === "en" ? goodEn : goodKo);
    await ask(7120, "explain tokenomics vesting schedule");
    expect(translated.map((t) => t.lang)).toEqual(["en"]);
    translated = [];
    await w.say(7121, "explain tokenomics vesting schedule"); // không xoá đệm
    expect(translated).toEqual([]);
    expect(w.channel.textsTo(7121).at(-1)).toBe(goodEn);
    expect((await w.db.query<{ n: number }>("SELECT count(*)::int AS n FROM template_translations WHERE template_id LIKE 'chunk:%' AND lang = 'en'")).rows[0]!.n).toBe(1);
  });
  it("khách Hàn + đoạn tiếng Việt: dịch sang tiếng Hàn", async () => {
    const reply = await ask(7103, "tokenomics 베스팅 일정 설명해 주세요");
    expect(reply).toBe(goodKo);
    expect(translated.map((t) => t.lang)).toEqual(["ko"]);
  });
  it("khách Việt + đoạn tiếng Việt: gửi nguyên văn, không tốn lượt dịch", async () => {
    const reply = await ask(7102, "giải thích giúp tôi tokenomics vesting schedule");
    expect(reply).toBe(`${VI_TEXT}\n\n${URL_OK}`);
    expect(translated).toEqual([]);
  });
  it("khách Anh + đoạn tiếng Anh: gửi nguyên văn, không tốn lượt dịch", async () => {
    hits = [enChunk];
    const reply = await ask(7104, "explain tokenomics vesting schedule");
    expect(reply).toBe(`${enChunk.text}\n\n${URL_OK}`);
    expect(translated).toEqual([]);
  });
  it("khách Việt + đoạn tiếng Anh: dịch sang tiếng Việt", async () => {
    translateImpl = () => `Lịch vesting: token bị khóa được mở dần trong tối đa 180 tháng.\n\n${URL_OK}`;
    const reply = await ask(7105, "giải thích giúp tôi tokenomics vesting schedule");
    expect(translated.map((t) => t.lang)).toEqual(["vi"]);
    expect(reply).toContain("mở dần");
  });

  it("bản dịch đổi con số -> KHÔNG gửi bản dịch, KHÔNG gửi tiếng Việt, chuyển người thật", async () => {
    hits = [viChunk];
    translateImpl = () => `Vesting schedule: locked tokens unlock gradually over a maximum of 240 months.\n\n${URL_OK}`;
    const reply = await ask(7106, "explain tokenomics vesting schedule");
    expect(isEscalation(reply)).toBe(true);
    expect(looksVietnamese(reply)).toBe(false);
    expect(reply).not.toContain("240");
    const decisions = await w.db.query<{ kind: string; reason: string }>("SELECT kind, reason FROM decisions WHERE user_id = 7106 ORDER BY id DESC LIMIT 1");
    expect(decisions.rows[0]!.kind).toBe("ESCALATE");
    expect(decisions.rows[0]!.reason).toContain("con số");
  });
  it("LLM 'dịch' mà vẫn trả tiếng Việt -> chuyển người thật", async () => {
    translateImpl = (r) => r.text;
    const reply = await ask(7107, "explain tokenomics vesting schedule");
    expect(isEscalation(reply)).toBe(true);
    expect(looksVietnamese(reply)).toBe(false);
  });
  it("dịch lỗi (bản dịch hỏng, không phải mất kết nối) -> chuyển người thật, không gửi đoạn tiếng Việt", async () => {
    translateImpl = () => {
      throw new Error("503");
    };
    const reply = await ask(7108, "explain tokenomics vesting schedule");
    expect(isEscalation(reply)).toBe(true);
    expect(looksVietnamese(reply)).toBe(false);
  });
  it("mất kết nối LLM khi dịch -> câu báo mất kết nối cố định (tiếng Anh), không gửi đoạn tiếng Việt chưa dịch", async () => {
    hits = [viChunk];
    const before = translateImpl;
    translateImpl = () => {
      throw new LlmUnavailableError("503");
    };
    const reply = await ask(7112, "explain tokenomics vesting schedule");
    expect(w.channel.textsTo(7112)).toEqual([NETWORK_DISCONNECTED_EN]);
    expect(looksVietnamese(reply)).toBe(false);
    const d = await w.db.query<{ kind: string }>("SELECT kind FROM decisions WHERE user_id = 7112 ORDER BY id DESC LIMIT 1");
    expect(d.rows[0]!.kind).toBe("UNAVAILABLE");
    // đoạn tiếng Anh cho khách Hàn: cũng không gửi nguyên văn khi không dịch được vì mất kết nối
    hits = [enChunk];
    await ask(7113, "tokenomics 베스팅 일정 설명해 주세요");
    expect(w.channel.textsTo(7113)).toEqual([NETWORK_DISCONNECTED_EN]);
    hits = [viChunk];
    translateImpl = before;
  });
  it("đoạn tiếng Anh mà dịch sang ngôn ngữ khác lỗi (cả 3 lần) -> chuyển người thật, KHÔNG gửi nguyên văn tiếng Anh", async () => {
    hits = [enChunk];
    const reply = await ask(7109, "tokenomics 베스팅 일정 설명해 주세요");
    expect(isEscalation(reply)).toBe(true);
    expect(reply).not.toContain(enChunk.text);
  });

  it("lớp chặn cuối: template answer:en do admin nạp nhầm bằng tiếng Việt cũng không tới khách không dùng tiếng Việt", async () => {
    const md = `---\nid: test-vi-in-en\ngroup: Test\nresponse_mode: EXACT_TEMPLATE\npriority: 300\nmatch:\n  keywords:\n    - zebra unicorn phrase\nsets_context:\n  issue: test issue\n  status: pending\n---\n<!-- answer:en -->\n${VI_TEXT}\n`;
    const { version } = await w.kbService.createDraft({ slug: "test-vi-in-en", kind: "templates", md, author: admin });
    await w.kbService.publish(version.id, admin);
    const en = await ask(7110, "zebra unicorn phrase");
    expect(isEscalation(en)).toBe(true);
    expect(looksVietnamese(en)).toBe(false);
    translateImpl = (r) => r.text; // bộ dịch hoạt động bình thường
    const vi = await ask(7111, "zebra unicorn phrase, cho tôi hỏi giúp với ạ");
    expect(looksVietnamese(vi)).toBe(true); // khách dùng tiếng Việt thì nhận tiếng Việt bình thường
  });
});

describe("resolver.dynamic: luôn dịch, dịch lại kèm lỗi khi không đạt, không có bản dự phòng", () => {
  let w: World;
  let calls = 0;
  let seen: (string[] | undefined)[] = [];
  beforeAll(async () => {
    w = await makeWorld();
  });
  afterAll(() => w.close());
  const KO = "잠긴 토큰은 최대 180개월에 걸쳐 해제됩니다.";
  const make = (out: (lang: string, attempt: number) => string = (l) => (l === "ko" ? KO : `Locked tokens unlock over 180 months. ${l}`)) =>
    new ResponseResolver(w.kb, fakeLlm({ translate: async (r) => { calls++; seen.push(r.problems); return out(r.lang, calls); } }), () => w.live.index, () => w.live.urlHosts);
  const reset = async () => { calls = 0; seen = []; await w.db.query("DELETE FROM template_translations WHERE template_id LIKE 'chunk:%'"); };

  it("cùng ngôn ngữ -> nguyên văn, không gọi LLM", async () => {
    await reset();
    expect(await make().dynamic(VI_TEXT, "vi", "vi")).toMatchObject({ text: VI_TEXT, lang: "vi", translated: false });
    expect(calls).toBe(0);
  });
  it("mặc định sourceLang = en; dịch đạt -> gửi bản dịch và lưu lại, lượt sau không gọi LLM", async () => {
    await reset();
    expect(await make().dynamic("Locked tokens unlock over 180 months.", "ko")).toMatchObject({ text: KO, lang: "ko", translated: true, mode: "machine_translation" });
    expect(await make().dynamic("Locked tokens unlock over 180 months.", "ko")).toMatchObject({ text: KO, mode: "stored_translation" });
    expect(calls).toBe(1);
  });
  it("lần đầu còn sót tiếng Việt -> gọi lại SKILL kèm lỗi bằng tiếng Anh, lần sau đạt thì gửi", async () => {
    await reset();
    const src = "Token bị khóa được mở dần trong tối đa 180 tháng.";
    const r = await make((_l, n) => (n === 1 ? "Locked tokens được mở dần over 180 tháng." : "Locked tokens are unlocked gradually over a maximum of 180 months.")).dynamic(src, "en", "vi");
    expect(r).toMatchObject({ lang: "en", translated: true, mode: "machine_translation" });
    expect(calls).toBe(2);
    expect(seen[0]).toBeUndefined();
    expect(seen[1]!.join(" ")).toMatch(/Vietnamese/);
    expect(looksVietnamese(seen[1]!.join(" "))).toBe(false);
  });
  it("dịch sang tiếng Hàn mà cứ trả tiếng Anh -> dịch lại đủ 3 lần rồi chặn; nguồn tiếng Anh cũng KHÔNG rơi về nguyên văn tiếng Anh", async () => {
    await reset();
    const wrongLang = make(() => "Locked tokens unlock over 180 months.");
    expect(await wrongLang.dynamic("Locked tokens unlock over 180 months.", "ko", "en")).toMatchObject({ blocked: true, text: "", mode: "blocked" });
    expect(calls).toBe(3);
    expect(await wrongLang.dynamic(VI_TEXT, "ko", "vi")).toMatchObject({ blocked: true });
  });
  it("bản dịch đã lưu nhưng không đạt kiểm tra -> không dùng, dịch lại", async () => {
    await reset();
    const src = "Locked tokens unlock over 180 months.";
    await w.kb.saveTranslation(`chunk:${sha1(src)}`, "ko", "Mở khoá trong 180 tháng", sha1(src), "human", "approved");
    expect(await make().dynamic(src, "ko", "en")).toMatchObject({ text: KO, mode: "machine_translation" });
    expect(calls).toBe(1);
  });
});

describe("resolver.forTemplate: câu trả lời mẫu cũng luôn qua AI dịch, không có bản tiếng Anh dự phòng", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });
  afterAll(() => w.close());

  it("dịch không đạt sau 3 lần -> blocked (bên gọi chuyển người thật), không trả bản tiếng Anh", async () => {
    let calls = 0;
    const r = new ResponseResolver(w.kb, fakeLlm({ translate: async (req) => { calls++; return req.text; } }), () => w.live.index, () => w.live.urlHosts);
    const id = w.live.index.templates.find((t) => t.answers.en && !t.answers.ko && !t.answer_from)!.id;
    expect(await r.forTemplate(id, "ko")).toMatchObject({ blocked: true, text: "", mode: "blocked" });
    expect(calls).toBe(3);
  });
});

describe("resolver.translateFreeform: dịch văn bản tự do (khối tóm tắt chuyển hỗ trợ...), không lưu vào Bản dịch", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });
  afterAll(() => w.close());
  const EN = "Issue: cannot log in. Customer reported: login fails with error 504.";

  it("cùng ngôn ngữ nguồn -> nguyên văn, không gọi LLM", async () => {
    const r = new ResponseResolver(w.kb, fakeLlm({ translate: async () => { throw new Error("không được gọi"); } }), () => w.live.index, () => w.live.urlHosts);
    expect(await r.translateFreeform(EN, "en")).toEqual({ ok: true, text: EN, translated: false });
  });
  it("dịch đạt kiểm tra (đúng chữ viết đích, không đổi số liệu) -> dùng bản dịch, KHÔNG lưu vào template_translations", async () => {
    const r = new ResponseResolver(w.kb, fakeLlm({ translate: async (req) => `[${req.lang}] ${req.text}` }), () => w.live.index, () => w.live.urlHosts);
    // "fr" không có chữ viết riêng (SCRIPT_RE): bản dịch giả vẫn qua được kiểm tra chữ Latin, đúng như dịch máy tiếng Pháp thật
    expect(await r.translateFreeform(EN, "fr")).toEqual({ ok: true, text: `[fr] ${EN}`, translated: true });
    const saved = await w.db.query("SELECT * FROM template_translations WHERE text LIKE '%cannot log in%'");
    expect(saved.rows).toHaveLength(0);
  });
  it("model không thực sự đổi sang chữ viết đích -> không đạt sau 3 lần, KHÔNG rơi về nguyên văn nguồn", async () => {
    const r = new ResponseResolver(w.kb, fakeLlm({ translate: async () => EN }), () => w.live.index, () => w.live.urlHosts); // "dịch" sang ko nhưng vẫn trả tiếng Anh
    expect(await r.translateFreeform(EN, "ko")).toMatchObject({ ok: false });
  });
  it("bản dịch đổi số liệu lần đầu -> gọi lại kèm lỗi về con số; lần sau đúng thì dùng", async () => {
    const seen: (string[] | undefined)[] = [];
    const r = new ResponseResolver(w.kb, fakeLlm({ translate: async (req) => { seen.push(req.problems); return seen.length === 1 ? "[fr] Issue: cannot log in. Customer reported: login fails with error 999." : `[fr] ${EN}`; } }), () => w.live.index, () => w.live.urlHosts);
    expect(await r.translateFreeform(EN, "fr")).toEqual({ ok: true, text: `[fr] ${EN}`, translated: true });
    expect(seen[1]!.join(" ")).toMatch(/numbers changed.*504.*999/i);
  });
  it("đầu ra hỏng (LLM ném lỗi không phải mất kết nối) -> dịch lại; hỏng cả 3 lần -> không đạt", async () => {
    let calls = 0;
    const r = new ResponseResolver(w.kb, fakeLlm({ translate: async () => { calls++; throw new Error("503"); } }), () => w.live.index, () => w.live.urlHosts);
    expect(await r.translateFreeform(EN, "fr")).toMatchObject({ ok: false });
    expect(calls).toBe(3);
  });
  it("chưa cấu hình LLM hoặc mất kết nối -> ném LlmUnavailableError (bên gọi gửi câu báo mất kết nối), không gửi nguyên văn chưa dịch", async () => {
    const none = new ResponseResolver(w.kb, undefined, () => w.live.index, () => w.live.urlHosts);
    await expect(none.translateFreeform(EN, "fr")).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(await none.translateFreeform(EN, "en")).toEqual({ ok: true, text: EN, translated: false }); // cùng ngôn ngữ: không cần LLM
    const down = new ResponseResolver(w.kb, fakeLlm({ translate: async () => { throw new LlmUnavailableError("503"); } }), () => w.live.index, () => w.live.urlHosts);
    await expect(down.translateFreeform(EN, "fr")).rejects.toBeInstanceOf(LlmUnavailableError);
    const bad = new ResponseResolver(w.kb, fakeLlm({ translate: async () => { throw new LlmUnavailableError("bad json", true); } }), () => w.live.index, () => w.live.urlHosts);
    expect(await bad.translateFreeform(EN, "fr")).toMatchObject({ ok: false });
  });
});

describe("kho: ngôn ngữ của chunk được lưu và tìm kiếm chấm điểm theo ngôn ngữ", () => {
  let w: World;
  const admin: Actor = { id: 9002, role: "admin", label: "admin#9002" };
  beforeAll(async () => {
    w = await makeWorld({ adminIds: [9001, 9002], ownerId: 9001 });
  });
  afterAll(() => w.close());

  it("publish tài liệu tiếng Việt -> chunk có lang=vi; truy vấn khác ngôn ngữ dùng điểm vector, cùng ngôn ngữ dùng công thức cũ", async () => {
    const md = `---\nslug: wp-vi\nlang: vi\nresponse_mode: GROUNDED_GENERATION\nsource_url: ${URL_OK}\n---\n## Lịch vesting\n\nTokenomics: ${VI_TEXT}\n\n## Đại sứ\n\nChương trình đại sứ tặng điểm mỗi tháng cho thành viên tích cực của cộng đồng.\n`;
    const { version, report } = await w.kbService.createDraft({ slug: "wp-vi", kind: "knowledge", md, author: admin });
    expect(report.ok).toBe(true);
    await w.kbService.publish(version.id, admin);

    const knowledge = w.pipeline["d"].knowledge!;
    // kho đã seed sẵn tài liệu tiếng Anh nên lấy đủ nhiều kết quả rồi chọn đúng đoạn của tài liệu vừa nạp
    const pick = async (queryLang: string) => (await knowledge.search("tokenomics vesting schedule", 40, queryLang)).find((h) => h.docSlug === "wp-vi")!;
    const en = await pick("en");
    const vi = await pick("vi");
    expect(en.lang).toBe("vi");
    expect(en.heading).toContain("vesting");
    expect(vi.chunkId).toBe(en.chunkId);
    // khác ngôn ngữ: điểm chỉ là cosine (không cộng độ phủ từ khoá) nên không thể cao hơn điểm cùng-ngôn-ngữ của cùng đoạn
    expect(en.score).toBeLessThanOrEqual(vi.score + 1e-9);
    expect(en.score).toBeGreaterThan(0);
    // ngôn ngữ của đoạn tiếng Anh đã seed cũng được nhận ra
    expect((await knowledge.search("tokenomics vesting schedule", 40, "en")).some((h) => h.docSlug !== "wp-vi" && h.lang === "en")).toBe(true);
    const row = await w.db.query<{ lang: string | null }>("SELECT metadata->>'lang' AS lang FROM kb_chunks WHERE doc_slug = 'wp-vi' LIMIT 1");
    expect(row.rows[0]!.lang).toBe("vi");
  });
});

describe("rà soát: các lỗ hổng tìm thấy khi review độc lập", () => {
  it("khách Bồ Đào Nha / Pháp / Romania KHÔNG bị nhận nhầm là người Việt (ă â ê ô đ dùng chung nhiều ngôn ngữ)", () => {
    for (const s of ["Você pode me ajudar a verificar minha conta?", "Où est mon compte ? Je suis à côté de l'hôtel", "Când pot retrage tokenurile?", "Quero saber quando os tokens serão liberados, três meses?"]) {
      expect(detectLanguage(s)).not.toBe("vi");
    }
    expect(detectLanguage("Tôi đang làm việc với ứng dụng này")).toBe("vi"); // vẫn nhận ra tiếng Việt thật
    expect(detectLanguage("cho tôi hỏi khi nào được rút tiền")).toBe("vi");
    expect(detectLanguage("toi khong duoc rut tien")).toBe("vi"); // không dấu: nhận bằng từ vựng
  });
  it("câu tiếng Việt lẫn trong đoạn tiếng Anh dài vẫn bị nhận ra (tỉ lệ toàn văn bị loãng)", () => {
    const long = `${"Locked tokens are unlocked gradually over a maximum of 180 months, which helps protect the price for all community members. ".repeat(4)}Bạn vui lòng liên hệ hỗ trợ.`;
    expect(looksVietnamese(long)).toBe(true);
    expect(sourceLangOf(long, "en")).toBe("vi");
    expect(looksVietnamese("The founder Nguyễn Thị Lan joined the team. The rest of this paragraph is written in plain English only.")).toBe(false);
  });
});

describe("rà soát: kiểm tra con số của bản dịch", () => {
  const p = (src: string, out: string, lang = "en") => translationProblems(src, out, lang).filter((x) => x.includes("con số"));
  it("chặn sai dấu thập phân (1,5 -> 15), 3.5 -> 35, 1.234,56 -> 1,234.65", () => {
    expect(p("Lãi 1,5% mỗi tháng cho tất cả mọi người", "Interest 15% per month for all people")).not.toEqual([]);
    expect(p("phiên bản 3.5 mới cho tất cả mọi người", "version 35 new for all users of the app")).not.toEqual([]);
    expect(p("tổng 1.234,56 ITL cho tất cả mọi người", "total 1,234.65 ITL for all people")).not.toEqual([]);
    expect(p("thời hạn 2,5 năm cho tất cả mọi người", "deadline 25 years for all the people")).not.toEqual([]);
  });
  it("không chặn nhầm cách viết số khác nhau giữa các ngôn ngữ", () => {
    expect(p("Lãi 1,5% mỗi tháng cho tất cả mọi người", "Interest 1.5% per month for all people")).toEqual([]);
    expect(p("tổng 1.234,56 ITL cho tất cả mọi người", "total 1,234.56 ITL for all people")).toEqual([]);
    expect(p("mở khóa sau 5.000 ngày kể từ nay trở đi", "unlocks after 5 000 days from now on")).toEqual([]);
    expect(p("Tổng cung 1.000.000.000 ITLG cho tất cả mọi người dùng", "Общее предложение 1 000 000 000 ITLG для всех пользователей", "ru")).toEqual([]);
    expect(p("Hạn chót 15/03/2025 lúc 09:00 giờ địa phương của bạn", "Deadline 15/03/2025 at 9:00 local time for you")).toEqual([]);
    expect(p("phiên bản 2.3.1 cho ứng dụng của bạn", "version 2.3.1 for your application")).toEqual([]);
    expect(p("Hạn chót 15/03/2025 lúc 09:00 giờ địa phương", "2025年3月15日 9:00 のローカル時間が期限です", "ja")).toEqual([]);
  });
});

describe("rà soát: các đường gửi khác nhau đều không để lọt tiếng Việt", () => {
  let w: World;
  const admin: Actor = { id: 9002, role: "admin", label: "admin#9002" };
  beforeAll(async () => {
    w = await makeWorld({ adminIds: [9001, 9002], ownerId: 9001 });
  });
  afterAll(() => w.close());

  it("template có bản answer:ko do admin nhập nhầm bằng tiếng Việt: khách Hàn không nhận nó", async () => {
    const md = `---\nid: test-ko-wrong\ngroup: Test\nresponse_mode: EXACT_TEMPLATE\npriority: 300\nmatch:\n  keywords:\n    - koala walrus phrase\nsets_context:\n  issue: test issue\n  status: pending\n---\n<!-- answer:en -->\nThis is the approved English answer.\n<!-- answer:ko -->\n${VI_TEXT}\n`;
    const { version } = await w.kbService.createDraft({ slug: "test-ko-wrong", kind: "templates", md, author: admin });
    await w.kbService.publish(version.id, admin);
    await w.say(8101, "koala walrus phrase 부탁드립니다");
    const reply = w.channel.textsTo(8101).at(-1)!;
    expect(looksVietnamese(reply)).toBe(false);
    // bộ dịch giả trả "[ko] ..." (không phải chữ Hàn): dịch lại 3 lần vẫn không đạt -> chuyển người thật, không gửi bản tiếng Anh
    expect(reply).not.toContain("approved English answer");
    expect(reply).toContain("@interlink_technicalsupport");
  });
  it("lưới an toàn cuối: cảnh báo ảnh chứa key đi đường riêng (không qua lớp chặn thứ nhất) vẫn không được có tiếng Việt cho khách khác", async () => {
    const resolver = w.pipeline["d"].resolver as unknown as { forTemplate: (id: string, lang: string, vars?: Record<string, string>) => Promise<unknown> };
    const original = resolver.forTemplate.bind(resolver);
    resolver.forTemplate = async (id, lang, vars) => (id === IMAGE_COVER_SECRET_ID ? { text: VI_TEXT, lang, translated: false } : original(id, lang, vars)); // giả lập kho hỏng
    try {
      w.channel.images.set("leak-1", { has_secret: true, screen_type: "app_screen" });
      await w.sayPhoto(8201, "leak-1");
      const replies = w.channel.textsTo(8201);
      expect(replies.length).toBeGreaterThan(0);
      expect(replies.some(looksVietnamese)).toBe(false);
      expect(replies[0]).toContain("@interlink_technicalsupport"); // bị thay bằng câu chuyển người thật cố định bằng tiếng Anh
      expect(replies[0]).not.toContain("Network disconnected"); // chuyển người thật thật sự, không phải câu báo mất kết nối
    } finally {
      resolver.forTemplate = original;
    }
  });
});

describe("translationProblems: tên tháng dịch thành số", () => {
  it("nguồn có 'November' -> bản dịch Hàn '11월' không bị coi là bịa số; số khác vẫn bị chặn", () => {
    const src = "The mainnet launch is planned for November 2026, with 10000 seats.";
    expect(translationProblems(src, "메인넷 출시는 2026년 11월로 예정되어 있으며, 10000석이 있습니다.", "ko")).toEqual([]);
    expect(translationProblems(src, "메인넷 출시는 2026년 11월로 예정되어 있으며, 20000석이 있습니다.", "ko").join(" ")).toContain("con số");
    expect(translationProblems("Có 10000 chỗ.", "10000석이 있고 11월에 시작합니다.", "ko").join(" ")).toContain("con số"); // nguồn không có tên tháng -> 11 là số lạ
  });
});
