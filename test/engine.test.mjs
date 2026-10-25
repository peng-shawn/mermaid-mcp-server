// Geometry rules of the browserless DOM. Each rule was established by probing
// Chromium (experiments/browserless/*-probe.mjs); these tests pin them down
// with the bundled DejaVu fonts so they hold on every platform.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDom } from "../dist/engine/dom.js";
import { measureRun } from "../dist/engine/fonts.js";

const FONT = "font-family: 'DejaVu Sans'; font-size: 16px";
const { document } = createDom();

function svg(markup) {
  document.body.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" style="${FONT}">${markup}</svg>`;
  return document.body.firstChild;
}
const box = (el) => {
  const b = el.getBBox();
  return [b.x, b.y, b.width, b.height].map((v) => Math.round(v * 100) / 100);
};
const bboxOf = (markup) => box(svg(markup).querySelector("#t"));

test("rect, circle and transforms", () => {
  assert.deepEqual(bboxOf(`<g id="t"><rect x="10" y="20" width="30" height="40"/></g>`), [10, 20, 30, 40]);
  assert.deepEqual(bboxOf(`<g id="t"><circle cx="50" cy="50" r="10"/></g>`), [40, 40, 20, 20]);
  assert.deepEqual(bboxOf(`<g id="t"><g transform="translate(5,5) scale(2)"><rect width="10" height="10"/></g></g>`), [5, 5, 20, 20]);
  // An element's own transform is not part of its getBBox
  assert.deepEqual(bboxOf(`<g id="t" transform="translate(100,100)"><rect width="10" height="10"/></g>`), [0, 0, 10, 10]);
});

test("exact bounds of curves, not of control points", () => {
  assert.deepEqual(bboxOf(`<g id="t"><path d="M0,10 a72,10 0,0,0 144,0"/></g>`), [0, 10, 144, 10]);
  assert.deepEqual(bboxOf(`<g id="t"><path d="M0,0 C0,100 100,100 100,0"/></g>`), [0, 0, 100, 75]);
});

test("empty shapes have no geometry but degenerate ones do (Blink)", () => {
  const text = `<text x="30" y="45">Hi</text>`;
  const textOnly = bboxOf(`<g id="t">${text}</g>`);
  for (const empty of [`<rect/>`, `<rect x="50" y="50" width="0" height="10"/>`, `<circle cx="50" cy="50" r="0"/>`, `<path/>`, `<text x="50" y="50"></text>`, `<g transform="translate(50,50)"></g>`]) {
    assert.deepEqual(bboxOf(`<g id="t">${empty}${text}</g>`), textOnly, empty);
  }
  // A single-point path and a zero-length line still count
  assert.deepEqual(bboxOf(`<g id="t"><path d="M50,80"/><rect x="60" y="60" width="5" height="5"/></g>`), [50, 60, 15, 20]);
});

test("display:none and unchosen <switch> branches are outside the render tree", () => {
  assert.deepEqual(bboxOf(`<g id="t"><rect width="10" height="10"/><rect x="100" width="10" height="10" style="display:none"/></g>`), [0, 0, 10, 10]);
  const root = svg(`<g id="t"><switch><rect id="a" width="10" height="10"/><rect id="b" x="100" width="10" height="10"/></switch></g>`);
  assert.deepEqual(box(root.querySelector("#t")), [0, 0, 10, 10]);
  assert.deepEqual(box(root.querySelector("#b")), [0, 0, 0, 0]);
});

test("nested <svg> maps its viewBox into the parent", () => {
  const root = svg(`<g id="t"><svg width="30" height="30" viewBox="0 0 80 80"><rect width="80" height="80"/></svg></g>`);
  assert.deepEqual(box(root.querySelector("svg svg")), [0, 0, 80, 80]);
  assert.deepEqual(box(root.querySelector("#t")), [0, 0, 30, 30]);
});

test("text box is the font box united with glyph ink", () => {
  const [, , w, h] = bboxOf(`<text id="t" y="20">Hx</text>`);
  const m = measureRun("Hx", { family: "DejaVu Sans", size: 16, weight: 400, style: "normal" });
  assert.equal(w, Math.round(m.width * 100) / 100);
  assert.ok(h >= 18 && h <= 20, `height ${h}`);
});

test("positioning attributes address characters; innermost wins", () => {
  // dy on <text> and on its first <tspan> address the same character: not summed
  const both = bboxOf(`<text id="t" y="100" dy="10"><tspan dy="20">A</tspan></text>`);
  const inner = bboxOf(`<text id="t" y="100"><tspan dy="20">A</tspan></text>`);
  assert.deepEqual(both, inner);
});

test("text-anchor aligns each chunk", () => {
  const [x, , w] = bboxOf(`<text id="t" x="100" text-anchor="middle">Hello</text>`);
  assert.ok(Math.abs(x + w / 2 - 100) < 0.01);
  const [xe, , we] = bboxOf(`<text id="t" x="100" text-anchor="end">Hello</text>`);
  assert.ok(Math.abs(xe + we - 100) < 0.01);
});

test("baseline keywords shift text like Chromium", () => {
  const top = (db) => bboxOf(`<text id="t" y="100" dominant-baseline="${db}">Hx</text>`)[1];
  const alphabetic = top("auto");
  assert.equal(top("alphabetic"), alphabetic);
  assert.equal(top("text-top"), alphabetic); // no effect in Chromium
  assert.ok(top("central") > alphabetic && top("text-before-edge") > top("central"));
  assert.ok(top("ideographic") < alphabetic);
});

test("whitespace: newlines become spaces, runs collapse", () => {
  const one = bboxOf(`<text id="t">a b</text>`)[2];
  assert.equal(bboxOf(`<text id="t">a\nb</text>`)[2], one);
  assert.equal(bboxOf(`<text id="t">a    b</text>`)[2], one);
  assert.equal(bboxOf(`<text id="t">  a b  </text>`)[2], one);
});

test("text nodes are shaped as one run across element boundaries", () => {
  const whole = bboxOf(`<text id="t">AV Ta</text>`)[2];
  assert.equal(bboxOf(`<text id="t"><tspan>A</tspan><tspan>V Ta</tspan></text>`)[2], whole);
  assert.equal(bboxOf(`<text id="t"><tspan>AV</tspan><tspan> </tspan><tspan>Ta</tspan></text>`)[2], whole);
});

test("CSS lengths: em, ex, %, pt, and relative font weights", () => {
  const w = (style) => bboxOf(`<text id="t" style="${style}">Width</text>`)[2];
  assert.equal(w("font-size: 24px"), w("font-size: 1.5em"));
  assert.equal(w("font-size: 12pt"), w("font-size: 16px"));
  assert.ok(w("font-weight: bolder") > w("font-weight: normal"));
  assert.equal(w("font-weight: bolder"), w("font-weight: bold"));
});

test("cascade: !important, specificity and presentation attributes", () => {
  document.body.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"><style>#s text { font-size: 30px } text.c { font-size: 10px !important }</style><g id="s"><text id="a" font-size="5">Hi</text><text id="b" class="c" style="font-size: 50px">Hi</text></g></svg>`;
  const h = (id) => document.getElementById(id).getBBox().height;
  assert.ok(h("a") > 30, "sheet rule beats presentation attribute");
  assert.ok(h("b") < 15, "!important rule beats inline style");
  // Browsers skip empty declarations; jsdom's own parser would drop this one
  document.body.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"><text id="x" style="; font-size: 40px;">Hi</text></svg>`;
  assert.ok(document.getElementById("x").getBBox().height > 40);
});

test("geometry answers are float32, as in Blink", () => {
  const [, y, , h] = bboxOf(`<g id="t"><rect y="72.6" width="1" height="0.1"/></g>`);
  const raw = svg(`<rect id="r" y="72.6" width="1" height="1"/>`).querySelector("#r").getBBox().y;
  assert.equal(raw, Math.fround(72.6));
  assert.notEqual(raw, 72.6);
  assert.ok(y && h);
});

test("incremental layout: empty labels count only after a change (Blink)", () => {
  // Static first layout, from validity-probe.mjs
  const T = `<text y="-10.1"><tspan x="0" y="-0.1em" dy="1.1em"></tspan></text>`;
  const far = `<rect x="100" y="100" width="5" height="5"/>`;
  const included = (frag) => box(svg(`<g id="t">${frag}${far}</g>`).querySelector("#t"))[0] < 100;
  assert.equal(included(`<g transform="translate(50,50)">${T}</g>`), true);
  assert.equal(included(`<g>${T}</g>`), true);
  assert.equal(included(`<g><g transform="translate(0,0)">${T}</g></g>`), false);
  assert.equal(included(`<g transform="translate(50,50)"><g>${T}</g></g>`), false);
  assert.equal(included(`<g><g transform="translate(50,50)">${T}</g></g>`), true);
});

test("getBoundingClientRect, SVGRect shape and getComputedStyle", () => {
  const root = svg(`<g transform="translate(10,20)"><rect id="r" width="5" height="5"/></g>`);
  const r = root.querySelector("#r");
  const rect = r.getBoundingClientRect();
  assert.equal(rect.left, 10);
  assert.equal(rect.top, 20);
  assert.equal("left" in r.getBBox(), false, "SVGRect has no left");
  const { window } = createDom();
  window.document.body.innerHTML = `<p style="font-weight: bold; font-size: 2em">x</p>`;
  const cs = window.getComputedStyle(window.document.querySelector("p"));
  assert.equal(cs.fontWeight, "700");
  assert.equal(cs.fontSize, "32px");
  assert.equal(cs.getPropertyValue("padding-left"), "0px");
});
