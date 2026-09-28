/**
 * `_meta/taxonomy.md`: bộ category/tag chuẩn và ngôn ngữ canonical (references/taxonomy-setup.md của skill).
 * Skill KHÔNG tự tạo category mới: đơn vị không khớp category nào được trả về `unmatched` để admin quyết định.
 */
import { ITEM_TOPICS } from "../core/items";

export interface Taxonomy {
  canonicalLang: string;
  categories: { key: string; description: string }[];
  tags: Record<string, string[]>;
}

/** Chủ đề không phải tri thức (câu chào, tin hệ thống, chuyển nhân viên) không làm category của vault. */
const NOT_KNOWLEDGE = new Set(["greeting", "support", "system"]);

export function defaultTaxonomyMd(): string {
  const cats = Object.entries(ITEM_TOPICS)
    .filter(([k]) => !NOT_KNOWLEDGE.has(k))
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
  return `# Taxonomy\n\nSửa file này để đổi category/tag. Không đổi mã category đã có note dùng.\n\n## Canonical language\n- en\n\n## Categories\n${cats}\n\n## Tags chuẩn theo category\n`;
}

export function parseTaxonomy(md: string): Taxonomy {
  const out: Taxonomy = { canonicalLang: "en", categories: [], tags: {} };
  let section = "";
  let tagCat = "";
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      section = h2[1]!.toLowerCase();
      tagCat = "";
      continue;
    }
    const h3 = /^###\s+(.+)$/.exec(line);
    if (h3) {
      tagCat = h3[1]!.trim();
      continue;
    }
    const item = /^[-*]\s+(.+)$/.exec(line);
    if (!item) continue;
    const v = item[1]!.trim();
    if (section.startsWith("canonical")) out.canonicalLang = v.toLowerCase();
    else if (section.startsWith("categor")) {
      const m = /^`?([a-z0-9][a-z0-9-]*)`?\s*(?:[:—–-]\s*(.*))?$/.exec(v);
      if (m) out.categories.push({ key: m[1]!, description: (m[2] ?? "").trim() });
    } else if (section.startsWith("tag") && tagCat) (out.tags[tagCat] ??= []).push(v);
  }
  return out;
}
