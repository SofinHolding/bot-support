/** Mã hoá bí mật lưu trong DB bằng AES-256-GCM; khoá lấy từ biến môi trường SECRETS_KEY (không nằm trong DB). */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash("sha256").update(secret).digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
  }

  /** Trả null khi sai khoá hoặc dữ liệu hỏng: bên gọi coi như chưa có bí mật thay vì làm sập tiến trình. */
  decrypt(blob: string): string | null {
    const [v, iv, tag, ct] = blob.split(".");
    if (v !== "v1" || !iv || !tag || !ct) return null;
    try {
      const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
      d.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}

/** Gợi ý để nhận ra khoá đang lưu mà không lộ nó: 4 ký tự cuối. */
export const keyHint = (k: string) => (k.length > 8 ? `••••${k.slice(-4)}` : "••••");
