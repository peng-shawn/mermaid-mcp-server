// CPU profile of warm renders of one benchmark case; prints the hottest
// functions by self and inclusive time.
//   node bench/profile.mjs <case> [renders]
import inspector from "node:inspector/promises";
import cases from "./cases.mjs";
import { MermaidEngine } from "../dist/engine/mermaid.js";
import { warmFonts } from "../dist/engine/fonts.js";

const [name = "small", count = "5"] = process.argv.slice(2);
warmFonts();
const engine = await MermaidEngine.create();
await engine.render(cases[name], {});
const session = new inspector.Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.setSamplingInterval", { interval: 100 });
await session.post("Profiler.start");
const t = performance.now();
for (let i = 0; i < Number(count); i++) await engine.render(cases[name], {});
const elapsed = performance.now() - t;
const { profile } = await session.post("Profiler.stop");

const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const self = new Map();
profile.samples.forEach((s, i) => self.set(s, (self.get(s) ?? 0) + (profile.timeDeltas[i] ?? 0)));
const key = (id) => {
  const f = nodes.get(id).callFrame;
  return `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
};
const selfBy = new Map();
const inclBy = new Map();
for (const [id, t] of self) {
  selfBy.set(key(id), (selfBy.get(key(id)) ?? 0) + t);
  const seen = new Set();
  for (let x = id; x !== undefined; x = parent.get(x)) {
    const k = key(x);
    if (!seen.has(k)) inclBy.set(k, (inclBy.get(k) ?? 0) + t), seen.add(k);
  }
}
const total = [...selfBy.values()].reduce((a, b) => a + b, 0);
const show = (title, map, filter = () => true, n = 15) => {
  console.log(`\n${title}`);
  for (const [k, v] of [...map].filter(([k]) => filter(k)).sort((a, b) => b[1] - a[1]).slice(0, n)) console.log(`${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`);
};
console.log(`${name}: ${(elapsed / Number(count)).toFixed(0)}ms per render`);
show("self", selfBy);
show("inclusive, engine", inclBy, (k) => /\b(dom|fonts|flatten|css|geometry)\.js/.test(k));
process.exit(0);
