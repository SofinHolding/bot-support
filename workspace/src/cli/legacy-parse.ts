/**
 * Đọc các file luật cũ (AGENTS.md, SKILL.md) và trích **nguyên văn** mọi câu trả lời cố định.
 * Dùng cho hai việc: (1) sinh khung kho template lần đầu, (2) kiểm tra đối chiếu (parity)
 * để chắc chắn kho template mới không thiếu hay sai lệch chữ nào so với bản gốc.
 */
import { readFileSync } from "node:fs";

export interface LegacyAnswer {
  file: string;
  line: number;
  heading: string;
  section: string; // heading cấp 2 gần nhất (nhóm)
  keywords: string[];
  text: string;
}

const FENCE = "```";

/** Bỏ cặp dấu ` bao quanh toàn bộ chuỗi (dạng `text` inline của tài liệu cũ). */
function unwrapBackticks(s: string): string | null {
  const t = s.trim();
  if (!t.startsWith("`")) return null;
  // Lấy từ dấu ` đầu tới dấu ` cuối; phần sau (nếu có) chỉ là ghi chú kiểu "(không escalate)".
  const last = t.lastIndexOf("`");
  if (last <= 0) return null;
  const inner = t.slice(1, last);
  if (inner.includes("`")) return null;
  return inner;
}

function collectQuoted(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/`([^`]+)`/g)) out.push(m[1]!.trim());
  for (const m of line.matchAll(/"([^"]+)"/g)) out.push(m[1]!.trim());
  return out;
}

export function extractLegacyAnswers(path: string): LegacyAnswer[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const results: LegacyAnswer[] = [];
  let heading = "";
  let section = "";
  let keywords: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().startsWith(FENCE) && !inFence) {
      // fence không đi kèm mũi tên → bỏ qua cả khối
      inFence = true;
      continue;
    }
    if (inFence) {
      if (line.trim().startsWith(FENCE)) inFence = false;
      continue;
    }

    const h = /^(#{2,4})\s+(.*)$/.exec(line);
    if (h) {
      heading = h[2]!.trim();
      if (h[1] === "##") section = heading;
      keywords = []; // từ khoá chỉ thuộc về mục ngay bên dưới heading của nó
      continue;
    }
    if (/\*\*(Keywords|Match|Image trigger)/i.test(line) || (/^\s*[-*]\s/.test(line) && heading.startsWith("FP-"))) {
      keywords.push(...collectQuoted(line));
      continue;
    }

    const arrow = /^→\s*(.*)$/.exec(line.trim());
    if (!arrow) continue;
    const rest = arrow[1]!;

    if (rest.startsWith(FENCE)) {
      // khối nhiều dòng
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trim().startsWith(FENCE)) {
        body.push(lines[j]!);
        j++;
      }
      results.push({ file: path, line: i + 1, heading, section, keywords: [...keywords], text: body.join("\n").trim() });
      i = j;
      continue;
    }
    const inline = unwrapBackticks(rest);
    if (inline) {
      results.push({ file: path, line: i + 1, heading, section, keywords: [...keywords], text: inline });
    }
  }
  return results;
}

/** Các câu cố định nằm rải rác trong AGENTS.md ngoài mục FAST-PATH (lời chào, lỗi, anti-spam, FP-0). */
export function extractAgentsExtras(path: string): { key: string; text: string }[] {
  const src = readFileSync(path, "utf8").split(/\r?\n/).join("\n");
  const out: { key: string; text: string }[] = [];

  // FP-0: khối code ngay sau "Reply NGUYÊN VĂN"
  const fp0 = /Reply NGUYÊN VĂN[^\n]*\n```\n([\s\S]*?)\n```/.exec(src);
  if (fp0) out.push({ key: "fp-0", text: fp0[1]!.trim() });

  // Thông báo cho owner khi có người lộ khoá (khối code bắt đầu bằng 🚨 FP-0)
  const notice = /```\n(🚨 FP-0 Security Alert triggered[\s\S]*?)\n```/.exec(src);
  if (notice) out.push({ key: "fp-0-owner-notice", text: notice[1]!.trim() });

  // Lời chào có context dở
  const greet = /NGUYÊN VĂN: `(Hi 👋 Your previous topic was[^`]+)`/.exec(src);
  if (greet) out.push({ key: "greeting-returning", text: greet[1]! });

  // Thông báo lỗi kỹ thuật
  const err = /^> `(⚠️ The system is currently[^`]+)`/m.exec(src);
  if (err) out.push({ key: "high-traffic", text: err[1]! });

  // Bảng anti-spam: | 1 | – | `text` |
  for (const m of src.matchAll(/^\|\s*(\d\+?)\s*\|\s*([^|]*)\|\s*`([^`]+)`\s*\|/gm)) {
    out.push({ key: `antispam-${m[1]!.replace("+", "plus")}`, text: m[3]!.trim() });
  }
  return out;
}

/** Lời nhắc trong image-reader và các skill khác có câu cố định. */
export function extractImageReaderExtras(path: string): { key: string; text: string }[] {
  const src = readFileSync(path, "utf8");
  const out: { key: string; text: string }[] = [];
  const unreadable = /GỬI NGUYÊN VĂN: `([^`]+)`/.exec(src);
  if (unreadable) out.push({ key: "image-unreadable", text: unreadable[1]! });
  const cover = /→ `(⚠️ Please cover sensitive[^`]+)`/.exec(src);
  if (cover) out.push({ key: "image-cover-secret", text: cover[1]! });
  return out;
}
