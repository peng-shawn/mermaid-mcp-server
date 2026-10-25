import puppeteer from "puppeteer";
import { createCanvas } from "@napi-rs/canvas";
const ctx = createCanvas(1, 1).getContext("2d");
const fams = ['"trebuchet ms", verdana, arial, sans-serif', '"Open Sans", sans-serif', 'sans-serif', 'arial'];
const sizes = [10, 12, 13.12, 14, 16, 18, 20];
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(`<!doctype html><svg xmlns="http://www.w3.org/2000/svg"><text id=t x=0 y=50>Hxg</text></svg>`);
for (const fam of fams) for (const size of sizes) {
  const c = await page.evaluate((fam, size) => { const t = document.getElementById("t"); t.style.fontFamily = fam; t.style.fontSize = size + "px"; const b = t.getBBox(); return [50 - b.y, b.height, b.width]; }, fam, size);
  ctx.font = `${size}px ${fam}`; const m = ctx.measureText("Hxg");
  console.log(fam.slice(0, 18).padEnd(19), String(size).padEnd(6), "chrome asc", c[0].toFixed(3), "h", c[1].toFixed(3), "w", c[2].toFixed(3), "| skia asc", m.fontBoundingBoxAscent.toFixed(3), "desc", m.fontBoundingBoxDescent.toFixed(3), "w", m.width.toFixed(3));
}
await browser.close();
