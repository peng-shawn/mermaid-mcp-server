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

function textWidth(text, font) {
  const key = fontString(font) + "\u0000" + text;
  let w = widthCache.get(key);
  if (w === undefined) {
    measureCtx.font = fontString(font);
    w = measureCtx.measureText(text).width;
    widthCache.set(key, w);
  }
  return w;
}

// ---------------------------------------------------------------------------
// CSS cascade, limited to the properties that change geometry

const INHERITED = new Set([
  "font-size", "font-family", "font-weight", "font-style", "text-anchor",
  "dominant-baseline", "white-space", "visibility", "letter-spacing", "line-height",
]);
const INITIAL = {
  "font-size": "16px", "font-family": "sans-serif", "font-weight": "normal", "font-style": "normal",
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

// ---------------------------------------------------------------------------
// The geometry engine bound to one jsdom window

export function createDom({ width = 784, height = 600 } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const window = dom.window;
  const { document } = window;

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
    const inline = el.style?.getPropertyValue?.(prop);
    const inlineImportant = inline && el.style.getPropertyPriority(prop) === "important";
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

  function fontSizePx(el, v) {
    const n = parseFloat(v);
    if (Number.isNaN(n)) return 16;
    if (/em$/.test(v) || /%$/.test(v)) {
      const parentSize = el.parentNode && el.parentNode.nodeType === 1 ? computed(el.parentNode, "font-size") : 16;
      return /%$/.test(v) ? (parentSize * n) / 100 : parentSize * n;
    }
    return n;
  }

  function fontOf(el) {
    let weight = computed(el, "font-weight");
    if (weight === "normal") weight = "400";
    else if (weight === "bold") weight = "700";
    return {
      size: computed(el, "font-size"),
      family: computed(el, "font-family"),
      weight,
      style: computed(el, "font-style"),
    };
  }

  function length(el, value, axis = "x") {
    if (value === null || value === undefined || value === "") return 0;
    const v = String(value).trim();
    const n = parseFloat(v);
    if (Number.isNaN(n)) return 0;
    if (v.endsWith("em")) return n * computed(el, "font-size");
    if (v.endsWith("%")) return (n / 100) * (axis === "x" ? width : height);
    return n;
  }

  // SVG list attributes on <text>/<tspan> (x="1 2 3"); we only use the first value
  function firstLength(el, name, axis) {
    const v = el.getAttribute(name);
    if (v === null) return null;
    const first = v.trim().split(/[\s,]+/)[0];
    return first === undefined || first === "" ? null : length(el, first, axis);
  }

  // ---- text layout --------------------------------------------------------

  function baselineShift(el, font) {
    let mode = el.localName === "tspan" ? specified(el, "alignment-baseline") : undefined;
    if (!mode || mode === "auto" || mode === "baseline") mode = computed(el, "dominant-baseline");
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
      case "before-edge":
      case "text-top":
        return ascent;
      case "text-after-edge":
      case "after-edge":
      case "ideographic":
      case "text-bottom":
        return -descent;
      default:
        return 0;
    }
  }

  // Lays out a <text> element into positioned runs, following SVG 1.1 text
  // chunk rules: absolute x starts a new chunk, text-anchor aligns each chunk.
  function layoutText(textEl) {
    const runs = [];
    const chunks = [];
    let chunk = null;
    const st = { x: 0, y: 0, lastSpace: true };

    function startChunk(anchorEl) {
      chunk = { anchor: computed(anchorEl, "text-anchor"), runs: [] };
      chunks.push(chunk);
    }

    function position(el) {
      const x = firstLength(el, "x", "x");
      const y = firstLength(el, "y", "y");
      if (x !== null) {
        st.x = x;
        startChunk(el);
      }
      if (y !== null) st.y = y;
      const dx = firstLength(el, "dx", "x");
      const dy = firstLength(el, "dy", "y");
      if (dx !== null) st.x += dx;
      if (dy !== null) st.y += dy;
    }

    function walk(el) {
      if (specified(el, "display") === "none") return;
      position(el);
      if (!chunk) startChunk(el);
      for (const child of el.childNodes) {
        if (child.nodeType === 3) {
          const preserve = el.getAttribute("xml:space") === "preserve" || computed(el, "white-space") === "pre";
          let text = child.data.replace(/[\n\r]/g, preserve ? " " : "").replace(/\t/g, " ");
          if (!preserve) {
            text = text.replace(/ +/g, " ");
            if (st.lastSpace) text = text.replace(/^ /, "");
          }
          if (!text) continue;
          st.lastSpace = text.endsWith(" ");
          const font = fontOf(el);
          const w = textWidth(text, font);
          const { ascent, descent } = fontMetrics(font);
          const shift = baselineShift(el, font);
          const run = { x: st.x, y: st.y + shift, width: w, ascent, descent, text, font };
          runs.push(run);
          chunk.runs.push(run);
          st.x += w;
        } else if (child.nodeType === 1 && (child.localName === "tspan" || child.localName === "a" || child.localName === "textPath")) {
          walk(child);
        }
      }
    }
    walk(textEl);

    // Trailing collapsible space does not take up room
    const last = runs[runs.length - 1];
    if (last && last.text.endsWith(" ") && computed(textEl, "white-space") !== "pre") {
      const trimmed = last.text.slice(0, -1);
      last.width = textWidth(trimmed, last.font);
      last.text = trimmed;
    }

    for (const c of chunks) {
      if (!c.runs.length || c.anchor === "start") continue;
      const left = Math.min(...c.runs.map((r) => r.x));
      const right = Math.max(...c.runs.map((r) => r.x + r.width));
      const shift = c.anchor === "middle" ? (right - left) / 2 : right - left;
      for (const r of c.runs) r.x -= shift;
    }
    return runs;
  }

  function textBBox(el) {
    // getBBox on a tspan reports that tspan's runs within its <text>
    const textEl = el.localName === "text" ? el : el.closest("text");
    if (!textEl) return null;
    const runs = layoutText(textEl).filter((r) => el === textEl || isInside(r, el, textEl));
    let box = null;
    for (const r of runs) box = unionRect(box, { x: r.x, y: r.y - r.ascent, width: r.width, height: r.ascent + r.descent });
    return box;
  }

  // Map each run back to the element that owns it
  function isInside(run, el, textEl) {
    if (!run.owner) annotateOwners(textEl);
    for (let e = run.owner; e && e !== textEl; e = e.parentNode) if (e === el) return true;
    return false;
  }
  function annotateOwners(textEl) {
    const runs = layoutText(textEl);
    let i = 0;
    (function walk(el) {
      for (const child of el.childNodes) {
        if (child.nodeType === 3 && i < runs.length && child.data.trim()) runs[i++].owner = el;
        else if (child.nodeType === 1) walk(child);
      }
    })(textEl);
    return runs;
  }

  function textLength(el) {
    const textEl = el.localName === "text" ? el : el.closest("text");
    if (!textEl) return 0;
    const runs = el === textEl ? layoutText(textEl) : annotateOwners(textEl).filter((r) => {
      for (let e = r.owner; e && e !== textEl; e = e.parentNode) if (e === el) return true;
      return false;
    });
    return runs.reduce((s, r) => s + r.width, 0);
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
      case "svg":
        if (el.parentNode && el.parentNode.namespaceURI === SVG_NS && el.hasAttribute("width") && el.hasAttribute("height")) {
          return { x: num(el, "x", "x"), y: num(el, "y", "y"), width: num(el, "width", "x"), height: num(el, "height", "y") };
        }
        return containerBBox(el);
      default:
        return containerBBox(el);
    }
  }

  // Matches Blink (verified with blink-probe.mjs): empty shapes (zero-size
  // rects, empty text, paths without segments) are skipped, while degenerate
  // but non-empty geometry such as a single-point path still counts.
  function containerBBox(el) {
    let box = null;
    for (const child of el.children) {
      if (child.namespaceURI !== SVG_NS) continue;
      if (specified(child, "display") === "none") continue;
      const b = ownBBox(child);
      if (!b) {
        if (globalThis.__bboxDebug) globalThis.__bboxDebug(el, child, null);
        continue;
      }
      const tb = transformRect(b, localTransform(child));
      if (globalThis.__bboxDebug) globalThis.__bboxDebug(el, child, tb);
      box = unionRect(box, tb);
    }
    return box;
  }

  function localTransform(el) {
    let t = el.getAttribute("transform");
    const css = el.style?.getPropertyValue?.("transform");
    if (css && css !== "none") t = css;
    return parseTransform(t);
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
  proto.getBBox = function () {
    fresh();
    const b = ownBBox(this) || ZERO;
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  };
  proto.getComputedTextLength = function () {
    fresh();
    return textLength(this);
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
      return new svgPathProperties(geometryPath(this)).getTotalLength();
    } catch {
      return 0;
    }
  };
  proto.getPointAtLength = function (len) {
    try {
      const p = new svgPathProperties(geometryPath(this)).getPointAtLength(len);
      return { x: p.x, y: p.y };
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
      const own = this.localName === "svg" && !(this.parentNode?.namespaceURI === SVG_NS) ? containerBBox(this) : ownBBox(this);
      return toRect(transformRect(own, ctm(this).multiply(this.localName === "svg" ? new Matrix() : new Matrix())));
    }
    return htmlRect.call(this);
  };

  // Block-level HTML containers take the full layout width
  const BLOCK = new Set(["div", "body", "html", "section", "main", "pre"]);
  for (const [prop, size] of [["offsetWidth", () => width], ["clientWidth", () => width], ["offsetHeight", () => 0], ["clientHeight", () => 0]]) {
    Object.defineProperty(window.HTMLElement.prototype, prop, {
      configurable: true,
      get() {
        return BLOCK.has(this.localName) ? size() : 0;
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

  // Canvas 2D (cytoscape and some diagrams measure text with it)
  window.HTMLCanvasElement.prototype.getContext = function (type) {
    if (type !== "2d") return null;
    if (!this.__ctx) this.__ctx = createCanvas(Math.max(1, this.width || 300), Math.max(1, this.height || 150)).getContext("2d");
    return this.__ctx;
  };

  return { window, document, font: { fontMetrics, textWidth }, internals: { ownBBox, layoutText, computed } };
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
