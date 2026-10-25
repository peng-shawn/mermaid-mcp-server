// Layout time of the browserless engine vs. Mermaid in headless Chromium, both
// warm (diagram code loaded, fonts indexed), median of several runs.
//   node bench/vs-chromium.mjs [runs]
import { createRequire } from "node:module";
import puppeteer from "puppeteer";
import cases from "./cases.mjs";
import { MermaidEngine, mermaidConfig } from "../dist/engine/mermaid.js";
import { warmFonts } from "../dist/engine/fonts.js";

const runs = Number(process.argv[2] ?? 5);
const require = createRequire(import.meta.url);
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

warmFonts();
const engine = await MermaidEngine.create();
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ path: require.resolve("mermaid/dist/mermaid.min.js") });
await page.evaluate((cfg) => window.mermaid.initialize(cfg), mermaidConfig({}));

console.log(`${"diagram".padEnd(13)} ${"chromium".padStart(9)} ${"browserless".padStart(12)}  ratio`);
for (const [name, code] of Object.entries(cases)) {
  await engine.render(code, {});
  const ours = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await engine.render(code, {});
    ours.push(performance.now() - t);
  }
  const chrome = await page.evaluate(
    async (code, runs) => {
      await window.mermaid.render("mermaid-svg", code);
      const times = [];
      for (let i = 0; i < runs; i++) {
        const t = performance.now();
        await window.mermaid.render("mermaid-svg", code);
        times.push(performance.now() - t);
      }
      return times;
    },
    code, runs
  );
  const c = median(chrome);
  const o = median(ours);
  console.log(`${name.padEnd(13)} ${c.toFixed(0).padStart(7)}ms ${o.toFixed(0).padStart(10)}ms  ${(o / c).toFixed(2)}x`);
}
await browser.close();
process.exit(0);
