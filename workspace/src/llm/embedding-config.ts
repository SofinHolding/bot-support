/**
 * Cấu hình dịch vụ embedding NGOÀI (API tương thích OpenAI `/embeddings`, vd platform.beeknoee.com với gemini-embedding-001),
 * chỉnh từ Admin Web như gateway LLM: owner đặt URL + khoá (khoá mã hoá bằng SECRETS_KEY), admin đổi model.
 * Người vận hành CHỌN đúng một model để dùng (`embedding.provider`): "external" (API) hoặc "local" (TEI/bge-m3 trong .env).
 * Không có dự phòng ngầm. API lỗi hẳn -> hệ thống tự chuyển hẳn sang "local" và KHOÁ lựa chọn API (`embedding.lock`) cho
 * tới khi admin kiểm tra và mở khoá thủ công (xem SelectedEmbedder và app.ts).
 */
import type { OpsRepo } from "../db/repo-ops";
import type { EmbeddingProvider, EmbeddingSelection } from "./embedder";
import { GatewayConfigError, normalizeBaseUrl } from "./gateway-config";
import { keyHint, type SecretBox } from "./secret-box";

const K = { baseUrl: "embedding.base_url", model: "embedding.model", apiKey: "embedding.api_key", dims: "embedding.dimensions", provider: "embedding.provider", lock: "embedding.lock", taskType: "embedding.task_type" } as const;
const MODEL_ID = /^[A-Za-z0-9._\/:@+-]{1,200}$/;

export interface EmbeddingResolved {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Số chiều yêu cầu (nếu API hỗ trợ `dimensions`), undefined = mặc định của model */
  dimensions?: number;
  /** true = dịch vụ nhận tham số `task_type` (API Gemini gốc); gateway chỉ tương thích OpenAI thì để false (mặc định). */
  taskType?: boolean;
}

export interface EmbeddingView {
  baseUrl: string;
  model: string;
  dimensions: number | null;
  hasKey: boolean;
  keyHint: string | null;
  canStoreKey: boolean;
  /** true = đủ URL + model: có thể chọn dịch vụ ngoài */
  configured: boolean;
  /** model đang được CHỌN để dùng (đã tính cả khoá: bị khoá thì luôn là local) */
  provider: EmbeddingProvider;
  /** lựa chọn admin đã lưu (có thể là external trong khi hiệu lực là local vì bị khoá) */
  storedProvider: EmbeddingProvider | null;
  locked: boolean;
  lockReason: string | null;
  lockedAt: string | null;
}

interface Lock {
  reason: string;
  at: string;
}

export class EmbeddingConfig {
  private cache: { at: number; resolved: EmbeddingResolved | null; view: EmbeddingView; selection: EmbeddingSelection } | null = null;

  constructor(
    private readonly ops: OpsRepo,
    private readonly box: SecretBox | null,
    private readonly ttlMs = 10_000,
    private readonly now: () => number = Date.now,
    private readonly fallbackApiKey?: string,
  ) {}

  invalidate() {
    this.cache = null;
  }

  async resolve(): Promise<EmbeddingResolved | null> {
    return (await this.load()).resolved;
  }

  async view(): Promise<EmbeddingView> {
    return (await this.load()).view;
  }

  private async load() {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache;
    const stored = await this.ops.getSettings();
    const str = (k: string) => (typeof stored[k] === "string" && (stored[k] as string).trim() ? (stored[k] as string).trim() : undefined);
    const enc = await this.ops.getSecret(K.apiKey);
    const storedApiKey = enc && this.box ? (this.box.decrypt(enc) ?? undefined) : undefined;
    // Headless/CI deployments may provide the credential through EMBEDDING_API_KEY.
    // An encrypted DB secret, when present and decryptable, remains authoritative.
    const apiKey = storedApiKey ?? (this.fallbackApiKey?.trim() || undefined);
    const baseUrl = str(K.baseUrl) ?? "";
    const model = str(K.model) ?? "";
    const dimsRaw = Number(stored[K.dims]);
    const dimensions = Number.isInteger(dimsRaw) && dimsRaw > 0 ? dimsRaw : undefined;
    const configured = !!baseUrl && !!model;
    const lockRaw = stored[K.lock];
    const lock: Lock | null = lockRaw && typeof lockRaw === "object" && typeof (lockRaw as Lock).reason === "string" ? (lockRaw as Lock) : null;
    const storedProvider: EmbeddingProvider | null = stored[K.provider] === "external" || stored[K.provider] === "local" ? (stored[K.provider] as EmbeddingProvider) : null;
    // Hiệu lực: bị khoá -> local; chưa cấu hình API -> local; chưa chọn -> external nếu đã cấu hình (giữ hành vi cũ: API là chính)
    const provider: EmbeddingProvider = lock || !configured ? "local" : (storedProvider ?? "external");
    const taskType = stored[K.taskType] === true;
    const resolved: EmbeddingResolved | null = configured ? { baseUrl, apiKey, model, dimensions, ...(taskType ? { taskType } : {}) } : null;
    const view: EmbeddingView = {
      baseUrl, model, dimensions: dimensions ?? null, hasKey: !!apiKey, keyHint: apiKey ? keyHint(apiKey) : null, canStoreKey: !!this.box, configured,
      provider, storedProvider, locked: !!lock, lockReason: lock?.reason ?? null, lockedAt: lock?.at ?? null,
    };
    const selection: EmbeddingSelection = { provider, external: resolved ? { url: resolved.baseUrl, apiKey: resolved.apiKey, model: resolved.model, dimensions: resolved.dimensions, taskType: resolved.taskType } : null };
    this.cache = { at: this.now(), resolved, view, selection };
    return this.cache;
  }

  /** Lựa chọn hiệu lực cho SelectedEmbedder (đã tính khoá và tình trạng cấu hình). */
  async selection(): Promise<EmbeddingSelection> {
    return (await this.load()).selection;
  }

  /** Admin chọn model. Chọn API khi đang bị khoá hoặc chưa cấu hình -> từ chối với lý do rõ. */
  async setProvider(p: EmbeddingProvider, by: string) {
    const { view } = await this.load();
    if (p === "external") {
      if (view.locked) throw new GatewayConfigError("Lựa chọn API đang bị KHOÁ sau sự cố. Kiểm tra lại URL/khoá rồi bấm \"Thử API & mở khoá\" trước.");
      if (!view.configured) throw new GatewayConfigError("Chưa cấu hình URL + model của dịch vụ embedding ngoài.");
    }
    await this.ops.setSetting(K.provider, p, by);
    this.invalidate();
    await this.load();
  }

  /** Hệ thống gọi khi API lỗi hẳn: chuyển hẳn sang local và khoá lựa chọn API. Lặp lại an toàn (không ghi đè lý do đầu tiên). */
  async lockExternal(reason: string, at: Date = new Date()) {
    const { view } = await this.load();
    if (!view.locked) await this.ops.setSetting(K.lock, { reason: reason.slice(0, 300), at: at.toISOString() } satisfies Lock, "system");
    await this.ops.setSetting(K.provider, "local", "system");
    this.invalidate();
    await this.load();
  }

  /** Admin đã kiểm tra API thành công: bỏ khoá. KHÔNG tự chuyển lại API — admin chọn lại rõ ràng. */
  async unlockExternal() {
    await this.ops.deleteSetting(K.lock);
    this.invalidate();
    await this.load();
  }

  /** Chuỗi rỗng = xoá (quay về chỉ dùng embedder cục bộ). undefined = giữ nguyên. */
  async save(c: { baseUrl?: string; apiKey?: string; model?: string; dimensions?: number | null }, by: string) {
    if (c.baseUrl !== undefined) {
      if (c.baseUrl.trim() === "") await this.ops.deleteSetting(K.baseUrl);
      else await this.ops.setSetting(K.baseUrl, normalizeBaseUrl(c.baseUrl), by);
    }
    if (c.apiKey !== undefined) {
      if (c.apiKey.trim() === "") await this.ops.deleteSecret(K.apiKey);
      else {
        if (!this.box) throw new GatewayConfigError("Chưa đặt SECRETS_KEY trên máy chủ nên không thể lưu khoá API từ web");
        await this.ops.setSecret(K.apiKey, this.box.encrypt(c.apiKey.trim()), by);
      }
    }
    if (c.model !== undefined) {
      if (c.model.trim() === "") await this.ops.deleteSetting(K.model);
      else {
        if (!MODEL_ID.test(c.model.trim())) throw new GatewayConfigError("tên model không hợp lệ");
        await this.ops.setSetting(K.model, c.model.trim(), by);
      }
    }
    if (c.dimensions !== undefined) {
      if (c.dimensions === null || c.dimensions <= 0) await this.ops.deleteSetting(K.dims);
      else if (!Number.isInteger(c.dimensions) || c.dimensions > 16000) throw new GatewayConfigError("số chiều phải là số nguyên 1..16000");
      else await this.ops.setSetting(K.dims, c.dimensions, by);
    }
    this.invalidate();
    await this.load();
  }
}
