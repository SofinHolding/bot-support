/**
 * Tài liệu tri thức (GROUNDED_GENERATION): frontmatter YAML + markdown, chunk theo heading.
 *
 *   ---
 *   slug: whitepaper-data
 *   title: InterLink Whitepaper Data
 *   response_mode: GROUNDED_GENERATION
 *   lang: vi                  # ngôn ngữ của tài liệu (vi | en). Bot dịch sang ngôn ngữ của khách khi trả lời; không khai thì tự nhận diện
 *   source_url: https://whitepaper.interlinklabs.ai
 *   section_links:            # tuỳ chọn: heading chứa cụm này -> gắn link này
 *     - { match: "InterLink Token ($ITL)", url: https://... }
 *   ---
 */
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { ParseIssue } from "../domain/types";
import { sourceLangOf } from "./language";
import { normalize } from "./text";

export interface KnowledgeChunk {
  index: number;
  heading: string;
  text: string;
  url?: string;
  searchText: string;
  /** sha1 của `text` (câu gửi khách): khoá của bản dịch đã lưu */
  hash: string;
  /** Câu dùng để tính vector: như `text` nhưng mang đủ đường dẫn tiêu đề "A › B" (đoạn của mục con không mất ngữ cảnh mục cha) */
  embedText: string;
  /** Ngôn ngữ THẬT của đoạn (vi | en | ...): quyết định có phải dịch trước khi gửi khách hay không */
  lang: string;
}

/**
 * Câu dùng để tính vector của một đoạn. `text` (câu gửi khách) chỉ mở đầu bằng tiêu đề lá; đoạn thuộc mục con ("A › B") được
 * embed kèm đủ đường dẫn để câu hỏi về "A" vẫn tìm tới đoạn "B". Đoạn của mục cấp cao nhất: đúng bằng `text`.
 */
export function chunkEmbedText(heading: string, text: string): string {
  if (!heading.includes(" › ")) return text;
  const i = text.indexOf("\n\n");
  return `${heading}\n\n${i >= 0 ? text.slice(i + 2) : text}`;
}

export interface KnowledgeDoc {
  slug: string;
  title: string;
  responseMode: "GROUNDED_GENERATION";
  /** Ngôn ngữ người nạp khai trong frontmatter (`lang: vi`); có thể không có */
  lang?: string;
  sourceUrl?: string;
  chunks: KnowledgeChunk[];
}

export const MAX_CHUNK_CHARS = 1800;

const stopwords = new Set(["the", "a", "an", "is", "are", "of", "to", "in", "and", "or", "for", "what", "how", "why", "when", "do", "does", "i", "me", "my", "you", "it", "this", "that", "with", "about", "on", "be", "can", "will", "there", "la", "va", "cua", "cho", "voi", "co", "khong", "nay", "the"]);

export function contentTokens(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((w) => w.length > 1 && !stopwords.has(w));
}

export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex");
}

function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n{2,}/)) {
    if (cur && (cur + "\n\n" + para).length > MAX_CHUNK_CHARS) {
      out.push(cur);
      cur = para;
    } else cur = cur ? cur + "\n\n" + para : para;
  }
  if (cur) out.push(cur);
  return out;
}

export function parseKnowledgeDoc(md: string, fallbackSlug?: string): { doc?: KnowledgeDoc; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];
  const text = md.replace(/\r\n/g, "\n");
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.trimStart());
  let meta: Record<string, unknown> = {};
  let body = text;
  if (fm) {
    try {
      meta = (parseYaml(fm[1]!) ?? {}) as Record<string, unknown>;
    } catch (e) {
      issues.push({ level: "error", message: `YAML không hợp lệ: ${(e as Error).message}` });
      return { issues };
    }
    body = fm[2]!;
  } else {
    issues.push({ level: "warning", message: "không có frontmatter; dùng slug mặc định" });
  }
  const slug = String(meta.slug ?? fallbackSlug ?? "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    issues.push({ level: "error", message: "slug thiếu hoặc không hợp lệ" });
    return { issues };
  }
  const mode = String(meta.response_mode ?? "GROUNDED_GENERATION");
  if (mode !== "GROUNDED_GENERATION") {
    issues.push({ level: "error", message: `tài liệu tri thức phải có response_mode: GROUNDED_GENERATION (đang là ${mode})` });
    return { issues };
  }
  const declaredRaw = meta.lang === undefined || meta.lang === null ? undefined : String(meta.lang).trim().toLowerCase();
  if (declaredRaw !== undefined && !/^[a-z]{2}$/.test(declaredRaw)) {
    issues.push({ level: "error", message: `lang không hợp lệ: "${declaredRaw}" (dùng mã 2 chữ cái như vi, en)` });
    return { issues };
  }
  const declared = declaredRaw;
  const sourceUrl = meta.source_url ? String(meta.source_url) : undefined;
  const links = Array.isArray(meta.section_links) ? (meta.section_links as { match: string; url: string }[]) : [];

  const lines = body.split("\n");
  const sections: { heading: string; lines: string[] }[] = [];
  let h2 = "";
  let cur: { heading: string; lines: string[] } | null = null;
  let inFence = false;
  for (const line of lines) {
    if (line.trim().startsWith("```")) inFence = !inFence;
    const h = !inFence ? /^(#{2,3})\s+(.*?)\s*$/.exec(line) : null;
    if (h) {
      if (cur) sections.push(cur);
      const title = h[2]!.replace(/[*_`]/g, "").trim();
      if (h[1] === "##") h2 = title;
      cur = { heading: h[1] === "##" ? title : `${h2} › ${title}`, lines: [] };
      continue;
    }
    if (!cur) cur = { heading: String(meta.title ?? slug), lines: [] };
    cur.lines.push(line);
  }
  if (cur) sections.push(cur);

  const chunks: KnowledgeChunk[] = [];
  for (const s of sections) {
    const bodyText = s.lines.join("\n").replace(/^\s+|\s+$/g, "");
    if (bodyText.length < 20) continue; // chỉ có heading
    const leaf = s.heading.split(" › ").pop()!;
    const link = links.find((l) => normalize(s.heading).includes(normalize(l.match)))?.url ?? sourceUrl;
    for (const part of splitLong(bodyText)) {
      const full = `${leaf}\n\n${part}`;
      chunks.push({
        index: chunks.length,
        heading: s.heading,
        text: full,
        url: link,
        searchText: normalize(`${s.heading} ${part}`),
        hash: sha1(full),
        embedText: chunkEmbedText(s.heading, full),
        lang: sourceLangOf(full, declared),
      });
    }
  }
  if (!chunks.length) issues.push({ level: "error", message: "tài liệu không có nội dung để chunk (cần các mục ## / ###)" });
  else {
    const counts = new Map<string, number>();
    for (const c of chunks) counts.set(c.lang, (counts.get(c.lang) ?? 0) + 1);
    const summary = [...counts].map(([l, n]) => `${l}: ${n}`).join(", ");
    const other = declared ? chunks.filter((c) => c.lang !== declared).length : 0;
    if (declared && other) issues.push({ level: "warning", message: `tài liệu khai lang: ${declared} nhưng ${other}/${chunks.length} đoạn có vẻ thuộc ngôn ngữ khác (${summary})` });
    else if (!declared && counts.size > 1) issues.push({ level: "warning", message: `tài liệu trộn nhiều ngôn ngữ (${summary}); nên khai lang trong frontmatter hoặc tách tài liệu` });
  }
  return { doc: { slug, title: String(meta.title ?? slug), responseMode: "GROUNDED_GENERATION", lang: declared, sourceUrl, chunks }, issues };
}
