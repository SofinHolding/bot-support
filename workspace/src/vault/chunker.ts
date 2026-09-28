/**
 * Chunk thân note theo chuỗi ưu tiên (trang Notion "Xây dựng bộ nhớ LLM" mục 3), dừng ở bước đầu tiên cho chunk đủ nhỏ:
 *   1. thân ≤ ~800 token: giữ nguyên 1 chunk (note atomic thường dừng ở đây);
 *   2. cắt theo heading ##/###;
 *   3. phần còn dài: cắt theo đoạn, gộp đoạn < ~100 token vào đoạn liền kề;
 *   4. đoạn vẫn dài, không cấu trúc: semantic breakpoint (cắt ở 20% điểm tương đồng thấp nhất giữa các câu liền kề);
 *   5. lưới an toàn: cắt theo độ dài, chồng lấn ~12%.
 * Token ước lượng = số ký tự / 3 (chưa đo riêng cho tiếng Việt). Ngưỡng là điểm xuất phát, chỉnh sau khi thử dữ liệu thật.
 */
import { cosine } from "../core/embedding";

export const MAX_TOKENS = 800;
export const MIN_TOKENS = 100;
const OVERLAP = 0.12;
const PERCENTILE = 20;

export const tokens = (text: string) => Math.max(1, Math.ceil(text.length / 3));

export interface Chunk {
  /** heading của phần (không có dấu #); rỗng nếu note một ý không có heading */
  heading: string;
  /** chữ gốc của chunk, heading ở dòng đầu dạng chữ thường (không có dấu #) */
  text: string;
}

/** Vector từng câu, chỉ để tìm điểm cắt rồi bỏ. Không có (hoặc lỗi) thì bỏ qua bước 4, cắt theo độ dài. */
export type SentenceEmbedder = (sentences: string[]) => Promise<number[][]>;

export function splitByHeading(body: string): string[] {
  return body.split(/^(?=#{2,3}\s)/m).map((p) => p.trim()).filter(Boolean);
}

const splitByParagraph = (text: string) => text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const splitSentences = (text: string) => text.split(/(?<=[.!?。])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

export function mergeTiny(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last !== undefined && (tokens(last) < MIN_TOKENS || tokens(p) < MIN_TOKENS) && tokens(last) + tokens(p) <= MAX_TOKENS) out[out.length - 1] = `${last}\n\n${p}`;
    else out.push(p);
  }
  return out;
}

export function hardCut(text: string): string[] {
  const size = MAX_TOKENS * 3;
  const step = Math.floor(size * (1 - OVERLAP));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += step) {
    out.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
  }
  return out;
}

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
}

export async function semanticSplit(text: string, embed?: SentenceEmbedder): Promise<string[]> {
  const sents = splitSentences(text);
  if (sents.length < 3 || !embed) return hardCut(text);
  let vecs: number[][];
  try {
    vecs = await embed(sents);
  } catch {
    return hardCut(text);
  }
  const sims = vecs.slice(0, -1).map((v, i) => cosine(v, vecs[i + 1]!));
  const cut = percentile(sims, PERCENTILE);
  const chunks: string[] = [];
  let cur = [sents[0]!];
  sims.forEach((sim, i) => {
    const next = sents[i + 1]!;
    const tooBig = tokens([...cur, next].join(" ")) > MAX_TOKENS;
    if ((sim <= cut && tokens(cur.join(" ")) >= MIN_TOKENS) || tooBig) {
      chunks.push(cur.join(" "));
      cur = [next];
    } else cur.push(next);
  });
  chunks.push(cur.join(" "));
  return chunks;
}

async function splitLong(part: string, embed?: SentenceEmbedder): Promise<string[]> {
  const out: string[] = [];
  for (const para of splitByParagraph(part)) {
    if (tokens(para) <= MAX_TOKENS) {
      out.push(para);
      continue;
    }
    for (const c of await semanticSplit(para, embed)) out.push(...(tokens(c) <= MAX_TOKENS ? [c] : hardCut(c)));
  }
  return mergeTiny(out);
}

/** "## Tiêu đề\n\nnội dung" -> { heading: "Tiêu đề", text: "Tiêu đề\n\nnội dung" }; heading ### con giữ dạng chữ thường. */
function toChunk(part: string, fallbackHeading: string): Chunk {
  const m = /^#{2,3}\s+(.+)$/m.exec(part);
  const heading = m && part.trimStart().startsWith("#") ? m[1]!.trim() : fallbackHeading;
  return { heading, text: part.replace(/^#{2,3}\s+/gm, "").trim() };
}

export async function chunkBody(body: string, embed?: SentenceEmbedder): Promise<Chunk[]> {
  const b = body.trim();
  if (!b) return [];
  if (tokens(b) <= MAX_TOKENS) return [toChunk(b, "")];
  const parts: string[] = [];
  let heading = "";
  for (const part of splitByHeading(b)) {
    const h = /^#{2,3}\s+(.+)$/m.exec(part);
    if (h && part.startsWith("#")) heading = h[1]!.trim();
    if (tokens(part) <= MAX_TOKENS) parts.push(part);
    else {
      // phần dài bị cắt tiếp: mọi mảnh vẫn mang heading của phần để đọc riêng vẫn hiểu
      const pieces = await splitLong(part, embed);
      pieces.forEach((p, i) => parts.push(i === 0 || !heading ? p : `## ${heading}\n\n${p}`));
    }
  }
  return mergeTiny(parts).map((p) => toChunk(p, ""));
}

/** Kiểm tra chất lượng sau mỗi lượt index (mục 8 trang Notion). Lời thường, cho admin đọc. */
export function chunkWarnings(title: string, body: string, chunks: Chunk[]): string[] {
  const w: string[] = [];
  if (tokens(body) > MAX_TOKENS && !/^#{2,3}\s/m.test(body)) w.push(`"${title}" dài mà không có heading: nên chia thành các mục ## để tìm kiếm chính xác hơn`);
  if (chunks.length > 1 && chunks.some((c) => tokens(c.text) < MIN_TOKENS)) w.push(`"${title}" có đoạn quá ngắn sau khi cắt: nên gộp các mục chỉ có một câu`);
  if (chunks.some((c) => tokens(c.text) > MAX_TOKENS * 1.2)) w.push(`"${title}" có đoạn quá dài: nên chia nhỏ nội dung`);
  const sections = splitByHeading(body).filter((p) => p.startsWith("#"));
  if (sections.length >= 3 && sections.every((s) => s.replace(/^#{2,3}\s+.+$/m, "").trim().split(/(?<=[.!?])\s+/).length <= 1)) w.push(`"${title}" có nhiều heading nhưng mỗi mục chỉ một câu: nên gộp lại`);
  return w;
}
