import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const EXT: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" };

/** Lưu ảnh khách gửi (có TTL). Ảnh có seed/key KHÔNG bao giờ được lưu (xem pipeline). */
export class MediaStore {
  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {
    mkdirSync(dir, { recursive: true });
  }

  save(mime: string, base64: string): string {
    const day = new Date(this.now()).toISOString().slice(0, 7);
    const sub = join(this.dir, day);
    mkdirSync(sub, { recursive: true });
    const name = `${randomUUID()}${EXT[mime] ?? ".bin"}`;
    writeFileSync(join(sub, name), Buffer.from(base64, "base64"));
    return `${day}/${name}`;
  }

  /** Đường dẫn tuyệt đối an toàn (chặn ../). */
  resolveRef(ref: string): string | null {
    const root = resolve(this.dir);
    const full = resolve(root, ref);
    return full.startsWith(root + sep) && existsSync(full) ? full : null;
  }

  read(ref: string): { data: Buffer; mime: string } | null {
    const p = this.resolveRef(ref);
    if (!p) return null;
    const ext = extname(p).toLowerCase();
    const mime = Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
    return { data: readFileSync(p), mime };
  }

  /** Xoá ảnh cũ hơn `days` ngày. Trả về số file đã xoá. */
  purgeOlderThan(days: number): number {
    const cutoff = this.now() - days * 86_400_000;
    let n = 0;
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (st.mtimeMs < cutoff) {
          unlinkSync(p);
          n++;
        }
      }
    };
    if (existsSync(this.dir)) walk(this.dir);
    return n;
  }
}
