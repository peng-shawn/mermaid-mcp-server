import puppeteer from "puppeteer";
import { createCanvas } from "@napi-rs/canvas";
const ctx = createCanvas(1, 1).getContext("2d");
const tests = [["arial", 16, "x"], ["arial", 16, "g"], ["arial", 16, "É"], ["arial", 16, "[Person]"], ["arial", 40, "Ég"], ['"trebuchet ms"', 20, "g"], ['"trebuchet ms"', 20, "x"], ['"trebuchet ms"', 30, "Åg|"], ["arial", 16, "f"], ["arial", 16, " "]];
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(`<!doctype html><svg xmlns="http://www.w3.org/2000/svg" width=900><text id=t x=100 y=100></text></svg>`);
for (const [fam, size, txt] of tests) {
  const c = await page.evaluate((fam, size, txt) => { const t = document.getElementById("t"); t.textContent = txt; t.style.fontFamily = fam; t.style.fontSize = size + "px"; const b = t.getBBox(); return [b.x - 100, 100 - b.y, b.y + b.height - 100, b.width]; }, fam, size, txt);
  ctx.font = `${size}px ${fam}`; const m = ctx.measureText(txt);
  console.log(`${fam} ${size} ${JSON.stringify(txt)}`.padEnd(28), "chrome x", c[0].toFixed(3), "top", c[1].toFixed(3), "bottom", c[2].toFixed(3), "w", c[3].toFixed(3), "| skia fontAsc", m.fontBoundingBoxAscent, "fontDesc", m.fontBoundingBoxDescent, "inkAsc", m.actualBoundingBoxAscent.toFixed(3), "inkDesc", m.actualBoundingBoxDescent.toFixed(3), "inkL", m.actualBoundingBoxLeft.toFixed(3), "inkR", m.actualBoundingBoxRight.toFixed(3), "w", m.width.toFixed(3));
}
await browser.close();
