/** Nạp lần đầu: template + tri thức + predicate + admin + bộ câu hỏi mẫu. Idempotent. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { GUIDE_SLUG, GUIDE_TITLE } from "../core/guide";
import { loadPredicates } from "../core/predicates";
import type { Db } from "../db/db";
import type { KbRepo } from "../db/repo-kb";
import type { OpsRepo } from "../db/repo-ops";
import type { KbService } from "./service";

export interface SeedOptions {
  contentDir: string;
  adminIds: number[];
  ownerId: number | null;
}

export interface SeedResult {
  templatesSeeded: boolean;
  docs: number;
  admins: number;
  evalCases: number;
}

export async function seedContent(kbService: KbService, kb: KbRepo, ops: OpsRepo, _db: Db, opt: SeedOptions): Promise<SeedResult> {
  const result: SeedResult = { templatesSeeded: false, docs: 0, admins: 0, evalCases: 0 };

  // Predicate: cấu hình được bảo vệ
  const prot = await ops.getProtected();
  if (!prot.predicates) await ops.setProtected("predicates", loadPredicates(join(opt.contentDir, "config", "predicates.yml")), "seed");

  // Admin: ID lấy từ cấu hình môi trường (không ghi cứng trong mã nguồn)
  const existing = new Set((await ops.listAdmins()).map((a) => a.telegram_id));
  for (const id of opt.adminIds) {
    if (!existing.has(id)) {
      await ops.upsertAdmin(id, id === opt.ownerId ? "owner" : "admin", null);
      result.admins++;
    }
  }
  if (opt.ownerId && !existing.has(opt.ownerId) && !opt.adminIds.includes(opt.ownerId)) {
    await ops.upsertAdmin(opt.ownerId, "owner", null);
    result.admins++;
  }

  // Nội dung: chỉ khi chưa có gì được publish
  const docs = await kb.listDocuments();
  if (!docs.some((d) => d.published_version !== null)) {
    const bundle: { slug: string; kind: "templates" | "knowledge"; title: string; md: string }[] = [];
    const tdir = join(opt.contentDir, "templates");
    for (const f of readdirSync(tdir).filter((x) => x.endsWith(".md")).sort()) {
      const stem = basename(f, ".md");
      bundle.push({ slug: `templates-${stem}`, kind: "templates", title: `Templates: ${stem}`, md: readFileSync(join(tdir, f), "utf8") });
    }
    const kdir = join(opt.contentDir, "knowledge");
    if (existsSync(kdir)) {
      for (const f of readdirSync(kdir).filter((x) => x.endsWith(".md")).sort()) {
        const md = readFileSync(join(kdir, f), "utf8");
        const meta = /^---\n([\s\S]*?)\n---/.exec(md.replace(/\r\n/g, "\n"));
        const fm = meta ? (parseYaml(meta[1]!) as { slug?: string; title?: string }) : {};
        const slug = fm.slug ?? basename(f, ".md");
        bundle.push({ slug, kind: "knowledge", title: fm.title ?? slug, md });
      }
    }
    await kbService.publishBundle(bundle, "seed");
    result.templatesSeeded = true;
    result.docs = bundle.length;
  }

  // "Hướng dẫn AI làm việc": nạp bản mặc định khi CHƯA từng có tài liệu này (kể cả với DB đã chạy từ trước khi có tính năng).
  // Đã có (dù đang Draft hay đã publish) thì không đụng tới: bản của quản trị viên là bản đúng.
  const guideFile = join(opt.contentDir, "guide", "agent-guide.md");
  if (existsSync(guideFile) && !(await kb.getDocument(GUIDE_SLUG))) {
    await kbService.publishBundle([{ slug: GUIDE_SLUG, kind: "guide", title: GUIDE_TITLE, md: readFileSync(guideFile, "utf8") }], "seed");
    result.docs++;
  }

  // Bộ câu hỏi mẫu cho hồi quy
  if ((await kb.countEvalCases()) === 0) {
    const file = join(opt.contentDir, "eval", "eval_cases.jsonl");
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim())) {
        const c = JSON.parse(line) as { question: string; expected: string | null; image_type?: string; lang?: string; source?: string };
        await kb.addEvalCase({ question: c.question, expected: c.expected, imageType: c.image_type ?? null, lang: c.lang ?? null, source: c.source ?? "seed" });
        result.evalCases++;
      }
    }
  }
  return result;
}
