/**
 * Job `vault-index` (trang Notion "Hướng dẫn vector dataset"): đọc `_jobs/index-queue.jsonl` từ cursor, mỗi việc:
 *   upsert / update_payload -> validate, chunk, ghi chữ + tsvector (luôn, rẻ), embed chunk có hash đổi (RETRIEVAL_DOCUMENT)
 *   remove                  -> xoá mọi chunk `<note_id>#*` khỏi cả hai nhánh
 * Note không ở trạng thái dùng được thì coi như remove. Chạy lại nhiều lần an toàn: cursor ghi sau mỗi việc, chunk có hash
 * không đổi không bị embed lại. Cuối lượt: embed bù chunk chưa có vector của model đang chọn (đổi model / API từng lỗi).
 */
import { existsSync, readFileSync } from "node:fs";
import { activeEmbedder, type Embedder } from "../core/embedding";
import { sha1 } from "../core/knowledge";
import { normalize } from "../core/text";
import type { VaultRepo } from "../db/repo-vault";
import { chunkBody, chunkWarnings } from "./chunker";
import { embedDocument, embedForChunking } from "./embed-roles";
import { readCursor, readQueue, writeCursor } from "./index-file";
import { relatedTarget, SERVABLE, validateNote, type VaultNote } from "./note";
import { writeFileAtomic } from "./paths";
import type { VaultStore } from "./store";

export interface IndexDeps {
  store: VaultStore;
  repo: VaultRepo;
  embedder: Embedder;
  log: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
}

export interface IndexReport {
  processed: number;
  upserted: number;
  removed: number;
  chunks: number;
  embedded: number;
  backfilled: number;
  errors: string[];
  warnings: string[];
  model: string;
  /** số chiều của vector vừa tạo trong lượt này (null = lượt này không embed gì) */
  dimension: number | null;
  remaining: number;
}

/** Ghép ngữ cảnh từ frontmatter vào chunk trước khi embed (contextual chunk): chunk tách rời vẫn giữ chủ đề. */
export function embedInputOf(n: VaultNote, chunkText: string): string {
  const related = n.meta.related.filter((r) => typeof r === "string").map((r) => {
    const inner = r.replace(/^\[\[|\]\]$/g, "");
    return inner.includes("|") ? inner.split("|").slice(1).join("|").trim() : relatedTarget(r);
  });
  return `[${n.meta.category} | ${n.meta.canonical_title} | related: ${related.join(", ")}]\n${n.meta.canonical_summary}\n${chunkText}`;
}

/** File điều phối cấu hình embed (_meta/embed-config.json): ghi lại model đang dùng; đổi model thì báo và embed bù theo model mới. */
function syncEmbedConfig(d: IndexDeps, model: string, dimension: number | null) {
  const p = d.store.paths.embedConfig;
  const want = { model, dimension, normalized: true, doc_task_type: "RETRIEVAL_DOCUMENT", query_task_type: "RETRIEVAL_QUERY", collection: `vault_chunk_vectors[model=${model}]` };
  const cur = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { model?: string; dimension?: number | null }) : null;
  if (cur && cur.model === model && (dimension === null || cur.dimension === dimension)) return;
  if (cur?.model && cur.model !== model) d.log("warn", `vault-index: model embed đổi ${cur.model} -> ${model}; vector cũ giữ nguyên theo model cũ, chunk được embed bù cho model mới`);
  writeFileAtomic(p, JSON.stringify(want, null, 2) + "\n");
}

async function indexNote(d: IndexDeps, noteId: string, r: IndexReport): Promise<void> {
  const n = await d.store.read(noteId);
  if (!n) {
    r.removed += (await d.repo.removeChunks(noteId)) ? 1 : 0;
    return;
  }
  const errors = validateNote(n);
  if (errors.length) {
    r.errors.push(`"${n.meta.title || noteId}": ${errors.join("; ")}`);
    return;
  }
  if (!SERVABLE.includes(n.meta.status)) {
    await d.repo.removeChunks(noteId);
    r.removed++;
    return;
  }
  const chunks = await chunkBody(n.body, async (s) => (await embedForChunking(d.embedder, s)).vectors);
  r.warnings.push(...chunkWarnings(n.meta.title, n.body, chunks));
  const ids = chunks.map((_, i) => `${noteId}#${i}`);
  await d.repo.removeChunks(noteId, ids);
  const path = d.store.entry(noteId)?.path ?? d.store.locationOf(n.meta);
  const lexicalMeta = [n.meta.title, n.meta.keywords.join(" "), n.meta.canonical_title, n.meta.canonical_summary, n.meta.canonical_keywords.join(" ")].join(" ");
  for (const [i, c] of chunks.entries()) {
    const embedInput = embedInputOf(n, c.text);
    const embedHash = sha1(embedInput);
    await d.repo.upsertChunk({
      chunkId: ids[i]!, noteId, seq: i, heading: c.heading || n.meta.title, text: c.text, embedInput, embedHash, searchText: normalize(`${lexicalMeta} ${c.heading} ${c.text}`),
      status: n.meta.status, category: n.meta.category, versionGroup: n.meta.version_group, path, langSource: n.meta.lang_source, ingestedAt: n.meta.ingested_at,
    });
    r.chunks++;
    const model = (await activeEmbedder(d.embedder)).version;
    if ((await d.repo.vectorHash(ids[i]!, model)) === embedHash) continue; // nội dung không đổi: không gọi API
    try {
      const e = await embedDocument(d.embedder, [embedInput]);
      await d.repo.putVector(ids[i]!, e.model, embedHash, e.vectors[0]!);
      r.dimension = e.vectors[0]!.length;
      r.embedded++;
    } catch (err) {
      // chữ đã vào nhánh tìm kiếm chữ; vector được embed bù ở cuối lượt sau
      d.log("warn", "vault-index: embed lỗi, sẽ embed bù sau", { noteId, err: (err as Error).message });
    }
  }
  r.upserted++;
}

export async function runIndex(d: IndexDeps, opts: { max?: number; backfill?: number } = {}): Promise<IndexReport> {
  const active = await activeEmbedder(d.embedder);
  const r: IndexReport = { processed: 0, upserted: 0, removed: 0, chunks: 0, embedded: 0, backfilled: 0, errors: [], warnings: [], model: active.version, dimension: null, remaining: 0 };
  const jobs = readQueue(d.store.paths);
  let cursor = Math.min(readCursor(d.store.paths), jobs.length);
  const max = opts.max ?? 500;
  while (cursor < jobs.length && r.processed < max) {
    const j = jobs[cursor]!;
    if (j.action === "remove") {
      await d.repo.removeChunks(j.note_id);
      r.removed++;
    } else await indexNote(d, j.note_id, r); // upsert và update_payload: chunk không đổi thì không embed lại
    cursor++;
    r.processed++;
    writeCursor(d.store.paths, cursor);
  }
  r.remaining = jobs.length - cursor;

  // embed bù: chunk chưa có vector (hoặc vector cũ) của model đang chọn
  const model = (await activeEmbedder(d.embedder)).version;
  const missing = await d.repo.chunksMissingVector(model, opts.backfill ?? 64);
  for (let i = 0; i < missing.length; i += 16) {
    const lot = missing.slice(i, i + 16);
    try {
      const e = await embedDocument(d.embedder, lot.map((m) => m.embedInput));
      for (const [k, m] of lot.entries()) await d.repo.putVector(m.chunkId, e.model, m.embedHash, e.vectors[k]!);
      r.dimension = e.vectors[0]?.length ?? r.dimension;
      r.backfilled += lot.length;
    } catch (err) {
      d.log("warn", "vault-index: embed bù lỗi", { err: (err as Error).message });
      break;
    }
  }
  syncEmbedConfig(d, model, r.dimension);
  if (r.processed || r.backfilled) d.log("info", "vault-index xong", { processed: r.processed, embedded: r.embedded, backfilled: r.backfilled, errors: r.errors.length });
  return r;
}
