/**
 * Nhận diện ngôn ngữ theo tin nhắn HIỆN TẠI (AGENTS.md > Ngôn ngữ), bằng code — không tốn token.
 *   Latin + dấu tiếng Việt -> vi · Latin thuần tiếng Anh -> en · Hán tự -> zh · Hangul -> ko
 *   Hiragana/Katakana -> ja · Cyrillic -> ru · Arabic -> ar
 * Tin quá ngắn (hi, ok, sticker) trả về null để dùng ngôn ngữ đã lưu (mặc định en).
 */
import { franc } from "franc-min";
import { normalize } from "./text";

export const DEFAULT_LANGUAGE = "en";

const VI_DIACRITICS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉĩịọỏốồổỗộớờởỡợụủũứừửữựỳỵỷỹ]/i;
const VI_PLAIN_WORDS = new Set(["toi", "ban", "khong", "duoc", "chua", "nhung", "rut", "tien", "lam", "sao", "cho", "voi", "cua", "nay", "vao", "tai", "khoan", "mat", "khau", "xac", "minh", "hoi", "giup", "nhan", "bi", "dang", "roi", "vay", "the", "nao"]);
const EN_WORDS = new Set(["the", "is", "are", "please", "how", "what", "why", "when", "not", "can", "could", "my", "i", "you", "to", "and", "for", "with", "have", "has", "do", "does", "did", "still", "again", "help", "need", "want", "get", "got", "it", "this", "that", "me", "in", "on", "of", "but", "no", "yes"]);

const ISO3_TO_1: Record<string, string> = {
  spa: "es", por: "pt", fra: "fr", deu: "de", ita: "it", ind: "id", tur: "tr", pes: "fa", hin: "hi", tha: "th", pol: "pl", nld: "nl",
};

export function detectLanguage(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/[\p{Script=Hangul}]/u.test(t)) return "ko";
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(t)) return "ja";
  if (/[\p{Script=Han}]/u.test(t)) return "zh";
  if (/[\p{Script=Cyrillic}]/u.test(t)) return "ru";
  if (/[\p{Script=Arabic}]/u.test(t)) return "ar";
  if (/[\p{Script=Thai}]/u.test(t)) return "th";
  if (/[\p{Script=Devanagari}]/u.test(t)) return "hi";
  if (!/\p{L}/u.test(t)) return null; // chỉ emoji / số

  if (VI_DIACRITICS.test(t)) return "vi";

  const words = normalize(t).split(" ").filter(Boolean);
  if (words.length < 2) return null; // quá ngắn để kết luận

  const vi = words.filter((w) => VI_PLAIN_WORDS.has(w)).length;
  const en = words.filter((w) => EN_WORDS.has(w)).length;
  if (vi >= 2 && vi > en) return "vi";
  if (en >= 1 && en >= vi) return "en";

  if (t.length >= 30) {
    const iso3 = franc(t, { minLength: 30 });
    if (iso3 === "vie") return "vi";
    if (iso3 === "eng") return "en";
    const mapped = ISO3_TO_1[iso3];
    if (mapped) return mapped;
  }
  return null;
}

const LANG_NAMES: Record<string, string> = {
  english: "en", vietnamese: "vi", "tiếng việt": "vi", "tieng viet": "vi", chinese: "zh", mandarin: "zh", japanese: "ja", korean: "ko", russian: "ru",
  spanish: "es", portuguese: "pt", french: "fr", german: "de", italian: "it", indonesian: "id", thai: "th", hindi: "hi", turkish: "tr", arabic: "ar", persian: "fa", farsi: "fa",
};

/** Khách yêu cầu rõ ngôn ngữ ("can you speak Vietnamese?", "请用中文") — thắng mọi suy đoán khác. */
export function explicitLanguageRequest(text: string): string | null {
  const t = text.trim();
  if (/请用中文|用中文|說中文|说中文/.test(t)) return "zh";
  if (/日本語で|日本語でお願い/.test(t)) return "ja";
  if (/한국어로|한국어 부탁/.test(t)) return "ko";
  if (/на русском|по-русски/i.test(t)) return "ru";
  const low = t.toLowerCase();
  for (const [name, code] of Object.entries(LANG_NAMES)) {
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?:speak|reply|answer|respond|write|talk|use|in|bằng|nói|trả lời|dùng)\\s+(?:in\\s+|bằng\\s+)?${n}\\b|\\b${n}\\s+please\\b|\\bcan you (?:speak|write|reply in)\\s+${n}\\b`, "i");
    if (re.test(low)) return code;
  }
  return null;
}

/**
 * Chọn ngôn ngữ trả lời:
 * 1) khách yêu cầu rõ -> ghi nhớ; 2) nhận diện được -> dùng (và ghi nhớ nếu khác); 3) quá ngắn -> ngôn ngữ đã lưu; 4) mặc định en.
 */
export function resolveLanguage(text: string, stored: string | null | undefined): { lang: string; update: boolean } {
  const explicit = explicitLanguageRequest(text);
  if (explicit) return { lang: explicit, update: explicit !== stored };
  const detected = detectLanguage(text);
  if (detected) return { lang: detected, update: detected !== stored };
  return { lang: stored ?? DEFAULT_LANGUAGE, update: false };
}
