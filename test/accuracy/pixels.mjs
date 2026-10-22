// Pixel accuracy of the full pipeline (layout, CSS flattening, resvg) against
// Chromium's screenshot of its own render of the same diagram.
//
//   node test/accuracy/pixels.mjs [--corpus builtin|docs|all] [--only <name>] [--out <dir>]
//
// Reads Chromium's SVGs from the cache written by run.mjs (run that first).
// Writes side-by-side images (Chromium | ours | diff) for the worst cases.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const corpusName = opt("corpus", "all");
const only = opt("only");
const outDir = opt("out", path.join(here, ".pixels"));
const SCALE = 2;
const NONDETERMINISTIC = new Set(["venn-04"]);

const corpus = {
  ...(corpusName !== "docs" ? (await import("./corpus-builtin.mjs")).default : {}),
  ...(corpusName !== "builtin" ? JSON.parse(fs.readFileSync(path.join(here, "corpus-docs.json"), "utf8")) : {}),
};
const names = Object.keys(corpus).filter((n) => !only || n === only);
const oracleDir = path.join(here, ".oracle", require("mermaid/package.json").version);

const FROZEN_CLOCK = `(() => { if (globalThis.__realDate) return; const R = Date; const NOW = R.UTC(2026, 0, 15, 12); globalThis.__realDate = R;
  globalThis.Date = class extends R { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }; })()`;
(0, eval)(FROZEN_CLOCK);
const { MermaidEngine } = await import("../../dist/engine/mermaid.js");
const { flattenSvg } = await import("../../dist/engine/flatten.js");
const { rasterize } = await import("../../dist/engine/raster.js");
const { takeFallbackSeen } = await import("../../dist/engine/fonts.js");
const { inlineEmoji, needsEmojiInlining } = await import("../../dist/engine/emoji.js");
const engine = await MermaidEngine.create();

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
fs.mkdirSync(outDir, { recursive: true });

// Chromium screenshot of an SVG at 1:1 CSS pixels times SCALE, white background
async function screenshot(svg) {
  const [, , w, h] = /viewBox="([^"]+)"/.exec(svg)[1].split(/[\s,]+/).map(Number);
  const sized = svg.replace(/<svg\b[^>]*>/, (t) => t.replace(/\swidth="[^"]*"/, ` width="${w}"`).replace(/\sstyle="[^"]*"/, "").replace(/^<svg/, `<svg height="${h}"`));
  await page.setViewport({ width: Math.ceil(w), height: Math.ceil(h), deviceScaleFactor: SCALE });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:white">${sized}</body></html>`);
  return PNG.sync.read(await page.screenshot({ clip: { x: 0, y: 0, width: Math.ceil(w), height: Math.ceil(h) } }));
}

function crop(img, w, h) {
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(img, out, 0, 0, w, h, 0, 0);
  return out;
}

const rows = [];
for (const name of names) {
  const file = path.join(oracleDir, `${name}.json`);
  if (!fs.existsSync(file)) continue;
  const ref = JSON.parse(fs.readFileSync(file, "utf8"));
  if (ref.error) continue;
  let ours;
  try {
    takeFallbackSeen();
    const { svg } = await engine.render(corpus[name], {});
    const flat = flattenSvg(engine.dom, svg, { background: "white" });
    const systemFonts = takeFallbackSeen();
    const raster = needsEmojiInlining(flat.svg) ? inlineEmoji(engine.dom, flat.svg, SCALE) : flat.svg;
    ours = PNG.sync.read(rasterize(raster, { scale: SCALE, background: "white", systemFonts }).data);
  } catch (e) {
    rows.push({ name, error: String(e.message).slice(0, 80) });
    continue;
  }
  const chrome = await screenshot(ref.svg);
  const w = Math.min(chrome.width, ours.width);
  const h = Math.min(chrome.height, ours.height);
  const a = crop(chrome, w, h);
  const b = crop(ours, w, h);
  const diff = new PNG({ width: w, height: h });
  const bad = pixelmatch(a.data, b.data, diff.data, w, h, { threshold: 0.2, includeAA: false });
  // Pixels that differ, as a share of the pixels that are ink in either image
  let ink = 0;
  for (let i = 0; i < a.data.length; i += 4) if (a.data[i] < 250 || a.data[i + 1] < 250 || a.data[i + 2] < 250 || b.data[i] < 250 || b.data[i + 1] < 250 || b.data[i + 2] < 250) ink++;
  const row = { name, pct: (100 * bad) / (w * h), inkPct: ink ? (100 * bad) / ink : 0, size: [chrome.width, chrome.height, ours.width, ours.height] };
  rows.push(row);
  row.images = { a, b, diff, w, h };
}
await browser.close();

const scored = rows.filter((r) => !r.error && !NONDETERMINISTIC.has(r.name));
const sorted = scored.slice().sort((x, y) => x.inkPct - y.inkPct);
const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]?.inkPct ?? 0;
for (const r of sorted.slice(-8)) {
  const { a, b, diff, w, h } = r.images;
  const side = new PNG({ width: w * 3 + 20, height: h });
  side.data.fill(255);
  PNG.bitblt(a, side, 0, 0, w, h, 0, 0);
  PNG.bitblt(b, side, 0, 0, w, h, w + 10, 0);
  PNG.bitblt(diff, side, 0, 0, w, h, 2 * w + 20, 0);
  fs.writeFileSync(path.join(outDir, `${r.name}.png`), PNG.sync.write(side));
  console.log(`${r.name.padEnd(28)} ${r.inkPct.toFixed(2).padStart(6)}% of ink pixels differ   (chromium ${r.size[0]}x${r.size[1]}, ours ${r.size[2]}x${r.size[3]})`);
}
for (const r of rows.filter((r) => r.error)) console.log(`${r.name.padEnd(28)} error: ${r.error}`);
console.log(`\n${scored.length} diagrams: ink pixels differing  median ${q(0.5).toFixed(2)}%  p90 ${q(0.9).toFixed(2)}%  p99 ${q(0.99).toFixed(2)}%  max ${q(1).toFixed(2)}%`);
console.log(`side-by-side images of the worst cases: ${outDir}`);
