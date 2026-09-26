/**
 * Câu khẩn và đường dịch nhanh (huong-dan-memory v3 mục 8; QĐ1: mọi câu bằng ngôn ngữ của khách; QĐ3: câu khẩn chỉ qua bước AI dịch).
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_FIXED_EN, URGENT_TEMPLATE_IDS } from "../src/core/fixed-messages";
import { LlmUnavailableError } from "../src/core/ports";
import { detectKeyLeak, withoutSecrets } from "../src/core/sanitize";
import { HANDLERS, type JobContext } from "../src/worker/jobs";
import { fakeLlm, makeWorld, type World } from "./helpers";

/** Bản dịch giả sang tiếng Hàn: giữ nguyên URL, @handle, {BIẾN}, con số — như LlmClient thật (protectTerms) */
const fakeKorean = (text: string): string => `번역 ${text.replace(/https?:\/\/\S+|@\w+|\{[A-Z_]+\}|[A-Za-z]+/g, (m) => (/^(https?:|@|\{)/.test(m) ? m : "번역"))}`;

const SEED = "abandon ability able about above absent absorb abstract absurd abuse access accident";

let w: World | undefined;
afterEach(async () => {
  await w?.close();
  w = undefined;
});

const jobCtx = (world: World, llm: ReturnType<typeof fakeLlm>): JobContext => ({
  db: world.db, conv: world.conv, kb: world.kb, ops: world.ops, settings: world.settings, kbService: world.kbService, channel: world.channel, llm,
  ownerId: null, adminWebUrl: "x", now: () => world.clock.now, fetchImpl: fetch, log: () => undefined,
  resolver: world.pipeline["d"].resolver, live: world.live,
});

describe("bỏ bí mật trước khi nhận diện ngôn ngữ", () => {
  it("dãy seed bị bỏ hẳn, phần chữ còn lại giữ nguyên", () => {
    expect(detectKeyLeak(`제 지갑 복구 문구입니다 ${SEED} 도와주세요`)).toBe("C");
    expect(withoutSecrets(`제 지갑 복구 문구입니다 ${SEED} 도와주세요`)).toBe("제 지갑 복구 문구입니다 도와주세요");
    expect(withoutSecrets(`/wallet 0x${"a".repeat(64)}`)).toBe("");
  });
});

describe("cảnh báo lộ seed / private key", () => {
  it("bằng ngôn ngữ của khách; lời gọi dịch chỉ nhận câu mẫu, không có seed hay tin của khách", async () => {
    const translated: string[] = [];
    const llm = fakeLlm({
      translate: async (r) => {
        translated.push(r.text);
        return fakeKorean(r.text);
      },
      understand: async () => { throw new Error("câu khẩn không được qua understand"); },
    });
    w = await makeWorld({ llm });
    const u = 882001;
    await w.say(u, `제 지갑 복구 문구입니다 ${SEED} 도와주세요`);
    const reply = w.channel.textsTo(u)[0]!;
    expect(reply).toMatch(/\p{Script=Hangul}/u);
    expect(reply).toContain("@interlink_technicalsupport");
    expect(translated.length).toBe(1);
    for (const word of ["abandon", "accident", "지갑", "도와주세요"]) expect(translated[0]).not.toContain(word);
    const ev = await w.conv.userEvents(u, ["security_alert"], 5);
    expect(ev[0]!.payload).toMatchObject({ pattern: "C", lang: "ko", source: "live" });
    expect((await w.conv.getUser(u))!.language).toBeNull(); // không nhớ ngôn ngữ từ tin có bí mật
  });

  it("không dịch được: vẫn cảnh báo ngay bằng bản gốc tiếng Anh", async () => {
    w = await makeWorld({ llm: fakeLlm({ translate: async () => { throw new LlmUnavailableError("down"); } }) });
    const u = 882002;
    await w.say(u, `제 지갑 복구 문구입니다 ${SEED}`);
    expect(w.channel.textsTo(u)[0]).toBe(DEFAULT_FIXED_EN["fp-0-security-alert"]);
    expect((await w.conv.userEvents(u, ["urgent_fallback"], 5))[0]!.payload).toMatchObject({ template_id: "fp-0-security-alert", lang: "ko" });
  });
});

describe("dịch sẵn nhóm câu khẩn", () => {
  it("job dịch sẵn mọi câu khẩn; lần chạy sau bỏ qua bản dịch còn hợp lệ", async () => {
    let calls = 0;
    const llm = fakeLlm({ translate: async (r) => { calls++; return fakeKorean(r.text); } });
    w = await makeWorld({ llm });
    const ctx = jobCtx(w, llm);
    const first = (await HANDLERS["prewarm-urgent-translations"]!(ctx, { langs: ["ko"] })) as { translated: number; skipped: number; failed: string[] };
    expect(first).toMatchObject({ translated: URGENT_TEMPLATE_IDS.length, skipped: 0, failed: [] });
    const n = calls;
    const again = (await HANDLERS["prewarm-urgent-translations"]!(ctx, { langs: ["ko"] })) as { translated: number; skipped: number };
    expect(again).toMatchObject({ translated: 0, skipped: URGENT_TEMPLATE_IDS.length });
    expect(calls).toBe(n);
  });

  it("AI mất kết nối: câu báo mất kết nối gửi bằng ngôn ngữ của khách từ bản dịch sẵn, không gọi AI", async () => {
    let down = false;
    let calls = 0;
    const llm = fakeLlm({
      understand: async (r) => {
        if (down) throw new LlmUnavailableError("gateway down");
        return { language: "ko", intent: "greeting", follow_up: "none", query_en: "", query_kb: "" };
      },
      translate: async (r) => {
        calls++;
        return fakeKorean(r.text);
      },
    });
    w = await makeWorld({ llm });
    const u = 882003;
    await w.say(u, "안녕하세요");
    expect((await w.conv.getUser(u))!.language).toBe("ko");
    await HANDLERS["prewarm-urgent-translations"]!(jobCtx(w, llm), {});
    down = true;
    const before = calls;
    await w.say(u, "지갑 주소를 어떻게 확인하나요?");
    const reply = w.channel.textsTo(u).at(-1)!;
    expect(reply).toMatch(/\p{Script=Hangul}/u);
    expect(reply).toContain("@interlink_technicalsupport");
    expect(reply).not.toContain("Network disconnected");
    expect(calls).toBe(before);
  });

  it("ngôn ngữ mới của khách chưa nằm trong danh sách dịch sẵn: xếp việc dịch sẵn cho ngôn ngữ đó", async () => {
    w = await makeWorld({ llm: fakeLlm({ understand: async (r) => ({ language: "sw", intent: "greeting", follow_up: "none", query_en: r.text, query_kb: r.text }) }) });
    await w.say(882004, "Habari yako rafiki");
    const jobs = (await w.db.query<{ payload: { langs: string[] } }>("SELECT payload FROM jobs WHERE type = 'prewarm-urgent-translations'")).rows;
    expect(jobs.map((j) => j.payload.langs)).toEqual([["sw"]]);
  });
});
