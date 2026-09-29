/**
 * Job `vault-decide`: áp dụng quyết định của admin cho một xung đột khi nạp (trang Notion "Hướng dẫn xử lý xung đột dữ liệu"
 * mục 6). Làm bằng CODE, không gọi LLM, để kết quả luôn giống nhau. Riêng "Gộp": note mới được soạn TRƯỚC (Admin Web gọi
 * SKILL knowledge-ingest, admin xem trước rồi xác nhận) và nằm trong decision_payload; ở đây chỉ ghi.
 *
 *   Giữ A/B/…     note được chọn -> confirmed, notes/; note mới còn lại + bản cũ (O) -> superseded, _archive/; upsert chọn, remove O
 *   Giữ bản cũ    O giữ nguyên; mọi note mới -> superseded, _archive/
 *   Gộp           note gộp N -> confirmed, supersedes mọi note mới + O; tất cả -> superseded; upsert N, remove O
 *   Bỏ cả hai     mọi note mới -> superseded; O giữ nguyên
 * Note mới gộp vào xung đột SAU lúc admin bấm (không nằm trong ảnh chụp lúc bấm) không bị quyết định thay: mở xung đột mới.
 */
import type { VaultDraftNote } from "../core/ports";
import type { OpsRepo } from "../db/repo-ops";
import type { ConflictCandidate, ConflictDecision, ConflictRow, VaultRepo } from "../db/repo-vault";
import type { VaultJobDeps } from "./ingest";
import { relatedLink, sectionsToBody, type NoteMeta, type VaultNote } from "./note";
import { notificationFileName, renderNotification } from "./notification-file";

export interface DecideReport {
  conflictId: number;
  decision: string;
  confirmed: string[];
  archived: string[];
  reopened: number | null;
}

const EXCERPT = 600;

export async function applyDecision(d: VaultJobDeps, conflictId: number): Promise<DecideReport> {
  const { store, repo } = d;
  const c = await repo.getConflict(conflictId);
  if (!c) throw new Error(`không có xung đột #${conflictId}`);
  if (c.status === "resolved") return { conflictId, decision: c.decision ?? "", confirmed: [], archived: [], reopened: null };
  if (c.status !== "deciding" || !c.decision) throw new Error(`xung đột #${conflictId} chưa có quyết định`);
  const at = d.now().toISOString();
  const snapshot = new Set(((c.decisionPayload?.candidateIds as string[] | undefined) ?? c.candidates.map((x) => x.noteId)));
  const newCands = c.candidates.filter((x) => !x.old && snapshot.has(x.noteId));
  const olds = c.candidates.filter((x) => x.old);
  const report: DecideReport = { conflictId, decision: c.decision, confirmed: [], archived: [], reopened: null };

  // supersedes ghi ở note THẮNG (confirm), note bị thay chỉ đổi trạng thái
  const archive = async (id: string) => {
    const n = await store.read(id);
    if (!n || n.meta.status === "superseded") return;
    const wasServable = n.meta.status === "confirmed" || n.meta.status === "provisional";
    n.meta.status = "superseded";
    n.meta.conflict_ref = null;
    await store.save(n);
    if (wasServable) store.queue([{ action: "remove", note_id: id, reason: "superseded", queued_at: at }]);
    report.archived.push(id);
  };
  const confirm = async (n: VaultNote, supersedes: string[], reason: "approved" | "merged") => {
    n.meta.status = "confirmed";
    n.meta.conflict_ref = null;
    n.meta.supersedes = supersedes.length ? (supersedes.length === 1 ? supersedes[0]! : supersedes) : null;
    const e = await store.save(n);
    store.queue([{ action: "upsert", note_id: n.meta.id, path: e.path, content_hash: e.content_hash, reason, queued_at: at }]);
    report.confirmed.push(n.meta.id);
  };

  const pick = /^[a-z]$/.test(c.decision) ? c.decision.toUpperCase() : null;
  if (pick) {
    const chosen = newCands.find((x) => x.label === pick);
    if (!chosen) throw new Error(`phương án ${pick} không có trong xung đột #${conflictId}`);
    const n = await store.read(chosen.noteId);
    if (!n) throw new Error(`không đọc được note ${chosen.noteId}`);
    await confirm(n, olds.map((o) => o.noteId), "approved");
    for (const x of newCands) if (x.noteId !== chosen.noteId) await archive(x.noteId);
    for (const o of olds) await archive(o.noteId);
  } else if (c.decision === "old" || c.decision === "drop_all") {
    for (const x of newCands) await archive(x.noteId);
  } else if (c.decision === "merge") {
    const draft = c.decisionPayload?.note as VaultDraftNote | undefined;
    if (!draft) throw new Error(`xung đột #${conflictId}: thiếu nội dung gộp`);
    const n = await mergedNote(d, c, draft, at);
    const replaced = [...newCands.map((x) => x.noteId), ...olds.map((o) => o.noteId)];
    await confirm(n, replaced, "merged");
    for (const id of replaced) await archive(id);
  } else throw new Error(`quyết định không hợp lệ: ${c.decision}`);

  // Đọc lại NGAY TRƯỚC khi kết luận (không dùng `c` đã đọc từ đầu hàm): một lượt nạp khác có thể đã gộp thêm ứng viên vào
  // đúng xung đột này trong lúc applyDecision còn đang chạy (ingest.ts coi status 'deciding' vẫn là "còn mở" để extendConflict
  // vào). Dùng bản cũ ở đây từng làm ứng viên đến muộn bị bỏ sót: report resolved nhưng note đó không bao giờ được mở lại.
  const latest = (await repo.getConflict(conflictId)) ?? c;
  if (latest.notificationFile) store.writeFile(latest.notificationFile, resolvedNotice(latest, at));
  await repo.resolveConflict(c.id);

  // note mới đổ vào xung đột sau lúc admin bấm: chưa ai xem, mở xung đột mới với nội dung đang dùng
  const late = latest.candidates.filter((x) => !x.old && !snapshot.has(x.noteId));
  if (late.length) report.reopened = await reopen(d, latest, late, at);

  store.flush();
  if (store.queuedCount) await d.enqueue("vault-index", {}, { dedupeKey: "vault-index" });
  d.log("info", "vault-decide xong", report);
  return report;
}

async function mergedNote(d: VaultJobDeps, c: ConflictRow, x: VaultDraftNote, at: string): Promise<VaultNote> {
  const taken = new Set(await d.repo.idsWithPrefix(c.versionGroup));
  let k = 1;
  while (taken.has(`${c.versionGroup}-${String(k).padStart(3, "0")}`)) k++;
  const id = `${c.versionGroup}-${String(k).padStart(3, "0")}`;
  const rel = (await d.repo.notesInGroups(x.related, ["confirmed", "provisional"])).slice(0, 5);
  const meta: NoteMeta = {
    id, title: x.title, category: x.category, tags: x.tags, status: "draft", lang_source: x.lang_source, source_file: "admin (gộp xung đột)", source_refs: [`Xung đột #${c.id}`],
    ingested_at: at, version_group: c.versionGroup, supersedes: null, conflict_ref: null, related: rel.map((r) => relatedLink(r.id, r.title)),
    summary: x.summary, keywords: x.keywords, canonical_title: x.canonical_title, canonical_summary: x.canonical_summary, canonical_keywords: x.canonical_keywords,
  };
  return { meta, body: sectionsToBody(x.sections) };
}

async function reopen(d: VaultJobDeps, c: ConflictRow, late: ConflictCandidate[], at: string): Promise<number> {
  const active = await d.repo.notesInGroups([c.versionGroup], ["confirmed", "provisional"]);
  const olds: ConflictCandidate[] = active.map((o, i) => ({ label: i ? `O${i + 1}` : "O", noteId: o.id, title: o.title, sourceFile: String(o.meta.source_file ?? ""), sourceRefs: (o.meta.source_refs as string[]) ?? [], excerpt: o.body.slice(0, EXCERPT), ingestedAt: String(o.meta.ingested_at ?? ""), old: true }));
  const cands = [...late.map((x, i) => ({ ...x, label: String.fromCharCode(65 + i) })), ...olds];
  const reasons = ["Nội dung mới được nạp trong lúc xung đột trước đang được xử lý: cần duyệt lại với nội dung đang dùng."];
  const id = await d.repo.createConflict({ type: "version", versionGroup: c.versionGroup, candidates: cands, activeNoteId: active[0]?.id ?? null, reasons, batchId: c.batchId });
  const file = notificationFileName(at.slice(0, 10), c.versionGroup);
  d.store.writeFile(file, renderNotification({ id, type: "version", versionGroup: c.versionGroup, topic: late[0]!.title, createdAt: at, sourceFile: late[0]!.sourceFile, candidates: cands, reasons }));
  await d.repo.setNotificationFile(id, file);
  for (const x of late) {
    const n = await d.store.read(x.noteId);
    if (n) {
      n.meta.conflict_ref = file;
      await d.store.save(n);
    }
  }
  await d.enqueue("vault-conflict-notify", {}, { dedupeKey: "vault-conflict-notify" });
  return id;
}

const DECISION_LABEL: Record<string, string> = { old: "Giữ bản cũ", merge: "Gộp / nhập lại", drop_all: "Bỏ các phương án mới" };
export const decisionLabel = (d: string) => DECISION_LABEL[d] ?? `Giữ phương án ${d.toUpperCase()}`;

export interface CommitDeps {
  repo: VaultRepo;
  ops: OpsRepo;
  enqueue: (type: string, payload: Record<string, unknown>, opts?: { dedupeKey?: string }) => Promise<boolean>;
}

export type CommitResult = { claimed: ConflictRow; decidedBy?: undefined } | { claimed: null; decidedBy: string | null };

/**
 * Bước dùng chung cho MỌI nơi ghi nhận quyết định xung đột (2 luồng Telegram + route Admin Web `/api/vault/conflicts/:id/decide`):
 * khoá quyết định nguyên tử (người bấm/xác nhận đầu tiên thắng) → xếp job `vault-decide` → ghi audit ĐÚNG MỘT định dạng.
 * Trước khi có hàm này, 3 nơi viết tay chuỗi này đã lệch định dạng audit (mỗi nơi một payload khác nhau) — nơi gọi chỉ còn
 * lo phần giao diện riêng (soạn tin trả lời, sửa nút, gọi `markMessagesDecided`).
 */
export async function claimAndCommitDecision(d: CommitDeps, conflictId: number, decision: ConflictDecision, payload: Record<string, unknown> | null, by: string, at: Date, via: "telegram" | "telegram-merge" | "admin-web"): Promise<CommitResult> {
  const claimed = await d.repo.claimDecision(conflictId, decision, payload, by, at);
  if (!claimed) {
    const cur = await d.repo.getConflict(conflictId);
    return { claimed: null, decidedBy: cur?.decidedBy ?? null };
  }
  await d.enqueue("vault-decide", { conflictId }, { dedupeKey: `vault-decide:${conflictId}` });
  await d.ops.audit(by, "vault.decide", String(conflictId), { candidates: claimed.candidates.map((x) => x.noteId) }, { decision, via });
  return { claimed };
}

function resolvedNotice(c: ConflictRow, at: string): string {
  return `---\nconflict_id: ${c.id}\nversion_group: ${c.versionGroup}\nstatus: da-xu-ly\ndecision: ${c.decision}\ndecided_by: "${c.decidedBy ?? ""}"\ndecided_at: ${at}\n---\n\n# ✅ Đã xử lý: xung đột #${c.id}\n\nQuyết định: **${decisionLabel(c.decision ?? "")}** — bởi ${c.decidedBy ?? "?"} lúc ${at}.\n\nCác phương án đã xem:\n${c.candidates.map((x) => `- ${x.old ? "Bản cũ" : `Phương án ${x.label}`}: ${x.title} (${x.noteId})`).join("\n")}\n`;
}
