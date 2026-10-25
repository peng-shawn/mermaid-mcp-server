// Which font does Chromium actually use for a fallback family, per string?
import puppeteer from "puppeteer";
import { createCanvas } from "@napi-rs/canvas";
const ctx = createCanvas(1, 1).getContext("2d");
const fam = process.argv[2] ?? '"Open Sans", sans-serif';
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(`<!doctype html><svg xmlns="http://www.w3.org/2000/svg"><text id=t x=0 y=100></text></svg>`);
for (const txt of ["Hxg", "Uses", "U", "s", "e", "H", "x"]) {
  const c = await page.evaluate((fam, txt) => { const t = document.getElementById("t"); t.style.font = `12px ${fam}`; t.textContent = txt; const b = t.getBBox(); return [100 - b.y, b.y + b.height - 100, b.width]; }, fam, txt);
  ctx.font = `12px ${fam}`; const m = ctx.measureText(txt);
  console.log(txt.padEnd(5), "chrome top", c[0].toFixed(3), "bot", c[1].toFixed(3), "w", c[2].toFixed(3), "| skia asc", m.fontBoundingBoxAscent, "desc", m.fontBoundingBoxDescent, "inkA", m.actualBoundingBoxAscent.toFixed(3), "inkD", m.actualBoundingBoxDescent.toFixed(3), "w", m.width.toFixed(3));
}
const fonts = await page.evaluate(async () => { const r = []; for (const f of ["Open Sans", "Helvetica", "Arial", "Times"]) r.push(f + ":" + document.fonts.check(`12px "${f}"`)); return r.join(" "); });
console.log(fonts);
await browser.close();
