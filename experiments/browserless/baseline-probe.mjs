// Measures where Chromium puts the text box for each baseline keyword, so the
// browserless engine can use the same offsets.
import puppeteer from "puppeteer";
import { createCanvas } from "@napi-rs/canvas";
const ctx = createCanvas(1, 1).getContext("2d");
const modes = ["auto", "alphabetic", "middle", "central", "mathematical", "hanging", "ideographic", "text-before-edge", "text-after-edge", "text-top", "text-bottom", "before-edge", "after-edge"];
const fonts = [["sans-serif", 12], ['"trebuchet ms"', 16], ["arial", 20]];
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(`<!doctype html><svg xmlns="http://www.w3.org/2000/svg" width=900 height=900><text id=t x=100 y=100>Hx</text><text id=u x=100 y=100><tspan id=s>Hx</tspan></text></svg>`);
for (const [fam, size] of fonts) {
  ctx.font = `${size}px ${fam}`;
  const m = ctx.measureText("x");
  const H = ctx.measureText("H");
  console.log(`== ${fam} ${size}px  skia: asc ${m.fontBoundingBoxAscent} desc ${m.fontBoundingBoxDescent} xh ${m.actualBoundingBoxAscent.toFixed(3)} capH ${H.actualBoundingBoxAscent.toFixed(3)} hanging ${m.hangingBaseline?.toFixed?.(3)} ideo ${m.ideographicBaseline?.toFixed?.(3)} alpha ${m.alphabeticBaseline}`);
  for (const mode of modes) {
    const r = await page.evaluate((fam, size, mode) => {
      const t = document.getElementById("t"); t.style.font = `${size}px ${fam}`; t.setAttribute("dominant-baseline", mode);
      const u = document.getElementById("u"); u.style.font = `${size}px ${fam}`; document.getElementById("s").setAttribute("alignment-baseline", mode);
      const a = t.getBBox(), b = u.getBBox();
      return [100 - a.y, a.height, 100 - b.y, b.height];
    }, fam, size, mode);
    console.log(`  ${mode.padEnd(17)} dominant: top ${r[0].toFixed(3)} h ${r[1].toFixed(3)} | alignment: top ${r[2].toFixed(3)} h ${r[3].toFixed(3)}`);
  }
}
await browser.close();
