import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendQueue, readCursor, readIndex, readQueue, upsertEntry, writeCursor, writeIndex } from "../src/vault/index-file";
import { noteContentHash, parseNote, relatedIds, relatedLink, renderNote, validateNote, type VaultNote } from "../src/vault/note";
import { ensureVault } from "../src/vault/paths";
import { parseTaxonomy } from "../src/vault/taxonomy";

const note = (over: Partial<VaultNote["meta"]> = {}, body = "## Thời gian hoàn tiền\n\nHoàn tiền trong 3-5 ngày làm việc."): VaultNote => ({
  meta: {
    id: "hoan-tien-001", title: "Thời gian hoàn tiền", category: "wallet", tags: ["hoan-tien"], status: "confirmed", lang_source: "vi", source_file: "chinh-sach.xlsx",
    source_refs: ["Sheet FAQ, dòng 12"], ingested_at: "2026-09-28T10:00:00+07:00", version_group: "hoan-tien", supersedes: null, conflict_ref: null,
    related: [relatedLink("phi-giao-dich-001", "Phí giao dịch")], summary: "Thời gian hoàn tiền.", keywords: ["bao lâu thì hoàn tiền"],
    canonical_title: "Refund time", canonical_summary: "Refunds take 3-5 business days.", canonical_keywords: ["refund time"], ...over,
  },
  body,
});

describe("vault note", () => {
  it("render rồi parse giữ nguyên dữ liệu; related luôn là chuỗi có ngoặc kép", () => {
    const md = renderNote(note());
    expect(md).toContain('related:\n  - "[[phi-giao-dich-001|Phí giao dịch]]"');
    const back = parseNote(md);
    expect(back.meta).toEqual(note().meta);
    expect(back.body).toBe(note().body);
    expect(validateNote(back)).toEqual([]);
    expect(relatedIds(back)).toEqual(["phi-giao-dich-001"]);
  });

  it("related viết thiếu ngoặc kép bị báo lỗi, nói rõ cần sửa gì", () => {
    const md = renderNote(note()).replace(/related:\n {2}- .*\n/, "related: [[A]]\n");
    const errs = validateNote(parseNote(md));
    expect(errs.join(" ")).toContain('related phải là danh sách chuỗi có ngoặc kép');
  });

  it("thiếu trường bắt buộc bị báo từng trường", () => {
    const errs = validateNote(note({ canonical_summary: "", keywords: [] }));
    expect(errs).toEqual(expect.arrayContaining([expect.stringContaining("canonical_summary"), expect.stringContaining("keywords")]));
  });

  it("content_hash đổi khi thân note hoặc canonical_summary đổi", () => {
    const h = noteContentHash(note());
    expect(noteContentHash(note({ canonical_summary: "Refunds take 7 business days." }))).not.toBe(h);
    expect(noteContentHash(note({}, "khác"))).not.toBe(h);
    expect(noteContentHash(note({ tags: ["x"] }))).toBe(h);
  });
});

describe("vault files", () => {
  it("ensureVault tạo cấu trúc, index.json, hàng đợi và cursor dùng được", () => {
    const root = mkdtempSync(join(tmpdir(), "vault-"));
    const p = ensureVault(root);
    expect(readIndex(p).notes).toEqual([]);
    const tax = parseTaxonomy(readFileSync(p.taxonomy, "utf8"));
    expect(tax.canonicalLang).toBe("en");
    expect(tax.categories.map((c) => c.key)).toContain("kyc");
    expect(tax.categories.map((c) => c.key)).not.toContain("system");

    const idx = readIndex(p);
    upsertEntry(idx, { id: "a", title: "A", category: "kyc", version_group: "a", status: "confirmed", lang_source: "vi", ingested_at: "x", supersedes: null, conflict_ref: null, content_hash: "h", path: "notes/kyc/a.md" });
    writeIndex(p, idx);
    expect(readIndex(p).notes).toHaveLength(1);

    appendQueue(p, [{ action: "upsert", note_id: "a", reason: "new", queued_at: "t" }]);
    appendQueue(p, [{ action: "remove", note_id: "b", reason: "superseded", queued_at: "t" }]);
    expect(readQueue(p).map((j) => [j.job, j.action, j.note_id])).toEqual([["index-note", "upsert", "a"], ["index-note", "remove", "b"]]);
    expect(readCursor(p)).toBe(0);
    writeCursor(p, 2);
    expect(readCursor(p)).toBe(2);
    // chạy lại không ghi đè taxonomy admin đã sửa
    ensureVault(root);
    expect(readIndex(p).notes).toHaveLength(1);
  });
});
