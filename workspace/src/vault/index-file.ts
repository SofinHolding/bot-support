/**
 * Sổ cái điều phối `_meta/index.json` và hàng đợi `_jobs/index-queue.jsonl` (+ cursor) — định dạng theo
 * references/frontmatter-schema.md và references/indexing-handoff.md của skill.
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { NoteStatus } from "./note";
import { writeFileAtomic, type VaultPaths } from "./paths";

export interface IndexEntry {
  id: string;
  title: string;
  category: string;
  version_group: string;
  status: NoteStatus;
  lang_source: string;
  ingested_at: string;
  supersedes: string | string[] | null;
  conflict_ref: string | null;
  content_hash: string;
  path: string;
}

export interface VaultIndex {
  notes: IndexEntry[];
}

export function readIndex(p: VaultPaths): VaultIndex {
  if (!existsSync(p.index)) return { notes: [] };
  const raw = JSON.parse(readFileSync(p.index, "utf8")) as Partial<VaultIndex>;
  return { notes: Array.isArray(raw.notes) ? raw.notes : [] };
}

export function writeIndex(p: VaultPaths, idx: VaultIndex) {
  const notes = [...idx.notes].sort((a, b) => a.id.localeCompare(b.id));
  writeFileAtomic(p.index, JSON.stringify({ notes }, null, 2) + "\n");
}

export function upsertEntry(idx: VaultIndex, e: IndexEntry) {
  const i = idx.notes.findIndex((x) => x.id === e.id);
  if (i >= 0) idx.notes[i] = e;
  else idx.notes.push(e);
}

export type QueueAction = "upsert" | "remove" | "update_payload";
export type QueueReason = "new" | "content_change" | "approved" | "superseded" | "rejected" | "status_change" | "initial" | "merged";

export interface QueueJob {
  job: "index-note";
  action: QueueAction;
  note_id: string;
  path?: string;
  content_hash?: string;
  reason: QueueReason;
  queued_at: string;
}

/** Append-only: mỗi dòng một việc. */
export function appendQueue(p: VaultPaths, jobs: Omit<QueueJob, "job">[]) {
  if (!jobs.length) return;
  mkdirSync(dirname(p.queue), { recursive: true });
  appendFileSync(p.queue, jobs.map((j) => JSON.stringify({ job: "index-note", ...j })).join("\n") + "\n", "utf8");
}

export function readQueue(p: VaultPaths): QueueJob[] {
  if (!existsSync(p.queue)) return [];
  return readFileSync(p.queue, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as QueueJob);
}

export function readCursor(p: VaultPaths): number {
  if (!existsSync(p.cursor)) return 0;
  const n = Number(readFileSync(p.cursor, "utf8").trim());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export const writeCursor = (p: VaultPaths, n: number) => writeFileAtomic(p.cursor, String(n));
