// CPU profile of Mermaid rendering one case in Chromium, for comparison with
// bench/profile.mjs.   node bench/profile-chromium.mjs <case>
import { createRequire } from "node:module";
import puppeteer from "puppeteer";
import cases from "./cases.mjs";
import { mermaidConfig } from "../dist/engine/mermaid.js";

const require = createRequire(import.meta.url);
const name = process.argv[2] ?? "small";
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ path: require.resolve("mermaid/dist/mermaid.js") });
await page.evaluate((cfg) => window.mermaid.initialize(cfg), mermaidConfig({}));
await page.evaluate(async (code) => window.mermaid.render("mermaid-svg", code), cases[name]);
const cdp = await page.createCDPSession();
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
await cdp.send("Profiler.start");
const ms = await page.evaluate(async (code) => { const t = performance.now(); await window.mermaid.render("mermaid-svg", code); return performance.now() - t; }, cases[name]);
const { profile } = await cdp.send("Profiler.stop");
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
profile.samples.forEach((s, i) => {
  const f = nodes.get(s).callFrame;
  const k = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
  self.set(k, (self.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0));
});
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log(`${name} in Chromium: ${ms.toFixed(0)}ms`);
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`);
await browser.close();
