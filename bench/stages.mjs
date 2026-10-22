// Time per pipeline stage (layout, CSS flattening, rasterization), warm.
//   node bench/stages.mjs [case]
import cases from "./cases.mjs";
import { MermaidEngine } from "../dist/engine/mermaid.js";
import { flattenSvg } from "../dist/engine/flatten.js";
import { rasterize } from "../dist/engine/raster.js";
import { warmFonts } from "../dist/engine/fonts.js";

warmFonts();
const engine = await MermaidEngine.create();
const only = process.argv[2];
console.log(`${"diagram".padEnd(13)} ${"layout".padStart(7)} ${"flatten".padStart(8)} ${"raster".padStart(7)}  elements`);
for (const [name, code] of Object.entries(cases)) {
  if (only && name !== only) continue;
  await engine.render(code, {});
  const t0 = performance.now();
  const { svg } = await engine.render(code, {});
  const t1 = performance.now();
  const flat = flattenSvg(engine.dom, svg, { background: "white" });
  const t2 = performance.now();
  rasterize(flat.svg, { scale: Math.min(2, 1568 / Math.max(flat.width, flat.height)), background: "white" });
  const t3 = performance.now();
  const n = (svg.match(/<[a-zA-Z]/g) || []).length;
  console.log(`${name.padEnd(13)} ${(t1 - t0).toFixed(0).padStart(5)}ms ${(t2 - t1).toFixed(0).padStart(6)}ms ${(t3 - t2).toFixed(0).padStart(5)}ms  ${n}`);
}
process.exit(0);
