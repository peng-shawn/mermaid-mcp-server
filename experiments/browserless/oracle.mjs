// Renders the corpus in real Chromium to produce ground-truth SVGs and to
// record which layout-dependent DOM APIs Mermaid calls for each diagram type.
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { cases } from "./corpus.mjs";
import { MERMAID_CONFIG, SEEDED_RANDOM_SRC, FROZEN_CLOCK_SRC } from "./config.mjs";

const INSTRUMENT_SRC = (cfg) => {
  window.__calls = {};
  const wrap = (proto, name, label) => {
    const orig = proto[name];
    if (!orig) return;
    proto[name] = function (...a) { window.__calls[label] = (window.__calls[label] || 0) + 1; return orig.apply(this, a); };
  };
  wrap(SVGGraphicsElement.prototype, "getBBox", "getBBox");
  wrap(SVGTextContentElement.prototype, "getComputedTextLength", "getComputedTextLength");
  wrap(SVGGeometryElement.prototype, "getTotalLength", "getTotalLength");
  wrap(SVGGeometryElement.prototype, "getPointAtLength", "getPointAtLength");
  wrap(Element.prototype, "getBoundingClientRect", "getBoundingClientRect");
  wrap(window, "getComputedStyle", "getComputedStyle");
  wrap(CanvasRenderingContext2D.prototype, "measureText", "canvas.measureText");
  window.mermaid.initialize(cfg);
};

const require = createRequire(import.meta.url);
const mermaidPath = require.resolve("mermaid/dist/mermaid.min.js");
const outDir = process.argv[2] ?? "out/oracle";
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({ headless: true });
let page;
async function freshPage() {
  page = await browser.newPage();
  await page.setContent("<!doctype html><html><body><div id=c></div></body></html>");
  await page.addScriptTag({ path: mermaidPath });
  await page.evaluate(INSTRUMENT_SRC, MERMAID_CONFIG);
}
const report = {};
await freshPage();
const RENDER_TIMEOUT = 20000;
for (const [name, code] of Object.entries(cases)) {
  const run = page.evaluate(async (name, code, seed, clock) => {
    window.__calls = {};
    eval(seed);
    eval(clock);
    try {
      const { svg } = await window.mermaid.render(`m-${name}`, code);
      return { svg, calls: window.__calls };
    } catch (e) { return { error: String(e?.message ?? e), calls: window.__calls }; }
  }, name, code, SEEDED_RANDOM_SRC, FROZEN_CLOCK_SRC);
  const r = await Promise.race([run, new Promise((res) => setTimeout(() => res({ error: "TIMEOUT", calls: {} }), RENDER_TIMEOUT))]);
  if (r.error === "TIMEOUT") {
    await page.close().catch(() => {});
    await freshPage();
  }
  if (r.svg) fs.writeFileSync(path.join(outDir, `${name}.svg`), r.svg);
  report[name] = r.error ? { error: r.error } : r.calls;
  console.log(name.padEnd(16), r.error ? "ERROR " + r.error.slice(0, 80) : JSON.stringify(r.calls));
}
fs.writeFileSync(path.join(outDir, "_calls.json"), JSON.stringify(report, null, 2));
await browser.close();
