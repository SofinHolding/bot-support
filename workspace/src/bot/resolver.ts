/**
 * ResponseResolver: nội dung đã duyệt (template / đoạn tri thức / câu hỏi lại / khối tóm tắt) -> văn bản gửi khách bằng ĐÚNG ngôn ngữ của khách.
 * - Khách dùng đúng ngôn ngữ gốc của nội dung -> gửi nguyên văn. Khác ngôn ngữ -> LUÔN dịch bằng SKILL translate-answer.
 *   Không có bước admin duyệt bản dịch, không có bản dự phòng bằng tiếng Anh.
 * - Mọi bản dịch qua kiểm tra bằng code (`translateChecked`): giữ nguyên URL / @handle / tên sản phẩm / con số, URL trong whitelist,
 *   đúng chữ viết đích, KHÔNG có tiếng Việt khi khách không dùng tiếng Việt. Không đạt -> gọi lại SKILL kèm danh sách lỗi
 *   (`translationFeedback`), tối đa `TRANSLATE_ATTEMPTS` lần. Vẫn không đạt -> `blocked`: bên gọi chuyển người thật.
 * - Mất kết nối LLM (hoặc chưa cấu hình) -> ném `LlmUnavailableError`: bên gọi gửi câu báo mất kết nối cố định bằng tiếng Anh.
 * - Bản dịch đạt được lưu lại (template_translations) để lượt sau không phải dịch lại; bản đã lưu cũng phải qua đúng các kiểm tra trên.
 */
import { checkOutput, TELEGRAM_MAX_CHARS } from "../core/gate";
import { sha1 } from "../core/knowledge";
import { looksVietnamese, scriptProblem } from "../core/language";
import { LlmUnavailableError, usableLlm, type LlmPort } from "../core/ports";
import { translationFeedback, translationProblems } from "../core/translate";
import type { TemplateIndex } from "../core/template-index";
import type { KbRepo } from "../db/repo-kb";

/** Số lần gọi SKILL dịch cho một nội dung (lần đầu + các lần dịch lại kèm lỗi) */
export const TRANSLATE_ATTEMPTS = 3;

export interface Resolved {
  text: string;
  lang: string; // ngôn ngữ thực sự dùng để gửi
  translated: boolean;
  /** Chế độ phản hồi đã dùng (khối "Xác định chế độ phản hồi" của workflow) */
  mode?: "verbatim" | "approved_translation" | "stored_translation" | "machine_translation" | "blocked";
  note?: string;
  /** true = KHÔNG có văn bản an toàn để gửi (dịch nhiều lần vẫn không đạt kiểm tra): bên gọi phải chuyển người thật */
  blocked?: boolean;
}

type Checked = { ok: true; text: string; attempts: number } | { ok: false; note: string };

export class ResponseResolver {
  constructor(
    private readonly kb: KbRepo,
    private readonly llm: LlmPort | undefined,
    private readonly getIndex: () => TemplateIndex,
    private readonly getHosts: () => Set<string>,
  ) {}

  /** Lỗi của một bản dịch (rỗng = đạt): kiểm tra đầu ra chung + trung thành với nguồn */
  private problems(source: string, out: string, lang: string, maxChars?: number): string[] {
    const chk = checkOutput(out, { urlHostWhitelist: this.getHosts(), maxChars });
    return [...chk.problems, ...translationProblems(source, out, lang)];
  }

  /**
   * Dịch có kiểm tra: gọi SKILL dịch, kiểm bằng code, sai thì dịch lại kèm danh sách lỗi (tiếng Anh) tới khi đạt hoặc hết lượt.
   * Mất kết nối -> ném LlmUnavailableError (không nuốt). Đầu ra hỏng (JSON sai, đổi URL/handle...) tính là một lần không đạt.
   */
  private async translateChecked(text: string, lang: string, from: string, maxChars?: number): Promise<Checked> {
    const llm = usableLlm(this.llm);
    if (!llm) throw new LlmUnavailableError("chưa cấu hình LLM để dịch");
    let problems: string[] = [];
    for (let attempt = 1; attempt <= TRANSLATE_ATTEMPTS; attempt++) {
      try {
        const out = await llm.translate({ text, lang, from, problems: problems.length ? translationFeedback(problems) : undefined });
        problems = this.problems(text, out, lang, maxChars);
        if (!problems.length) return { ok: true, text: out, attempts: attempt };
      } catch (e) {
        if (e instanceof LlmUnavailableError && !e.badOutput) throw e; // mất kết nối: bên gọi gửi câu báo mất kết nối
        problems = [(e as Error).message.slice(0, 160)];
      }
    }
    return { ok: false, note: `dịch ${TRANSLATE_ATTEMPTS} lần vẫn không đạt kiểm tra: ${problems.join("; ")}` };
  }

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
    // Bản dịch admin nhập sẵn trong nội dung bằng tiếng Việt cho khách không dùng tiếng Việt là lỗi nhập liệu: bỏ qua, đi đường dịch
    const wrongLang = (s: string) => lang !== "vi" && (looksVietnamese(s) || !!scriptProblem(s, lang));

    if (lang === "en") return { text: fill(en), lang: "en", translated: false, mode: "verbatim" };
    const own = src.answers[lang];
    if (own && !wrongLang(own)) return { text: fill(own), lang, translated: false, mode: "approved_translation" }; // nội dung đã duyệt viết sẵn bằng ngôn ngữ này

    const hash = sha1(en);
    const stored = await this.kb.getTranslation(src.id, lang);
    if (stored && stored.source_hash === hash && !this.problems(en, stored.text, lang, TELEGRAM_MAX_CHARS).length) {
      return { text: fill(stored.text), lang, translated: true, mode: "stored_translation" };
    }
    const r = await this.translateChecked(en, lang, "en", TELEGRAM_MAX_CHARS);
    if (!r.ok) return { text: "", lang, translated: false, blocked: true, mode: "blocked", note: r.note };
    await this.kb.saveTranslation(src.id, lang, r.text, hash, "llm", "pending").catch(() => undefined);
    return { text: fill(r.text), lang, translated: true, mode: "machine_translation", note: r.attempts > 1 ? `dịch lại ${r.attempts - 1} lần mới đạt` : undefined };
  }

  /**
   * Dịch một đoạn văn bản TỰ DO (không gắn với nội dung nào trong kho, vd khối tóm tắt chuyển hỗ trợ core/handoff.ts)
   * sang `lang`, qua ĐÚNG SKILL dịch và đúng các kiểm tra như mọi nội dung khác. KHÔNG lưu (nội dung riêng theo từng lượt).
   * Dịch nhiều lần vẫn không đạt -> `{ ok: false }`: bên gọi quyết định (không có bản dự phòng bằng ngôn ngữ nguồn).
   */
  async translateFreeform(text: string, lang: string, from = "en"): Promise<{ ok: true; text: string; translated: boolean } | { ok: false; note: string }> {
    if (lang === from) return { ok: true, text, translated: false };
    const r = await this.translateChecked(text, lang, from);
    return r.ok ? { ok: true, text: r.text, translated: true } : r;
  }

  /**
   * Đưa một đoạn nội dung đã duyệt (đoạn tri thức, câu hỏi lại khách) tới khách bằng ĐÚNG ngôn ngữ của khách.
   * `sourceLang` là ngôn ngữ thật của đoạn.
   *  - cùng ngôn ngữ -> gửi nguyên văn, không tốn token;
   *  - khác ngôn ngữ -> dịch có kiểm tra (dịch lại kèm lỗi khi không đạt); bản dịch đạt được lưu theo hash nội dung đoạn;
   *  - vẫn không đạt -> `blocked`, KHÔNG gửi. Bên gọi chuyển người thật.
   */
  async dynamic(text: string, lang: string, sourceLang: string = "en"): Promise<Resolved> {
    if (sourceLang === lang) return { text, lang, translated: false, mode: "verbatim" };
    // Đệm theo nội dung đoạn: cùng đoạn, cùng ngôn ngữ thì không dịch lại (bớt một lời gọi model mạnh)
    const hash = sha1(text);
    const key = `chunk:${hash}`;
    const stored = await this.kb.getTranslation(key, lang);
    if (stored && stored.source_hash === hash && !this.problems(text, stored.text, lang).length) {
      return { text: stored.text, lang, translated: true, mode: "stored_translation" };
    }
    const r = await this.translateChecked(text, lang, sourceLang);
    if (!r.ok) return { text: "", lang, translated: false, blocked: true, mode: "blocked", note: `không dịch được đoạn ${sourceLang} sang ${lang}: ${r.note}` };
    await this.kb.saveTranslation(key, lang, r.text, hash, "llm", "pending").catch(() => undefined);
    return { text: r.text, lang, translated: true, mode: "machine_translation", note: r.attempts > 1 ? `dịch lại ${r.attempts - 1} lần mới đạt` : undefined };
  }
}
