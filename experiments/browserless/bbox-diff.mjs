// Element-level oracle: load each Chromium-rendered SVG into both Chromium and
// the browserless DOM, ask every element for getBBox(), and compare. This
// tests the geometry engine on real Mermaid output, independent of Mermaid's
// own control flow.
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { createDom } from "./dom.mjs";

const dir = process.argv[2] ?? "out/oracle";
const only = process.argv[3];
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".svg") && (!only || f === `${only}.svg`));

function collect(doc) {
  // Display at 1:1. Chromium sizes SVG text with the on-screen scale, and
  // Mermaid measures before the root gets its viewBox, so scale 1 is what
  // Mermaid sees during layout.
  const root = doc.querySelector("svg");
  const vb = (root.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  if (vb.length === 4) {
    root.setAttribute("width", vb[2]);
    root.setAttribute("height", vb[3]);
    root.removeAttribute("style");
  }
  const out = [];
  const GRAPHICS = new Set(["g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "tspan", "image", "foreignobject", "use", "svg", "a"]);
  for (const el of doc.querySelectorAll("svg *")) {
    if (!GRAPHICS.has(el.tagName.toLowerCase()) || el.closest("marker, defs, clipPath, mask, pattern, symbol")) continue;
    let b;
    try {
      b = el.getBBox();
    } catch {
      continue;
    }
    const cls = el.getAttribute("class") || "";
    out.push({ tag: el.tagName.toLowerCase(), cls, text: (el.textContent || "").trim().slice(0, 20), b: [b.x, b.y, b.width, b.height] });
  }
  return out;
}

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
const { window } = createDom();
let total = 0, bad = 0;
for (const f of files) {
  const svg = fs.readFileSync(path.join(dir, f), "utf8");
  await page.setContent(`<!doctype html><html><body>${svg}</body></html>`);
  const chrome = await page.evaluate(`(${collect.toString()})(document)`);
  window.document.body.innerHTML = svg;
  const local = collect(window.document);
  let worst = null, n = 0;
  for (let i = 0; i < Math.min(chrome.length, local.length); i++) {
    const d = Math.max(...chrome[i].b.map((v, k) => Math.abs(v - local[i].b[k])));
    total++;
    if (d > 0.05) {
      bad++;
      n++;
      if (!worst || d > worst.d) worst = { d, i, c: chrome[i], l: local[i] };
    }
  }
  console.log(`${f.padEnd(18)} elements ${String(chrome.length).padStart(4)}  mismatched ${String(n).padStart(4)}` + (worst ? `  worst #${worst.i} <${worst.c.tag}.${worst.c.cls}> "${worst.c.text}" C=${worst.c.b.map((v) => +v.toFixed(2))} J=${worst.l.b.map((v) => +v.toFixed(2))}` : ""));
}
console.log(`\n${total - bad}/${total} element boxes within 0.05px`);
await browser.close();
