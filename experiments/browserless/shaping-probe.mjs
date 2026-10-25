// Compares text advance widths: Chromium SVG vs Chromium canvas vs Skia (napi-rs canvas).
import puppeteer from "puppeteer";
import { createCanvas } from "@napi-rs/canvas";
const font = `16px "trebuchet ms", verdana, arial, sans-serif`;
const strings = ["A label", "AV", "A V", "To", "Ta", "LT", "A fa:fa-camera-retro", "⚙️ config.yaml", "config.yaml", "日本語テキスト", "Animal"];
const ctx = createCanvas(1, 1).getContext("2d");
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(`<!doctype html><svg xmlns="http://www.w3.org/2000/svg" width=900 height=200><text id=t x=10 y=100 style='font: ${font}'></text></svg><canvas id=c></canvas>`);
for (const s of strings) {
  const c = await page.evaluate((s, font) => {
    const t = document.getElementById("t"); t.textContent = s; const b = t.getBBox();
    const cx = document.getElementById("c").getContext("2d"); cx.font = font;
    const k = cx.measureText(s).width; cx.fontKerning = "none"; const nk = cx.measureText(s).width; cx.fontKerning = "auto";
    return [t.getComputedTextLength(), b.height, k, nk];
  }, s, font);
  ctx.font = font;
  const sk = ctx.measureText(s);
  let skNone = null;
  try { ctx.fontKerning = "none"; skNone = ctx.measureText(s).width; ctx.fontKerning = "normal"; } catch {}
  console.log(JSON.stringify(s).padEnd(26), "svg", c[0].toFixed(2).padStart(7), "h", c[1].toFixed(1), "| chromeCanvas", c[2].toFixed(2), "noKern", c[3].toFixed(2), "| skia", sk.width.toFixed(2), "noKern", skNone?.toFixed(2), "h", (sk.fontBoundingBoxAscent + sk.fontBoundingBoxDescent).toFixed(1));
}
await browser.close();
