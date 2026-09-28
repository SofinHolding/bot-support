/**
 * Vault Obsidian (docs/adr/0005): nơi soạn và duyệt tri thức mới nạp. Cấu trúc theo skill obsidian-knowledge-ingest:
 *   _meta/ (taxonomy.md, synonyms.md, index.json, embed-config.json), notes/<category>/, _pending/, _archive/,
 *   _notifications/, _jobs/ (index-queue.jsonl + cursor). Mọi thứ không phải note tri thức đều bắt đầu bằng `_`.
 * Chỉ tiến trình worker GHI vào vault (một nơi ghi); admin chỉ lưu file thô vào raw-data/ rồi xếp job.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { defaultTaxonomyMd } from "./taxonomy";

export interface VaultPaths {
  root: string;
  meta: string;
  notes: string;
  pending: string;
  archive: string;
  notifications: string;
  jobs: string;
  index: string;
  taxonomy: string;
  synonyms: string;
  embedConfig: string;
  queue: string;
  cursor: string;
}

export function vaultPaths(root: string): VaultPaths {
  const meta = join(root, "_meta");
  const jobs = join(root, "_jobs");
  return {
    root,
    meta,
    notes: join(root, "notes"),
    pending: join(root, "_pending"),
    archive: join(root, "_archive"),
    notifications: join(root, "_notifications"),
    jobs,
    index: join(meta, "index.json"),
    taxonomy: join(meta, "taxonomy.md"),
    synonyms: join(meta, "synonyms.md"),
    embedConfig: join(meta, "embed-config.json"),
    queue: join(jobs, "index-queue.jsonl"),
    cursor: join(jobs, "index-queue.cursor"),
  };
}

/** Ghi nguyên tử: ghi file tạm cạnh đích rồi đổi tên, để tiến trình khác (hoặc Obsidian) không bao giờ đọc phải file ghi dở. */
export function writeFileAtomic(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/** Đường dẫn tương đối trong vault, luôn dùng "/" (ghi vào index.json, dùng được trên cả Windows lẫn Linux). */
export const relPath = (p: VaultPaths, abs: string) => relative(p.root, abs).split(sep).join("/");
export const absPath = (p: VaultPaths, rel: string) => join(p.root, ...rel.split("/"));

/** Tạo cấu trúc vault nếu chưa có. Không ghi đè file đã tồn tại (taxonomy/synonyms do admin sửa). */
export function ensureVault(root: string): VaultPaths {
  const p = vaultPaths(root);
  for (const d of [p.meta, p.notes, p.pending, p.archive, p.notifications, p.jobs]) mkdirSync(d, { recursive: true });
  if (!existsSync(p.index)) writeFileAtomic(p.index, JSON.stringify({ notes: [] }, null, 2) + "\n");
  if (!existsSync(p.taxonomy)) writeFileAtomic(p.taxonomy, defaultTaxonomyMd());
  if (!existsSync(p.synonyms)) writeFileAtomic(p.synonyms, "# Bảng đồng nghĩa\n\nDo admin duy trì. Mỗi dòng: `- từ chuẩn: biến thể 1, biến thể 2`.\n");
  if (!existsSync(p.queue)) writeFileAtomic(p.queue, "");
  return p;
}
