// Accuracy suite: renders a corpus with the browserless engine and with
// Chromium (the reference: Mermaid's own target), then compares the SVGs.
//
// Both sides run the same Mermaid build with the same configuration, the same
// seeded random sequence and a frozen clock, so any difference comes from the
// geometry answers. Each SVG is tokenized into its element/attribute structure
// and the numbers in geometric attributes; we report whether the structure is
// identical and how far the numbers drift.
//
//   node test/accuracy/run.mjs [--corpus builtin|docs|all] [--only <name>] [--refresh-oracle] [--json <file>]
//
// Chromium output is cached per Mermaid version in test/accuracy/.oracle/.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const corpusName = opt("corpus", "all");
const only = opt("only");
const refresh = args.includes("--refresh-oracle");
const jsonOut = opt("json");

// Known differences that are not geometry: venn seeds its layout optimizer
// with Math.random, and jsdom and Chromium draw a different number of random
// values before it runs, so each finds a different (equally valid) optimum.
const NONDETERMINISTIC = new Set(["venn-04"]);

const FROZEN_CLOCK = `(() => {
  if (globalThis.__realDate) return;
  const Real = Date;
  const NOW = Real.UTC(2026, 0, 15, 12, 0, 0);
  globalThis.__realDate = Real;
  globalThis.Date = class extends Real {
    constructor(...a) { super(...(a.length ? a : [NOW])); }
    static now() { return NOW; }
  };
})()`;

async function loadCorpus() {
  const out = {};
  if (corpusName !== "docs") Object.assign(out, (await import("./corpus-builtin.mjs")).default);
  if (corpusName !== "builtin") Object.assign(out, JSON.parse(fs.readFileSync(path.join(here, "corpus-docs.json"), "utf8")));
  return only ? Object.fromEntries(Object.entries(out).filter(([k]) => k === only)) : out;
}

// ---- Chromium reference ----------------------------------------------------

async function oracle(cases, config, seedSource) {
  const mermaidVersion = require("mermaid/package.json").version;
  const dir = path.join(here, ".oracle", mermaidVersion);
  fs.mkdirSync(dir, { recursive: true });
  const missing = Object.keys(cases).filter((k) => refresh || !fs.existsSync(path.join(dir, `${k}.json`)));
  if (missing.length) {
    const { default: puppeteer } = await import("puppeteer");
    const browser = await puppeteer.launch({ headless: true });
    let page;
    const fresh = async () => {
      page = await browser.newPage();
      await page.setContent("<!doctype html><html><body></body></html>");
      await page.addScriptTag({ path: require.resolve("mermaid/dist/mermaid.min.js") });
    };
    await fresh();
    for (const name of missing) {
      const run = page.evaluate(
        async (code, config, seed, clock) => {
          eval(clock);
          const reset = eval(seed);
          window.mermaid.initialize(config);
          try {
            await window.mermaid.parse(code);
            reset();
            return { svg: (await window.mermaid.render("mermaid-svg", code)).svg };
          } catch (e) {
            return { error: String(e?.message ?? e) };
          }
        },
        cases[name], config, seedSource, FROZEN_CLOCK
      );
      const result = await Promise.race([run, new Promise((r) => setTimeout(() => r({ error: "TIMEOUT" }), 30000))]);
      if (result.error === "TIMEOUT") {
        await page.close().catch(() => {});
        await fresh();
      }
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(result));
      process.stderr.write(".");
    }
    process.stderr.write("\n");
    await browser.close();
  }
  return (name) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
}

// ---- comparison ---------------------------------------------------------------

const GEOMETRY = /^(x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|width|height|d|points|transform|viewBox|dx|dy|style)$/;
const NUMBER = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

function tokenize(svg) {
  const structure = [];
  const numbers = [];
  for (const [, tag, attrs] of svg.matchAll(/<([a-zA-Z][\w:-]*)([^>]*)>/g)) {
    structure.push(tag.toLowerCase());
    const pairs = [...attrs.matchAll(/([\w:-]+)="([^"]*)"/g)].sort((a, b) => (a[1] < b[1] ? -1 : 1));
    for (const [, name, value] of pairs) {
      if (!GEOMETRY.test(name)) continue;
      const v = name === "style" ? (value.match(/max-width:\s*[\d.]+px/) || [""])[0] : value;
      const ns = v.match(NUMBER) || [];
      structure.push(`${name}#${ns.length}`);
      for (const n of ns) numbers.push({ v: parseFloat(n), where: `${tag}@${name}` });
    }
  }
  return { structure, numbers };
}

function compare(reference, ours) {
  const a = tokenize(reference);
  const b = tokenize(ours);
  if (a.structure.join() !== b.structure.join() || a.numbers.length !== b.numbers.length) return { structural: false };
  let max = 0;
  let worst = null;
  for (let i = 0; i < a.numbers.length; i++) {
    const d = Math.abs(a.numbers[i].v - b.numbers[i].v);
    if (d > max) [max, worst] = [d, `${a.numbers[i].where} ${a.numbers[i].v} vs ${b.numbers[i].v}`];
  }
  return { structural: true, max, worst, count: a.numbers.length, within: (t) => a.numbers.every((n, i) => Math.abs(n.v - b.numbers[i].v) <= t) };
}

// ---- main -------------------------------------------------------------------------

(0, eval)(FROZEN_CLOCK);
const { MermaidEngine, mermaidConfig, SEEDED_RANDOM_SOURCE } = await import("../../dist/engine/mermaid.js");
const cases = await loadCorpus();
const reference = await oracle(cases, mermaidConfig({}), SEEDED_RANDOM_SOURCE);
const engine = await MermaidEngine.create();

const rows = [];
for (const [name, code] of Object.entries(cases)) {
  const ref = reference(name);
  if (ref.error) {
    rows.push({ name, status: "reference-error", detail: ref.error.slice(0, 80) });
    continue;
  }
  const t = performance.now();
  let svg;
  try {
    svg = (await engine.render(code, {})).svg;
  } catch (e) {
    rows.push({ name, status: "render-error", detail: String(e.message).slice(0, 120) });
    continue;
  }
  const ms = performance.now() - t;
  const c = compare(ref.svg, svg);
  rows.push({ name, ms, ...(c.structural ? { status: "ok", max: c.max, worst: c.worst, exact: c.within(0.05), close: c.within(1) } : { status: "structure-differs" }) });
}

const scored = rows.filter((r) => r.status !== "reference-error");
const ok = scored.filter((r) => r.status === "ok");
const pct = (n) => `${((100 * n) / scored.length).toFixed(1)}%`;
const summary = {
  mermaid: require("mermaid/package.json").version,
  diagrams: scored.length,
  structurallyIdentical: ok.length,
  within005px: ok.filter((r) => r.exact).length,
  within1px: ok.filter((r) => r.close).length,
  renderErrors: scored.filter((r) => r.status === "render-error").length,
  referenceErrors: rows.length - scored.length,
  medianMs: Math.round(ok.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)] ?? 0),
};
for (const r of rows.filter((r) => r.status !== "ok" || !r.close)) {
  if (r.status === "reference-error") continue;
  console.log(`${r.name.padEnd(28)} ${r.status === "ok" ? `max ${r.max.toFixed(2)}px  ${r.worst}` : `${r.status} ${r.detail ?? ""}`}${NONDETERMINISTIC.has(r.name) ? "  (known nondeterministic)" : ""}`);
}
console.log(
  `\n${summary.diagrams} diagrams (Mermaid ${summary.mermaid}): ${summary.structurallyIdentical} structurally identical, ` +
    `${summary.within005px} (${pct(summary.within005px)}) within 0.05px, ${summary.within1px} (${pct(summary.within1px)}) within 1px; median render ${summary.medianMs}ms`
);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ summary, rows }, null, 2));

// Gate: everything structurally identical and within 1px, except known cases
const failures = scored.filter((r) => !NONDETERMINISTIC.has(r.name) && !(r.status === "ok" && r.close));
process.exit(failures.length ? 1 : 0);
