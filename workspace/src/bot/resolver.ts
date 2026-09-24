/**
 * ResponseResolver: từ template id -> văn bản gửi khách.
 * - Bản dịch admin đã cung cấp (answer:xx) > bản dịch đã lưu (khớp source_hash; bản admin đã duyệt/sửa thay thế bản máy) > dịch MỘT LẦN > tiếng Anh.
 * - Bản dịch máy chỉ được gửi khi qua kiểm tra: URL trong whitelist, giữ nguyên URL / @handle / tên sản phẩm, không vượt giới hạn Telegram.
 *   Nó được lưu 'pending' để admin duyệt hoặc sửa ở mục Bản dịch. Chế độ chặt (translation.send_unapproved = false): chỉ gửi bản đã duyệt.
 * - Giữ nguyên URL, tên sản phẩm, handle (kiểm tra sau khi dịch).
 */
import { checkOutput, TELEGRAM_MAX_CHARS } from "../core/gate";
import { sha1 } from "../core/knowledge";
import { looksVietnamese, scriptProblem } from "../core/language";
import { LlmUnavailableError, usableLlm, type LlmPort } from "../core/ports";
import { translationProblems } from "../core/translate";
import type { TemplateIndex } from "../core/template-index";
import type { KbRepo } from "../db/repo-kb";

export interface Resolved {
  text: string;
  lang: string; // ngôn ngữ thực sự dùng để gửi
  translated: boolean;
  /** Chế độ phản hồi đã dùng (khối "Xác định chế độ phản hồi" của workflow) */
  mode?: "verbatim" | "approved_translation" | "stored_translation" | "machine_translation" | "fallback_en" | "blocked";
  note?: string;
  /** true = KHÔNG có văn bản an toàn để gửi (vd đoạn tiếng Việt không dịch được cho khách không dùng tiếng Việt): bên gọi phải chuyển người thật */
  blocked?: boolean;
}

export class ResponseResolver {
  constructor(
    private readonly kb: KbRepo,
    private readonly llm: LlmPort | undefined,
    private readonly getIndex: () => TemplateIndex,
    private readonly getHosts: () => Set<string>,
    /** true (mặc định) = gửi bản dịch máy đã qua kiểm tra dù admin chưa duyệt; false = chỉ gửi bản đã duyệt. */
    private readonly sendUnapproved: () => Promise<boolean> = async () => true,
  ) {}

  async forTemplate(templateId: string, lang: string, vars: Record<string, string> = {}): Promise<Resolved> {
    const index = this.getIndex();
    const t = index.get(templateId);
    if (!t) throw new Error(`template không tồn tại: ${templateId}`);
    const src = index.resolveAnswerSource(t);
    const en = src.answers.en;
    if (!en) throw new Error(`template ${src.id} không có bản tiếng Anh`);
    // hàm thay thế (không dùng chuỗi thay thế trực tiếp): "$&"/"$1" có thể xuất hiện trong lời khách và bị hiểu nhầm thành mẫu thay thế
    const fill = (s: string) =>
      s
        .replace(/\{ISSUE\}/g, () => vars.ISSUE ?? "")
        .replace(/\{SUPPORT_SUMMARY\}/g, () => vars.SUPPORT_SUMMARY ?? "")
        .trimEnd();
    // Bản dịch admin nhập / bản dịch đã lưu bằng tiếng Việt cho khách không dùng tiếng Việt là lỗi nhập liệu: bỏ qua, đi tiếp đường dịch/tiếng Anh
    const wrongLang = (s: string) => lang !== "vi" && (looksVietnamese(s) || !!scriptProblem(s, lang));

    if (lang === "en") return { text: fill(en), lang: "en", translated: false, mode: "verbatim" };
    const own = src.answers[lang];
    if (own && !wrongLang(own)) return { text: fill(own), lang, translated: false, mode: "approved_translation" }; // bản dịch admin soạn sẵn trong template

    const hash = sha1(en);
    const stored = await this.kb.getTranslation(src.id, lang);
    const loose = await this.sendUnapproved();
    if (stored && stored.source_hash === hash && !wrongLang(stored.text)) {
      if (stored.status === "approved" || loose) return { text: fill(stored.text), lang, translated: true, mode: stored.status === "approved" ? "approved_translation" : "stored_translation" };
      return { text: fill(en), lang: "en", translated: false, mode: "fallback_en", note: `bản dịch ${lang} đang chờ duyệt: gửi nguyên văn tiếng Anh` };
    }

    const llm = usableLlm(this.llm);
    if (!llm) throw new LlmUnavailableError("chưa cấu hình LLM để dịch");
    try {
      const out = await llm.translate({ text: en, lang, from: "en" });
      const chk = checkOutput(out, { urlHostWhitelist: this.getHosts(), maxChars: TELEGRAM_MAX_CHARS });
      const faithful = translationProblems(en, out, lang);
      if (!chk.ok || faithful.length) return { text: fill(en), lang: "en", translated: false, mode: "fallback_en", note: `bản dịch bị chặn: ${[...chk.problems, ...faithful].join("; ")}` };
      await this.kb.saveTranslation(src.id, lang, out, hash, "llm", "pending");
      if (loose) return { text: fill(out), lang, translated: true, mode: "machine_translation" };
      return { text: fill(en), lang: "en", translated: false, mode: "fallback_en", note: `đã tạo bản dịch ${lang} chờ duyệt: gửi nguyên văn tiếng Anh` };
    } catch (e) {
      if (e instanceof LlmUnavailableError && !e.badOutput) throw e; // mất kết nối: bên gọi gửi câu báo mất kết nối
      return { text: fill(en), lang: "en", translated: false, mode: "fallback_en", note: `dịch lỗi: ${(e as Error).message.slice(0, 120)}` };
    }
  }

  /**
   * Dịch một đoạn văn bản TỰ DO (không gắn với template/tri thức nào, vd khối tóm tắt chuyển hỗ trợ core/handoff.ts)
   * sang `lang`, qua ĐÚNG SKILL dịch (`llm.translate`) và kiểm chứng như mọi nội dung khác (translationProblems:
   * không đổi/bịa số liệu, không sót tiếng Việt, đúng chữ viết đích). KHÔNG lưu vào template_translations (nội dung
   * là riêng theo từng lượt, không phải thứ admin cần duyệt một lần rồi dùng lại như bản dịch template/tri thức).
   * Dịch lỗi hoặc không đạt kiểm tra -> trả về nguyên văn `from` (mặc định coi là an toàn để gửi thẳng, như `en`).
   */
  async translateFreeform(text: string, lang: string, from = "en"): Promise<{ text: string; translated: boolean }> {
    if (lang === from) return { text, translated: false };
    const llm = usableLlm(this.llm);
    if (!llm) throw new LlmUnavailableError("chưa cấu hình LLM để dịch");
    try {
      const out = await llm.translate({ text, lang, from });
      const chk = checkOutput(out, { urlHostWhitelist: this.getHosts() });
      const faithful = translationProblems(text, out, lang);
      if (chk.ok && !faithful.length) return { text: out, translated: true };
    } catch (e) {
      if (e instanceof LlmUnavailableError && !e.badOutput) throw e;
      /* bản dịch hỏng: rơi về nguyên văn bên dưới */
    }
    return { text, translated: false };
  }

  /**
   * Đưa một đoạn tri thức tới khách bằng ĐÚNG ngôn ngữ của khách (không lưu bản dịch).
   * `sourceLang` là ngôn ngữ thật của đoạn (kho thường bằng tiếng Việt, đôi khi tiếng Anh).
   *  - cùng ngôn ngữ -> gửi nguyên văn, không tốn token;
   *  - khác ngôn ngữ -> dịch; bản dịch phải qua kiểm tra bằng code (URL, handle, con số, độ dài, không sót tiếng Việt);
   *  - không dịch được: nguồn là tiếng Anh (nội dung gốc đã duyệt của hệ thống) -> gửi nguyên văn tiếng Anh như các đường khác;
   *    MỌI nguồn khác (đặc biệt tiếng Việt) -> `blocked`, KHÔNG gửi. Bên gọi chuyển người thật.
   */
  async dynamic(text: string, lang: string, sourceLang: string = "en"): Promise<Resolved> {
    if (sourceLang === lang) return { text, lang, translated: false, mode: "verbatim" };
    // Đệm theo nội dung đoạn: cùng đoạn, cùng ngôn ngữ thì không dịch lại (bớt một lời gọi model mạnh; admin duyệt/sửa được ở mục Bản dịch)
    const hash = sha1(text);
    const key = `chunk:${hash}`;
    const loose = await this.sendUnapproved();
    const stored = await this.kb.getTranslation(key, lang);
    if (stored && stored.source_hash === hash && (stored.status === "approved" || loose) && !translationProblems(text, stored.text, lang).length && checkOutput(stored.text, { urlHostWhitelist: this.getHosts() }).ok) {
      return { text: stored.text, lang, translated: true, mode: stored.status === "approved" ? "approved_translation" : "stored_translation" };
    }
    const llm = usableLlm(this.llm);
    let note: string | undefined;
    if (!llm) throw new LlmUnavailableError("chưa cấu hình LLM để dịch");
    if (!loose) note = "chế độ chặt: không gửi bản dịch máy chưa duyệt";
    else {
      try {
        const out = await llm.translate({ text, lang, from: sourceLang });
        const chk = checkOutput(out, { urlHostWhitelist: this.getHosts() });
        const faithful = translationProblems(text, out, lang);
        if (chk.ok && !faithful.length) {
          await this.kb.saveTranslation(key, lang, out, hash, "llm", "pending").catch(() => undefined);
          return { text: out, lang, translated: true, mode: "machine_translation" };
        }
        note = [...chk.problems, ...faithful].join("; ");
      } catch (e) {
        if (e instanceof LlmUnavailableError && !e.badOutput) throw e;
        note = `dịch lỗi: ${(e as Error).message.slice(0, 120)}`;
      }
    }
    if (sourceLang === "en") return { text, lang: "en", translated: false, mode: "fallback_en", note };
    return { text: "", lang, translated: false, blocked: true, mode: "blocked", note: `không dịch được đoạn ${sourceLang} sang ${lang}: ${note}` };
  }
}
