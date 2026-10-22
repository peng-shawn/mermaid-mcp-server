// Parsing for the two places CSS lives in Mermaid output: <style> sheets and
// style attributes.
import * as cssom from "rrweb-cssom";

export interface Declaration {
  value: string;
  important: boolean;
}

export interface Rule {
  selector: string;
  specificity: number;
  order: number;
  declarations: Map<string, Declaration>;
  // Rightmost compound's id, classes or tag: an element can only match if it
  // has one of these (the bucketing browsers use to skip most rules)
  key: { id?: string; classes: string[]; tag?: string };
}

// The id, classes and tag of a selector's rightmost compound
export function rightmostKey(selector: string): Rule["key"] {
  // Drop brackets and parentheses so their contents can't look like combinators
  const flat = selector.replace(/\[[^\]]*\]/g, "[]").replace(/\([^)]*\)/g, "()");
  const compound = flat.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() ?? "";
  const id = /#([\w-]+)/.exec(compound)?.[1];
  const classes = [...compound.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const tag = /^([a-zA-Z][\w-]*)/.exec(compound)?.[1]?.toLowerCase();
  return { id, classes, tag };
}

// Rules bucketed by rightmost key; `candidates` returns the only rules an
// element could match
export class RuleIndex {
  private byId = new Map<string, Rule[]>();
  private byClass = new Map<string, Rule[]>();
  private byTag = new Map<string, Rule[]>();
  private universal: Rule[] = [];

  constructor(rules: Rule[]) {
    const add = (map: Map<string, Rule[]>, k: string, r: Rule) => (map.get(k) ?? map.set(k, []).get(k)!).push(r);
    for (const r of rules) {
      if (r.key.id) add(this.byId, r.key.id, r);
      else if (r.key.classes.length) add(this.byClass, r.key.classes[0], r);
      else if (r.key.tag) add(this.byTag, r.key.tag, r);
      else this.universal.push(r);
    }
  }

  candidates(el: Element): Rule[] {
    const out: Rule[] = [...this.universal];
    const id = el.getAttribute("id");
    if (id) out.push(...(this.byId.get(id) ?? []));
    const cls = el.getAttribute("class");
    if (cls) for (const c of new Set(cls.split(/\s+/))) if (c) out.push(...(this.byClass.get(c) ?? []));
    out.push(...(this.byTag.get(el.localName.toLowerCase()) ?? []));
    return out;
  }
}

// Selector specificity packed into one number: ids, then classes/attributes/
// pseudo-classes, then types
export function specificity(selector: string): number {
  const s = selector.replace(/:not\(([^)]*)\)/g, " $1 ");
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length;
  const types = (s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, " ").match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
  return ids * 10000 + classes * 100 + types;
}

const sheetCache = new Map<string, Rule[]>();

// Flattens a style sheet into one rule per selector. Rules nested in at-rules
// (@media, @keyframes) never apply to a static render and are dropped.
export function parseSheet(text: string): Rule[] {
  const cached = sheetCache.get(text);
  if (cached) return cached;
  const rules: Rule[] = [];
  let parsed: { cssRules: ArrayLike<any> };
  try {
    parsed = cssom.parse(text) as unknown as { cssRules: ArrayLike<any> };
  } catch {
    parsed = { cssRules: [] };
  }
  let order = 0;
  for (const rule of Array.from(parsed.cssRules)) {
    if (!rule.selectorText || !rule.style) continue;
    const declarations = new Map<string, Declaration>();
    for (let i = 0; i < rule.style.length; i++) {
      const name: string = rule.style[i];
      declarations.set(name, { value: String(rule.style.getPropertyValue(name)).trim(), important: rule.style.getPropertyPriority(name) === "important" });
    }
    for (const part of String(rule.selectorText).split(",")) {
      const selector = part.trim();
      if (selector) rules.push({ selector, specificity: specificity(selector), order: order++, declarations, key: rightmostKey(selector) });
    }
  }
  if (sheetCache.size > 256) sheetCache.clear();
  sheetCache.set(text, rules);
  return rules;
}

const inlineCache = new Map<string, Map<string, Declaration>>();
const EMPTY = new Map<string, Declaration>();

// Parses a style attribute the way browsers do: empty declarations are
// skipped and unknown (SVG-only) properties are kept. jsdom's parser drops
// both, and Mermaid emits things like style="; font-weight: bold".
export function parseInlineStyle(text: string | null | undefined): Map<string, Declaration> {
  if (!text) return EMPTY;
  const cached = inlineCache.get(text);
  if (cached) return cached;
  const decls = new Map<string, Declaration>();
  for (const part of text.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    let value = part.slice(colon + 1).trim();
    if (!name || !value) continue;
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, "").trim();
    decls.set(name, { value, important });
  }
  if (inlineCache.size > 10000) inlineCache.clear();
  inlineCache.set(text, decls);
  return decls;
}
