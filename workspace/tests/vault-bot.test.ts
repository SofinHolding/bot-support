/** Đầu-cuối: note trong vault (đã index) được bot dùng để trả lời; note chờ duyệt không bao giờ đến tay khách. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HashEmbedder } from "../src/core/embedding";
import { vaultRepo } from "../src/db/repo-vault";
import { PgKnowledge } from "../src/kb/knowledge-search";
import { runIndex } from "../src/vault/indexer";
import type { NoteMeta } from "../src/vault/note";
import { CompositeKnowledge, VaultKnowledge } from "../src/vault/search";
import { VaultStore } from "../src/vault/store";
import { fakeLlm, makeWorld, type World } from "./helpers";

let w: World;
let selected: string[][] = [];

const meta = (id: string, over: Partial<NoteMeta>): NoteMeta => ({
  id, title: id, category: "wallet", tags: [], status: "confirmed", lang_source: "vi", source_file: "a.xlsx", source_refs: [], ingested_at: "2026-09-28T03:00:00.000Z",
  version_group: id, supersedes: null, conflict_ref: null, related: [], summary: "s", keywords: ["k"], canonical_title: id, canonical_summary: "s", canonical_keywords: ["k"], ...over,
});

beforeAll(async () => {
  const llm = fakeLlm({
    understand: async (r) => ({ language: "vi", intent: "question", follow_up: "none", query_en: r.text, query_kb: r.text }),
    select: async (r) => {
      selected.push(r.candidates.map((c) => c.ref));
      return { ref: r.candidates.find((c) => c.ref.startsWith("K:v:"))?.ref ?? "ESCALATE", reason: "" };
    },
  });
  w = await makeWorld({ llm });
  const repo = vaultRepo(w.db);
  const embedder = new HashEmbedder();
  const store = VaultStore.open(mkdtempSync(join(tmpdir(), "vault-")), repo);
  await store.save({ meta: meta("phi-giao-dich-001", { keywords: ["phí rút xyzcoin"] }), body: "Phí rút xyzcoin hiện tại là 1.5% mỗi giao dịch." });
  await store.save({ meta: meta("phi-giao-dich-002", { status: "awaiting_approval", keywords: ["phí rút xyzcoin"] }), body: "Phí rút xyzcoin hiện tại là 9% mỗi giao dịch." });
  store.queue([{ action: "upsert", note_id: "phi-giao-dich-001", reason: "new", queued_at: "t" }, { action: "upsert", note_id: "phi-giao-dich-002", reason: "new", queued_at: "t" }]);
  store.flush();
  await runIndex({ store, repo, embedder, log: () => undefined });
  (w.pipeline["d"] as { knowledge?: unknown }).knowledge = new CompositeKnowledge(new PgKnowledge(w.kb, embedder), new VaultKnowledge(repo, embedder));
});
afterAll(() => w.close());

describe("bot dùng note vault", () => {
  it("trả lời bằng nguyên văn thân note đã duyệt; bản chờ duyệt không nằm trong ứng viên", async () => {
    selected = [];
    await w.say(8101, "phí rút xyzcoin là bao nhiêu vậy");
    const reply = w.channel.textsTo(8101).at(-1)!;
    expect(selected.flat()).toContain("K:v:phi-giao-dich-001#0");
    expect(selected.flat().some((r) => r.includes("phi-giao-dich-002"))).toBe(false);
    expect(reply).toContain("1.5%");
    expect(reply).not.toContain("9%");
  });
});
