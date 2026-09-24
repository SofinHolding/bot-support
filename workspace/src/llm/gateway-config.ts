/**
 * Cấu hình gateway LLM (9router hoặc bất kỳ endpoint tương thích OpenAI) chỉnh được từ Admin Web, không cần deploy lại.
 * Giá trị hiệu lực = giá trị lưu trong DB nếu có, nếu không thì biến môi trường. Bot, admin và worker là ba tiến trình riêng,
 * nên cả ba đọc lại từ DB theo TTL ngắn thay vì giữ bản sao lúc khởi động.
 */
import { existsSync } from "node:fs";
import type { OpsRepo } from "../db/repo-ops";
import { keyHint, type SecretBox } from "./secret-box";
import { z } from "zod";
import { OpenAICompatProvider } from "./openai-compat";
import type { ModelTier } from "./types";

const K = { baseUrl: "llm.base_url", fast: "llm.model_fast", strong: "llm.model_strong", intake: "llm.model_intake", apiKey: "llm.api_key" } as const;
const MODEL_ID = /^[A-Za-z0-9._\/:@+-]{1,200}$/;

export interface GatewayEnv {
  baseUrl?: string;
  apiKey?: string;
  modelFast: string;
  modelStrong: string;
}

export interface GatewayResolved {
  baseUrl: string;
  apiKey?: string;
  models: Record<ModelTier, string>;
}

type Source = "custom" | "env" | "none";
export interface GatewayView {
  baseUrl: string;
  baseUrlSource: Source;
  hasKey: boolean;
  keyHint: string | null;
  keySource: Source;
  modelFast: string;
  modelFastSource: Source;
  modelStrong: string;
  modelStrongSource: Source;
  /** Chưa cấu hình riêng ("fallback") thì lời gọi tầng intake tự dùng model nhanh — không phải "chưa có" theo nghĩa lỗi. */
  modelIntake: string;
  modelIntakeSource: "custom" | "fallback";
  env: { baseUrl: string; hasKey: boolean; modelFast: string; modelStrong: string };
  /** false khi thiếu SECRETS_KEY: không thể lưu khoá API từ web (vẫn dùng được khoá trong biến môi trường). */
  canStoreKey: boolean;
}

export class GatewayConfigError extends Error {}

export function normalizeBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new GatewayConfigError("URL không hợp lệ");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new GatewayConfigError("URL phải bắt đầu bằng http:// hoặc https://");
  if (u.username || u.password) throw new GatewayConfigError("Không đặt tên đăng nhập/mật khẩu trong URL; dùng ô khoá API");
  // Bot/admin/worker chạy trong Docker: "localhost" là chính container, không phải máy chủ. Sự cố thật đã gặp: admin lưu
  // http://localhost:20128 -> mọi lời gọi AI lỗi kết nối, bot âm thầm rơi về luồng từ khoá và chuyển nhân viên câu "chào bạn".
  if (runningInDocker() && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname)) {
    throw new GatewayConfigError(`Hệ thống đang chạy trong Docker: "${u.hostname}" trỏ vào chính container, không tới máy chủ. Dùng http://host.docker.internal:${u.port || (u.protocol === "https:" ? 443 : 80)}${u.pathname.replace(/\/+$/, "")} (hoặc địa chỉ IP của máy chủ)`);
  }
  return u.toString().replace(/\/+$/, "");
}

let dockerCached: boolean | undefined;
/** Tiến trình đang chạy trong container Docker? (có /.dockerenv, hoặc DOCKER_CONTAINER=1) */
export function runningInDocker(): boolean {
  if (dockerCached === undefined) {
    try {
      dockerCached = process.env.DOCKER_CONTAINER === "1" || existsSync("/.dockerenv");
    } catch {
      dockerCached = false;
    }
  }
  return dockerCached;
}

export class GatewayConfig {
  private cache: { at: number; view: GatewayView; resolved: GatewayResolved | null; conn: { baseUrl: string; apiKey?: string } | null } | null = null;

  constructor(
    private readonly ops: OpsRepo,
    private readonly env: GatewayEnv,
    private readonly box: SecretBox | null,
    private readonly ttlMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Đồng bộ, theo lần đọc gần nhất: dùng để quyết định bot có chạy chế độ template thuần hay không. */
  get ready(): boolean {
    return !!this.cache?.resolved;
  }

  invalidate() {
    this.cache = null;
  }

  async resolve(): Promise<GatewayResolved | null> {
    return (await this.load()).resolved;
  }

  /** URL + khoá, không đòi phải có model: dùng để lấy danh sách model khi mới cấu hình. */
  async connection(): Promise<{ baseUrl: string; apiKey?: string } | null> {
    return (await this.load()).conn;
  }

  async view(): Promise<GatewayView> {
    return (await this.load()).view;
  }

  private async load() {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache;
    const stored = await this.ops.getSettings();
    const str = (k: string) => (typeof stored[k] === "string" && (stored[k] as string).trim() ? (stored[k] as string).trim() : undefined);
    const enc = await this.ops.getSecret(K.apiKey);
    const customKey = enc && this.box ? this.box.decrypt(enc) : null;

    const baseUrl = str(K.baseUrl) ?? this.env.baseUrl?.trim() ?? "";
    const apiKey = customKey ?? (this.env.apiKey || undefined);
    const fast = str(K.fast) ?? this.env.modelFast;
    const strong = str(K.strong) ?? this.env.modelStrong;
    const intakeCustom = str(K.intake);
    const intake = intakeCustom ?? fast; // chưa cấu hình riêng -> dùng chung model nhanh (chung quota với bot)
    const view: GatewayView = {
      baseUrl,
      baseUrlSource: str(K.baseUrl) ? "custom" : baseUrl ? "env" : "none",
      hasKey: !!apiKey,
      keyHint: apiKey ? keyHint(apiKey) : null,
      keySource: customKey ? "custom" : apiKey ? "env" : "none",
      modelFast: fast,
      modelFastSource: str(K.fast) ? "custom" : "env",
      modelStrong: strong,
      modelStrongSource: str(K.strong) ? "custom" : "env",
      modelIntake: intake,
      modelIntakeSource: intakeCustom ? "custom" : "fallback",
      env: { baseUrl: this.env.baseUrl ?? "", hasKey: !!this.env.apiKey, modelFast: this.env.modelFast, modelStrong: this.env.modelStrong },
      canStoreKey: !!this.box,
    };
    const resolved: GatewayResolved | null = baseUrl && fast && strong ? { baseUrl, apiKey, models: { fast, strong, intake } } : null;
    this.cache = { at: this.now(), view, resolved, conn: baseUrl ? { baseUrl, apiKey } : null };
    return this.cache;
  }

  /** Chuỗi rỗng = quay về giá trị trong biến môi trường. undefined = giữ nguyên. */
  async saveModels(m: { fast?: string; strong?: string; intake?: string }, by: string) {
    for (const [tier, v] of [["fast", m.fast], ["strong", m.strong], ["intake", m.intake]] as const) {
      if (v === undefined) continue;
      const key = tier === "fast" ? K.fast : tier === "strong" ? K.strong : K.intake;
      if (v.trim() === "") await this.ops.deleteSetting(key);
      else {
        if (!MODEL_ID.test(v.trim())) throw new GatewayConfigError(`tên model không hợp lệ: ${tier}`);
        await this.ops.setSetting(key, v.trim(), by);
      }
    }
    this.invalidate();
    await this.load(); // nạp lại ngay để `ready` không chớp tắt
  }

  /** `baseUrl`/`apiKey`: chuỗi rỗng = quay về biến môi trường; undefined = giữ nguyên. */
  async saveConnection(c: { baseUrl?: string; apiKey?: string }, by: string) {
    if (c.baseUrl !== undefined) {
      if (c.baseUrl.trim() === "") await this.ops.deleteSetting(K.baseUrl);
      else await this.ops.setSetting(K.baseUrl, normalizeBaseUrl(c.baseUrl), by);
    }
    if (c.apiKey !== undefined) {
      if (c.apiKey.trim() === "") await this.ops.deleteSecret(K.apiKey);
      else {
        if (!this.box) throw new GatewayConfigError("Chưa đặt SECRETS_KEY trên máy chủ nên không thể lưu khoá API từ web. Đặt SECRETS_KEY (chuỗi ngẫu nhiên ≥ 32 ký tự) hoặc dùng LLM_API_KEY trong .env");
        await this.ops.setSecret(K.apiKey, this.box.encrypt(c.apiKey.trim()), by);
      }
    }
    this.invalidate();
    await this.load(); // nạp lại ngay để `ready` không chớp tắt
  }
}

/** Danh sách model mà gateway đang cung cấp (GET {baseUrl}/models). Dùng để điền ô chọn model trên web. */
export async function listGatewayModels(g: Pick<GatewayResolved, "baseUrl" | "apiKey">, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(`${g.baseUrl}/models`, {
    headers: g.apiKey ? { authorization: `Bearer ${g.apiKey}` } : {},
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new GatewayConfigError(`gateway trả về ${res.status} khi lấy danh sách model`);
  const body = (await res.json()) as { data?: { id?: unknown }[] };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string").sort();
}

/** "status 400: {"error":{"message":"[400]: {\"detail\":\"...\"}"}}" -> "400: ..." (câu người đọc được, giữ nguyên nếu không đúng dạng). */
export function friendlyGatewayError(raw: string): string {
  const m = /^status (\d+): ([\s\S]*)$/.exec(raw);
  if (!m) return raw.slice(0, 300);
  let text = m[2]!;
  try {
    const j = JSON.parse(text) as { error?: string | { message?: string } };
    text = String(typeof j.error === "string" ? j.error : (j.error?.message ?? text));
    const inner = /^\[\d+\]:\s*(\{[\s\S]*\})$/.exec(text);
    if (inner) {
      const d = JSON.parse(inner[1]!) as { detail?: string; message?: string };
      text = d.detail ?? d.message ?? text;
    }
  } catch {
    /* giữ nguyên */
  }
  return `${m[1]}: ${text}`.slice(0, 300);
}

export interface GatewayTestResult {
  ok: boolean;
  model: string;
  latencyMs: number;
  error?: string;
}

/** Gọi thử một lời gọi tối thiểu (khoảng vài chục token) tới model của tầng đã chọn, đúng đường mà bot dùng: cùng endpoint, cùng kiểu JSON. */
export async function testGateway(g: GatewayResolved, tier: ModelTier, fetchImpl?: typeof fetch): Promise<GatewayTestResult> {
  const provider = new OpenAICompatProvider({ ...g, fetchImpl, timeoutMs: 20_000 }, "gateway-test");
  const started = Date.now();
  try {
    const r = await provider.generateJson({
      tier,
      purpose: "classify",
      system: [{ text: 'Reply with the JSON object {"ok": true} and nothing else.' }],
      user: [{ type: "text", text: "ping" }],
      schema: z.object({ ok: z.boolean() }),
      maxTokens: 30,
    });
    return { ok: true, model: r.model, latencyMs: r.latencyMs };
  } catch (e) {
    return { ok: false, model: g.models[tier], latencyMs: Date.now() - started, error: friendlyGatewayError((e as Error).message) };
  }
}
