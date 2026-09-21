/**
 * ResponseResolver: từ template id -> văn bản gửi khách.
 * - Bản dịch admin đã cung cấp (answer:xx) > bản dịch đã lưu (khớp source_hash) > dịch MỘT LẦN rồi lưu chờ duyệt > tiếng Anh.
 * - Giữ nguyên URL, tên sản phẩm, handle (kiểm tra sau khi dịch).
 */
import { checkOutput, TELEGRAM_MAX_CHARS } from "../core/gate";
import { sha1 } from "../core/knowledge";
import type { LlmPort } from "../core/ports";
import type { TemplateIndex } from "../core/template-index";
import type { KbRepo } from "../db/repo-kb";

export interface Resolved {
  text: string;
  lang: string; // ngôn ngữ thực sự dùng để gửi
  translated: boolean;
  note?: string;
}

export class ResponseResolver {
  constructor(private readonly kb: KbRepo, private readonly llm: LlmPort | undefined, private readonly getIndex: () => TemplateIndex, private readonly getHosts: () => Set<string>) {}

  async forTemplate(templateId: string, lang: string, vars: Record<string, string> = {}): Promise<Resolved> {
    const index = this.getIndex();
    const t = index.get(templateId);
    if (!t) throw new Error(`template không tồn tại: ${templateId}`);
    const src = index.resolveAnswerSource(t);
    const en = src.answers.en;
    if (!en) throw new Error(`template ${src.id} không có bản tiếng Anh`);
    const fill = (s: string) => s.replace(/\{ISSUE\}/g, vars.ISSUE ?? "");

    if (lang === "en") return { text: fill(en), lang: "en", translated: false };
    const own = src.answers[lang];
    if (own) return { text: fill(own), lang, translated: false };

    const hash = sha1(en);
    const stored = await this.kb.getTranslation(src.id, lang);
    if (stored && stored.source_hash === hash) return { text: fill(stored.text), lang, translated: true };

    if (!this.llm) return { text: fill(en), lang: "en", translated: false, note: "chưa cấu hình LLM để dịch" };
    try {
      const out = await this.llm.translate({ text: en, lang });
      const chk = checkOutput(out, { urlHostWhitelist: this.getHosts(), maxChars: TELEGRAM_MAX_CHARS });
      if (!chk.ok) return { text: fill(en), lang: "en", translated: false, note: `bản dịch bị chặn: ${chk.problems.join("; ")}` };
      await this.kb.saveTranslation(src.id, lang, out, hash, "llm", "pending");
      return { text: fill(out), lang, translated: true };
    } catch (e) {
      return { text: fill(en), lang: "en", translated: false, note: `dịch lỗi: ${(e as Error).message.slice(0, 120)}` };
    }
  }

  /** Dịch động một đoạn tri thức (không lưu bản dịch). Lỗi -> giữ tiếng Anh. */
  async dynamic(text: string, lang: string): Promise<Resolved> {
    if (lang === "en" || !this.llm) return { text, lang: "en", translated: false };
    try {
      const out = await this.llm.translate({ text, lang });
      const chk = checkOutput(out, { urlHostWhitelist: this.getHosts() });
      if (chk.ok) return { text: out, lang, translated: true };
      return { text, lang: "en", translated: false, note: chk.problems.join("; ") };
    } catch (e) {
      return { text, lang: "en", translated: false, note: (e as Error).message.slice(0, 120) };
    }
  }
}
