import { normalize } from "./text";

export interface Embedder {
  /** Định danh phiên bản (ghi cùng vector để biết khi nào phải re-index / hiệu chỉnh lại ngưỡng). */
  readonly version: string;
  embed(texts: string[]): Promise<number[][]>;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Embedding cục bộ, xác định (không gọi mạng): băm n-gram ký tự vào vector chuẩn hoá.
 * Đủ dùng để chạy dev/test và làm phương án dự phòng khi dịch vụ embedding lỗi;
 * production nên cấu hình model đa ngôn ngữ thật (bge-m3, voyage-multilingual...).
 */
export class HashEmbedder implements Embedder {
  readonly version: string;
  constructor(private readonly dim = 384) {
    this.version = `local-hash-${dim}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.one(t));
  }

  private one(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    const norm = " " + normalize(text) + " ";
    const add = (gram: string, w: number) => {
      let h = 2166136261;
      for (let i = 0; i < gram.length; i++) {
        h ^= gram.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      v[(h >>> 0) % this.dim]! += w;
    };
    for (let i = 0; i + 3 <= norm.length; i++) add(norm.slice(i, i + 3), 1);
    for (const w of norm.split(" ")) if (w) add("w:" + w, 2);
    const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / len);
  }
}

export function toPgVector(v: number[]): string {
  return `[${v.map((x) => Number(x.toFixed(6))).join(",")}]`;
}
