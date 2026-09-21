/** Chuẩn hoá văn bản để so khớp: bỏ dấu tiếng Việt, hạ chữ thường, bỏ dấu câu, gộp khoảng trắng. */
export function normalize(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s/$]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Cụm từ (đã normalize) có xuất hiện trong văn bản (đã normalize) theo ranh giới từ không. */
export function containsPhrase(normText: string, phrase: string): boolean {
  const p = normalize(phrase);
  if (!p) return false;
  if (CJK.test(p)) return normText.includes(p);
  return (" " + normText + " ").includes(" " + p + " ");
}

/**
 * Như containsPhrase nhưng cho phép xen tối đa `maxGap` từ giữa các từ của cụm (theo đúng thứ tự):
 * cụm "delete account" khớp "delete my account", "forgot ID" khớp "forgot my ID". Vẫn xác định, không dùng LLM.
 */
export function containsPhraseLoose(normText: string, phrase: string, maxGap = 2): boolean {
  const p = normalize(phrase);
  if (!p) return false;
  if (CJK.test(p)) return normText.includes(p);
  const pt = p.split(" ");
  if (pt.length < 2) return (" " + normText + " ").includes(" " + p + " ");
  const tt = normText.split(" ");
  for (let i = 0; i < tt.length; i++) {
    if (tt[i] !== pt[0]) continue;
    let pos = i;
    let ok = true;
    for (let k = 1; k < pt.length && ok; k++) {
      let found = -1;
      for (let j = pos + 1; j <= Math.min(pos + 1 + maxGap, tt.length - 1); j++) {
        if (tt[j] === pt[k]) {
          found = j;
          break;
        }
      }
      if (found < 0) ok = false;
      else pos = found;
    }
    if (ok) return true;
  }
  return false;
}

export function wordCount(normText: string): number {
  return normText ? normText.split(" ").length : 0;
}

/** Số ký tự hiển thị (grapheme) — dùng cho luật "tin quá ngắn". */
export function graphemeLength(s: string): number {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let n = 0;
  for (const g of seg.segment(s.trim())) if (g.segment.trim()) n++;
  return n;
}

const EMOJI_ONLY = /^(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s])+$/u;
export function isEmojiOnly(s: string): boolean {
  const t = s.trim();
  return t.length > 0 && EMOJI_ONLY.test(t);
}
