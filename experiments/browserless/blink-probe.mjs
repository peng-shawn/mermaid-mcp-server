// Asks Chromium how getBBox treats edge cases, so dom.mjs can match it exactly.
import puppeteer from "puppeteer";
const probes = {
  "text>tspan(empty) y=-10.1": `<g id=t><g transform="translate(50,50)"><text y="-10.1"><tspan x="0" y="-0.1em" dy="1.1em"><tspan></tspan></tspan></text></g><text x="30" y="45">Hi</text></g>`,
  "text>tspan(empty) no attrs": `<g id=t><g transform="translate(50,50)"><text><tspan></tspan></text></g><text x="30" y="45">Hi</text></g>`,
  "text(empty) no attrs": `<g id=t><g transform="translate(50,50)"><text></text></g><text x="30" y="45">Hi</text></g>`,
  "text(empty) y=20": `<g id=t><g transform="translate(50,50)"><text y="20"></text></g><text x="30" y="45">Hi</text></g>`,
  "text>tspan(empty) y=20": `<g id=t><g transform="translate(50,50)"><text><tspan y="20"></tspan></text></g><text x="30" y="45">Hi</text></g>`,
  "text(space) y=20": `<g id=t><g transform="translate(50,50)"><text y="20"> </text></g><text x="30" y="45">Hi</text></g>`,
  "getBBox empty text direct": `<text id=t x="5" y="20"></text>`,
};
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
for (const [name, frag] of Object.entries(probes)) {
  await page.setContent(`<!doctype html><svg xmlns="http://www.w3.org/2000/svg" style="font: 16px 'trebuchet ms'">${frag}</svg>`);
  const r = await page.evaluate(() => { const b = document.getElementById("t").getBBox(); return [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 100) / 100).join(","); });
  console.log(name.padEnd(44), r);
}
await browser.close();
