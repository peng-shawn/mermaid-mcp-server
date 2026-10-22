// Scores browserless output against the Chromium oracle.
//
// Both SVGs come from the same Mermaid code with the same deterministic ids, so
// any difference comes from geometry answers. We tokenize each SVG into its
// element/attribute structure and the numbers inside geometric attributes, then
// report whether the structure matches and how far the numbers drift.
import fs from "fs";
import path from "path";
import { render } from "./render.mjs";
import { cases } from "./corpus.mjs";

const oracleDir = process.argv[2] ?? "out/oracle";
const outDir = process.argv[3] ?? "out/browserless";
const only = process.argv[4];
fs.mkdirSync(outDir, { recursive: true });

const GEOM_ATTRS = /^(x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|width|height|d|points|transform|viewBox|dx|dy|style)$/;
const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

function tokenize(svg) {
  const structure = [];
  const numbers = [];
  for (const [, tag, attrs] of svg.matchAll(/<([a-zA-Z][\w:-]*)([^>]*)>/g)) {
    structure.push(tag.toLowerCase());
    const pairs = [...attrs.matchAll(/([\w:-]+)="([^"]*)"/g)].sort((p, q) => (p[1] < q[1] ? -1 : 1));
    for (const [, name, value] of pairs) {
      if (!GEOM_ATTRS.test(name)) continue;
      const v = name === "style" ? (value.match(/max-width:\s*[\d.]+px/) || [""])[0] : value;
      const ns = v.match(NUM) || [];
      structure.push(`${name}#${ns.length}`);
      for (const n of ns) numbers.push({ v: parseFloat(n), where: `${tag}@${name}` });
    }
  }
  return { structure, numbers };
}

function score(a, b) {
  const ta = tokenize(a), tb = tokenize(b);
  const structural = ta.structure.length === tb.structure.length && ta.structure.every((t, i) => t === tb.structure[i]);
  if (!structural || ta.numbers.length !== tb.numbers.length) {
    let i = 0;
    while (i < ta.structure.length && ta.structure[i] === tb.structure[i]) i++;
    return { structural: false, at: `${ta.structure.slice(Math.max(0, i - 3), i + 1).join(" ")} | ${tb.structure.slice(Math.max(0, i - 3), i + 1).join(" ")}` };
  }
  const diffs = ta.numbers.map((n, i) => ({ d: Math.abs(n.v - tb.numbers[i].v), where: n.where, a: n.v, b: tb.numbers[i].v }));
  diffs.sort((x, y) => y.d - x.d);
  const exact = diffs.filter((d) => d.d < 0.01).length / diffs.length;
  const close = diffs.filter((d) => d.d < 1).length / diffs.length;
  return { structural: true, n: diffs.length, exact, close, max: diffs[0]?.d ?? 0, worst: diffs[0] };
}

const results = [];
for (const [name, code] of Object.entries(cases)) {
  if (only && name !== only) continue;
  const oraclePath = path.join(oracleDir, `${name}.svg`);
  if (!fs.existsSync(oraclePath)) continue;
  const t = performance.now();
  let svg;
  try {
    svg = await render(`m-${name}`, code);
  } catch (e) {
    console.log(`${name.padEnd(16)} RENDER ERROR ${String(e.message).slice(0, 100)}`);
    results.push({ name, ok: false });
    continue;
  }
  const ms = performance.now() - t;
  fs.writeFileSync(path.join(outDir, `${name}.svg`), svg);
  const s = score(fs.readFileSync(oraclePath, "utf8"), svg);
  results.push({ name, ...s, ms });
  if (!s.structural) console.log(`${name.padEnd(16)} STRUCTURE DIFFERS near: ${s.at}`);
  else
    console.log(
      `${name.padEnd(16)} ${(s.exact * 100).toFixed(1).padStart(5)}% exact  ${(s.close * 100).toFixed(1).padStart(5)}% <1px  max ${s.max.toFixed(2).padStart(7)}  (${s.worst?.where} ${s.worst?.a} vs ${s.worst?.b})  ${ms.toFixed(0)}ms`
    );
}
const ok = results.filter((r) => r.structural);
const all = ok.reduce((s, r) => s + r.n, 0);
console.log(`\nstructurally identical: ${ok.length}/${results.length}   numbers exact: ${(ok.reduce((s, r) => s + r.exact * r.n, 0) / all * 100).toFixed(1)}%   within 1px: ${(ok.reduce((s, r) => s + r.close * r.n, 0) / all * 100).toFixed(1)}%`);
