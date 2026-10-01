/** Khởi tạo các dịch vụ dùng chung cho cả ba khối (bot, admin, worker). */
import { loadPredicates } from "./core/predicates";
import type { KnowledgePort, LlmPort } from "./core/ports";
import { SettingsService } from "./core/settings";
import type { Embedder } from "./core/embedding";
import { BotPipeline } from "./bot/pipeline";
import { MediaStore } from "./bot/media";
import { ResponseResolver } from "./bot/resolver";
import type { Channel } from "./bot/types";
import { TelegramClient } from "./bot/telegram";
import type { Config } from "./config";
import { migrate, openDb, type Db } from "./db/db";
import { convRepo } from "./db/repo-conv";
import { kbRepo } from "./db/repo-kb";
import { opsRepo } from "./db/repo-ops";
import { vaultRepo, type VaultRepo } from "./db/repo-vault";
import { PgKnowledge } from "./kb/knowledge-search";
import { PythonKnowledge, ShadowKnowledge } from "./kb/python-knowledge";
import { CompositeKnowledge, VaultKnowledge } from "./vault/search";
import { LiveContent } from "./kb/live-content";
import { seedContent } from "./kb/seed";
import { KbService } from "./kb/service";
import { AnthropicProvider } from "./llm/anthropic";
import { ProviderChain } from "./llm/chain";
import { LlmClient } from "./llm/client";
import { SkillStore } from "./llm/skills";
import { GatewayConfig } from "./llm/gateway-config";
import { SecretBox } from "./llm/secret-box";
import { createEmbedder, SelectedEmbedder } from "./llm/embedder";
import { EmbeddingConfig } from "./llm/embedding-config";
import { OpenAICompatProvider } from "./llm/openai-compat";
import type { LlmProvider } from "./llm/types";
import { makeLogger, type LogFn } from "./log";

export interface Services {
  cfg: Config;
  db: Db;
  conv: ReturnType<typeof convRepo>;
  kb: ReturnType<typeof kbRepo>;
  ops: ReturnType<typeof opsRepo>;
  vault: VaultRepo;
  settings: SettingsService;
  embedder: Embedder;
  embedding: EmbeddingConfig;
  skills: SkillStore;
  live: LiveContent;
  kbService: KbService;
  llm?: LlmPort;
  gateway: GatewayConfig;
  channel: Channel;
  telegram?: TelegramClient;
  resolver: ResponseResolver;
  /**
   * Resolver riêng cho việc NỀN, không khẩn cấp (hiện chỉ job `prewarm-urgent-translations`) — dùng cùng gateway
   * nhưng gọi CÁCH QUÃNG (`minIntervalMs`), để việc nền tự nhường chỗ cho câu hỏi khách thật thay vì cạnh tranh
   * cùng lúc. Phát hiện 2026-09-30: job dịch sẵn 34 ngôn ngữ chiếm cổng LLM liên tục 25-30 phút mỗi giờ, đủ để làm
   * chậm/hỏng câu trả lời khách thật đang chạy song song dù bản thân job không có lỗi gì.
   */
  resolverBackground: ResponseResolver;
  knowledge: KnowledgePort;
  media: MediaStore;
  pipeline: BotPipeline;
  log: LogFn;
  close(): Promise<void>;
}

/** Channel không làm gì khi chưa có token Telegram (chạy admin/worker ở chế độ demo/CI). */
class NullChannel implements Channel {
  async send(): Promise<{ messageId?: number }> {
    throw new Error("TELEGRAM_BOT_TOKEN chưa được cấu hình");
  }
  async downloadImage(): Promise<{ mime: string; base64: string }> {
    throw new Error("TELEGRAM_BOT_TOKEN chưa được cấu hình");
  }
}

export async function createServices(cfg: Config, service: string, opts: { seed?: boolean } = {}): Promise<Services> {
  const log = makeLogger(cfg.LOG_LEVEL as "info" | "warn" | "error", service);
  const db = await openDb(cfg.DATABASE_URL);
  await migrate(db);
  const conv = convRepo(db);
  const kb = kbRepo(db);
  const ops = opsRepo(db);
  const vault = vaultRepo(db);
  // Embedding: người vận hành CHỌN đúng một model (Admin Web → Cấu hình → Embedding): API ngoài (vd gemini-embedding-001) hoặc
  // cục bộ trong .env (TEI/bge-m3). Không dự phòng ngầm (bỏ 2026-09-30 theo yêu cầu chủ dự án): chọn API ngoài thì MỌI lượt
  // đều gọi API thật, lỗi thì báo lỗi thẳng — không tự chuyển/tự khoá sang cục bộ nữa. Xem ghi chú trong embedder.ts.
  const secretBox = cfg.SECRETS_KEY ? new SecretBox(cfg.SECRETS_KEY) : null; // mã hoá khoá API nhập từ web; không có -> chỉ dùng khoá trong .env
  const localEmbedder = createEmbedder(cfg);
  const embedding = new EmbeddingConfig(ops, secretBox);
  const embedder = new SelectedEmbedder(() => embedding.selection(), localEmbedder, { log: (m) => log("warn", m) });
  const settings = new SettingsService(ops);
  const predicatesFile = `${cfg.CONTENT_DIR}/config/predicates.yml`;

  // LLM: gateway tương thích OpenAI (9router) là provider chính, cấu hình đọc lại từ DB nên đổi trên Admin Web có hiệu lực không cần restart.
  // Anthropic trực tiếp chỉ là dự phòng tuỳ chọn. Chưa cấu hình gì => llm.ready = false, bot chạy bằng template thuần.
  const gateway = new GatewayConfig(ops, { baseUrl: cfg.LLM_BASE_URL, apiKey: cfg.LLM_API_KEY, modelFast: cfg.LLM_MODEL_FAST, modelStrong: cfg.LLM_MODEL_STRONG }, secretBox);
  await gateway.resolve();
  const gatewayTimer = setInterval(() => void gateway.resolve().catch(() => undefined), 5_000);
  gatewayTimer.unref();
  const providers: LlmProvider[] = [new OpenAICompatProvider(async () => {
    const g = await gateway.resolve();
    return g && { baseUrl: g.baseUrl, apiKey: g.apiKey, models: g.models };
  }, "gateway")];
  if (cfg.ANTHROPIC_API_KEY) providers.push(new AnthropicProvider({ apiKey: cfg.ANTHROPIC_API_KEY, baseURL: cfg.ANTHROPIC_BASE_URL, models: { fast: cfg.ANTHROPIC_MODEL_FAST, strong: cfg.ANTHROPIC_MODEL_STRONG, intake: cfg.ANTHROPIC_MODEL_FAST } }));
  const chain = new ProviderChain(providers, {
    onCall: async (r) => {
      try {
        await conv.addLlmCall({ messageId: r.messageId, userId: r.userId, purpose: r.purpose, provider: r.provider, model: r.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cacheRead: r.usage.cacheRead, cacheWrite: r.usage.cacheWrite, cost: r.cost, latencyMs: r.latencyMs, ok: r.ok, error: r.error });
      } catch (e) {
        log("warn", "không ghi được llm_calls", { err: (e as Error).message });
      }
    },
  });
  // Hướng dẫn AI làm việc: đọc bản đang publish (tự làm mới theo kb_version) — sửa trên Admin Web có hiệu lực ở cả bot lẫn worker, không cần restart
  const skills = new SkillStore(ops, cfg.CONTENT_DIR); // SKILL: file mặc định + bản Admin sửa trong DB
  const llm = new LlmClient(chain, () => skills.get(), () => gateway.ready || !!cfg.ANTHROPIC_API_KEY, async () => {
    await live.ensureFresh(10_000);
    return live.guide;
  });

  // Chuỗi gọi AI riêng cho việc nền, gọi cách quãng để không cạnh tranh với câu hỏi khách thật (xem ghi chú ở `resolverBackground`).
  const chainBackground = new ProviderChain(providers, {
    minIntervalMs: 4_000,
    onCall: async (r) => {
      try {
        await conv.addLlmCall({ messageId: r.messageId, userId: r.userId, purpose: r.purpose, provider: r.provider, model: r.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cacheRead: r.usage.cacheRead, cacheWrite: r.usage.cacheWrite, cost: r.cost, latencyMs: r.latencyMs, ok: r.ok, error: r.error });
      } catch (e) {
        log("warn", "không ghi được llm_calls (nền)", { err: (e as Error).message });
      }
    },
  });
  const llmBackground = new LlmClient(chainBackground, () => skills.get(), () => gateway.ready || !!cfg.ANTHROPIC_API_KEY, async () => {
    await live.ensureFresh(10_000);
    return live.guide;
  });

  const telegram = cfg.TELEGRAM_BOT_TOKEN ? new TelegramClient(cfg.TELEGRAM_BOT_TOKEN) : undefined;
  const channel: Channel = telegram ?? new NullChannel();

  const live = new LiveContent(db, kb, ops, embedder, predicatesFile, Date.now, async () => (await embedder.active()).version);
  const kbService = new KbService({ db, kb, ops, embedder, live, llm, predicatesFallback: () => loadPredicates(predicatesFile), secondApproval: async () => (await settings.get())["approval.second_person"] });
  if (opts.seed !== false) {
    const r = await seedContent(kbService, kb, ops, db, { contentDir: cfg.CONTENT_DIR, adminIds: cfg.adminIds, ownerId: cfg.ownerId });
    if (r.templatesSeeded || r.admins || r.evalCases) log("info", "seed", r);
    // mốc lịch sử ban đầu (V1) cho dữ liệu chưa có lịch sử — chỉ dịch vụ admin làm, tránh bot/worker khởi động cùng lúc ghi trùng
    if (service === "admin") {
      const base = await kbService.ensureHistoryBaseline().catch((e: Error) => (log("warn", "không ghi được mốc lịch sử ban đầu", { err: e.message }), 0));
      if (base) log("info", "ghi mốc lịch sử ban đầu (V1)", { documents: base });
    }
  }
  await live.rebuild();

  const resolver = new ResponseResolver(kb, llm, () => live.index, () => live.urlHosts);
  const resolverBackground = new ResponseResolver(kb, llmBackground, () => live.index, () => live.urlHosts);
  // Trong migration: legacy vẫn là production mặc định. Python/RAGFlow có thể chạy shadow trước khi cutover.
  const legacyKnowledge = new CompositeKnowledge(new PgKnowledge(kb, embedder), new VaultKnowledge(vault, embedder));
  const pythonKnowledge = cfg.KNOWLEDGE_SERVICE_URL
    ? new PythonKnowledge({ baseUrl: cfg.KNOWLEDGE_SERVICE_URL, token: cfg.INTERNAL_SERVICE_TOKEN })
    : null;
  let knowledge: KnowledgePort = legacyKnowledge;
  if (cfg.RETRIEVAL_PROVIDER === "python") {
    if (!pythonKnowledge) throw new Error("RETRIEVAL_PROVIDER=python nhưng chưa cấu hình KNOWLEDGE_SERVICE_URL");
    knowledge = pythonKnowledge;
  } else if (cfg.RETRIEVAL_PROVIDER === "shadow") {
    if (!pythonKnowledge) throw new Error("RETRIEVAL_PROVIDER=shadow nhưng chưa cấu hình KNOWLEDGE_SERVICE_URL");
    knowledge = new ShadowKnowledge(legacyKnowledge, pythonKnowledge, (msg, extra) => log("info", msg, extra));
  }
  const media = new MediaStore(cfg.MEDIA_DIR);
  const pipeline = new BotPipeline({ db, conv, kb, ops, live, settings, resolver, channel, llm, knowledge, media, ownerId: cfg.ownerId, adminWebUrl: cfg.PUBLIC_ADMIN_URL, log });

  const close = async () => {
    clearInterval(gatewayTimer);
    await db.close();
  };
  return { cfg, db, conv, kb, ops, vault, settings, embedder, embedding, skills, live, kbService, llm, gateway, channel, telegram, resolver, resolverBackground, knowledge, media, pipeline, log, close };
}
