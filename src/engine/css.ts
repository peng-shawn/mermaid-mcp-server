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
      if (selector) rules.push({ selector, specificity: specificity(selector), order: order++, declarations });
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
