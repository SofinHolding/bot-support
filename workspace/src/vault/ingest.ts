/**
 * Job `vault-ingest`: file thô trong raw-data/ -> note atomic trong vault (SKILL knowledge-ingest) -> phát hiện xung đột theo
 * ý nghĩa (SKILL knowledge-conflict) -> CODE quyết định trạng thái, ghi file, chỉ mục, hàng đợi index, thông báo.
 *
 * Luật xung đột (quyết định của owner 2026-09-28, docs/adr/0005): MỌI mâu thuẫn đều chặn — cả loại B1 (bản mới khác bản cũ,
 * khác mốc thời gian). Note mới dính mâu thuẫn -> awaiting_approval trong _pending/, không được index; bản cũ vẫn dùng cho tới
 * khi admin chọn. Cặp AI không trả kết quả = mâu thuẫn (bất biến 5 trong CLAUDE.md). Chủ đề đang có xung đột mở: note mới
 * cùng chủ đề gộp vào xung đột đó, không được dùng.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { usableLlm, type LlmPort, type VaultCompareVerdict, type VaultDraftNote } from "../core/ports";
import type { ConflictCandidate, ConflictRow, ConflictType, NoteRow, VaultRepo } from "../db/repo-vault";
import { NOTE_ID_RE, relatedIds, relatedLink, sectionsToBody, type NoteMeta, type VaultNote } from "./note";
import { notificationFileName, renderNotification } from "./notification-file";
import { batchUnits, sourceUnits, type SourceUnit } from "./source-units";
import type { VaultStore } from "./store";
import { parseTaxonomy, type Taxonomy } from "./taxonomy";

export interface VaultJobDeps {
  store: VaultStore;
  repo: VaultRepo;
  llm?: LlmPort;
  rawDir: string;
  now: () => Date;
  log: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
  enqueue: (type: string, payload: Record<string, unknown>, opts?: { dedupeKey?: string }) => Promise<boolean>;
}

export interface IngestReport {
  file: string;
  units: number;
  confirmed: { id: string; title: string; path: string }[];
  pending: { id: string; title: string; path: string }[];
  skipped: { title: string; reason: string }[];
  unmatched: { ref: string; topic: string; suggestedCategory: string }[];
  missedUnits: string[];
  conflicts: { id: number; topic: string; type: ConflictType; extended: boolean }[];
  relatedUpdated: number;
  archived: number;
  queuedJobs: number;
}

const EXCERPT = 600;
const COMPARE_BATCH = 20;
export const UNCHECKED_REASON = "AI chưa kiểm tra được cặp này nên hệ thống tạm chặn để người duyệt xem.";

export function renderTaxonomyForPrompt(t: Taxonomy): string {
  const tags = Object.entries(t.tags).map(([k, v]) => `  ${k}: ${v.join(", ")}`);
  return [`Canonical language: ${t.canonicalLang}`, "Categories:", ...t.categories.map((c) => `- ${c.key}: ${c.description}`), ...(tags.length ? ["Standard tags:", ...tags] : [])].join("\n");
}

const excerptOf = (body: string) => (body.length > EXCERPT ? `${body.slice(0, EXCERPT).trimEnd()}…` : body);
const labelOf = (i: number) => String.fromCharCode(65 + i);

/**
 * Id note = `<version_group>-<nnn>`, số tiếp theo chưa dùng (không bao giờ dùng lại id cũ). `cache`: id đã dùng theo từng
 * group, hỏi DB đúng một lần cho mỗi group dù một lượt nạp có nhiều note cùng chủ đề (trước đây hỏi lại mỗi note).
 */
async function nextId(repo: VaultRepo, group: string, reserved: Set<string>, cache: Map<string, Set<string>>): Promise<string> {
  let taken = cache.get(group);
  if (!taken) {
    taken = new Set(await repo.idsWithPrefix(group));
    cache.set(group, taken);
  }
  for (let n = 1; ; n++) {
    const id = `${group}-${String(n).padStart(3, "0")}`;
    if (!taken.has(id) && !reserved.has(id)) return id;
  }
}

const rowToNote = (r: NoteRow): VaultNote => ({ meta: r.meta as unknown as NoteMeta, body: r.body });

export async function runIngest(d: VaultJobDeps, batchId: number): Promise<IngestReport> {
  const batch = await d.repo.getBatch(batchId);
  if (!batch) throw new Error(`không có lượt nạp #${batchId}`);
  if (batch.status === "done" && batch.report) return batch.report as unknown as IngestReport; // job chạy lại sau khi đã xong: không làm lại
  const llm = usableLlm(d.llm);
  if (!llm) {
    await d.repo.markBatch(batchId, "failed", { error: "Chưa cấu hình AI (Cấu hình → LLM). Cấu hình xong rồi bấm \"Chạy lại\" lượt nạp này." });
    throw new Error("chưa cấu hình LLM");
  }
  await d.repo.markBatch(batchId, "running");
  try {
    const report = await ingest(d, llm, batchId, batch.fileName, batch.rawPath);
    await d.repo.markBatch(batchId, "done", { report: report as unknown as Record<string, unknown> });
    return report;
  } catch (e) {
    await d.repo.markBatch(batchId, "failed", { error: `${(e as Error).message.slice(0, 500)}. Hệ thống sẽ tự thử lại; vẫn lỗi thì kiểm tra tệp hoặc cấu hình AI rồi bấm "Chạy lại".` });
    throw e;
  }
}

async function ingest(d: VaultJobDeps, llm: LlmPort, batchId: number, fileName: string, rawPath: string): Promise<IngestReport> {
  const { store, repo } = d;
  const now = d.now();
  const ingestedAt = now.toISOString();
  const report: IngestReport = { file: fileName, units: 0, confirmed: [], pending: [], skipped: [], unmatched: [], missedUnits: [], conflicts: [], relatedUpdated: 0, archived: 0, queuedJobs: 0 };

  // 1. Đọc và tách nguồn
  const units = await sourceUnits(readFileSync(join(d.rawDir, rawPath)), fileName);
  report.units = units.length;
  const unitById = new Map(units.map((u) => [u.id, u]));
  const taxonomy = parseTaxonomy(readFileSync(store.paths.taxonomy, "utf8"));
  if (!taxonomy.categories.length) throw new Error("_meta/taxonomy.md chưa có category nào: thêm danh sách category rồi chạy lại");
  const catKeys = new Set(taxonomy.categories.map((c) => c.key));
  const taxText = renderTaxonomyForPrompt(taxonomy);

  // 2. AI soạn note (theo lô). Chưa ghi gì cho tới khi có đủ kết quả: lỗi giữa chừng thì job chạy lại từ đầu, vault không dở dang.
  const existing = await repo.activeGroups();
  const drafts: { d: VaultDraftNote; units: SourceUnit[] }[] = [];
  for (const lot of batchUnits(units)) {
    const known = [...existing, ...drafts.map((x) => ({ versionGroup: x.d.version_group, category: x.d.category, canonicalTitle: x.d.canonical_title }))];
    const r = await llm.draftVaultNotes({ sourceFile: fileName, taxonomy: taxText, existingGroups: known, units: lot });
    const lotIds = new Set(lot.map((u) => u.id));
    const covered = new Set<string>();
    for (const n of r.notes) {
      const us = n.units.filter((u) => lotIds.has(u)).map((u) => unitById.get(u)!);
      us.forEach((u) => covered.add(u.id));
      if (!catKeys.has(n.category)) {
        for (const u of us.length ? us : [{ ref: n.title } as SourceUnit]) report.unmatched.push({ ref: u.ref, topic: n.title, suggestedCategory: n.category });
        continue;
      }
      drafts.push({ d: n, units: us });
    }
    for (const u of r.unmatched) {
      const unit = unitById.get(u.unit);
      if (unit && lotIds.has(unit.id)) {
        covered.add(unit.id);
        report.unmatched.push({ ref: unit.ref, topic: u.topic, suggestedCategory: u.suggested_category });
      }
    }
    for (const u of lot) if (!covered.has(u.id)) report.missedUnits.push(u.ref);
  }

  // 3. Dựng note nháp: code gán id, thời điểm nạp, nguồn
  const reserved = new Set<string>();
  const idCache = new Map<string, Set<string>>();
  const fresh: VaultNote[] = [];
  const draftRelated = new Map<string, string[]>();
  for (const x of drafts) {
    const group = x.d.version_group;
    const id = await nextId(repo, group, reserved, idCache);
    if (!NOTE_ID_RE.test(id)) continue;
    reserved.add(id);
    const meta: NoteMeta = {
      id, title: x.d.title.trim(), category: x.d.category, tags: [...new Set(x.d.tags.map((t) => t.trim()).filter(Boolean))], status: "draft", lang_source: x.d.lang_source,
      source_file: fileName, source_refs: x.units.map((u) => u.ref), ingested_at: ingestedAt, version_group: group, supersedes: null, conflict_ref: null, related: [],
      summary: x.d.summary.trim(), keywords: x.d.keywords, canonical_title: x.d.canonical_title.trim(), canonical_summary: x.d.canonical_summary.trim(), canonical_keywords: x.d.canonical_keywords,
    };
    fresh.push({ meta, body: sectionsToBody(x.d.sections) });
    draftRelated.set(id, x.d.related);
  }

  // 4. Gom theo chủ đề, so cặp theo ý nghĩa
  const byGroup = new Map<string, VaultNote[]>();
  for (const n of fresh) byGroup.set(n.meta.version_group, [...(byGroup.get(n.meta.version_group) ?? []), n]);
  const activeRows = await repo.notesInGroups([...byGroup.keys()], ["confirmed", "provisional"]);
  const activeByGroup = new Map<string, NoteRow[]>();
  for (const r of activeRows) activeByGroup.set(r.versionGroup, [...(activeByGroup.get(r.versionGroup) ?? []), r]);
  const openByGroup = new Map<string, ConflictRow>();
  for (const g of byGroup.keys()) {
    const c = await repo.openConflictForGroup(g);
    if (c) openByGroup.set(g, c);
  }

  type Pair = { id: string; group: string; a: VaultNote; b: VaultNote | NoteRow; kind: "new" | "old" };
  const pairs: Pair[] = [];
  for (const [g, notes] of byGroup) {
    if (openByGroup.has(g)) continue; // đang có xung đột mở: gộp vào, không cần so
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) pairs.push({ id: `P${pairs.length + 1}`, group: g, a: notes[i]!, b: notes[j]!, kind: "new" });
      for (const o of activeByGroup.get(g) ?? []) pairs.push({ id: `P${pairs.length + 1}`, group: g, a: notes[i]!, b: o, kind: "old" });
    }
  }
  const verdicts = new Map<string, { verdict: VaultCompareVerdict; reason: string }>();
  for (let i = 0; i < pairs.length; i += COMPARE_BATCH) {
    const lot = pairs.slice(i, i + COMPARE_BATCH);
    try {
      const r = await llm.compareVaultNotes({
        // note mới (VaultNote) và bản sao note cũ (NoteRow) đều có meta.canonical_summary + body
        pairs: lot.map((p) => ({
          id: p.id,
          left: { canonicalSummary: p.a.meta.canonical_summary, excerpt: p.a.body },
          right: { canonicalSummary: String((p.b.meta as { canonical_summary?: unknown }).canonical_summary ?? ""), excerpt: p.b.body },
        })),
      });
      const ids = new Set(lot.map((p) => p.id));
      for (const x of r.results) if (ids.has(x.pair)) verdicts.set(x.pair, { verdict: x.verdict, reason: x.reason });
    } catch (e) {
      d.log("warn", "vault-ingest: AI không so được một lô cặp note — các cặp này bị chặn", { err: (e as Error).message });
    }
  }
  const verdictOf = (p: Pair) => verdicts.get(p.id) ?? { verdict: "contradiction" as const, reason: UNCHECKED_REASON };

  // 5. Code quyết định trạng thái theo từng chủ đề
  const confirmed: VaultNote[] = [];
  const blockedGroups: { group: string; notes: VaultNote[]; olds: NoteRow[]; type: ConflictType; reasons: string[]; open?: ConflictRow }[] = [];
  const linkOld = new Map<string, Set<string>>(); // note cũ -> note mới cần nối related hai chiều
  for (const [g, notes] of byGroup) {
    const olds = activeByGroup.get(g) ?? [];
    const open = openByGroup.get(g);
    const gp = pairs.filter((p) => p.group === g);
    const contra = gp.filter((p) => verdictOf(p).verdict === "contradiction");
    if (open || contra.length) {
      const type: ConflictType = open ? open.type : contra.some((p) => p.kind === "new") ? "in_file" : contra.some((p) => p.kind === "old" && Date.parse((p.b as NoteRow).meta.ingested_at as string) === Date.parse(p.a.meta.ingested_at)) ? "tie" : "version";
      const reasons = open ? ["Chủ đề này đang có xung đột chờ duyệt, nội dung mới được gộp vào để người duyệt xem cùng lúc."] : [];
      for (const p of contra) reasons.push(verdictOf(p).reason || UNCHECKED_REASON);
      blockedGroups.push({ group: g, notes, olds, type, reasons: [...new Set(reasons)], open });
      continue;
    }
    const dropped = new Set<string>();
    for (const p of gp) {
      const v = verdictOf(p).verdict;
      if (dropped.has(p.a.meta.id)) continue;
      if (v === "same_meaning") {
        if (p.kind === "old") {
          dropped.add(p.a.meta.id);
          report.skipped.push({ title: p.a.meta.title, reason: `trùng ý với nội dung đang dùng "${(p.b as NoteRow).title}", không tạo thêm` });
        } else if (!dropped.has((p.b as VaultNote).meta.id)) {
          dropped.add((p.b as VaultNote).meta.id);
          report.skipped.push({ title: (p.b as VaultNote).meta.title, reason: `trùng ý với "${p.a.meta.title}" trong cùng file, chỉ giữ một bản` });
        }
      } else if (v === "scope_difference") {
        if (p.kind === "old") {
          const o = p.b as NoteRow;
          linkOld.set(o.id, (linkOld.get(o.id) ?? new Set()).add(p.a.meta.id));
          (draftRelated.get(p.a.meta.id) ?? []).push(`#id:${o.id}`);
        } else {
          const b = p.b as VaultNote;
          draftRelated.get(p.a.meta.id)?.push(`#id:${b.meta.id}`);
          draftRelated.get(b.meta.id)?.push(`#id:${p.a.meta.id}`);
        }
      }
    }
    for (const n of notes) if (!dropped.has(n.meta.id)) confirmed.push(n);
  }

  // 6. Nối related: tên chủ đề (AI trả) -> id note; "#id:" là liên kết code thêm vì hai note cùng chủ đề khác phạm vi
  const keptNew = new Map([...confirmed, ...blockedGroups.flatMap((b) => b.notes)].map((n) => [n.meta.id, n]));
  const activeGroupIds = new Map((await repo.notesInGroups([...new Set(fresh.flatMap((n) => draftRelated.get(n.meta.id) ?? []).filter((r) => !r.startsWith("#id:")))], ["confirmed", "provisional"])).map((r) => [r.versionGroup, r]));
  const titleOf = new Map<string, string>([...keptNew.values()].map((n) => [n.meta.id, n.meta.title]));
  for (const r of activeRows) titleOf.set(r.id, r.title);
  for (const r of activeGroupIds.values()) titleOf.set(r.id, r.title);
  for (const n of keptNew.values()) {
    const ids: string[] = [];
    for (const r of draftRelated.get(n.meta.id) ?? []) {
      let target: string | undefined;
      if (r.startsWith("#id:")) target = r.slice(4);
      else target = [...keptNew.values()].find((x) => x.meta.version_group === r && x.meta.id !== n.meta.id)?.meta.id ?? activeGroupIds.get(r)?.id;
      if (target && target !== n.meta.id && !ids.includes(target)) ids.push(target);
    }
    n.meta.related = ids.slice(0, 5).map((id) => relatedLink(id, titleOf.get(id)));
  }

  // 7. Ghi note dùng được ngay
  for (const n of confirmed) {
    n.meta.status = "confirmed";
    const e = await store.save(n, batchId);
    store.queue([{ action: "upsert", note_id: n.meta.id, path: e.path, content_hash: e.content_hash, reason: "new", queued_at: ingestedAt }]);
    report.confirmed.push({ id: n.meta.id, title: n.meta.title, path: e.path });
  }
  // note cũ khác phạm vi: thêm liên kết ngược (tối đa 5), đổi nội dung embed nên xếp upsert lại
  for (const [oldId, newIds] of linkOld) {
    const old = await store.read(oldId);
    if (!old) continue;
    const have = new Set(relatedIds(old));
    const add = [...newIds].filter((id) => keptNew.has(id) && keptNew.get(id)!.meta.status === "confirmed" && !have.has(id));
    if (!add.length || have.size >= 5) continue;
    old.meta.related = [...old.meta.related, ...add.slice(0, 5 - have.size).map((id) => relatedLink(id, titleOf.get(id)))];
    const e = await store.save(old);
    store.queue([{ action: "upsert", note_id: oldId, path: e.path, content_hash: e.content_hash, reason: "content_change", queued_at: ingestedAt }]);
    report.relatedUpdated++;
  }

  // 8. Note bị chặn: _pending/, không index; tạo/gộp xung đột + file thông báo
  const date = ingestedAt.slice(0, 10);
  for (const b of blockedGroups) {
    const notifFile = b.open?.notificationFile ?? notificationFileName(date, b.group);
    for (const n of b.notes) {
      n.meta.status = "awaiting_approval";
      n.meta.conflict_ref = notifFile;
      const e = await store.save(n, batchId);
      report.pending.push({ id: n.meta.id, title: n.meta.title, path: e.path });
    }
    const prev = b.open?.candidates ?? [];
    const prevNew = prev.filter((c) => !c.old);
    const newCands: ConflictCandidate[] = b.notes.map((n, i) => ({ label: labelOf(prevNew.length + i), noteId: n.meta.id, title: n.meta.title, sourceFile: n.meta.source_file, sourceRefs: n.meta.source_refs, excerpt: excerptOf(n.body), ingestedAt: n.meta.ingested_at }));
    const olds = b.olds.sort((x, y) => y.ingestedAt.getTime() - x.ingestedAt.getTime());
    const oldCands: ConflictCandidate[] = b.open
      ? prev.filter((c) => c.old)
      : olds.map((o, i) => ({ label: i ? `O${i + 1}` : "O", noteId: o.id, title: o.title, sourceFile: String(o.meta.source_file ?? ""), sourceRefs: (o.meta.source_refs as string[]) ?? [], excerpt: excerptOf(o.body), ingestedAt: String(o.meta.ingested_at ?? o.ingestedAt.toISOString()), old: true }));
    const candidates = [...prevNew, ...newCands, ...oldCands];
    const reasons = [...new Set([...(b.open?.reasons ?? []), ...b.reasons])];
    let id: number;
    if (b.open) {
      id = b.open.id;
      await repo.extendConflict(id, candidates, reasons);
    } else {
      id = await repo.createConflict({ type: b.type, versionGroup: b.group, candidates, activeNoteId: olds[0]?.id ?? null, reasons, batchId });
    }
    store.writeFile(notifFile, renderNotification({ id, type: b.open?.type ?? b.type, versionGroup: b.group, topic: b.notes[0]!.meta.title, createdAt: ingestedAt, sourceFile: fileName, candidates, reasons }));
    await repo.setNotificationFile(id, notifFile);
    report.conflicts.push({ id, topic: b.notes[0]!.meta.title, type: b.open?.type ?? b.type, extended: !!b.open });
  }

  store.flush();
  report.queuedJobs = store.queuedCount;
  if (report.queuedJobs) await d.enqueue("vault-index", {}, { dedupeKey: "vault-index" });
  if (report.conflicts.length) await d.enqueue("vault-conflict-notify", {}, { dedupeKey: "vault-conflict-notify" });
  d.log("info", "vault-ingest xong", { batchId, confirmed: report.confirmed.length, pending: report.pending.length, conflicts: report.conflicts.length });
  return report;
}

export { rowToNote };
