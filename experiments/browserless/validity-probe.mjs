// Which empty structures does Chromium count in a parent's bbox on first layout?
import puppeteer from "puppeteer";
const T = `<text y="-10.1"><tspan x="0" y="-0.1em" dy="1.1em"></tspan></text>`;
const probes = {
  "P g>path(M0,0)": `<g><path d="M0,0"></path></g>`,
  "Q g>line(0,0,0,0)": `<g><line x1="0" y1="0" x2="0" y2="0"></line></g>`,
  "R g>rect0": `<g><rect></rect></g>`,
  "S g>image(no size)": `<g><image></image></g>`,
  "T g>foreignObject0": `<g><foreignObject></foreignObject></g>`,
  "U g>g(empty)": `<g><g></g></g>`,
  "V g>text(bare)": `<g><text></text></g>`,
};
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
for (const [name, frag] of Object.entries(probes)) {
  await page.setContent(`<!doctype html><svg xmlns="http://www.w3.org/2000/svg" width=300 height=300 style="font: 16px 'trebuchet ms'"><g id=t>${frag}<rect x="100" y="100" width="5" height="5"></rect></g></svg>`);
  const r = await page.evaluate(() => { const b = document.getElementById("t").getBBox(); return [b.x, b.y, b.width, b.height].map((v) => +v.toFixed(2)).join(","); });
  console.log(name.padEnd(28), r.padEnd(16), r === "100,100,5,5" ? "excluded" : "INCLUDED");
}
await browser.close();
