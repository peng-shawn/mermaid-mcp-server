// Pixel-level score: Chromium's screenshot of its own SVG vs resvg's PNG of the
// browserless SVG, both at the same scale.
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { toPng, normalizeRoot } from "./raster.mjs";
import { flattenSvg } from "./flatten.mjs";

const [oracleDir = "out/oracle", oursDir = "out/browserless", outDir = "out/pixels", only] = process.argv.slice(2);
const SCALE = 2;
fs.mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
const rows = [];
for (const f of fs.readdirSync(oursDir).filter((f) => f.endsWith(".svg") && (!only || f === `${only}.svg`))) {
  const name = f.slice(0, -4);
  const oracleSvg = fs.readFileSync(path.join(oracleDir, f), "utf8");
  const ours = toPng(flattenSvg(fs.readFileSync(path.join(oursDir, f), "utf8")), { scale: SCALE });
  const norm = normalizeRoot(oracleSvg);
  const [w, h] = (/viewBox="([^"]+)"/.exec(norm)[1].split(/[\s,]+/).map(Number)).slice(2);
  await page.setViewport({ width: Math.ceil(w), height: Math.ceil(h), deviceScaleFactor: SCALE });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:white">${norm}</body></html>`);
  const shot = await page.screenshot({ clip: { x: 0, y: 0, width: Math.ceil(w), height: Math.ceil(h) }, omitBackground: false });
  const a = PNG.sync.read(shot), b = PNG.sync.read(ours.png);
  const W = Math.min(a.width, b.width), H = Math.min(a.height, b.height);
  const crop = (img) => { const o = new PNG({ width: W, height: H }); PNG.bitblt(img, o, 0, 0, W, H, 0, 0); return o; };
  const ca = crop(a), cb = crop(b), diff = new PNG({ width: W, height: H });
  const n = pixelmatch(ca.data, cb.data, diff.data, W, H, { threshold: 0.2, includeAA: false });
  fs.writeFileSync(path.join(outDir, `${name}.chrome.png`), shot);
  fs.writeFileSync(path.join(outDir, `${name}.ours.png`), ours.png);
  fs.writeFileSync(path.join(outDir, `${name}.diff.png`), PNG.sync.write(diff));
  const pct = (n / (W * H)) * 100;
  rows.push({ name, pct, size: `${a.width}x${a.height} vs ${b.width}x${b.height}` });
  console.log(`${name.padEnd(22)} ${pct.toFixed(2).padStart(6)}% pixels differ   ${a.width}x${a.height} vs ${b.width}x${b.height}`);
}
rows.sort((x, y) => x.pct - y.pct);
const med = rows[Math.floor(rows.length / 2)]?.pct ?? 0;
console.log(`\nmedian ${med.toFixed(2)}%   worst ${rows.at(-1)?.name} ${rows.at(-1)?.pct.toFixed(2)}%`);
await browser.close();
