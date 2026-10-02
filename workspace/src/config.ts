import { z } from "zod";

const csvNumbers = (s: string | undefined) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));

const Env = z.object({
  DATABASE_URL: z.string().default("pglite:./data/pgdata"),
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  TELEGRAM_MODE: z.enum(["webhook", "polling"]).default("polling"),
  PUBLIC_BOT_URL: z.string().optional(), // https://bot.example.com  (để đặt webhook)
  BOT_PORT: z.coerce.number().default(3000),

  ADMIN_PORT: z.coerce.number().default(3001),
  PUBLIC_ADMIN_URL: z.string().default("http://localhost:3001"),
  ADMIN_TELEGRAM_IDS: z.string().optional(), // danh sách ID admin (seed lần đầu)
  OWNER_TELEGRAM_ID: z.string().optional(), // owner nhận cảnh báo (Anh Phi)
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"), // true khi Admin API nằm sau reverse proxy

  // LLM chính: gateway tương thích OpenAI (9router). Các giá trị này là mặc định; Admin Web có thể ghi đè (lưu trong DB).
  LLM_BASE_URL: z.string().optional(), // vd http://localhost:20128/v1
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL_FAST: z.string().default(""), // phân loại tầng 2, vision, tóm tắt
  LLM_MODEL_STRONG: z.string().default(""), // dịch template, tri thức tầng 3
  /** JSON map model -> token rates USD/1M. cacheRead/cacheWrite chỉ khai báo khi provider đã xác minh rate riêng. */
  LLM_PRICING_JSON: z.string().optional(),
  SECRETS_KEY: z.string().min(32, "SECRETS_KEY phải dài ≥ 32 ký tự").optional(), // khoá mã hoá bí mật lưu trong DB (khoá API nhập từ web)
  // Dự phòng tuỳ chọn: gọi thẳng API Anthropic khi gateway lỗi
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  ANTHROPIC_MODEL_FAST: z.string().default("claude-haiku-4-5"),
  ANTHROPIC_MODEL_STRONG: z.string().default("claude-opus-5"),

  EMBEDDING_URL: z.string().optional(), // endpoint tương thích OpenAI /embeddings
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().optional(),

  // Migration có kiểm soát sang Python + RAGFlow. Mặc định legacy để rollback tức thì; shadow chỉ quan sát.
  KNOWLEDGE_SERVICE_URL: z.string().optional(), // vd http://knowledge-api:3010
  INTERNAL_SERVICE_TOKEN: z.string().optional(),
  RETRIEVAL_PROVIDER: z.enum(["legacy", "shadow", "python"]).default("legacy"),

  MEDIA_DIR: z.string().default("./data/media"),
  CONTENT_DIR: z.string().default("content"),
  // Vault Obsidian (note tri thức đã chuẩn hoá) và thư mục lưu file thô admin tải lên (docs/adr/0005)
  VAULT_DIR: z.string().default("knowledge"),
  RAW_DATA_DIR: z.string().default("raw-data"),
});

export type Config = ReturnType<typeof loadConfig>;

function parsePricing(raw: string | undefined): Record<string, { in: number; out: number; cacheRead?: number; cacheWrite?: number }> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`LLM_PRICING_JSON không phải JSON hợp lệ: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("LLM_PRICING_JSON phải là object model -> {in,out}");
  const out: Record<string, { in: number; out: number; cacheRead?: number; cacheWrite?: number }> = {};
  for (const [model, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`pricing ${model} phải là {in,out}`);
    const p = value as Record<string, unknown>;
    if (typeof p.in !== "number" || typeof p.out !== "number" || !Number.isFinite(p.in) || !Number.isFinite(p.out) || p.in < 0 || p.out < 0) {
      throw new Error(`pricing ${model}: in/out phải là số >= 0`);
    }
    const optional: Record<string, number> = {};
    for (const key of ["cacheRead", "cacheWrite"] as const) {
      if (p[key] === undefined) continue;
      if (typeof p[key] !== "number" || !Number.isFinite(p[key]) || p[key] < 0) throw new Error(`pricing ${model}: ${key} phải là số >= 0`);
      optional[key] = p[key];
    }
    out[model] = { in: p.in, out: p.out, ...optional };
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = Env.parse(env);
  return {
    ...e,
    adminIds: csvNumbers(e.ADMIN_TELEGRAM_IDS),
    ownerId: e.OWNER_TELEGRAM_ID ? Number(e.OWNER_TELEGRAM_ID) : null,
    cookieSecure: e.COOKIE_SECURE === "true",
    trustProxy: e.TRUST_PROXY === "true",
    llmPrices: parsePricing(e.LLM_PRICING_JSON),
  };
}
