/** Khởi tạo các dịch vụ dùng chung cho cả ba khối (bot, admin, worker). */
import { loadPredicates } from "./core/predicates";
import type { LlmPort } from "./core/ports";
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
import { PgKnowledge } from "./kb/knowledge-search";
import { LiveContent } from "./kb/live-content";
import { seedContent } from "./kb/seed";
import { KbService } from "./kb/service";
import { AnthropicProvider } from "./llm/anthropic";
import { ProviderChain } from "./llm/chain";
import { LlmClient } from "./llm/client";
import { createEmbedder } from "./llm/embedder";
import { OpenAICompatProvider } from "./llm/openai-compat";
import type { LlmProvider } from "./llm/types";
import { makeLogger, type LogFn } from "./log";

export interface Services {
  cfg: Config;
  db: Db;
  conv: ReturnType<typeof convRepo>;
  kb: ReturnType<typeof kbRepo>;
  ops: ReturnType<typeof opsRepo>;
  settings: SettingsService;
  embedder: Embedder;
  live: LiveContent;
  kbService: KbService;
  llm?: LlmPort;
  channel: Channel;
  telegram?: TelegramClient;
  resolver: ResponseResolver;
  knowledge: PgKnowledge;
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
  const embedder = createEmbedder(cfg);
  const settings = new SettingsService(ops);
  const predicatesFile = `${cfg.CONTENT_DIR}/config/predicates.yml`;

  // LLM: provider chính (Anthropic) + dự phòng (tương thích OpenAI). Không có key thì bot chạy bằng template thuần.
  const providers: LlmProvider[] = [];
  if (cfg.ANTHROPIC_API_KEY) providers.push(new AnthropicProvider({ apiKey: cfg.ANTHROPIC_API_KEY, baseURL: cfg.ANTHROPIC_BASE_URL, models: { fast: cfg.LLM_MODEL_FAST, strong: cfg.LLM_MODEL_STRONG } }));
  if (cfg.OPENAI_COMPAT_BASE_URL) {
    providers.push(new OpenAICompatProvider({ baseUrl: cfg.OPENAI_COMPAT_BASE_URL, apiKey: cfg.OPENAI_COMPAT_API_KEY, models: { fast: cfg.OPENAI_COMPAT_MODEL_FAST ?? cfg.LLM_MODEL_FAST, strong: cfg.OPENAI_COMPAT_MODEL_STRONG ?? cfg.LLM_MODEL_STRONG } }));
  }
  const chain = providers.length
    ? new ProviderChain(providers, {
        onCall: async (r) => {
          try {
            await conv.addLlmCall({ messageId: r.messageId, userId: r.userId, purpose: r.purpose, provider: r.provider, model: r.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cacheRead: r.usage.cacheRead, cacheWrite: r.usage.cacheWrite, cost: r.cost, latencyMs: r.latencyMs, ok: r.ok, error: r.error });
          } catch (e) {
            log("warn", "không ghi được llm_calls", { err: (e as Error).message });
          }
        },
      })
    : null;
  const llm = chain ? new LlmClient(chain) : undefined;

  const telegram = cfg.TELEGRAM_BOT_TOKEN ? new TelegramClient(cfg.TELEGRAM_BOT_TOKEN) : undefined;
  const channel: Channel = telegram ?? new NullChannel();

  const live = new LiveContent(db, kb, ops, embedder, predicatesFile);
  const kbService = new KbService({ db, kb, ops, embedder, live, predicatesFallback: () => loadPredicates(predicatesFile) });
  if (opts.seed !== false) {
    const r = await seedContent(kbService, kb, ops, db, { contentDir: cfg.CONTENT_DIR, adminIds: cfg.adminIds, ownerId: cfg.ownerId });
    if (r.templatesSeeded || r.admins || r.evalCases) log("info", "seed", r);
  }
  await live.rebuild();

  const resolver = new ResponseResolver(kb, llm, () => live.index, () => live.urlHosts);
  const knowledge = new PgKnowledge(kb, embedder);
  const media = new MediaStore(cfg.MEDIA_DIR);
  const pipeline = new BotPipeline({ db, conv, kb, ops, live, settings, resolver, channel, llm, knowledge, media, ownerId: cfg.ownerId, adminWebUrl: cfg.PUBLIC_ADMIN_URL, log });

  return { cfg, db, conv, kb, ops, settings, embedder, live, kbService, llm, channel, telegram, resolver, knowledge, media, pipeline, log, close: () => db.close() };
}
