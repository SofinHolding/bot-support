/**
 * Người vận hành chủ động về ngữ cảnh của AI, không fix cứng trong code:
 *  - SKILL sửa trên Admin Web (bản DB ghi đè file; bản hỏng bị bỏ qua), có/không cần người thứ hai duyệt theo cài đặt;
 *  - nhánh AI/RAG: AI viết câu trả lời từ đoạn đã chọn, code kiểm (trích dẫn, số liệu, link, ngôn ngữ), không đạt -> nguyên văn;
 *  - câu AI viết/dịch được lưu để admin xem ở mục Bản dịch;
 *  - đánh giá bộ câu hỏi mẫu bằng AI.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { numbersNotIn } from "../src/core/translate";
import type { KnowledgeHit, LlmPort, SelectRequest, UnderstandResult } from "../src/core/ports";
import type { Actor } from "../src/kb/service";
import { SkillStore } from "../src/llm/skills";
import { fakeKorean, fakeLlm, makeWorld, type World } from "./helpers";

const U = (over: Partial<UnderstandResult>): UnderstandResult => ({ language: "en", intent: "question", follow_up: "none", query_en: "", query_kb: "", ...over });
const URL_OK = "https://whitepaper.interlinklabs.ai";
const CHUNK: KnowledgeHit = { chunkId: "31", docSlug: "wp", heading: "Vesting", text: "Locked tokens are unlocked gradually over a maximum of 180 months, 5% each month.", url: URL_OK, score: 0.8, lang: "en" };

describe("numbersNotIn", () => {
  it("số có trong nguồn (kể cả khác cách viết) không bị coi là bịa; số lạ thì có", () => {
    expect(numbersNotIn("Unlocks over 180 months at 5% per month.", [CHUNK.text])).toEqual([]);
    expect(numbersNotIn("Mở khoá trong 180 tháng, mỗi tháng 5,0%.", [CHUNK.text])).toEqual([]);
    expect(numbersNotIn("Unlocks over 240 months at 5% per month, worth $10.", [CHUNK.text]).sort()).toEqual(["10", "240"]);
  });
});

describe("SkillStore: bản Admin sửa ghi đè file, bản hỏng bị bỏ qua", () => {
  let w: World;
  beforeAll(async () => { w = await makeWorld(); });
  afterAll(() => w.close());

  it("mặc định từ file; lưu bản sửa -> LlmClient thấy ngay; bản không hợp lệ bị từ chối; reset về file", async () => {
    const store = new SkillStore(w.ops, "content", 0);
    const before = (await store.get())["verify-answer"].body;
    const custom = readFileSync("content/skills/verify-answer/SKILL.md", "utf8").replace("## Purpose", "## Purpose\n\nDÒNG-ADMIN-THÊM: luôn nghiêm khắc với câu hỏi về giá.");
    await store.save("verify-answer", custom, "admin#1");
    expect((await store.get())["verify-answer"].body).toContain("DÒNG-ADMIN-THÊM");
    expect((await store.list()).find((x) => x.name === "verify-answer")!.source).toBe("custom");
    await expect(store.save("verify-answer", "# không có frontmatter", "admin#1")).rejects.toThrow(/frontmatter/);
    await expect(store.save("verify-answer", custom.replace("## Requirements", "## Rules"), "admin#1")).rejects.toThrow(/Requirements/);
    // bản hỏng lọt vào DB bằng đường khác (vd sửa tay) -> bỏ qua, dùng file, không sập
    await w.ops.setSetting("skill.understand", "hỏng hoàn toàn", "test");
    store.invalidate();
    expect((await store.get()).understand.body).toContain("You do NOT answer the customer");
    await store.reset("verify-answer");
    expect((await store.get())["verify-answer"].body).toBe(before);
  });
});

describe("AI/RAG chế độ sinh: AI viết câu trả lời có kiểm chứng; câu đã gửi lưu cho admin xem", () => {
  let w: World;
  let grounded: LlmPort["grounded"];
  let seenGrounded: Parameters<LlmPort["grounded"]>[0][] = [];
  beforeAll(async () => {
    const llm: LlmPort = fakeLlm({
      understand: async (r) => U({ language: "en", query_en: r.text }),
      select: async (r: SelectRequest) => ({ ref: r.candidates.find((c) => c.ref.startsWith("K:"))?.ref ?? "ESCALATE", reason: "" }),
      grounded: async (r) => { seenGrounded.push(r); return grounded(r); },
      translate: async (r) => (r.lang === "ko" ? fakeKorean(r.text) : `[${r.lang}] ${r.text}`),
    });
    w = await makeWorld({ llm, mode: "llm_first" });
    (w.pipeline["d"] as { knowledge?: unknown }).knowledge = { search: async () => [CHUNK] };
    await w.ops.setSetting("router.tier3_mode", "generative", "test");
    w.settings.invalidate();
  });
  afterAll(() => w.close());
  const ask = async (uid: number, text: string) => {
    seenGrounded = [];
    await w.say(uid, text);
    const d = (await w.db.query<{ kind: string; via: string | null; notes: { notes: string[] } }>("SELECT kind, via, notes FROM decisions WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [uid])).rows[0]!;
    return { reply: w.channel.textsTo(uid).at(-1)!, d, notes: d.notes.notes.join(" | ") };
  };

  it("câu AI viết đạt kiểm tra -> gửi câu đó (đã ở ngôn ngữ khách, không dịch thêm), lưu vào Bản dịch với khoá answer:", async () => {
    grounded = async (r) => ({ answerable: true, answer: `Your locked tokens unlock gradually over up to 180 months (5% per month). Details: ${URL_OK}`, cited: [r.chunks[0]!.id] });
    const r = await ask(7201, "how long does vesting take for locked tokens?");
    expect(r.d.via).toBe("grounded:generative");
    expect(r.reply).toContain("180 months");
    expect(r.reply).not.toContain("[en]"); // không qua dịch máy nữa
    expect(r.notes).toContain("AI viết câu trả lời");
    expect(seenGrounded[0]!.lang).toBe("en");
    const saved = await w.db.query<{ template_id: string; text: string; status: string }>("SELECT template_id, text, status FROM template_translations WHERE template_id LIKE 'answer:%'");
    expect(saved.rows).toHaveLength(1);
    expect(saved.rows[0]!).toMatchObject({ status: "pending" });
    expect(saved.rows[0]!.text).toContain("180 months");
  });
  it("AI bịa số / không trích đoạn đã chọn / dự đoán giá / link lạ -> chặn, gửi nguyên văn đoạn đã chọn", async () => {
    const cases: [string, Parameters<typeof grounded>[0] extends infer R ? (r: R) => ReturnType<LlmPort["grounded"]> : never, string][] = [
      ["bịa số", async (r) => ({ answerable: true, answer: "Locked tokens unlock over 240 months.", cited: [r.chunks[0]!.id] }), "số liệu không có trong tài liệu"],
      ["không trích", async () => ({ answerable: true, answer: "Locked tokens unlock over 180 months.", cited: ["999"] }), "không trích đoạn nào trong danh sách"],
      ["dự đoán giá", async (r) => ({ answerable: true, answer: "Locked tokens unlock over 180 months and ITLG will reach $5 soon.", cited: [r.chunks[0]!.id] }), "bị chặn"],
      ["link lạ", async (r) => ({ answerable: true, answer: "Locked tokens unlock over 180 months, see https://evil.example.com", cited: [r.chunks[0]!.id] }), "bị chặn"],
      ["AI lỗi", async () => { throw new Error("503"); }, "AI viết câu trả lời lỗi"],
    ];
    let uid = 7210;
    for (const [name, fn, note] of cases) {
      grounded = fn as LlmPort["grounded"];
      const r = await ask(uid++, "how long does vesting take for locked tokens?");
      expect(r.d.via, name).toBe("grounded:extractive");
      expect(r.reply, name).toBe(`${CHUNK.text}\n\n${URL_OK}`);
      expect(r.notes, name).toContain(note);
    }
  });
  it("khách Hàn: AI viết bằng tiếng Hàn; nếu viết sai chữ (tiếng Anh) thì bị chặn và đoạn được dịch máy như thường", async () => {
    grounded = async (r) => ({ answerable: true, answer: `잠긴 토큰은 최대 180개월에 걸쳐 매월 5%씩 해제됩니다. ${URL_OK}`, cited: [r.chunks[0]!.id] });
    const ko = await ask(7220, "잠긴 토큰의 베스팅 기간은 얼마나 되나요? vesting");
    expect(ko.d.via).toBe("grounded:generative");
    expect(ko.reply).toContain("180개월");
    grounded = async (r) => ({ answerable: true, answer: `Locked tokens unlock over 180 months, 5% monthly. ${URL_OK}`, cited: [r.chunks[0]!.id] });
    const wrong = await ask(7221, "잠긴 토큰의 베스팅 기간은 얼마나 되나요? vesting");
    expect(wrong.d.via).toBe("grounded:extractive");
    // câu AI viết sai chữ bị chặn -> đoạn đã chọn được dịch sang tiếng Hàn như mọi nội dung khác
    expect(wrong.reply).toBe(fakeKorean(`${CHUNK.text}\n\n${URL_OK}`));
  });
});

describe("cài đặt approval.second_person", () => {
  let w: World;
  const admin: Actor = { id: 9002, role: "admin", label: "admin#9002" };
  beforeAll(async () => { w = await makeWorld({ adminIds: [9001, 9002], ownerId: 9001 }); });
  afterAll(() => w.close());
  it("tắt -> Hướng dẫn AI publish ngay không cần người thứ hai; bật lại -> chờ duyệt", async () => {
    const md = readFileSync("content/guide/agent-guide.md", "utf8").replace("nhân viên hỗ trợ tuyến đầu", "nhân viên hỗ trợ tuyến đầu (SỬA-1)");
    await w.ops.setSetting("approval.second_person", false, "test");
    w.settings.invalidate();
    const a = await w.kbService.createDraft({ slug: "agent-guide", kind: "guide", md, author: admin });
    expect(await w.kbService.publish(a.version.id, admin)).toBe("published");
    expect(w.live.guide?.sections[1]).toContain("SỬA-1");
    await w.ops.setSetting("approval.second_person", true, "test");
    w.settings.invalidate();
    const b = await w.kbService.createDraft({ slug: "agent-guide", kind: "guide", md: md.replace("SỬA-1", "SỬA-2"), author: admin });
    expect(await w.kbService.publish(b.version.id, admin)).toBe("pending_approval");
    expect(w.live.guide?.sections[1]).toContain("SỬA-1");
  });
});
