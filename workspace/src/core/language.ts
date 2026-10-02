/**
 * Nhận diện ngôn ngữ theo tin nhắn HIỆN TẠI (AGENTS.md > Ngôn ngữ), bằng code — không tốn token.
 *   Latin + dấu tiếng Việt -> vi · Latin thuần tiếng Anh -> en · Hán tự -> zh · Hangul -> ko
 *   Hiragana/Katakana -> ja · Cyrillic -> ru · Arabic -> ar
 * Tin quá ngắn (hi, ok, sticker) trả về null để dùng ngôn ngữ đã lưu (mặc định en).
 */
import { francAll } from "franc-min";
import { normalize } from "./text";

export const DEFAULT_LANGUAGE = "en";

// Ký tự GẦN NHƯ CHỈ có ở tiếng Việt (khối U+1EA0–1EF9 như ạ ế ộ ữ, cùng ơ ư). KHÔNG gồm ă â đ ê ô: tiếng Bồ Đào Nha, Pháp, Romania, Croatia cũng dùng —
// coi chúng là bằng chứng thì khách Pháp/Bồ bị nhận nhầm là người Việt và nhận tiếng Việt.
const VI_DIACRITICS = /[Ạ-ỹơưƠƯ]/;
const VI_PLAIN_WORDS = new Set(["toi", "ban", "khong", "duoc", "chua", "nhung", "rut", "tien", "lam", "sao", "cho", "voi", "cua", "nay", "vao", "tai", "khoan", "mat", "khau", "xac", "minh", "hoi", "giup", "nhan", "bi", "dang", "roi", "vay", "the", "nao"]);
const EN_WORDS = new Set(["the", "is", "are", "please", "how", "what", "why", "when", "not", "can", "could", "my", "i", "you", "to", "and", "for", "with", "have", "has", "do", "does", "did", "still", "again", "help", "need", "want", "get", "got", "it", "this", "that", "me", "in", "on", "of", "but", "no", "yes"]);

// Từ tiếng Anh thường gặp trong câu hỏi về dự án mà không trùng với ngôn ngữ Latin khác (khác EN_WORDS: đây không phải từ chức năng)
const EN_DOMAIN = new Set(["explain", "tell", "show", "give", "about", "schedule", "vesting", "tokenomics", "details", "detail", "supply", "withdraw", "withdrawal", "release", "released", "unlock", "unlocked", "locked", "price", "listing", "whitepaper", "halving", "mining", "verification", "verify", "account", "reward", "rewards", "stake", "staking"]);

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
  if (en >= 2 && en >= vi) return "en";
  // Câu tiếng Anh ngắn toàn từ chuyên ngành ("explain tokenomics vesting schedule") bị franc xếp là Hà Lan/Đức. Chỉ coi là en khi từ chuyên ngành
  // chiếm ĐA SỐ câu: câu Đức/Bồ có lẫn vài từ mượn ("Whitepaper", "Listing", "price") vẫn là Đức/Bồ.
  if (t.length < 80 && words.filter((w) => EN_DOMAIN.has(w)).length / words.length >= 0.5) return "en";

  // MỘT từ chức năng "tiếng Anh" không đủ: "do", "me", "no", "i", "in" cũng là từ của tiếng Bồ, Ý, Tây Ban Nha.
  // Câu đủ dài thì để bộ nhận diện thống kê quyết định; câu ngắn giữ hành vi cũ (en).
  const iso3 = t.length >= 30 ? (francAll(t, { minLength: 30 })[0]?.[0] ?? "und") : "und";
  if (iso3 === "vie") return "vi";
  if (iso3 === "eng") return "en";
  const mapped = ISO3_TO_1[iso3];
  if (mapped) return mapped;
  return en >= 1 && en >= vi ? "en" : null;
}

/**
 * Văn bản này có phải tiếng Việt (có dấu) không? Dùng làm lớp chặn cuối trước khi gửi khách: chỉ đếm các ký tự gần như
 * CHỈ có ở tiếng Việt (khối U+1EA0–1EF9 như ạ ế ộ ữ, cùng ơ ư đ) — không đếm ă â ê ô vì tiếng Pháp/Bồ/Romania cũng dùng.
 * Ngưỡng theo tỉ lệ nên một cái tên riêng ("Nguyễn") nằm trong đoạn tiếng Anh dài không bị coi là tiếng Việt.
 * Không thấy được tiếng Việt viết KHÔNG dấu: đó là giới hạn của kiểm tra bằng code.
 */
const VI_MARKS = /[Ạ-ỹơưđƠƯĐ]/g;
const markStats = (s: string) => ({ letters: s.match(/\p{L}/gu)?.length ?? 0, marks: s.match(VI_MARKS)?.length ?? 0 });
export function looksVietnamese(text: string): boolean {
  const t = text.normalize("NFC");
  const all = markStats(t);
  // >= 3 dấu (tên riêng như "Nguyễn Thị Lan" chỉ có 2), hoặc >= 2 dấu khi mật độ dày (cụm ngắn như "Cảm ơn bạn ạ")
  if (all.letters >= 6 && ((all.marks >= 3 && all.marks / all.letters >= 0.02) || (all.marks >= 2 && all.marks / all.letters >= 0.08))) return true;
  // Câu/dòng tiếng Việt lẫn trong văn bản dài (tỉ lệ toàn văn bị loãng): xét từng câu với ngưỡng chặt hơn, để tên riêng không bị coi là tiếng Việt
  return t.split(/[\n.!?;。！？]+/).some((seg) => {
    const s = markStats(seg);
    return s.letters >= 12 && s.marks >= 3 && s.marks / s.letters >= 0.08;
  });
}

const SCRIPT_RE: Record<string, RegExp> = {
  ko: /\p{Script=Hangul}/gu,
  ru: /\p{Script=Cyrillic}/gu,
  uk: /\p{Script=Cyrillic}/gu,
  ar: /\p{Script=Arabic}/gu,
  fa: /\p{Script=Arabic}/gu,
  ur: /\p{Script=Arabic}/gu,
  ps: /\p{Script=Arabic}/gu,
  th: /\p{Script=Thai}/gu,
  hi: /\p{Script=Devanagari}/gu,
  mr: /\p{Script=Devanagari}/gu,
  bn: /\p{Script=Bengali}/gu,
  as: /\p{Script=Bengali}/gu,
  te: /\p{Script=Telugu}/gu,
  kn: /\p{Script=Kannada}/gu,
  ta: /\p{Script=Tamil}/gu,
  my: /\p{Script=Myanmar}/gu,
  am: /\p{Script=Ethiopic}/gu,
  zh: /\p{Script=Han}/gu,
  ja: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu,
};
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u; // không cờ g: .test() với cờ g giữ lastIndex giữa các lần gọi
const NON_TEXT = /\bhttps?:\/\/[^\s)>\]"']+|(?<![\w])@[A-Za-z0-9_]{4,}|⟦\d+⟧/giu; // URL, handle, token bảo vệ: không thuộc ngôn ngữ nào

/**
 * Văn bản có viết bằng CHỮ VIẾT của ngôn ngữ `lang` không? Kiểm tra bằng code, không tốn token; chặn các lỗi hiển nhiên như
 * "dịch sang tiếng Hàn" mà trả tiếng Anh, hoặc "dịch sang tiếng Anh" mà còn chữ Hán/Hàn/Nga. Không phân biệt được các ngôn ngữ
 * cùng chữ Latin (en/es/fr...): riêng tiếng Việt có kiểm tra riêng (`looksVietnamese`). Trả về mô tả lỗi, hoặc null nếu đạt.
 */
export function scriptProblem(text: string, lang: string): string | null {
  const t = text.replace(NON_TEXT, " ");
  const letters = t.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 6) return null; // quá ngắn để kết luận
  const target = SCRIPT_RE[lang];
  if (target) {
    const share = (t.match(target)?.length ?? 0) / letters;
    if (share < 0.3) return `bản dịch không viết bằng chữ của ngôn ngữ đích "${lang}"`;
    if (lang === "zh" && KANA.test(t)) return `bản dịch đích "zh" có chữ Kana (tiếng Nhật)`;
    if (lang === "ja" && !KANA.test(t)) return `bản dịch đích "ja" không có Kana`;
    return null;
  }
  const latin = (t.match(/\p{Script=Latin}/gu)?.length ?? 0) / letters;
  if (latin < 0.7) return `bản dịch còn nhiều chữ không phải Latin trong khi ngôn ngữ đích "${lang}" dùng chữ Latin`;
  return null;
}

/**
 * Ngôn ngữ thật của một đoạn văn (chunk tri thức, câu LLM sinh...). Ưu tiên bằng chứng trong chính văn bản: có dấu tiếng Việt thì là
 * "vi" dù người nạp khai gì; không thì tin lời khai; không có lời khai thì nhận diện, cuối cùng mặc định "en".
 */
export function sourceLangOf(text: string, declared?: string | null): string {
  if (looksVietnamese(text)) return "vi";
  if (declared) return declared;
  // Kho tri thức là tiếng Việt hoặc tiếng Anh. Đoán ngôn ngữ Latin bằng franc không đáng tin (đoạn tiếng Anh từng bị đoán là Hà Lan) và một nhãn sai
  // làm đoạn tiếng Anh bị chặn thay vì gửi, nên chỉ nhận kết quả đoán khi có bằng chứng mạnh: chữ viết không phải Latin, hoặc tiếng Việt không dấu.
  const d = detectLanguage(text);
  return d && (d === "vi" || d in SCRIPT_RE) ? d : DEFAULT_LANGUAGE;
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
