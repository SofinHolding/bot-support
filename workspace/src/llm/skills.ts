/**
 * SKILL = file `content/skills/<tên>/SKILL.md`: frontmatter (name, version, description) + thân là chỉ dẫn gửi cho LLM.
 * Chỉ dẫn nằm trong file để người duyệt đọc được đúng thứ model nhận; code chỉ nạp và kiểm tra cấu trúc lúc khởi động
 * (thiếu file / thiếu mục Requirements / sai tên => dừng ngay, không chạy với prompt thiếu). Ràng buộc quan trọng vẫn được CODE kiểm lại
 * ở đầu ra (core/translate.ts), không tin vào việc model nhớ.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export const SKILL_NAMES = ["understand", "select-answer", "verify-answer", "translate-query", "translate-answer", "review-eval", "summarize-episode", "verify-handoff", "review-overlap", "intake-draft"] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

export interface Skill {
  name: SkillName;
  version: number;
  description: string;
  /** Chỉ dẫn gửi cho LLM (không gồm frontmatter) */
  body: string;
  /** Toàn bộ file (frontmatter + thân) để hiển thị/sửa trên Admin Web */
  markdown: string;
}

export type SkillSet = Record<SkillName, Skill>;

export function parseSkill(md: string, expected: SkillName): Skill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(md.trimStart());
  if (!m) throw new Error(`SKILL ${expected}: thiếu frontmatter`);
  const meta = (parseYaml(m[1]!) ?? {}) as Record<string, unknown>;
  const body = m[2]!.trim();
  if (meta.name !== expected) throw new Error(`SKILL ${expected}: frontmatter name là "${String(meta.name)}"`);
  const version = Number(meta.version);
  if (!Number.isInteger(version) || version < 1) throw new Error(`SKILL ${expected}: version phải là số nguyên >= 1`);
  if (!/^## Requirements$/m.test(body)) throw new Error(`SKILL ${expected}: thiếu mục "## Requirements"`);
  if (!/^## Output$/m.test(body)) throw new Error(`SKILL ${expected}: thiếu mục "## Output"`);
  if (!/^R1\./m.test(body)) throw new Error(`SKILL ${expected}: các yêu cầu phải đánh số R1, R2, ...`);
  return { name: expected, version, description: String(meta.description ?? "").replace(/\s+/g, " ").trim(), body, markdown: md };
}

/** Nguồn SKILL cho LlmClient: file trong content/skills (mặc định) + bản Admin sửa lưu trong settings `skill.<name>` (ưu tiên). */
export class SkillStore {
  private readonly file: SkillSet;
  private cache: { at: number; set: SkillSet } | null = null;
  constructor(private readonly ops: { getSettings(): Promise<Record<string, unknown>>; setSetting(k: string, v: unknown, by: string): Promise<void>; deleteSetting(k: string): Promise<void> }, contentDir: string, private readonly ttlMs = 10_000, private readonly now: () => number = Date.now) {
    this.file = loadSkills(contentDir);
  }
  invalidate() {
    this.cache = null;
  }
  async get(): Promise<SkillSet> {
    if (this.cache && this.now() - this.cache.at < this.ttlMs) return this.cache.set;
    const stored = await this.ops.getSettings();
    const set = { ...this.file } as SkillSet;
    for (const name of SKILL_NAMES) {
      const md = stored[`skill.${name}`];
      if (typeof md !== "string" || !md.trim()) continue;
      try {
        set[name] = parseSkill(md, name);
      } catch {
        /* bản trong DB hỏng (không qua được kiểm tra cấu trúc): dùng bản file */
      }
    }
    this.cache = { at: this.now(), set };
    return set;
  }
  /** Cho Admin Web: từng SKILL với nguồn đang dùng và nội dung markdown đầy đủ (frontmatter + thân). */
  async list(): Promise<{ name: SkillName; version: number; description: string; source: "file" | "custom"; markdown: string; fileMarkdown: string }[]> {
    const stored = await this.ops.getSettings();
    return SKILL_NAMES.map((name) => {
      const custom = stored[`skill.${name}`];
      const fileMarkdown = this.file[name].markdown;
      const md = typeof custom === "string" && custom.trim() ? custom : fileMarkdown;
      let parsed: Skill;
      try {
        parsed = parseSkill(md, name);
      } catch {
        parsed = this.file[name];
      }
      return { name, version: parsed.version, description: parsed.description, source: typeof custom === "string" && custom.trim() ? "custom" : "file", markdown: md, fileMarkdown };
    });
  }
  /** Kiểm tra cấu trúc rồi lưu. Ném lỗi (thông điệp tiếng Việt) nếu không hợp lệ. */
  async save(name: SkillName, markdown: string, by: string) {
    parseSkill(markdown, name); // ném lỗi nếu thiếu frontmatter / Requirements / Output / R1
    await this.ops.setSetting(`skill.${name}`, markdown, by);
    this.invalidate();
  }
  async reset(name: SkillName) {
    await this.ops.deleteSetting(`skill.${name}`);
    this.invalidate();
  }
}

export function loadSkills(contentDir: string): SkillSet {
  const out = {} as SkillSet;
  for (const name of SKILL_NAMES) {
    const file = join(contentDir, "skills", name, "SKILL.md");
    let md: string;
    try {
      md = readFileSync(file, "utf8");
    } catch (e) {
      throw new Error(`không đọc được SKILL ${name} (${file}): ${(e as Error).message}`);
    }
    out[name] = parseSkill(md, name);
  }
  return out;
}
