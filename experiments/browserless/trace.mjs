// Records every geometry query Mermaid makes, in Chromium and in the browserless
// DOM, and prints the first answers that disagree. This turns "the picture is
// off" into "this getBBox on this element returned the wrong number".
import puppeteer from "puppeteer";
import { createRequire } from "module";
import { cases } from "./corpus.mjs";
import { MERMAID_CONFIG, SEEDED_RANDOM_SRC } from "./config.mjs";
import { createDom, installGlobals } from "./dom.mjs";

const name = process.argv[2];
const limit = Number(process.argv[3] ?? 10);
const code = cases[name];
const require = createRequire(import.meta.url);

// Shared instrumentation, serialized into the page and also run locally
function instrument(win, out) {
  const describe = (el) => {
    if (!el || !el.tagName) return String(el);
    const cls = el.getAttribute && (el.getAttribute("class") || "");
    const txt = (el.textContent || "").trim().slice(0, 24);
    return `${el.tagName.toLowerCase()}${cls ? "." + cls.split(/\s+/).join(".") : ""}${txt ? ` "${txt}"` : ""}`;
  };
  const round = (v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v);
  const summarize = (r) => {
    if (r && typeof r === "object") {
      if ("a" in r && "f" in r) return [r.a, r.b, r.c, r.d, r.e, r.f].map(round).join(",");
      return ["x", "y", "width", "height"].map((k) => round(r[k])).join(",");
    }
    return round(r);
  };
  const wrap = (proto, fn) => {
    const orig = proto[fn];
    if (!orig) return;
    proto[fn] = function (...args) {
      const r = orig.apply(this, args);
      out.push(`${fn}(${describe(this)}${args.length ? "," + args.join(",") : ""}) = ${summarize(r)}`);
      return r;
    };
  };
  const svgProto = win.SVGGraphicsElement ? win.SVGGraphicsElement.prototype : win.SVGElement.prototype;
  wrap(win.SVGElement.prototype.getBBox ? win.SVGElement.prototype : svgProto, "getBBox");
  wrap(win.SVGTextContentElement ? win.SVGTextContentElement.prototype : win.SVGElement.prototype, "getComputedTextLength");
  wrap(win.SVGGeometryElement ? win.SVGGeometryElement.prototype : win.SVGElement.prototype, "getTotalLength");
  wrap(win.Element.prototype, "getBoundingClientRect");
}

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body><div id=c></div></body></html>");
await page.addScriptTag({ path: require.resolve("mermaid/dist/mermaid.min.js") });
const chrome = await page.evaluate(
  async (instrumentSrc, cfg, code, seed) => {
    const out = [];
    eval(seed);
    // eslint-disable-next-line no-eval
    eval(`(${instrumentSrc})`)(window, out);
    window.mermaid.initialize(cfg);
    await window.mermaid.render("m-x", code);
    return out;
  },
  instrument.toString(), MERMAID_CONFIG, code, SEEDED_RANDOM_SRC
);
await browser.close();

const { window } = createDom();
installGlobals(window);
const local = [];
instrument(window, local);
const mermaid = (await import("mermaid")).default;
mermaid.initialize(MERMAID_CONFIG);
(0, eval)(SEEDED_RANDOM_SRC);
await mermaid.render("m-x", code);

// Sub-0.05px differences come from Blink's scaled-font rounding; ignore them
function same(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const re = /-?\d+(?:\.\d+)?/g;
  if (a.replace(re, "#") !== b.replace(re, "#")) return false;
  const na = a.match(re) || [], nb = b.match(re) || [];
  return na.every((v, i) => Math.abs(Number(v) - Number(nb[i])) <= 0.05);
}
console.log(`calls: chrome ${chrome.length}, browserless ${local.length}`);
let shown = 0;
for (let i = 0; i < Math.max(chrome.length, local.length) && shown < limit; i++) {
  if (same(chrome[i], local[i])) continue;
  console.log(`#${i}\n  C: ${chrome[i]}\n  J: ${local[i]}`);
  shown++;
}
process.exit(0);
