// Records every geometry query Mermaid makes while rendering one diagram, in
// Chromium and in the browserless engine, and prints the first answers that
// disagree: "the picture is off" becomes "this getBBox returned the wrong box".
//
//   node test/accuracy/trace.mjs <case-name> [count]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const [name, countArg] = process.argv.slice(2);
const corpus = { ...(await import("./corpus-builtin.mjs")).default, ...JSON.parse(fs.readFileSync(path.join(here, "corpus-docs.json"), "utf8")) };
const code = corpus[name];
if (!code) throw new Error(`No case named ${name}`);

// Runs in both environments
function instrument(win, out) {
  const describe = (el) => {
    if (!el?.tagName) return String(el);
    const cls = el.getAttribute?.("class") || "";
    const text = (el.textContent || "").trim().slice(0, 24);
    return `${el.tagName.toLowerCase()}${cls ? "." + cls.split(/\s+/).join(".") : ""}${text ? ` "${text}"` : ""}`;
  };
  const round = (v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);
  const summarize = (r) => {
    if (r && typeof r === "object") {
      if ("a" in r && "f" in r) return [r.a, r.b, r.c, r.d, r.e, r.f].map(round).join(",");
      if ("x" in r && !("width" in r)) return [r.x, r.y].map(round).join(",");
      return ["x", "y", "width", "height"].map((k) => round(r[k])).join(",");
    }
    return round(r);
  };
  const wrap = (proto, fn) => {
    const orig = proto?.[fn];
    if (!orig) return;
    proto[fn] = function (...args) {
      const r = orig.apply(this, args);
      out.push(`${fn}(${describe(this)}${args.length ? "," + args.join(",") : ""}) = ${summarize(r)}`);
      return r;
    };
  };
  const gfx = win.SVGGraphicsElement?.prototype ?? win.SVGElement.prototype;
  const geo = win.SVGGeometryElement?.prototype ?? win.SVGElement.prototype;
  const txt = win.SVGTextContentElement?.prototype ?? win.SVGElement.prototype;
  wrap(win.SVGElement.prototype.getBBox ? win.SVGElement.prototype : gfx, "getBBox");
  wrap(txt, "getComputedTextLength");
  wrap(geo, "getTotalLength");
  wrap(geo, "getPointAtLength");
  wrap(win.Element.prototype, "getBoundingClientRect");
  const cs = win.getComputedStyle;
  win.getComputedStyle = function (el, p) {
    const r = cs.call(this, el, p);
    out.push(`getComputedStyle(${describe(el)}) font=${r.fontSize} ${r.fontWeight} ${r.fontFamily}`);
    return r;
  };
}

const { MermaidEngine, mermaidConfig, SEEDED_RANDOM_SOURCE } = await import("../../dist/engine/mermaid.js");

const browser = await puppeteer.launch({ headless: true, args: process.getuid?.() === 0 ? ["--no-sandbox"] : [] });
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ path: require.resolve("mermaid/dist/mermaid.min.js") });
const chrome = await page.evaluate(
  async (src, config, seed, code) => {
    const out = [];
    eval(`(${src})`)(window, out);
    const reset = eval(seed);
    window.mermaid.initialize(config);
    await window.mermaid.parse(code);
    reset();
    await window.mermaid.render("mermaid-svg", code);
    return out;
  },
  instrument.toString(), mermaidConfig({}), SEEDED_RANDOM_SOURCE, code
);
await browser.close();

const engine = await MermaidEngine.create();
const local = [];
instrument(engine.dom.window, local);
await engine.render(code, {});

// Sub-0.05px differences come from Blink's scaled-font rounding
const same = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const re = /-?\d+(?:\.\d+)?/g;
  if (a.replace(re, "#") !== b.replace(re, "#")) return false;
  const nb = b.match(re) || [];
  return (a.match(re) || []).every((v, i) => Math.abs(Number(v) - Number(nb[i])) <= 0.05);
};
console.log(`calls: chromium ${chrome.length}, browserless ${local.length}`);
let shown = 0;
for (let i = 0; i < Math.max(chrome.length, local.length) && shown < Number(countArg ?? 8); i++) {
  if (same(chrome[i], local[i])) continue;
  console.log(`#${i}\n  C: ${chrome[i]}\n  J: ${local[i]}`);
  shown++;
}
process.exit(0);
