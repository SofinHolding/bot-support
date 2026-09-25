/**
 * Mục hỏi đáp ở luồng chọn câu trả lời (Giai đoạn 2): hai mục đã khai báo "khác với" không bao giờ tự phân định bằng thứ hạng;
 * AI được hỏi lại khách ĐÚNG 1 lần (câu hỏi lại đã duyệt), lượt sau chỉ chọn trong hai mục đó, vẫn không rõ thì chuyển nhân viên;
 * câu trả lời nhiều bước đi theo từng bước khi khách báo "vẫn chưa được".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmPort, SelectRequest, UnderstandResult } from "../src/core/ports";
import { evalSettings, routeOffline } from "../src/kb/eval";
import type { Actor } from "../src/kb/service";
import { fakeLlm, makeWorld, type World } from "./helpers";

const admin: Actor = { id: 9002, role: "admin", label: "admin#9002" };
const CLARIFY_Q = "Is it the PIN of the app or the PIN of your card?";
const DOC = `topic: account
items:
  - id: app-pin-reset
    title: Đặt lại PIN ứng dụng
    questions: [how do I reset my app pin, I forgot the pin of the app, change the app lock pin]
    phrases: [app pin reset]
    applies_when: Khách quên PIN mở khoá ứng dụng
    distinct_from:
      - { item: card-pin-reset, difference: PIN ứng dụng khác PIN thẻ, clarify: "${CLARIFY_Q}" }
    steps: [{ say: Open Settings and tap Reset app PIN. }]
  - id: card-pin-reset
    title: Đặt lại PIN thẻ
    questions: [how do I reset my card pin, I forgot the pin of my card, change the card pin code]
    phrases: [pin reset for card]
    steps: [{ say: Open Card and tap Reset card PIN. }]
  - id: sync-stuck
    title: Đồng bộ bị treo
    questions: [my sync is stuck, the sync never finishes, sync keeps spinning forever]
    phrases: [sync is stuck]
    steps:
      - say: Please restart the app and try the sync again.
        next: { negative: next }
      - say: Please clear the app cache, then sync again.
        next: { negative: handoff }
`;

describe("mục hỏi đáp trong luồng chọn câu trả lời", () => {
  let w: World;
  let understand: (text: string) => Partial<UnderstandResult> = () => ({});
  let select: (r: SelectRequest) => string = () => "ESCALATE";
  let seen: SelectRequest[] = [];
  let verifyOk = true;

  beforeAll(async () => {
    const llm: LlmPort = fakeLlm({
      understand: async (r) => ({ language: "en", intent: "question", follow_up: "none", query_en: r.text, query_kb: r.text, ...understand(r.text) }),
      select: async (r) => { seen.push(r); return { ref: select(r), reason: "test" }; },
      verify: async () => ({ ok: verifyOk }),
    });
    w = await makeWorld({ llm, mode: "llm_first", adminIds: [9001, 9002], ownerId: 9001 });
    const { version, report } = await w.kbService.createDraft({ slug: "test-items-router", kind: "items", md: DOC, author: admin });
    expect(report.steps.filter((s) => s.status === "error")).toEqual([]);
    await w.kbService.publish(version.id, admin);
  });
  afterAll(() => w.close());

  const ask = async (uid: number, text: string) => {
    seen = [];
    await w.say(uid, text);
    const d = (await w.db.query<{ kind: string; template_id: string | null; via: string | null; reason: string | null }>("SELECT kind, template_id, via, reason FROM decisions WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [uid])).rows[0]!;
    const ep = (await w.db.query<{ pending_clarify: { items: string[] } | null }>("SELECT pending_clarify FROM episodes WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [uid])).rows[0];
    return { reply: w.channel.textsTo(uid).at(-1), d, pending: ep?.pending_clarify ?? null };
  };
  const setAsk = async (on: boolean) => {
    await w.ops.setSetting("episode.ask_when_unclear", on, "test");
    w.settings.invalidate();
  };

  it("cổng: hai mục đã khai báo khác nhau cùng khớp → không tự chọn theo thứ hạng (mơ hồ)", async () => {
    const r = await routeOffline("app pin reset or pin reset for card", null, w.live.index, w.live.evaluator, evalSettings());
    expect(r.outcome.kind).toBe("ESCALATE");
    expect(r.outcome.kind === "ESCALATE" && r.outcome.reason).toMatch(/mơ hồ/);
  });

  it("AI thấy ngữ cảnh áp dụng và điểm khác nhau của từng mục", async () => {
    select = () => "T:app-pin-reset";
    await ask(7101, "I need to reset a pin");
    const topic = seen[0]!.candidates.find((c) => c.ref === "T:app-pin-reset")?.topic ?? "";
    if (seen[0]!.candidates.some((c) => c.ref === "T:card-pin-reset")) expect(topic).toContain("differs from T:card-pin-reset");
    expect(topic).toContain("applies when: Khách quên PIN");
  });

  it("tính năng hỏi lại đang tắt: CLARIFY của AI → chuyển nhân viên", async () => {
    await setAsk(false);
    select = () => "CLARIFY:T:app-pin-reset,T:card-pin-reset";
    const { d } = await ask(7102, "reset my pin please");
    expect(d.kind).toBe("ESCALATE");
  });

  it("các trường hợp chưa khai báo 'khác với': vẫn hỏi lại, câu hỏi DỰNG TỪ dữ liệu đã duyệt (câu khách hay hỏi của từng mục)", async () => {
    await setAsk(true);
    select = (r) => (r.candidates.some((c) => c.ref === "T:sync-stuck") && r.candidates.some((c) => c.ref === "T:app-pin-reset") ? "CLARIFY:app-pin-reset,sync-stuck" : "ESCALATE");
    const { d, reply, pending } = await ask(7103, "my sync is stuck and I need to reset my app pin");
    expect(d.kind).toBe("CLARIFY");
    expect(reply).toBe("To help you correctly, which of these is your case?\n1) how do I reset my app pin\n2) my sync is stuck");
    expect(pending).toEqual({ items: ["T:app-pin-reset", "T:sync-stuck"] });
  });

  it("các trường hợp đang xung đột chưa giải quyết: không hỏi lại (không đưa dữ liệu mâu thuẫn cho khách chọn) → chuyển nhân viên", async () => {
    await setAsk(true);
    const before = w.live.conflicts;
    w.live.conflicts = new Set(["template:app-pin-reset|template:sync-stuck"]);
    select = () => "CLARIFY:app-pin-reset,sync-stuck";
    const { d, pending } = await ask(7107, "my sync is stuck and I need to reset my app pin");
    w.live.conflicts = before;
    expect(d.kind).toBe("ESCALATE");
    expect(pending).toBeNull();
  });

  it("hỏi lại giữa một câu trả lời và một đoạn tài liệu; khách chọn đoạn tài liệu → trích đúng đoạn đó", async () => {
    await setAsk(true);
    const kmd = `---\nslug: pin-guide\ntitle: PIN guide\nresponse_mode: GROUNDED_GENERATION\nlang: en\n---\n# PIN guide\n\n## App PIN security tips\n\nNever share your app PIN. Change the app PIN every few months and do not reuse it.\n`;
    const k = await w.kbService.createDraft({ slug: "pin-guide", kind: "knowledge", md: kmd, author: admin });
    await w.kbService.publish(k.version.id, admin);
    let chunkRef = "";
    select = (r) => {
      const kr = r.candidates.find((c) => c.ref.startsWith("K:"));
      chunkRef = kr?.ref ?? "";
      return kr && r.candidates.some((c) => c.ref === "T:app-pin-reset") ? `CLARIFY:T:app-pin-reset,${kr.ref}` : "ESCALATE";
    };
    const first = await ask(7108, "app pin security tips and reset my app pin");
    expect(first.d.kind).toBe("CLARIFY");
    expect(first.reply).toBe("To help you correctly, which of these is your case?\n1) how do I reset my app pin\n2) App PIN security tips");
    select = (r) => r.candidates.find((c) => c.ref === chunkRef)?.ref ?? "ESCALATE";
    const second = await ask(7108, "the security tips");
    expect(seen[0]!.candidates.map((c) => c.ref).sort()).toEqual(["T:app-pin-reset", chunkRef].sort());
    expect(second.d.kind).toBe("GROUNDED");
    expect(second.reply).toContain("Never share your app PIN");
  });

  it("hỏi lại 1 lần bằng câu đã duyệt; lượt sau chỉ chọn giữa hai mục và trả lời đúng mục khách nói", async () => {
    await setAsk(true);
    select = () => "CLARIFY:app-pin-reset,card-pin-reset";
    const first = await ask(7104, "I need to reset my pin");
    expect(first.d.kind).toBe("CLARIFY");
    expect(first.reply).toBe(CLARIFY_Q);
    expect(first.pending).toEqual({ items: ["T:app-pin-reset", "T:card-pin-reset"] });

    select = () => "T:card-pin-reset";
    const second = await ask(7104, "the card one");
    expect(seen[0]!.candidates.map((c) => c.ref).sort()).toEqual(["T:app-pin-reset", "T:card-pin-reset"]);
    expect(second.d).toMatchObject({ kind: "TEMPLATE", template_id: "card-pin-reset", via: "clarified" });
    expect(second.reply).toBe("Open Card and tap Reset card PIN.");
    expect(second.pending).toBeNull();
  });

  it("đã hỏi lại mà vẫn không rõ → chuyển nhân viên, không hỏi lần 2", async () => {
    await setAsk(true);
    select = () => "CLARIFY:app-pin-reset,card-pin-reset";
    await ask(7105, "I need to reset my pin");
    select = () => "CLARIFY:app-pin-reset,card-pin-reset";
    const again = await ask(7105, "not sure, both?");
    expect(again.d.kind).toBe("ESCALATE");
    expect(again.d.reason).toMatch(/đã hỏi lại khách/);
    expect(again.pending).toBeNull();
  });

  it("nhiều bước: 'vẫn chưa được' → bước 2 → vẫn chưa được → chuyển nhân viên", async () => {
    select = () => "T:sync-stuck";
    const s1 = await ask(7106, "my sync is stuck");
    expect(s1.reply).toBe("Please restart the app and try the sync again.");
    understand = () => ({ intent: "follow_up", follow_up: "negative" });
    const s2 = await ask(7106, "still not working");
    expect(s2.d).toMatchObject({ kind: "TEMPLATE", template_id: "sync-stuck--b2" });
    expect(s2.reply).toBe("Please clear the app cache, then sync again.");
    const s3 = await ask(7106, "still no");
    expect(s3.d.kind).toBe("ESCALATE");
    understand = () => ({});
  });
  describe("nội dung AI chọn đang mâu thuẫn chưa giải quyết với nội dung khác: dùng bên mới hơn, có ghi vết", () => {
    const withConflict = async (times: Record<string, number>, fn: () => Promise<void>) => {
      const before = { c: w.live.conflicts, t: w.live.answerTimes };
      w.live.conflicts = new Set(["template:app-pin-reset|template:sync-stuck"]);
      w.live.answerTimes = new Map(Object.entries(times));
      try {
        await fn();
      } finally {
        w.live.conflicts = before.c;
        w.live.answerTimes = before.t;
        verifyOk = true;
      }
    };
    const notes = async (uid: number) => (await w.db.query<{ notes: { notes: string[] } }>("SELECT notes FROM decisions WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [uid])).rows[0]!.notes.notes.join(" | ");

    it("nội dung AI chọn mới hơn -> dùng nó", async () => {
      select = () => "T:app-pin-reset";
      await withConflict({ "item:app-pin-reset": 2000, "item:sync-stuck": 1000 }, async () => {
        const { d } = await ask(7201, "how do I reset my app pin");
        expect(d).toMatchObject({ kind: "TEMPLATE", template_id: "app-pin-reset" });
        expect(await notes(7201)).toContain("dùng nội dung mới hơn");
      });
    });
    it("bên kia mới hơn và AI xác nhận nó trả lời đúng tin -> dùng bên mới hơn", async () => {
      select = () => "T:app-pin-reset";
      await withConflict({ "item:app-pin-reset": 1000, "item:sync-stuck": 2000 }, async () => {
        const { d, reply } = await ask(7202, "how do I reset my app pin");
        expect(d).toMatchObject({ kind: "TEMPLATE", template_id: "sync-stuck" });
        expect(reply).toBe("Please restart the app and try the sync again.");
      });
    });
    it("bên kia mới hơn nhưng AI không xác nhận nó trả lời đúng tin -> chuyển nhân viên (không gửi nội dung cũ)", async () => {
      select = () => "T:app-pin-reset";
      verifyOk = false;
      await withConflict({ "item:app-pin-reset": 1000, "item:sync-stuck": 2000 }, async () => {
        const { d } = await ask(7203, "how do I reset my app pin");
        expect(d.kind).toBe("ESCALATE");
      });
    });
    it("cùng mốc thời gian (lúc thêm chưa thống nhất) hoặc thiếu mốc -> chuyển nhân viên", async () => {
      select = () => "T:app-pin-reset";
      await withConflict({ "item:app-pin-reset": 1000, "item:sync-stuck": 1000 }, async () => {
        const { d } = await ask(7204, "how do I reset my app pin");
        expect(d.kind).toBe("ESCALATE");
        expect(d.reason).toContain("cùng mốc thời gian");
      });
      await withConflict({ "item:app-pin-reset": 1000 }, async () => {
        expect((await ask(7205, "how do I reset my app pin")).d.kind).toBe("ESCALATE");
      });
    });
  });
});
