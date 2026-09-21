/** Nạp kho nội dung (content/) thành bộ template + predicate + chỉ mục sẵn dùng. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParseIssue, Template } from "../domain/types";
import { HashEmbedder, type Embedder } from "./embedding";
import { loadPredicates, makeEvaluator, type Evaluator, type PredicateMap } from "./predicates";
import { parseTemplateFile, validateBundle } from "./templates";
import { TemplateIndex } from "./template-index";

export interface ContentBundle {
  templates: Template[];
  predicates: PredicateMap;
  evaluator: Evaluator;
  issues: ParseIssue[];
}

export function loadContentDir(root = "content"): ContentBundle {
  const predicates = loadPredicates(join(root, "config", "predicates.yml"));
  const evaluator = makeEvaluator(predicates);
  const templates: Template[] = [];
  const issues: ParseIssue[] = [];
  const dir = join(root, "templates");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
    const r = parseTemplateFile(readFileSync(join(dir, f), "utf8"), f);
    templates.push(...r.templates);
    issues.push(...r.issues.map((i) => ({ ...i, message: `${f}: ${i.message}` })));
  }
  issues.push(...validateBundle(templates, evaluator.names()));
  return { templates, predicates, evaluator, issues };
}

export async function buildIndex(bundle: Pick<ContentBundle, "templates" | "evaluator">, embedder: Embedder = new HashEmbedder()): Promise<TemplateIndex> {
  const vectors = await TemplateIndex.computeVectors(bundle.templates, embedder);
  return new TemplateIndex(bundle.templates, bundle.evaluator, embedder, vectors);
}
