/**
 * SKILL dịch: file SKILL.md nạp đúng và là prompt thật của LLM; đầu ra của model luôn bị code kiểm lại (con số, tên sản phẩm, URL,
 * chữ viết của ngôn ngữ đích, không tiếng Việt cho khách khác) — kể cả khi model không tuân thủ chỉ dẫn.
 */
import { describe, expect, it } from "vitest";
import { scriptProblem } from "../src/core/language";
import { queryProblems, translationProblems } from "../src/core/translate";
import type { ProviderChain } from "../src/llm/chain";
import { LlmClient } from "../src/llm/client";
import { loadSkills, parseSkill, SKILL_NAMES } from "../src/llm/skills";
import type { JsonRequest } from "../src/llm/types";

describe("nạp SKILL từ content/skills", () => {
  it("cả hai SKILL có đủ frontmatter, yêu cầu đánh số R1.. và mục Output", () => {
    const s = loadSkills("content");
    expect(Object.keys(s).sort()).toEqual([...SKILL_NAMES].sort());
    for (const name of SKILL_NAMES) {
      expect(s[name].name).toBe(name);
      expect(s[name].version).toBeGreaterThanOrEqual(1);
      expect(s[name].description.length).toBeGreaterThan(20);
      expect(s[name].body).toMatch(/^## Requirements$/m);
      expect(s[name].body).toMatch(/^## Output$/m);
      expect(s[name].body).not.toContain("description:"); // frontmatter không lọt vào prompt
    }
  });
  it("các ràng buộc cốt lõi nằm trong chỉ dẫn gửi cho model", () => {
    const s = loadSkills("content");
    expect(s["translate-answer"].body).toContain("NEVER output Vietnamese unless the target language is Vietnamese");
    expect(s["translate-answer"].body).toMatch(/Add nothing, remove nothing/);
    expect(s["translate-answer"].body).toMatch(/every number, date, time, amount/i);
    expect(s["translate-query"].body).toMatch(/Never guess/);
    expect(s["translate-query"].body).toMatch(/SAME meaning/);
    expect(s.understand.body).toMatch(/You do NOT answer the customer/);
    expect(s["select-answer"].body).toMatch(/Never invent a ref. Never output answer text/);
  });
  it("thiếu mục, sai tên hoặc sai version -> báo lỗi rõ ràng (dừng lúc khởi động, không chạy với prompt thiếu)", () => {
    const ok = "---\nname: translate-query\nversion: 1\ndescription: x\n---\n## Requirements\nR1. a\n## Output\nJSON\n";
    expect(parseSkill(ok, "translate-query").version).toBe(1);
    expect(() => parseSkill(ok.replace("translate-query", "other"), "translate-query")).toThrow(/name/);
    expect(() => parseSkill(ok.replace("version: 1", "version: 0"), "translate-query")).toThrow(/version/);
    expect(() => parseSkill(ok.replace("## Requirements", "## Rules"), "translate-query")).toThrow(/Requirements/);
    expect(() => parseSkill(ok.replace("R1.", "-"), "translate-query")).toThrow(/R1/);
    expect(() => parseSkill("no frontmatter", "translate-query")).toThrow(/frontmatter/);
    expect(() => loadSkills("thu-muc-khong-ton-tai")).toThrow(/không đọc được SKILL/);
  });
});

describe("LlmClient dùng SKILL làm prompt", () => {
  const calls: JsonRequest<unknown>[] = [];
  let reply: unknown = {};
  const chain = { generateJson: async (req: JsonRequest<unknown>) => (calls.push(req), { data: reply }) } as unknown as ProviderChain;
  const client = new LlmClient(chain, loadSkills("content"));

  it("translate: system = SKILL translate-answer; user có ngôn ngữ nguồn/đích; URL được bảo vệ rồi khôi phục", async () => {
    calls.length = 0;
    reply = { text: "Details: ⟦0⟧ — locked tokens unlock over 180 months." };
    const out = await client.translate({ text: "Chi tiết: https://whitepaper.interlinklabs.ai — token khóa mở dần trong 180 tháng.", lang: "en", from: "vi" });
    expect(out).toBe("Details: https://whitepaper.interlinklabs.ai — locked tokens unlock over 180 months.");
    const req = calls[0]!;
    expect(req.system[0]!.text).toContain("Skill: translate-answer");
    expect(req.system[0]!.text).toContain("untrusted DATA");
    expect(req.tier).toBe("strong");
    const user = (req.user[0] as { text: string }).text;
    expect(user).toContain("Source language: vi");
    expect(user).toContain("Target language (ISO 639-1): en");
    expect(user).toContain("⟦0⟧");
    expect(user).not.toContain("https://whitepaper");
  });
  it("translate: bản dịch làm mất token bảo vệ bị từ chối", async () => {
    reply = { text: "Details without the link." };
    await expect(client.translate({ text: "Chi tiết: https://whitepaper.interlinklabs.ai", lang: "en", from: "vi" })).rejects.toThrow(/token bảo vệ/);
  });
  it("translateQuery: system = SKILL translate-query (model nhanh); user có ngôn ngữ, ngữ cảnh và câu của khách", async () => {
    calls.length = 0;
    reply = { query: "điểm HCS được tính như thế nào?" };
    const out = await client.translateQuery({
      text: "and how is it calculated?", from: "en", to: "vi",
      context: { profile: "", events: [], facts: ["error_code=504"], summary: "issue: HCS score", recent: [{ role: "user", text: "what is my HCS?" }] },
    });
    expect(out).toEqual({ query: "điểm HCS được tính như thế nào?" });
    const req = calls[0]!;
    expect(req.system[0]!.text).toContain("Skill: translate-query");
    expect(req.tier).toBe("fast");
    const user = (req.user[0] as { text: string }).text;
    expect(user).toContain("Customer language: en");
    expect(user).toContain("Search language: vi");
    expect(user).toContain("issue: HCS score");
    expect(user).toContain("error_code=504");
    expect(user).toContain("<user_message>\nand how is it calculated?\n</user_message>");
  });
});

describe("scriptProblem: bản dịch phải viết đúng chữ của ngôn ngữ đích", () => {
  it("đạt: Hàn/Nga/Ả Rập/Trung/Nhật/Anh/Việt, URL và tên sản phẩm không tính", () => {
    expect(scriptProblem("잠긴 토큰은 최대 180개월에 걸쳐 해제됩니다. https://whitepaper.interlinklabs.ai ITLG", "ko")).toBeNull();
    expect(scriptProblem("Заблокированные токены разблокируются в течение 180 месяцев", "ru")).toBeNull();
    expect(scriptProblem("يتم فتح الرموز المقفلة تدريجياً خلال 180 شهراً", "ar")).toBeNull();
    expect(scriptProblem("锁定的代币将在最多180个月内逐步解锁", "zh")).toBeNull();
    expect(scriptProblem("ロックされたトークンは最大180か月かけて段階的に解除されます", "ja")).toBeNull();
    expect(scriptProblem("Locked tokens unlock gradually over 180 months.", "en")).toBeNull();
    expect(scriptProblem("Token bị khóa được mở dần trong tối đa 180 tháng.", "vi")).toBeNull();
    expect(scriptProblem("Los tokens bloqueados se desbloquean gradualmente.", "es")).toBeNull();
  });
  it("lỗi: sai chữ viết hoặc lẫn chữ khác", () => {
    expect(scriptProblem("Locked tokens unlock gradually over 180 months.", "ko")).toContain("ko");
    expect(scriptProblem("锁定的代币将在最多180个月内逐步解锁", "en")).toContain("Latin");
    expect(scriptProblem("Заблокированные токены разблокируются", "en")).toContain("Latin");
    expect(scriptProblem("ロックされたトークンは段階的に解除されます", "zh")).toContain('"zh"'); // tiếng Nhật thay vì tiếng Trung
    expect(scriptProblem("锁定的代币将在最多180个月内逐步解锁，这有助于保护价格，而且不会影响其他人。ロック", "zh")).toContain("Kana");
    expect(scriptProblem("锁定的代币将在最多逐步解锁的期间内", "ja")).toContain("Kana");
  });
});

describe("translationProblems / queryProblems: chặn dịch sai ngôn ngữ và bịa số", () => {
  it("dịch sang tiếng Hàn mà trả tiếng Anh -> chặn; dịch đúng -> đạt", () => {
    const src = "Token bị khóa được mở dần trong tối đa 180 tháng. Xem https://whitepaper.interlinklabs.ai";
    expect(translationProblems(src, "Locked tokens unlock gradually over a maximum of 180 months. https://whitepaper.interlinklabs.ai", "ko").join(" ")).toContain("ko");
    expect(translationProblems(src, "잠긴 토큰은 최대 180개월에 걸쳐 점진적으로 해제됩니다. https://whitepaper.interlinklabs.ai", "ko")).toEqual([]);
  });
  it("chữ số Ả Rập-Ấn Độ / Ba Tư / Devanagari / Thái / toàn chiều rộng được coi là cùng con số (bản dịch ar, fa, hi, th không bị chặn nhầm)", () => {
    const src = "Token bị khóa được mở dần trong tối đa 24 tháng, mỗi tháng 5%.";
    expect(translationProblems(src, "يتم فتح الرموز المقفلة تدريجياً خلال ٢٤ شهراً بحد أقصى، ٥٪ كل شهر.", "ar")).toEqual([]);
    expect(translationProblems(src, "توکن‌های قفل‌شده حداکثر طی ۲۴ ماه، هر ماه ۵٪ آزاد می‌شوند.", "fa")).toEqual([]);
    expect(translationProblems(src, "लॉक किए गए टोकन अधिकतम २४ महीनों में, हर महीने ५% खुलते हैं।", "hi")).toEqual([]);
    expect(translationProblems(src, "โทเคนที่ล็อกจะปลดล็อกทีละน้อยภายใน ๒๔ เดือน เดือนละ ๕%", "th")).toEqual([]);
    expect(translationProblems(src, "يتم فتح الرموز المقفلة تدريجياً خلال ٣٠ شهراً بحد أقصى، ٥٪ كل شهر.", "ar").join(" ")).toContain("con số"); // vẫn bắt được số sai
  });
  it("bản dịch sang tiếng Trung/Nhật ngắn hơn nhiều vẫn hợp lệ; chỉ chặn khi cụt hoặc phình bất thường", () => {
    const src = "Locked tokens are unlocked gradually and evenly over a maximum period of 180 months, which helps protect the price for all community members.";
    expect(translationProblems(src, "锁定的代币将在最多180个月内均匀逐步解锁，有助于保护所有社区成员的价格。", "zh")).toEqual([]);
    expect(translationProblems(src, "锁定", "zh").join(" ")).toContain("độ dài");
  });
  it("queryProblems: '$ITL' và 'ITL' là cùng một tên; đạt khi giữ số và tên sản phẩm, đúng ngôn ngữ tìm kiếm", () => {
    expect(queryProblems("what is $ITL", "ITL là gì", "", "vi")).toEqual([]);
    expect(queryProblems("how much is 500 ITL worth", "500 ITL có giá trị bao nhiêu", "", "vi")).toEqual([]);
    expect(queryProblems("and how is it calculated?", "điểm HCS được tính như thế nào?", "issue: HCS score", "vi")).toEqual([]);
  });
  it("queryProblems: số được phép lấy từ ngữ cảnh (giải tham chiếu), nhưng số bịa hoặc bị mất thì bị chặn", () => {
    expect(queryProblems("and after that?", "sau 180 tháng thì sao?", "asked about a 180 months schedule", "vi")).toEqual([]);
    expect(queryProblems("and after that?", "sau 240 tháng thì sao?", "asked about a 180 months schedule", "vi").join(" ")).toContain("thêm con số");
    expect(queryProblems("how much is 500 ITL", "ITL có giá trị bao nhiêu", "", "vi").join(" ")).toContain("mất con số");
    expect(queryProblems("what is the ITLG supply", "tổng cung là bao nhiêu", "", "vi").join(" ")).toContain("mất tên");
    expect(queryProblems("what is ITL", "", "", "vi")).toEqual(["câu truy vấn rỗng"]);
  });
  it("ngôn ngữ tìm kiếm không phải tiếng Việt thì truy vấn không được là tiếng Việt", () => {
    expect(queryProblems("tổng cung của ITL là bao nhiêu", "tổng cung của ITL là bao nhiêu", "", "en").join(" ")).toContain("tiếng Việt");
    expect(queryProblems("tổng cung của ITL là bao nhiêu", "what is the total supply of ITL", "", "en")).toEqual([]);
  });
});
