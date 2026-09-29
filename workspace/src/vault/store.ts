/**
 * Ghi note vào vault và giữ ba nơi luôn khớp nhau: file note (đúng thư mục theo trạng thái), `_meta/index.json`, bảng
 * `vault_notes` (bot/admin đọc). Chỉ worker dùng lớp này (một nơi ghi). Gọi `flush()` sau cùng để ghi index.json một lần.
 *
 * GIẢ ĐỊNH: chỉ một tiến trình worker chạy tại một thời điểm (xem chú thích ở service `worker` trong docker-compose.yml).
 * `index.json` đọc cả file vào bộ nhớ và `flush()` ghi đè cả file, không khoá/gộp — nếu chạy nhiều worker song song và có
 * hai job cùng đụng vào vault, bản ghi sau có thể mất dữ liệu của bản trước dù bảng `vault_notes` (nguồn bot đọc để trả
 * lời) vẫn đúng. Muốn scale worker phải thêm khoá (vd advisory lock Postgres theo tên vault) trước khi mở `VaultStore`.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { VaultRepo } from "../db/repo-vault";
import { appendQueue, readIndex, upsertEntry, writeIndex, type IndexEntry, type QueueJob, type VaultIndex } from "./index-file";
import { noteContentHash, parseNote, renderNote, type NoteMeta, type VaultNote } from "./note";
import { absPath, ensureVault, writeFileAtomic, type VaultPaths } from "./paths";

export class VaultStore {
  private idx: VaultIndex | null = null;
  private queued = 0;

  constructor(readonly paths: VaultPaths, readonly repo: VaultRepo) {}

  static open(root: string, repo: VaultRepo) {
    return new VaultStore(ensureVault(root), repo);
  }

  get index(): VaultIndex {
    return (this.idx ??= readIndex(this.paths));
  }

  /** Thư mục theo trạng thái: dùng được -> notes/<category>/, chờ duyệt -> _pending/, bị thay thế -> _archive/. */
  locationOf(m: Pick<NoteMeta, "id" | "status" | "category">): string {
    if (m.status === "confirmed" || m.status === "provisional") return `notes/${m.category}/${m.id}.md`;
    if (m.status === "superseded") return `_archive/${m.id}.md`;
    return `_pending/${m.id}.md`;
  }

  entry(id: string): IndexEntry | undefined {
    return this.index.notes.find((e) => e.id === id);
  }

  /** Đọc note theo id: file trong vault; file mất (bị xoá tay) thì dựng lại từ bản sao trong DB. */
  async read(id: string): Promise<VaultNote | null> {
    const e = this.entry(id);
    if (e) {
      const abs = absPath(this.paths, e.path);
      if (existsSync(abs)) return parseNote(readFileSync(abs, "utf8"));
    }
    const row = await this.repo.getNote(id);
    return row ? { meta: row.meta as unknown as NoteMeta, body: row.body } : null;
  }

  /** Ghi note vào đúng thư mục theo trạng thái; nếu trước đó nằm chỗ khác thì xoá file cũ (chuyển file). */
  async save(n: VaultNote, batchId: number | null = null): Promise<IndexEntry> {
    const path = this.locationOf(n.meta);
    const prev = this.entry(n.meta.id);
    writeFileAtomic(absPath(this.paths, path), renderNote(n));
    if (prev && prev.path !== path) rmSync(absPath(this.paths, prev.path), { force: true });
    const e: IndexEntry = {
      id: n.meta.id, title: n.meta.title, category: n.meta.category, version_group: n.meta.version_group, status: n.meta.status, lang_source: n.meta.lang_source,
      ingested_at: n.meta.ingested_at, supersedes: n.meta.supersedes, conflict_ref: n.meta.conflict_ref, content_hash: noteContentHash(n), path,
    };
    upsertEntry(this.index, e);
    await this.repo.upsertNote({
      id: e.id, title: e.title, category: e.category, versionGroup: e.version_group, status: e.status, langSource: e.lang_source, ingestedAt: e.ingested_at,
      path, contentHash: e.content_hash, meta: n.meta as unknown as Record<string, unknown>, body: n.body, batchId,
    });
    return e;
  }

  queue(jobs: Omit<QueueJob, "job">[]) {
    appendQueue(this.paths, jobs);
    this.queued += jobs.length;
  }

  get queuedCount() {
    return this.queued;
  }

  writeFile(rel: string, content: string) {
    writeFileAtomic(absPath(this.paths, rel), content);
  }

  flush() {
    if (this.idx) writeIndex(this.paths, this.idx);
  }
}
