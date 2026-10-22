// A layout-faithful DOM for running the official Mermaid renderer in Node.
//
// Mermaid needs a browser for exactly one thing: geometry. It asks the DOM how
// big text and shapes are (getBBox, getComputedTextLength, ...) and lays the
// diagram out from the answers. jsdom provides the document model but answers
// every geometry question with zeros. This module fills that gap with a small
// SVG geometry engine: CSS cascade for the properties that affect geometry,
// font metrics from Skia, exact path bounds, and transform math.
import { JSDOM } from "jsdom";
import { createCanvas } from "@napi-rs/canvas";
import { svgPathBbox } from "svg-path-bbox";
import { svgPathProperties } from "svg-path-properties";
import * as cssom from "rrweb-cssom";
import { segmentRun, emojiFont } from "./fonts.mjs";

// ---------------------------------------------------------------------------
// Matrix

export class Matrix {
  constructor(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0) {
    Object.assign(this, { a, b, c, d, e, f });
  }
  multiply(m) {
    return new Matrix(
      this.a * m.a + this.c * m.b,
      this.b * m.a + this.d * m.b,
      this.a * m.c + this.c * m.d,
      this.b * m.c + this.d * m.d,
      this.a * m.e + this.c * m.f + this.e,
      this.b * m.e + this.d * m.f + this.f
    );
  }
  inverse() {
    const det = this.a * this.d - this.b * this.c;
    if (!det) return new Matrix();
    return new Matrix(
      this.d / det,
      -this.b / det,
      -this.c / det,
      this.a / det,
      (this.c * this.f - this.d * this.e) / det,
      (this.b * this.e - this.a * this.f) / det
    );
  }
  apply(x, y) {
    return [this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f];
  }
  isIdentity() {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && !this.e && !this.f;
  }
}

const TRANSFORM_RE = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;

export function parseTransform(value) {
  let m = new Matrix();
  if (!value) return m;
  for (const [, fn, argText] of value.matchAll(TRANSFORM_RE)) {
    const a = argText.split(/[\s,]+/).filter(Boolean).map(Number);
    let t;
    switch (fn) {
      case "matrix":
        t = new Matrix(...a);
        break;
      case "translate":
        t = new Matrix(1, 0, 0, 1, a[0] || 0, a[1] || 0);
        break;
      case "scale":
        t = new Matrix(a[0], 0, 0, a[1] ?? a[0], 0, 0);
        break;
      case "rotate": {
        const r = ((a[0] || 0) * Math.PI) / 180;
        const cos = Math.cos(r), sin = Math.sin(r);
        t = new Matrix(cos, sin, -sin, cos, 0, 0);
        if (a.length === 3) {
          t = new Matrix(1, 0, 0, 1, a[1], a[2]).multiply(t).multiply(new Matrix(1, 0, 0, 1, -a[1], -a[2]));
        }
        break;
      }
      case "skewX":
        t = new Matrix(1, 0, Math.tan(((a[0] || 0) * Math.PI) / 180), 1, 0, 0);
        break;
      case "skewY":
        t = new Matrix(1, Math.tan(((a[0] || 0) * Math.PI) / 180), 0, 1, 0, 0);
        break;
    }
    m = m.multiply(t);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Rect helpers. A null rect means "no geometry" and is skipped in unions.

function transformRect(r, m) {
  if (!r || m.isIdentity()) return r;
  const pts = [m.apply(r.x, r.y), m.apply(r.x + r.width, r.y), m.apply(r.x, r.y + r.height), m.apply(r.x + r.width, r.y + r.height)];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function unionRect(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

// ---------------------------------------------------------------------------
// Fonts

const measureCtx = createCanvas(1, 1).getContext("2d");
const metricsCache = new Map();
const widthCache = new Map();

function fontString(font) {
  return `${font.style} ${font.weight} ${font.size}px ${font.family}`;
}

// Blink rounds ascent and descent to whole pixels for layout
function fontMetrics(font) {
  const key = fontString(font);
  let m = metricsCache.get(key);
  if (!m) {
    measureCtx.font = key;
    const t = measureCtx.measureText("x");
    m = {
      ascent: Math.round(t.fontBoundingBoxAscent),
      descent: Math.round(t.fontBoundingBoxDescent),
      xHeight: t.actualBoundingBoxAscent,
    };
    metricsCache.set(key, m);
  }
  return m;
}

// Advance width plus ink extents of a run of text. Advances come from
// shaping the run on the matched face (fonts.mjs), as Chromium's SVG text
// does; ink extents and fallback glyphs are measured with Skia, each segment
// with the font that will actually draw it.
function skiaMeasure(text, fontStr) {
  measureCtx.font = fontStr;
  return measureCtx.measureText(text);
}

function measureRun(text, font) {
  const key = fontString(font) + "\u0000" + text;
  let m = widthCache.get(key);
  if (m !== undefined) return m;
  const segments = segmentRun(text, font) ?? [{ kind: "fallback", text }];
  const emoji = emojiFont();
  let x = 0;
  m = { width: 0, inkLeft: Infinity, inkRight: -Infinity, inkAscent: 0, inkDescent: 0 };
  for (const seg of segments) {
    const fontStr = seg.kind === "emoji" && emoji ? `${font.size}px "${emoji}"` : fontString(font);
    const t = skiaMeasure(seg.text, fontStr);
    const w = seg.width ?? t.width;
    m.inkLeft = Math.min(m.inkLeft, x - t.actualBoundingBoxLeft);
    // Right ink is the overhang past the last advance, anchored at the shaped
    // end (Skia's own layout may be unkerned)
    m.inkRight = Math.max(m.inkRight, x + w + (t.actualBoundingBoxRight - t.width));
    m.inkAscent = Math.max(m.inkAscent, t.actualBoundingBoxAscent);
    m.inkDescent = Math.max(m.inkDescent, t.actualBoundingBoxDescent);
    x += w;
  }
  m.width = x;
  if (!Number.isFinite(m.inkLeft)) m.inkLeft = m.inkRight = 0;
  if (widthCache.size > 50000) widthCache.clear();
  widthCache.set(key, m);
  return m;
}

function textWidth(text, font) {
  return measureRun(text, font).width;
}

// ---------------------------------------------------------------------------
// CSS cascade, limited to the properties that change geometry

const INHERITED = new Set([
  "font-size", "font-family", "font-weight", "font-style", "text-anchor",
  "dominant-baseline", "white-space", "visibility", "letter-spacing", "line-height",
]);
const INITIAL = {
  // Chromium's default page font; SVG with no font rules inherits it
  "font-size": "16px", "font-family": 'Times, "Times New Roman", serif', "font-weight": "normal", "font-style": "normal",
  "text-anchor": "start", "dominant-baseline": "auto", "alignment-baseline": "auto", display: "inline",
  visibility: "visible", "letter-spacing": "normal", "line-height": "normal", "white-space": "normal",
};

function specificity(selector) {
  const s = selector.replace(/:not\(([^)]*)\)/g, " $1 ");
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length;
  const types = (s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]*\]|::?[\w-]+(\([^)]*\))?/g, " ").match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
  return ids * 10000 + classes * 100 + types;
}

const sheetCache = new Map();

function parseSheet(text) {
  let rules = sheetCache.get(text);
  if (rules) return rules;
  rules = [];
  let sheet;
  try {
    sheet = cssom.parse(text);
  } catch {
    sheet = { cssRules: [] };
  }
  let order = 0;
  for (const rule of sheet.cssRules) {
    if (!rule.selectorText || !rule.style) continue;
    const decls = [];
    for (let i = 0; i < rule.style.length; i++) {
      const name = rule.style[i];
      decls.push([name, rule.style.getPropertyValue(name), rule.style.getPropertyPriority(name) === "important"]);
    }
    for (const sel of rule.selectorText.split(",")) {
      const selector = sel.trim();
      if (selector) rules.push({ selector, specificity: specificity(selector), order: order++, decls });
    }
  }
  sheetCache.set(text, rules);
  return rules;
}

// Parses a style attribute the way browsers do: empty declarations are
// skipped, unknown (e.g. SVG-only) properties are kept. jsdom's parser drops
// both "; font-weight: bold" and properties it doesn't know.
const inlineCache = new Map();
export function parseInlineStyle(text) {
  let decls = inlineCache.get(text);
  if (decls) return decls;
  decls = new Map();
  for (const part of text.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    let value = part.slice(i + 1).trim();
    if (!name || !value) continue;
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, "").trim();
    decls.set(name, { value, important });
  }
  if (inlineCache.size > 10000) inlineCache.clear();
  inlineCache.set(text, decls);
  return decls;
}
function inlineStyle(el) {
  const text = el.getAttribute && el.getAttribute("style");
  return text ? parseInlineStyle(text) : EMPTY_MAP;
}
const EMPTY_MAP = new Map();

// ---------------------------------------------------------------------------
// The geometry engine bound to one jsdom window

// The virtual viewport matches headless Chromium's defaults (800x600, 8px body
// margin). A few diagram types read it: gantt sizes to its container and C4
// wraps rows at screen.availWidth.
export function createDom({ viewportWidth = 800, viewportHeight = 600 } = {}) {
  const width = viewportWidth - 16;
  const height = viewportHeight;
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const window = dom.window;
  const { document } = window;
  for (const [k, v] of Object.entries({ width: viewportWidth, height: viewportHeight, availWidth: viewportWidth, availHeight: viewportHeight })) {
    Object.defineProperty(window.screen, k, { value: v, configurable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: viewportWidth, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: viewportHeight, configurable: true });

  // Per-render caches; cleared whenever the document changes
  let generation = 0;
  const observer = new window.MutationObserver(() => generation++);
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const caches = { gen: -1, styles: new WeakMap(), sheets: null };
  function fresh() {
    // MutationObserver callbacks are async; synchronous geometry calls happen
    // between mutations, so we also invalidate on every top-level call.
    caches.styles = new WeakMap();
    caches.sheets = null;
  }

  function allRules() {
    if (caches.sheets) return caches.sheets;
    const rules = [];
    for (const style of document.querySelectorAll("style")) rules.push(...parseSheet(style.textContent || ""));
    caches.sheets = rules;
    return rules;
  }

  function matches(el, selector) {
    try {
      return el.matches(selector);
    } catch {
      return false;
    }
  }

  // Specified value of one property on one element (no inheritance)
  function specified(el, prop) {
    let cache = caches.styles.get(el);
    if (!cache) caches.styles.set(el, (cache = new Map()));
    if (cache.has(prop)) return cache.get(prop);
    let value;
    const decl = inlineStyle(el).get(prop);
    const inline = decl?.value;
    const inlineImportant = !!decl?.important;
    let best = null;
    for (const rule of allRules()) {
      for (const [name, v, important] of rule.decls) {
        if (name !== prop) continue;
        if (!matches(el, rule.selector)) continue;
        const rank = (important ? 1e9 : 0) + rule.specificity * 1000 + rule.order / 1e6;
        if (!best || rank >= best.rank) best = { rank, v, important };
      }
    }
    if (inlineImportant) value = inline;
    else if (best?.important) value = best.v;
    else if (inline) value = inline;
    else if (best) value = best.v;
    else if (el.namespaceURI === SVG_NS && el.hasAttribute(prop)) value = el.getAttribute(prop);
    if (value !== undefined) value = String(value).replace(/\s*!important\s*$/, "").trim();
    if (value === "inherit") value = undefined;
    cache.set(prop, value);
    return value;
  }

  function computed(el, prop) {
    for (let e = el; e && e.nodeType === 1; e = e.parentNode) {
      const v = specified(e, prop);
      if (v !== undefined && v !== "") return prop === "font-size" ? fontSizePx(e, v) : v;
      if (!INHERITED.has(prop)) break;
    }
    return prop === "font-size" ? 16 : INITIAL[prop];
  }

  // CSS length to px. `fontEl` supplies the font for em/ex/ch: for font-size
  // itself that is the parent, for every other property the element itself.
  const ABSOLUTE = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };
  const KEYWORD_SIZES = { "xx-small": 9, "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32 };
  function toPx(v, fontEl, percentBase) {
    const m = /^(-?[\d.]+(?:e[-+]?\d+)?)([a-z%]*)$/i.exec(String(v).trim());
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    if (!unit) return n;
    if (unit in ABSOLUTE) return n * ABSOLUTE[unit];
    if (unit === "%") return (n / 100) * percentBase();
    if (unit === "rem") return n * 16;
    if (unit === "vw") return (n / 100) * width;
    if (unit === "vh") return (n / 100) * height;
    const font = fontEl ? fontOf(fontEl) : { size: 16, family: INITIAL["font-family"], weight: "400", style: "normal" };
    if (unit === "em") return n * font.size;
    if (unit === "ex") return n * fontMetrics(font).xHeight;
    if (unit === "ch") return n * measureRun("0", font).width;
    return n;
  }

  function fontSizePx(el, v) {
    if (v in KEYWORD_SIZES) return KEYWORD_SIZES[v];
    const parent = el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null;
    const px = toPx(v, parent, () => (parent ? computed(parent, "font-size") : 16));
    return px === null || Number.isNaN(px) ? 16 : px;
  }

  // Computed font-weight as a number; bolder/lighter resolve against the
  // parent per the CSS Fonts 4 table
  function weightOf(el) {
    let v;
    let e = el;
    for (; e && e.nodeType === 1; e = e.parentNode) {
      v = specified(e, "font-weight");
      if (v !== undefined && v !== "") break;
    }
    if (v === undefined || v === "" || v === "normal") return 400;
    if (v === "bold") return 700;
    if (v === "bolder" || v === "lighter") {
      const parent = e.parentNode && e.parentNode.nodeType === 1 ? weightOf(e.parentNode) : 400;
      if (v === "bolder") return parent < 350 ? 400 : parent < 550 ? 700 : 900;
      return parent < 550 ? 100 : parent < 750 ? 400 : 700;
    }
    return Number(v) || 400;
  }

  function fontOf(el) {
    const weight = String(weightOf(el));
    return {
      size: computed(el, "font-size"),
      family: computed(el, "font-family"),
      weight,
      style: computed(el, "font-style"),
    };
  }

  function length(el, value, axis = "x") {
    if (value === null || value === undefined || value === "") return 0;
    const px = toPx(value, el, () => (axis === "x" ? width : height));
    return px === null || Number.isNaN(px) ? parseFloat(value) || 0 : px;
  }

  // SVG list attributes on <text>/<tspan> (x="1 2 3"); we only use the first value
  function firstLength(el, name, axis) {
    const v = el.getAttribute(name);
    if (v === null) return null;
    const first = v.trim().split(/[\s,]+/)[0];
    return first === undefined || first === "" ? null : length(el, first, axis);
  }

  // ---- text layout --------------------------------------------------------

  // Baseline offsets measured from Chromium (baseline-probe.mjs). text-top and
  // text-bottom have no effect, and before-/after-edge only work as
  // alignment-baseline on a tspan.
  function baselineShift(el, font) {
    let mode = el.localName === "tspan" ? specified(el, "alignment-baseline") : undefined;
    const fromAlignment = !!mode && mode !== "auto" && mode !== "baseline";
    if (!fromAlignment) mode = computed(el, "dominant-baseline");
    const { ascent, descent, xHeight } = fontMetrics(font);
    switch (mode) {
      case "middle":
        return xHeight / 2;
      case "central":
        return (ascent - descent) / 2;
      case "hanging":
        return ascent * 0.8;
      case "mathematical":
        return ascent / 2;
      case "text-before-edge":
        return ascent;
      case "text-after-edge":
      case "ideographic":
        return -descent;
      case "before-edge":
        return fromAlignment ? ascent : 0;
      case "after-edge":
        return fromAlignment ? -descent : 0;
      default:
        return 0;
    }
  }

  // Lays out a <text> element into positioned runs of glyphs.
  //
  // Positioning attributes (x, y, dx, dy) address characters: each applies to
  // the first character inside its element, and when nested elements address
  // the same character the innermost one wins. An absolute x starts a new text
  // chunk, and text-anchor aligns each chunk as a whole.
  function layoutText(textEl) {
    const runs = [];
    const chunks = [];
    let chunk = null;
    const st = { x: 0, y: 0, lastSpace: true, emitted: 0 };
    let pending = {};

    function enter(el) {
      for (const [name, axis] of [["x", "x"], ["y", "y"], ["dx", "x"], ["dy", "y"]]) {
        const v = firstLength(el, name, axis);
        if (v !== null) {
          pending[name] = v;
          if (name === "x") pending.anchorEl = el;
        }
      }
    }

    function applyPending(el) {
      st.positioned = pending.x !== undefined || pending.y !== undefined || pending.dx !== undefined || pending.dy !== undefined;
      if (pending.x !== undefined) {
        st.x = pending.x;
        chunk = { anchor: computed(pending.anchorEl, "text-anchor"), runs: [] };
        chunks.push(chunk);
      }
      if (pending.y !== undefined) st.y = pending.y;
      if (pending.dx !== undefined) st.x += pending.dx;
      if (pending.dy !== undefined) st.y += pending.dy;
      pending = {};
      if (!chunk) {
        chunk = { anchor: computed(textEl, "text-anchor"), runs: [] };
        chunks.push(chunk);
      }
    }

    function walk(el) {
      if (specified(el, "display") === "none") return;
      const saved = { ...pending };
      const emittedBefore = st.emitted;
      enter(el);
      for (const child of el.childNodes) {
        if (child.nodeType === 3) {
          const preserve = el.getAttribute("xml:space") === "preserve" || computed(el, "white-space") === "pre";
          // Chromium applies CSS white-space processing to SVG text: newlines
          // and tabs become spaces (SVG 1.1 deleted newlines instead)
          let text = child.data.replace(/\r\n?|\n|\t/g, " ");
          if (!preserve) {
            text = text.replace(/ +/g, " ");
            if (st.lastSpace) text = text.replace(/^ /, "");
          }
          if (!text) continue;
          applyPending(el);
          st.lastSpace = text.endsWith(" ");
          st.emitted += text.length;
          const font = fontOf(el);
          const { ascent, descent } = fontMetrics(font);
          const run = { x: st.x, y: st.y + baselineShift(el, font), text, font, owner: el, ascent, descent, positioned: st.positioned, ...measureRun(text, font) };
          runs.push(run);
          chunk.runs.push(run);
          st.x += run.width;
        } else if (child.nodeType === 1 && (child.localName === "tspan" || child.localName === "a" || child.localName === "textPath")) {
          walk(child);
        }
      }
      // Attributes on an element that contained no characters address nothing
      if (st.emitted === emittedBefore) pending = saved;
    }
    walk(textEl);

    // Chromium shapes across element and text-node boundaries when the font
    // and baseline are unchanged (Mermaid builds labels one word per node), so
    // kerning applies across them. Reshape such groups as one string and give
    // each run its share via prefix widths.
    for (let i = 0; i < runs.length; ) {
      let j = i + 1;
      while (j < runs.length && !runs[j].positioned && runs[j].y === runs[i].y && fontString(runs[j].font) === fontString(runs[i].font)) j++;
      if (j - i > 1) {
        let prefix = "", prev = 0;
        const x0 = runs[i].x;
        const originalEnd = runs[j - 1].x + runs[j - 1].width;
        for (let k = i; k < j; k++) {
          prefix += runs[k].text;
          const total = measureRun(prefix, runs[i].font).width;
          const overhang = runs[k].inkRight - runs[k].width;
          runs[k].x = x0 + prev;
          runs[k].width = total - prev;
          runs[k].inkRight = runs[k].width + overhang;
          prev = total;
        }
        // Positions after the group shift by the difference
        const delta = x0 + prev - originalEnd;
        for (let k = j; k < runs.length && !runs[k].positioned; k++) runs[k].x += delta;
      }
      i = j;
    }

    // A trailing collapsible space takes no room
    const last = runs[runs.length - 1];
    if (last && last.text.endsWith(" ") && computed(textEl, "white-space") !== "pre") {
      Object.assign(last, measureRun(last.text.slice(0, -1), last.font), { text: last.text.slice(0, -1) });
    }

    for (const c of chunks) {
      if (!c.runs.length || c.anchor === "start") continue;
      const left = Math.min(...c.runs.map((r) => r.x));
      const right = Math.max(...c.runs.map((r) => r.x + r.width));
      const shift = c.anchor === "middle" ? (right - left) / 2 : right - left;
      for (const r of c.runs) r.x -= shift;
    }
    return runs.filter((r) => r.text);
  }

  function runsOf(el) {
    const textEl = el.localName === "text" ? el : el.closest("text");
    if (!textEl) return [];
    const runs = layoutText(textEl);
    if (el === textEl) return runs;
    return runs.filter((r) => el.contains(r.owner));
  }

  // Blink's text box is the union of the font box (rounded ascent/descent,
  // advance width) and the glyphs' actual ink (verified with fontprobe2.mjs)
  function textBBox(el) {
    let box = null;
    for (const r of runsOf(el)) {
      const left = r.x + Math.min(0, r.inkLeft);
      const right = r.x + Math.max(r.width, r.inkRight);
      const top = r.y - Math.max(r.ascent, r.inkAscent);
      const bottom = r.y + Math.max(r.descent, r.inkDescent);
      box = unionRect(box, { x: left, y: top, width: right - left, height: bottom - top });
    }
    return box;
  }

  function textLength(el) {
    return runsOf(el).reduce((s, r) => s + r.width, 0);
  }

  // ---- shapes -------------------------------------------------------------

  const NON_RENDERED = new Set([
    "defs", "style", "marker", "clipPath", "mask", "pattern", "linearGradient", "radialGradient",
    "title", "desc", "metadata", "symbol", "script", "filter",
  ]);

  function num(el, name, axis) {
    return length(el, el.getAttribute(name), axis);
  }

  function pointsBBox(pts) {
    if (!pts.length) return null;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  // Bounding box in the element's own user space (its transform excluded)
  function ownBBox(el) {
    const tag = el.localName;
    if (NON_RENDERED.has(tag)) return null;
    switch (tag) {
      case "rect":
      case "image":
      case "foreignObject": {
        const w = num(el, "width", "x"), h = num(el, "height", "y");
        // Blink treats zero-size boxes as having no geometry at all
        if (w <= 0 || h <= 0) return null;
        return { x: num(el, "x", "x"), y: num(el, "y", "y"), width: Math.max(0, w), height: Math.max(0, h) };
      }
      case "circle": {
        const r = num(el, "r");
        if (r <= 0) return null;
        return { x: num(el, "cx", "x") - r, y: num(el, "cy", "y") - r, width: 2 * r, height: 2 * r };
      }
      case "ellipse": {
        const rx = num(el, "rx", "x"), ry = num(el, "ry", "y");
        if (rx <= 0 || ry <= 0) return null;
        return { x: num(el, "cx", "x") - rx, y: num(el, "cy", "y") - ry, width: 2 * rx, height: 2 * ry };
      }
      case "line":
        return pointsBBox([[num(el, "x1", "x"), num(el, "y1", "y")], [num(el, "x2", "x"), num(el, "y2", "y")]]);
      case "polyline":
      case "polygon": {
        const n = (el.getAttribute("points") || "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
        const pts = [];
        for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
        return pointsBBox(pts);
      }
      case "path": {
        const d = el.getAttribute("d");
        if (!d || !d.trim()) return null;
        try {
          const [x0, y0, x1, y1] = svgPathBbox(d);
          if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
          return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        } catch {
          return null;
        }
      }
      case "text":
      case "tspan":
      case "textPath": {
        // Blink quirk (blink-probe.mjs): <text> with no glyphs but with child
        // elements still reports a zero-size box at its origin
        const box = textBBox(el);
        if (!box && tag === "text" && el.children.length) return { ...ZERO };
        return box;
      }
      case "use": {
        if (el.hasAttribute("width") && el.hasAttribute("height")) {
          return { x: num(el, "x", "x"), y: num(el, "y", "y"), width: num(el, "width", "x"), height: num(el, "height", "y") };
        }
        const href = el.getAttribute("href") || el.getAttribute("xlink:href");
        const target = href && href.startsWith("#") ? document.getElementById(href.slice(1)) : null;
        const inner = target ? containerBBox(target) : null;
        return transformRect(inner, new Matrix(1, 0, 0, 1, num(el, "x", "x"), num(el, "y", "y")));
      }
      default:
        // Containers (g, a, switch, nested and root <svg>) report the box their
        // last layout computed; a nested <svg> reports it in viewBox units
        return containerBox(el);
    }
  }

  // Matches Blink (verified with blink-probe.mjs): empty shapes (zero-size
  // rects, empty text, paths without segments) are skipped, while degenerate
  // but non-empty geometry such as a single-point path still counts.
  // <switch> renders only its first child whose conditions pass
  function switchChoice(sw) {
    for (const child of sw.children) {
      if (child.namespaceURI !== SVG_NS) continue;
      if (child.hasAttribute("requiredExtensions") && child.getAttribute("requiredExtensions").trim()) continue;
      const lang = child.getAttribute("systemLanguage");
      if (lang !== null && !lang.split(",").some((l) => /^en\b/i.test(l.trim()))) continue;
      return child;
    }
    return null;
  }

  // Elements outside the render tree (display:none, unchosen <switch> branches,
  // resources such as <defs>) have no geometry; getBBox reports zeros for them
  function rendered(el) {
    for (let e = el; e && e.namespaceURI === SVG_NS; e = e.parentNode) {
      if (specified(e, "display") === "none") return false;
      if (NON_RENDERED.has(e.localName) && e !== el) return false;
      const parent = e.parentNode;
      if (parent && parent.localName === "switch" && switchChoice(parent) !== e) return false;
    }
    return true;
  }

  // ---- incremental layout -------------------------------------------------
  //
  // Blink keeps a layout object per rendered element, and a container
  // recomputes its bounding box only when one of its children reports that
  // its own bounds changed (SVGContentContainer::Layout -> UpdateBoundingBoxes)
  // or when a child went away. A child "changes" when its box or transform
  // differs from the previous layout, starting from an empty box at the origin
  // and the identity transform. So an empty <text> created at the origin never
  // reports a change, its container is never recomputed, and the container
  // stays invalid and invisible to its ancestors' getBBox. getBBox therefore
  // depends on layout history, and we replay that history: every geometry
  // query is a layout flush, and per-element state persists between flushes
  // the way Blink's layout objects do.

  const SHAPES = new Set(["rect", "circle", "ellipse", "line", "polyline", "polygon", "path"]);
  const CONTAINERS = new Set(["g", "a", "svg", "switch"]);
  const state = new WeakMap(); // element -> { box, valid, tf, pass, parent, kids }
  const passes = new WeakMap(); // root <svg> -> pass number

  function kindOf(el) {
    if (el.namespaceURI !== SVG_NS) return null;
    const tag = el.localName;
    if (SHAPES.has(tag)) return "shape";
    if (tag === "text") return "text";
    if (tag === "image" || tag === "foreignObject" || tag === "use") return "leaf";
    if (CONTAINERS.has(tag)) return "container";
    if (NON_RENDERED.has(tag)) return "hidden";
    return null;
  }

  function renderedChildren(el) {
    const only = el.localName === "switch" ? switchChoice(el) : null;
    const out = [];
    for (const child of el.children) {
      if (only && child !== only) continue;
      if (!kindOf(child) || specified(child, "display") === "none") continue;
      out.push(child);
    }
    return out;
  }

  const rectEq = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  const transformKey = (el) => {
    const m = localTransform(el);
    return m.isIdentity() ? "" : [m.a, m.b, m.c, m.d, m.e, m.f].join(",");
  };

  // Lays out one element; returns whether its bounds changed (Blink's
  // SVGLayoutResult::bounds_changed)
  function layoutNode(el, pass, parentIsNew = false) {
    const kind = kindOf(el);
    let old = state.get(el);
    // A layout object that missed the previous pass or moved is brand new, and
    // so is everything under it (Blink rebuilds the whole subtree)
    if (parentIsNew || (old && (old.pass !== pass - 1 || old.parent !== el.parentNode))) old = undefined;
    let box, valid, kids;
    if (kind === "container" || kind === "hidden") {
      kids = renderedChildren(el);
      let childChanged = false;
      for (const c of kids) if (layoutNode(c, pass, !old)) childChanged = true;
      // Losing a child forces a recompute (bounds_dirty_from_removed_child_)
      if (old?.kids && old.kids.some((k) => !kids.includes(k))) childChanged = true;
      if (childChanged || !old) {
        box = null;
        valid = false;
        if (childChanged) {
          for (const c of kids) {
            const cs = state.get(c);
            if (!cs || !cs.valid || kindOf(c) === "hidden") continue;
            const tb = transformRect(cs.box, localTransform(c));
            if (globalThis.__bboxDebug) globalThis.__bboxDebug(el, c, tb);
            box = box ? unionEvenIfEmpty(box, tb) : tb;
            valid = true;
          }
        }
        box ??= { ...ZERO };
      } else {
        ({ box, valid } = old);
      }
      if (kind === "hidden") valid = false;
    } else {
      const b = ownBBox(el);
      if (kind === "text") valid = !!b || el.children.length > 0;
      else valid = !!b;
      box = b ?? { ...ZERO };
    }
    const tf = transformKey(el);
    // Leaves always report a change on their first layout (validity-probe.mjs);
    // containers only when their recomputed box or their transform moved
    const isLeaf = kind !== "container" && kind !== "hidden";
    const changed = (isLeaf && !old) || !rectEq(box, old?.box ?? ZERO) || tf !== (old?.tf ?? "");
    state.set(el, { box, valid, tf, pass, parent: el.parentNode, kids });
    return changed;
  }

  function unionEvenIfEmpty(a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
  }

  function outermostSvg(el) {
    let root = null;
    for (let e = el; e && e.namespaceURI === SVG_NS; e = e.parentNode) if (e.localName === "svg") root = e;
    return root;
  }

  // Runs a layout pass over the <svg> tree containing `el`
  function flush(el) {
    const root = outermostSvg(el);
    if (!root || !root.isConnected) return null;
    const pass = (passes.get(root) ?? 0) + 1;
    passes.set(root, pass);
    layoutNode(root, pass);
    return root;
  }

  function containerBox(el) {
    const root = flush(el);
    if (!root) return null;
    const st = state.get(el);
    return st && st.pass === passes.get(root) ? st.box : null;
  }

  // Stateless union of children, for content that has no layout objects of its
  // own (the target of a <use>)
  function containerBBox(el) {
    let box = null;
    for (const child of renderedChildren(el)) {
      const b = kindOf(child) === "container" ? containerBBox(child) : ownBBox(child);
      if (b) box = unionRect(box, transformRect(b, localTransform(child)));
    }
    return box;
  }

  function localTransform(el) {
    if (el.localName === "svg" && el.parentNode && el.parentNode.namespaceURI === SVG_NS) return viewportTransform(el);
    let t = el.getAttribute("transform");
    const css = inlineStyle(el).get("transform")?.value;
    if (css && css !== "none") t = css;
    return parseTransform(t);
  }

  // x/y offset plus the viewBox-to-viewport mapping of a nested <svg>
  function viewportTransform(el) {
    const x = num(el, "x", "x"), y = num(el, "y", "y");
    const w = el.hasAttribute("width") ? num(el, "width", "x") : width;
    const h = el.hasAttribute("height") ? num(el, "height", "y") : height;
    let m = new Matrix(1, 0, 0, 1, x, y);
    const vb = (el.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    if (vb.length !== 4 || vb.some(Number.isNaN) || vb[2] <= 0 || vb[3] <= 0) return m;
    const [vx, vy, vw, vh] = vb;
    const par = (el.getAttribute("preserveAspectRatio") || "xMidYMid meet").trim().split(/\s+/);
    let sx = w / vw, sy = h / vh;
    let tx = -vx * sx, ty = -vy * sy;
    if (par[0] !== "none") {
      const s = par[1] === "slice" ? Math.max(sx, sy) : Math.min(sx, sy);
      sx = sy = s;
      const align = par[0];
      const fx = /xMid/.test(align) ? 0.5 : /xMax/.test(align) ? 1 : 0;
      const fy = /YMid/.test(align) ? 0.5 : /YMax/.test(align) ? 1 : 0;
      tx = -vx * s + (w - vw * s) * fx;
      ty = -vy * s + (h - vh * s) * fy;
    }
    return m.multiply(new Matrix(sx, 0, 0, sy, tx, ty));
  }

  // Transform from the element's user space to the outermost <svg>'s user space
  function ctm(el) {
    let m = new Matrix();
    for (let e = el; e && e.namespaceURI === SVG_NS; e = e.parentNode) {
      if (e.localName === "svg" && !(e.parentNode && e.parentNode.namespaceURI === SVG_NS)) break;
      m = localTransform(e).multiply(m);
    }
    return m;
  }

  // ---- install on the jsdom prototypes -------------------------------------

  const SVG_NS = "http://www.w3.org/2000/svg";
  const proto = window.SVGElement.prototype;
  const ZERO = { x: 0, y: 0, width: 0, height: 0 };
  const toRect = (r) => {
    const b = r || ZERO;
    return { x: b.x, y: b.y, width: b.width, height: b.height, top: b.y, left: b.x, right: b.x + b.width, bottom: b.y + b.height };
  };

  // An SVGRect has only x/y/width/height; Mermaid relies on `left` being absent
  // SVG geometry interfaces are single precision in Blink (SVGRect, float
  // lengths). Mermaid compares coordinates exactly when deduplicating points,
  // so the float32 rounding is observable and we reproduce it.
  const f32 = Math.fround;
  proto.getBBox = function () {
    fresh();
    flush(this);
    const b = (rendered(this) && ownBBox(this)) || ZERO;
    return { x: f32(b.x), y: f32(b.y), width: f32(b.width), height: f32(b.height) };
  };
  proto.getComputedTextLength = function () {
    fresh();
    return f32(textLength(this));
  };
  proto.getSubStringLength = function (start, count) {
    fresh();
    const text = (this.textContent || "").substr(start, count);
    return textWidth(text, fontOf(this));
  };
  proto.getNumberOfChars = function () {
    return (this.textContent || "").length;
  };
  function geometryPath(el) {
    switch (el.localName) {
      case "path":
        return el.getAttribute("d") || "";
      case "line":
        return `M${num(el, "x1")},${num(el, "y1")}L${num(el, "x2")},${num(el, "y2")}`;
      case "rect": {
        const x = num(el, "x"), y = num(el, "y"), w = num(el, "width"), h = num(el, "height");
        return `M${x},${y}h${w}v${h}h${-w}Z`;
      }
      case "polyline":
      case "polygon":
        return "M" + (el.getAttribute("points") || "").trim() + (el.localName === "polygon" ? "Z" : "");
      case "circle": {
        const r = num(el, "r"), cx = num(el, "cx"), cy = num(el, "cy");
        return `M${cx - r},${cy}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;
      }
      default:
        return "";
    }
  }
  proto.getTotalLength = function () {
    try {
      return f32(new svgPathProperties(geometryPath(this)).getTotalLength());
    } catch {
      return 0;
    }
  };
  proto.getPointAtLength = function (len) {
    try {
      const p = new svgPathProperties(geometryPath(this)).getPointAtLength(len);
      return { x: f32(p.x), y: f32(p.y) };
    } catch {
      return { x: 0, y: 0 };
    }
  };
  proto.getCTM = function () {
    return ctm(this);
  };
  proto.getScreenCTM = function () {
    return ctm(this);
  };

  const elementProto = window.Element.prototype;
  const htmlRect = window.Element.prototype.getBoundingClientRect;
  elementProto.getBoundingClientRect = function () {
    if (this.namespaceURI === SVG_NS) {
      fresh();
      flush(this);
      const own = ownBBox(this);
      return toRect(transformRect(own, ctm(this).multiply(this.localName === "svg" ? new Matrix() : new Matrix())));
    }
    return htmlRect.call(this);
  };

  // Block-level HTML containers take the full layout width; anything hidden
  // with display:none (or detached) has no box, as in a browser
  const BLOCK = new Set(["div", "body", "html", "section", "main", "pre"]);
  function hidden(el) {
    if (!el.isConnected) return true;
    for (let e = el; e && e.nodeType === 1; e = e.parentNode) if (specified(e, "display") === "none") return true;
    return false;
  }
  for (const [prop, size] of [["offsetWidth", () => width], ["clientWidth", () => width], ["offsetHeight", () => 0], ["clientHeight", () => 0]]) {
    Object.defineProperty(window.HTMLElement.prototype, prop, {
      configurable: true,
      get() {
        fresh();
        return BLOCK.has(this.localName) && !hidden(this) ? size() : 0;
      },
    });
  }

  // getComputedStyle answers geometry-affecting properties from our cascade
  const nativeComputed = window.getComputedStyle.bind(window);
  const toKebab = (p) => p.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  window.getComputedStyle = function (el, pseudo) {
    const base = nativeComputed(el, pseudo);
    fresh();
    const resolve = (name) => {
      if (name === "font-size") return computed(el, "font-size") + "px";
      // Browsers resolve box lengths to "0px", never ""
      if (/^(padding|margin|border)(-(top|right|bottom|left))?(-width)?$/.test(name)) {
        const v = base.getPropertyValue(name);
        return v === "" ? "0px" : v;
      }
      if (name in INITIAL || name === "font-family" || name === "font-weight") {
        const v = computed(el, name);
        return v === undefined ? "" : String(v);
      }
      return base.getPropertyValue(name);
    };
    return new Proxy(base, {
      get(target, prop) {
        if (prop === "getPropertyValue") return (n) => resolve(n);
        if (typeof prop === "string" && /^[a-z]/.test(prop) && !(prop in Object.getPrototypeOf(target)) || prop === "fontSize" || prop === "fontFamily" || prop === "fontWeight" || prop === "lineHeight") {
          const v = resolve(toKebab(prop));
          if (v !== "" && v !== undefined) return v;
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };

  // Canvas 2D: diagrams only *measure* text with it (cytoscape also paints
  // into it, which nobody sees), so measurement is real and drawing is a no-op
  window.HTMLCanvasElement.prototype.getContext = function (type) {
    if (type !== "2d") return null;
    if (!this.__ctx) this.__ctx = measuringContext();
    return this.__ctx;
  };

  return {
    window,
    document,
    font: { fontMetrics, textWidth },
    cascade: { specified, computed, fresh },
    internals: { ownBBox, layoutText, computed, state, passes, outermostSvg, kindOf, renderedChildren },
  };
}

// A CanvasRenderingContext2D whose text measurement is real (Skia) and whose
// drawing calls do nothing
function measuringContext() {
  const ctx = createCanvas(1, 1).getContext("2d");
  const state = { font: "10px sans-serif" };
  const noop = new Proxy(function () {}, {
    get: (_, p) => (p === Symbol.toPrimitive ? () => "" : noop),
    apply: () => noop,
  });
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === "measureText") return (text) => { ctx.font = state.font; return ctx.measureText(String(text)); };
        if (prop === "canvas") return undefined;
        if (prop in state) return state[prop];
        if (prop === "getImageData") return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h });
        return noop;
      },
      set(_, prop, value) {
        state[prop] = value;
        return true;
      },
    }
  );
}

// Expose a window's globals the way a browser would, without clobbering Node's own
export function installGlobals(window) {
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis || key.startsWith("_")) continue;
    let value;
    try {
      value = window[key];
    } catch {
      continue;
    }
    Object.defineProperty(globalThis, key, {
      value: typeof value === "function" && !/^[A-Z]/.test(key) ? value.bind(window) : value,
      configurable: true,
      writable: true,
    });
  }
  for (const key of ["window", "document", "navigator", "getComputedStyle", "self"]) {
    Object.defineProperty(globalThis, key, {
      value: key === "window" || key === "self" ? window : key === "getComputedStyle" ? window.getComputedStyle : window[key],
      configurable: true,
      writable: true,
    });
  }
  if (!window.CSSStyleSheet.prototype.replaceSync) window.CSSStyleSheet.prototype.replaceSync = function () {};
}
