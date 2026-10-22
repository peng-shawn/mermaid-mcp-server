// Pins down when Chromium counts a glyph-less <text> in a parent's bbox.
import puppeteer from "puppeteer";
const T = (attrs, inner) => `<g id=t><g transform="translate(50,50)"><text ${attrs}>${inner}</text></g><text x="30" y="45">Hi</text></g>`;
const probes = {
  "tspan": T(`y="-10.1"`, `<tspan x="0" y="-0.1em" dy="1.1em"></tspan>`),
  "anchor=middle on text": T(`y="-10.1" text-anchor="middle"`, `<tspan x="0" y="-0.1em" dy="1.1em"></tspan>`),
  "anchor=middle on both": T(`y="-10.1" text-anchor="middle"`, `<tspan x="0" y="-0.1em" dy="1.1em" text-anchor="middle"></tspan>`),
  "anchor=end": T(`text-anchor="end"`, `<tspan></tspan>`),
  "anchor=start explicit": T(`text-anchor="start"`, `<tspan></tspan>`),
  "nested tspans": T(``, `<tspan><tspan></tspan></tspan>`),
  "tspan with space": T(``, `<tspan> </tspan>`),
};
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
for (const [name, frag] of Object.entries(probes)) {
  await page.setContent(`<!doctype html><svg xmlns="http://www.w3.org/2000/svg" width=300 height=300 style="font: 16px 'trebuchet ms'">${frag}</svg>`);
  const r = await page.evaluate(() => { const b = document.getElementById("t").getBBox(); return [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 100) / 100).join(","); });
  console.log(name.padEnd(26), r, r.startsWith("30,30,15") ? "(excluded)" : "(included)");
}
await browser.close();
