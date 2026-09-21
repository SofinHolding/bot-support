import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Condition, VisionScreenType } from "../domain/types";
import { containsPhrase, normalize } from "./text";

export type PredicateDef =
  | { any: string[] }
  | { regex: string; flags?: string; normalized?: boolean }
  | { all_of: string[] }
  | { image_type: string | string[] };

export type PredicateMap = Record<string, PredicateDef>;

export function loadPredicates(path: string): PredicateMap {
  const doc = parseYaml(readFileSync(path, "utf8")) as { predicates?: PredicateMap };
  return doc.predicates ?? {};
}

/** Đầu vào để đánh giá điều kiện cho một tin nhắn. */
export interface EvalInput {
  text: string;
  norm: string;
  imageType?: VisionScreenType;
  lastTemplateId?: string;
}

export function makeEvaluator(predicates: PredicateMap) {
  const regexCache = new Map<string, RegExp>();
  const rx = (src: string, flags = "iu") => {
    const k = `${flags}/${src}`;
    let r = regexCache.get(k);
    if (!r) regexCache.set(k, (r = new RegExp(src, flags)));
    return r;
  };

  const evalDef = (def: PredicateDef, inp: EvalInput, depth = 0): boolean => {
    if (depth > 5) return false;
    if ("any" in def) return def.any.some((p) => containsPhrase(inp.norm, p));
    if ("regex" in def) return rx(def.regex, def.flags).test(def.normalized ? inp.norm : inp.text);
    if ("all_of" in def) return def.all_of.every((n) => predicates[n] && evalDef(predicates[n]!, inp, depth + 1));
    if ("image_type" in def) {
      const list = Array.isArray(def.image_type) ? def.image_type : [def.image_type];
      return !!inp.imageType && list.includes(inp.imageType);
    }
    return false;
  };

  const evalCondition = (c: Condition, inp: EvalInput): boolean => {
    if (typeof c === "string") {
      const def = predicates[c];
      return def ? evalDef(def, inp) : false;
    }
    if ("any" in c) return c.any.some((p) => containsPhrase(inp.norm, p));
    if ("regex" in c) return rx(c.regex, c.flags).test(inp.text);
    if ("image_type" in c) {
      const list = Array.isArray(c.image_type) ? c.image_type : [c.image_type];
      return !!inp.imageType && list.includes(inp.imageType);
    }
    if ("last_template" in c) {
      const list = Array.isArray(c.last_template) ? c.last_template : [c.last_template];
      return !!inp.lastTemplateId && list.includes(inp.lastTemplateId);
    }
    return false;
  };

  const test = (name: string, inp: EvalInput) => (predicates[name] ? evalDef(predicates[name]!, inp) : false);
  return { evalCondition, test, names: () => new Set(Object.keys(predicates)) };
}

export type Evaluator = ReturnType<typeof makeEvaluator>;
export const makeInput = (text: string, extra: Partial<EvalInput> = {}): EvalInput => ({ text, norm: normalize(text), ...extra });
