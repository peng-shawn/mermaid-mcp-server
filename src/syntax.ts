// Mermaid's own syntax documentation (MIT, from the mermaid repository),
// served as MCP resources so a model can look up a diagram type it doesn't
// know well, or the one a parse error points at.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export interface SyntaxDoc {
  slug: string;
  title: string;
  keywords: string[];
}

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/syntax");
let docs: SyntaxDoc[] | null = null;

export function syntaxDocs(): SyntaxDoc[] {
  if (!docs) {
    const index = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")) as Record<string, { title: string; keywords: string[] }>;
    docs = Object.entries(index).map(([slug, v]) => ({ slug, ...v }));
  }
  return docs;
}

export function readSyntaxDoc(slug: string): string | null {
  if (!syntaxDocs().some((d) => d.slug === slug)) return null;
  return fs.readFileSync(path.join(dir, `${slug}.md`), "utf8");
}

export const syntaxUri = (slug: string) => `mermaid://syntax/${slug}`;

// The first keyword of a diagram, after frontmatter, directives and comments
export function diagramKeyword(code: string): string | null {
  const body = code.replace(/^\s*---\n[\s\S]*?\n---\s*\n/, "");
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("%%")) continue;
    return t.split(/[\s;:{]/)[0] || null;
  }
  return null;
}

export function docForCode(code: string): SyntaxDoc | null {
  const kw = diagramKeyword(code)?.toLowerCase();
  if (!kw) return null;
  return syntaxDocs().find((d) => d.keywords.some((k) => k.toLowerCase() === kw)) ?? null;
}
