/**
 * Gói chống xung đột nội dung (sự cố: lối tắt escalate cũ `esc-login-fail` giành mất tài liệu mới `login-help`):
 *  1. luật code — lối tắt chuyển nhân viên (câu trả lời trỏ về fp-12) không được gợi ý bằng độ giống mờ, chỉ khớp xác định;
 *  2. kiểm tra chồng lấn lúc import — tài liệu tri thức/template mới được so với template + đoạn tri thức đang publish;
 *  4. quét chồng lấn toàn kho — cùng máy quét, cặp không lặp, không cờ hai đoạn của cùng một tài liệu.
 * (Việc 3 — thu hẹp 3 template cũ — là thay đổi nội dung do admin quyết trên Admin Web, không test ở đây.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HashEmbedder } from "../src/core/embedding";
import { normalize } from "../src/core/text";
import { scanCorpus } from "../src/kb/overlap";
import type { Actor } from "../src/kb/service";
import { makeWorld, type World } from "./helpers";

const admin: Actor = { id: 9002, role: "admin", label: "admin#9002" };
const KB = (slug: string, sections: [string, string][]) =>
  `---\nslug: ${slug}\ntitle: ${slug}\nresponse_mode: GROUNDED_GENERATION\nlang: vi\n---\n# ${slug}\n\n` + sections.map(([h, t]) => `## ${h}\n\n${t}\n`).join("\n");

describe("1. lối tắt chuyển nhân viên không được gợi ý bằng độ giống mờ", () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld({ adminIds: [9001, 9002], ownerId: 9001 });
  });
  afterAll(() => w.close());

  it("esc-login-fail là lối tắt (answer_from fp-12); suggest() không trả nó dù câu hỏi y hệt câu mẫu; hitsFor vẫn khớp từ khoá", async () => {
    const idx = w.live.index;
    expect(idx.isEscalateShortcut("esc-login-fail")).toBe(true);
    expect(idx.isEscalateShortcut("fp-2-withdraw")).toBe(false);
    expect(idx.isEscalateShortcut("fp-12-escalate")).toBe(false); // câu chung không phải lối tắt
    const sug = await idx.suggest("login fail", 20);
    expect(sug.length).toBeGreaterThan(0);
    expect(sug.map((s) => s.templateId)).not.toContain("esc-login-fail");
    expect(sug.map((s) => s.templateId)).not.toContain("esc-wallet-create");
    const hits = idx.hitsFor({ text: "my login fail again", norm: normalize("my login fail again") });
    expect(hits.some((h) => h.templateId === "esc-login-fail" && h.kind === "keyword")).toBe(true);
  });

  it("máy quét vẫn THẤY lối tắt (includeShortcuts) để cờ cho admin, dù runtime không gợi ý nó", async () => {
    const [q] = await new HashEmbedder().embed(["login fail"]);
    const withShortcuts = w.live.index.suggestVector(q!, 20, { includeShortcuts: true }).map((s) => s.templateId);
    const runtime = w.live.index.suggestVector(q!, 20).map((s) => s.templateId);
    expect(withShortcuts).toContain("esc-login-fail");
    expect(runtime).not.toContain("esc-login-fail");
  });
});

describe("2. kiểm tra chồng lấn lúc import + 4. quét toàn kho", () => {
  let w: World;
  beforeAll(async () => {
    w = await makeWorld({ adminIds: [9001, 9002], ownerId: 9001 });
  });
  afterAll(() => w.close());

  it("tài liệu tri thức mới về đăng nhập -> bước 3 cảnh báo đúng tên lối tắt cũ esc-login-fail (từ khoá 'login fail' nằm trong nội dung)", async () => {
    const md = KB("login-help-test", [
      ["Bước 1 — Lỗi Invalid ID hoặc login fail", "Thử chuyển sang kết nối mạng ổn định hơn rồi đăng nhập lại. Nếu vẫn báo login fail thì tiếp tục bước 2."],
      ["Bước 2 — Kiểm tra ID", "Kiểm tra lại InterLink ID đã nhập, đảm bảo không thiếu hoặc sai ký tự."],
    ]);
    const { report } = await w.kbService.createDraft({ slug: "login-help-test", kind: "knowledge", md, author: admin });
    const step3 = report.steps.find((s) => s.name.startsWith("3."))!;
    expect(step3.status).toBe("warning");
    const text = step3.details.join("\n");
    expect(text).toContain("esc-login-fail");
    expect(text).toMatch(/login fail/);
    expect(text).toMatch(/Khách hỏi "Bước 1 — Lỗi Invalid ID hoặc login fail".*bot sẽ trả lời bằng mục/); // câu dễ hiểu: câu nào, của đâu, bị trả lời bằng mục nào
    expect(text).toContain("Cách sửa"); // dòng hướng dẫn xử lý
    expect(report.ok).toBe(true); // cảnh báo, không chặn: admin quyết
  });

  it("publish tài liệu A rồi tạo tài liệu B có đoạn giống hệt -> cảnh báo kèm gợi ý 'tạo PHIÊN BẢN MỚI' thay vì tài liệu mới; bản mới của CHÍNH A thì không tự cờ mình", async () => {
    const body = "Token bị khoá sẽ được mở dần đều trong tối đa 180 tháng theo lịch vesting đã công bố, mỗi tháng năm phần trăm.";
    const a = await w.kbService.createDraft({ slug: "vesting-a", kind: "knowledge", md: KB("vesting-a", [["Lịch vesting", body]]), author: admin });
    expect(await w.kbService.publish(a.version.id, admin)).toBe("published");
    const b = await w.kbService.createDraft({ slug: "vesting-b", kind: "knowledge", md: KB("vesting-b", [["Lịch vesting", body]]), author: admin });
    const s3 = b.report.steps.find((s) => s.name.startsWith("3."))!;
    expect(s3.status).toBe("warning");
    expect(s3.details.join("\n")).toContain("vesting-a");
    expect(s3.details.join("\n")).toContain("PHIÊN BẢN MỚI");
    // cập nhật đúng cách: phiên bản mới của chính vesting-a không bị cờ vì trùng với bản đang publish của nó
    const a2 = await w.kbService.createDraft({ slug: "vesting-a", kind: "knowledge", md: KB("vesting-a", [["Lịch vesting", body + " Cập nhật."]]), author: admin });
    const s3a = a2.report.steps.find((s) => s.name.startsWith("3."))!;
    expect(s3a.details.join("\n")).not.toContain("vesting-a");
  });

  it("template mới có câu mẫu giống đoạn tri thức đang publish -> bước 3 cũng cờ đoạn đó", async () => {
    const md = `---\nid: test-vesting-tpl\ngroup: Test\nresponse_mode: EXACT_TEMPLATE\npriority: 300\nmatch:\n  keywords:\n    - lịch vesting\n  examples:\n    - Token bị khoá sẽ được mở dần đều trong tối đa 180 tháng theo lịch vesting\n---\n<!-- answer:en -->\nSee the vesting schedule.\n`;
    const { report } = await w.kbService.createDraft({ slug: "test-vesting-tpl-doc", kind: "templates", md, author: admin });
    const s3 = report.steps.find((s) => s.name.startsWith("3."))!;
    expect(s3.details.join("\n")).toContain("vesting-a");
  });

  it("quét toàn kho: dùng lại vector đã lưu (KHÔNG embed lại kho -> không gọi API); trả về cặp có tín hiệu, không cặp cùng tài liệu, không cặp tự-với-mình", async () => {
    const rows = await w.kb.loadPublishedTemplateRows();
    const embedder = new HashEmbedder();
    let embedded = 0;
    const counting = { version: embedder.version, embed: async (t: string[]) => ((embedded += t.length), embedder.embed(t)) };
    const pairs = await scanCorpus({ index: w.live.index, kb: w.kb, embedder: counting, docOf: new Map(rows.map((r) => [r.template.id, r.docSlug])) }, { minScore: 0.55 });
    expect(embedded).toBe(0); // sự cố thật: quét kho embed lại ~900 câu qua API ngoài -> 400 -> tự chuyển cục bộ và khoá API
    expect(pairs.length).toBeGreaterThan(0);
    for (const p of pairs) {
      expect(p.signals.length).toBeGreaterThan(0);
      expect(`${p.a.kind}:${p.a.id}`).not.toBe(`${p.b.kind}:${p.b.id}`);
      if (p.a.kind === "chunk" && p.b.kind === "chunk") expect(p.a.doc).not.toBe(p.b.doc);
    }
    // cặp không lặp theo thứ tự
    const keys = pairs.map((p) => [`${p.a.kind}:${p.a.id}`, `${p.b.kind}:${p.b.id}`].sort().join("|"));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
