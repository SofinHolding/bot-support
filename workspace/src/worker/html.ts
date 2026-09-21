/** Trích văn bản từ HTML trang whitepaper (đơn giản, không phụ thuộc thư viện). */
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ", "&rsquo;": "’", "&lsquo;": "‘", "&ldquo;": "“", "&rdquo;": "”", "&mdash;": "—", "&ndash;": "–" };

export function htmlToText(html: string): string {
  let s = html
    .replace(/<head[\s\S]*?<\/head>/gi, " ") // <title> lấy riêng bằng pageTitle(), không dính vào đoạn đầu
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)\s*>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&[a-z]+;|&#39;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ");
  return s
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim())
    .filter((p) => p.length > 0)
    .join("\n\n");
}

/** Chia thành các đoạn để so sánh "chỉ lấy phần MỚI hoặc ĐÃ THAY ĐỔI". */
export function paragraphs(text: string, minLen = 40): string[] {
  return text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length >= minLen);
}

export function pageTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? htmlToText(m[1]!).replace(/\s+/g, " ").trim() : null;
}
