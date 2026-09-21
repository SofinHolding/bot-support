/**
 * FP-0 — phát hiện private key / seed phrase trong tin nhắn và che dữ liệu nhạy cảm trước khi lưu hay gửi cho LLM.
 * Đây là quy tắc bảo mật: chạy bằng code, không phụ thuộc LLM.
 */
import { wordlist } from "@scure/bip39/wordlists/english.js";

export type KeyLeakPattern = "A" | "B" | "C";

const BIP39 = new Set(wordlist);
const HEX = "[0-9a-fA-F]";

// Pattern A — lệnh kiểu scam: "/wallet 0x...", "/wallet <12|24 từ>", "import/connect wallet 0x<hex dài>"
const A_WALLET_CMD_HEX = new RegExp(`(?:^|\\s)/wallet\\s+0x${HEX}+`, "i");
const A_WALLET_HEX_LONG = new RegExp(`\\bwallet\\s+0x${HEX}{40,}`, "i");
const A_WALLET_WORDS = /(?:^|\s)\/wallet\s+((?:[a-z]+\s+){11}[a-z]+(?:\s+(?:[a-z]+\s+){11}[a-z]+)?)(?:\s|$)/i;

// Pattern B — khoá đứng độc lập
const B_HEX_64 = new RegExp(`\\b0x${HEX}{64}\\b`);
const B_HEX_STANDALONE = new RegExp(`^\\W*0x(?:${HEX}{40}|${HEX}{64})\\W*$`);
const B_WIF = /\b5[JKH][A-Za-z0-9]{49,50}\b/;

interface Run {
  start: number;
  end: number;
  tokens: string[];
}

/** Các dãy token liên tiếp toàn chữ thường 3-8 ký tự, không dấu câu. */
function seedRuns(text: string): Run[] {
  const re = /\S+/g;
  const toks: { t: string; i: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) toks.push({ t: m[0], i: m.index });
  const runs: Run[] = [];
  let cur: { t: string; i: number }[] = [];
  const flush = () => {
    if (cur.length) {
      const last = cur[cur.length - 1]!;
      runs.push({ start: cur[0]!.i, end: last.i + last.t.length, tokens: cur.map((c) => c.t) });
    }
    cur = [];
  };
  for (const tk of toks) {
    if (/^[a-z]{3,8}$/.test(tk.t)) cur.push(tk);
    else flush();
  }
  flush();
  return runs;
}

/** Số từ BIP39 liên tiếp dài nhất trong một dãy. */
function maxBipRun(tokens: string[]): number {
  let best = 0;
  let run = 0;
  for (const t of tokens) {
    if (BIP39.has(t)) best = Math.max(best, ++run);
    else run = 0;
  }
  return best;
}

function isSeedRun(run: Run, wholeMessageTokens: number): boolean {
  // "Có thể match nếu >= 10 từ dạng BIP39 liên tiếp"
  if (maxBipRun(run.tokens) >= 10) return true;
  // Luật gốc: đúng 12 hoặc 24 từ liên tiếp, thường, 3-8 chữ cái, không dấu câu. Để tránh báo nhầm câu hỏi bình thường,
  // chỉ nhận khi dãy chiếm cả tin nhắn và ít nhất một nửa số từ nằm trong danh sách BIP39.
  const n = run.tokens.length;
  if ((n === 12 || n === 24) && wholeMessageTokens === n) {
    const inList = run.tokens.filter((t) => BIP39.has(t)).length;
    return inList / n >= 0.5;
  }
  return false;
}

export function detectKeyLeak(text: string): KeyLeakPattern | null {
  if (A_WALLET_CMD_HEX.test(text) || A_WALLET_HEX_LONG.test(text) || A_WALLET_WORDS.test(text)) return "A";
  if (B_HEX_64.test(text) || B_HEX_STANDALONE.test(text) || B_WIF.test(text)) return "B";
  const total = text.split(/\s+/).filter(Boolean).length;
  for (const run of seedRuns(text)) if (isSeedRun(run, total)) return "C";
  return null;
}

/**
 * Che thông tin nhạy cảm để lưu DB / gửi LLM / hiển thị cho admin.
 * Không phải cơ chế bảo vệ duy nhất (xem detectKeyLeak) mà là lớp cuối trước khi dữ liệu rời bộ nhớ.
 */
export function maskSensitive(text: string): string {
  let out = text;
  out = out.replace(new RegExp(`\\b0x${HEX}{40,}\\b`, "g"), "[REDACTED_KEY]");
  out = out.replace(/\b5[JKH][A-Za-z0-9]{49,50}\b/g, "[REDACTED_KEY]");
  const runs = seedRuns(out)
    .filter((r) => maxBipRun(r.tokens) >= 10)
    .sort((a, b) => b.start - a.start);
  for (const r of runs) out = out.slice(0, r.start) + "[REDACTED_SEED]" + out.slice(r.end);
  // mật khẩu / passcode đi kèm giá trị
  out = out.replace(/\b(password|passcode|mật khẩu|mat khau)\s*[:=]?\s*\S+/gi, "$1 [REDACTED]");
  // email và dãy số dài (Interlink ID, số điện thoại...) không được nằm trong log
  out = out.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[EMAIL]");
  out = out.replace(/\b\d{8,}\b/g, "[NUMBER]");
  return out;
}

export const REDACTED_LOG_TEXT = "[REDACTED - key leak warning sent]";
