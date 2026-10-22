// A DOM whose geometry answers match Chromium's, so the official Mermaid
// renderer can run in Node.
//
// Mermaid needs a browser for one thing: geometry. It asks how big text and
// shapes are (getBBox, getComputedTextLength, getBoundingClientRect, ...) and
// lays the diagram out from the answers. jsdom supplies the document model
// but answers every geometry question with zeros. This module answers them the
// way Blink does: a CSS cascade for the properties that affect geometry, text
// shaped like Chromium's SVG text (fonts.ts), exact path bounds, transforms,
// and a replay of Blink's incremental layout, whose history is observable
// through getBBox.
//
// Every rule here was established by probing Chromium, not by reading specs;
// the probes live in experiments/browserless. Accuracy is measured against
// Chromium on Mermaid's own documentation examples (test/accuracy).
import { JSDOM } from "jsdom";
import { createCanvas } from "@napi-rs/canvas";
import { svgPathBbox } from "svg-path-bbox";
import { svgPathProperties } from "svg-path-properties";
import { parseInlineStyle, parseSheet, RuleIndex, type Declaration, type Rule } from "./css.js";
import { fontMetrics, measureRun, type FontSpec, type RunMetrics } from "./fonts.js";
import { Matrix, parseTransform, pointsRect, rectEquals, transformRect, union, ZERO_RECT, type Rect } from "./geometry.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const INHERITED = new Set([
  "font-size", "font-family", "font-weight", "font-style", "text-anchor",
  "dominant-baseline", "white-space", "visibility", "letter-spacing", "line-height",
]);

const INITIAL: Record<string, string> = {
  // Chromium's default page font; SVG without font rules inherits it
  "font-family": 'Times, "Times New Roman", serif',
  "font-size": "16px",
  "font-weight": "normal",
  "font-style": "normal",
  "text-anchor": "start",
  "dominant-baseline": "auto",
  "alignment-baseline": "auto",
  display: "inline",
  visibility: "visible",
  "letter-spacing": "normal",
  "line-height": "normal",
  "white-space": "normal",
};

// Elements that are resources, not rendering: no geometry of their own
const NON_RENDERED = new Set([
  "defs", "style", "marker", "clipPath", "mask", "pattern", "linearGradient", "radialGradient",
  "title", "desc", "metadata", "symbol", "script", "filter",
]);
const SHAPES = new Set(["rect", "circle", "ellipse", "line", "polyline", "polygon", "path"]);
const TEXT_CONTENT = new Set(["text", "tspan", "textPath", "a"]);
const CONTAINERS = new Set(["g", "a", "svg", "switch"]);

const ABSOLUTE_UNITS: Record<string, number> = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 101.6 };
const KEYWORD_SIZES: Record<string, number> = { "xx-small": 9, "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32 };

// SVG geometry interfaces are single precision in Blink (SVGRect, float
// lengths). Mermaid compares coordinates exactly when deduplicating points,
// so the float32 rounding is observable and reproduced.
const f32 = Math.fround;

type El = Element & { [key: string]: any };

interface Run extends RunMetrics {
  x: number;
  y: number;
  text: string;
  font: FontSpec;
  fontKey: string;
  owner: El;
  ascent: number;
  descent: number;
  positioned: boolean;
}

// Per-element layout object, as Blink keeps one per rendered element
interface LayoutState {
  box: Rect;
  valid: boolean;
  transform: string;
  parent: Node | null;
  kids?: El[];
}

export interface DomOptions {
  // Matches headless Chromium (800x600 with an 8px body margin). Gantt sizes
  // itself to its container and C4 wraps rows at screen.availWidth.
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface GeometryDom {
  window: any;
  document: Document;
  // Specified and computed values from the cascade, for the flattener
  specified(el: Element, prop: string): string | undefined;
  computed(el: Element, prop: string): string;
  fontOf(el: Element): FontSpec;
}

export function createDom({ viewportWidth = 800, viewportHeight = 600 }: DomOptions = {}): GeometryDom {
  const containerWidth = viewportWidth - 16;
  const jsdom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const window = jsdom.window as any;
  const document: Document = window.document;
  for (const [k, v] of Object.entries({ width: viewportWidth, height: viewportHeight, availWidth: viewportWidth, availHeight: viewportHeight })) {
    Object.defineProperty(window.screen, k, { value: v, configurable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: viewportWidth, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: viewportHeight, configurable: true });

  // ---- invalidation ---------------------------------------------------------
  //
  // Geometry calls arrive between DOM mutations, often hundreds per render.
  // takeRecords() hands us, synchronously, exactly what changed since the
  // last call, and we invalidate only that, like Blink's dirty bits: style
  // caches of the touched elements (their subtrees when a class or id changes
  // which selectors match), and layout of the touched elements plus a
  // "something below is dirty" mark up their ancestor chain. A layout pass
  // then only walks dirty paths.
  // Records reach us two ways: delivered to the callback at microtask
  // boundaries (Mermaid awaits between DOM changes and geometry calls), or
  // taken synchronously by sync(). Both must be processed, or changes are lost.
  const observer = new window.MutationObserver((records: MutationRecord[]) => invalidate(records));
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const layout = new WeakMap<Element, LayoutState>();
  let styleCache = new WeakMap<Element, Map<string, string | undefined>>();
  let matchCache = new WeakMap<Element, Rule[]>();
  let textCache = new WeakMap<Element, Run[]>();
  let sheetRules: Rule[] | null = null;
  let selectorAttributes = new Set<string>();
  // Properties declared by any rule; lookups of others skip selector matching
  let sheetProperties = new Set<string>();
  let ruleIndex: RuleIndex | null = null;
  // Bumped when a style sheet changes: every root then re-lays out fully
  let styleEpoch = 0;
  const layoutDirty = new WeakSet<Node>();
  const descendantDirty = new WeakSet<Node>();

  function markLayoutDirty(node: Node | null): void {
    if (!node) return;
    layoutDirty.add(node);
    // Text layout of the enclosing <text> depends on everything inside it
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    const text = el && TEXT_CONTENT.has(el.localName) ? el.closest("text") : null;
    if (text) {
      textCache.delete(text);
      layoutDirty.add(text);
    }
    for (let p = node.parentNode; p && !descendantDirty.has(p); p = p.parentNode) descendantDirty.add(p);
  }

  function forgetSubtree(el: Element): void {
    for (const e of [el, ...Array.from(el.querySelectorAll("*"))]) {
      styleCache.delete(e);
      matchCache.delete(e);
      textCache.delete(e);
      layout.delete(e);
      layoutDirty.add(e);
    }
  }

  function restyleSubtree(el: Element): void {
    for (const e of [el, ...Array.from(el.querySelectorAll("*"))]) {
      styleCache.delete(e);
      matchCache.delete(e);
      textCache.delete(e);
      layoutDirty.add(e);
    }
    markLayoutDirty(el);
  }

  // Whether a mutation record touches a <style> element (or its text)
  const isStyle = (n: Node | null) => !!n && n.nodeType === 1 && (n as Element).localName === "style";
  function touchesStyle(r: MutationRecord): boolean {
    if (isStyle(r.target) || isStyle(r.target.parentNode)) return true;
    for (const list of [r.addedNodes, r.removedNodes]) {
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        if (isStyle(n) || (n.nodeType === 1 && (n as Element).firstElementChild && (n as Element).querySelector("style"))) return true;
      }
    }
    return false;
  }

  function sync(): void {
    invalidate(observer.takeRecords());
  }

  function invalidate(records: MutationRecord[]): void {
    if (!records.length) return;
    if (records.some(touchesStyle)) {
      // A style sheet changed: everything may match differently
      styleCache = new WeakMap();
      matchCache = new WeakMap();
      textCache = new WeakMap();
      sheetRules = null;
      styleEpoch++;
    }
    for (const r of records) {
      const target = r.target;
      if (r.type === "attributes") {
        const el = target as Element;
        const name = r.attributeName!;
        if (name === "class" || name === "id" || name === "style" || selectorAttributes.has(name) || INHERITED.has(name)) restyleSubtree(el);
        else {
          styleCache.delete(el);
          markLayoutDirty(el);
        }
        // The parent's set of rendered children may change (display, switch)
        markLayoutDirty(el.parentNode);
      } else if (r.type === "characterData") {
        markLayoutDirty(target.parentNode);
      } else {
        markLayoutDirty(target);
        if (r.removedNodes.length) removedFrom.add(target);
        for (const n of Array.from(r.addedNodes) as Node[]) {
          if (n.nodeType === 1) forgetSubtree(n as Element);
          markLayoutDirty(n);
        }
      }
    }
  }
  // Containers that lost a child since their last layout
  const removedFrom = new WeakSet<Node>();

  // ---- cascade --------------------------------------------------------------

  function allRules(): Rule[] {
    if (!sheetRules) {
      sheetRules = [];
      for (const style of Array.from(document.querySelectorAll("style"))) sheetRules.push(...parseSheet(style.textContent || ""));
      // Attribute selectors make those attributes affect matching
      selectorAttributes = new Set(sheetRules.flatMap((r) => [...r.selector.matchAll(/\[\s*([\w:-]+)/g)].map((m) => m[1])));
      sheetProperties = new Set(sheetRules.flatMap((r) => [...r.declarations.keys()]));
      ruleIndex = new RuleIndex(sheetRules);
    }
    return sheetRules;
  }

  function matchedRules(el: Element): Rule[] {
    let rules = matchCache.get(el);
    if (!rules) {
      allRules();
      rules = ruleIndex!.candidates(el).filter((r) => {
        try {
          return el.matches(r.selector);
        } catch {
          return false;
        }
      });
      matchCache.set(el, rules);
    }
    return rules;
  }

  // Specified value of one property on one element (no inheritance):
  // !important inline > !important rules > inline > rules > presentation attribute
  function specified(el: Element, prop: string): string | undefined {
    let cache = styleCache.get(el);
    if (!cache) styleCache.set(el, (cache = new Map()));
    if (cache.has(prop)) return cache.get(prop);
    const inline = parseInlineStyle(el.getAttribute("style")).get(prop);
    let best: (Declaration & { rank: number }) | null = null;
    allRules();
    for (const rule of sheetProperties.has(prop) ? matchedRules(el) : []) {
      const d = rule.declarations.get(prop);
      if (!d) continue;
      const rank = rule.specificity * 1e6 + rule.order;
      if (!best || (d.important && !best.important) || (d.important === best.important && rank >= best.rank)) best = { ...d, rank };
    }
    let value: string | undefined;
    if (inline?.important) value = inline.value;
    else if (best?.important) value = best.value;
    else if (inline) value = inline.value;
    else if (best) value = best.value;
    else if (el.namespaceURI === SVG_NS && el.hasAttribute(prop)) value = el.getAttribute(prop) ?? undefined;
    value = value?.replace(/\s*!important\s*$/, "").trim();
    if (value === "inherit" || value === "") value = undefined;
    cache.set(prop, value);
    return value;
  }

  function computed(el: Element, prop: string): string {
    for (let e: Node | null = el; e && e.nodeType === 1; e = e.parentNode) {
      const v = specified(e as Element, prop);
      if (v !== undefined) return v;
      if (!INHERITED.has(prop)) break;
    }
    return INITIAL[prop] ?? "";
  }

  function parentElement(el: Element): Element | null {
    const p = el.parentNode;
    return p && p.nodeType === 1 ? (p as Element) : null;
  }

  // CSS length in px. `fontEl` supplies the font for em/ex/ch: the parent for
  // font-size itself, the element for every other property.
  function toPx(value: string, fontEl: Element | null, percentBase: () => number): number | null {
    const m = /^(-?[\d.]+(?:e[-+]?\d+)?)([a-z%]*)$/i.exec(value.trim());
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    if (!unit) return n;
    if (unit in ABSOLUTE_UNITS) return n * ABSOLUTE_UNITS[unit];
    if (unit === "%") return (n / 100) * percentBase();
    if (unit === "rem") return n * 16;
    if (unit === "vw") return (n / 100) * containerWidth;
    if (unit === "vh") return (n / 100) * viewportHeight;
    const font = fontEl ? fontOf(fontEl) : { family: INITIAL["font-family"], size: 16, weight: 400, style: "normal" };
    if (unit === "em") return n * font.size;
    if (unit === "ex") return n * fontMetrics(font).xHeight;
    if (unit === "ch") return n * measureRun("0", font).width;
    return n;
  }

  function fontSize(el: Element): number {
    for (let e: Element | null = el; e; e = parentElement(e)) {
      const v = specified(e, "font-size");
      if (v === undefined) continue;
      if (v in KEYWORD_SIZES) return KEYWORD_SIZES[v];
      const parent = parentElement(e);
      const px = toPx(v, parent, () => (parent ? fontSize(parent) : 16));
      return px === null || Number.isNaN(px) ? 16 : px;
    }
    return 16;
  }

  // Numeric font-weight; bolder/lighter resolve against the parent (CSS Fonts 4)
  function fontWeight(el: Element): number {
    for (let e: Element | null = el; e; e = parentElement(e)) {
      const v = specified(e, "font-weight");
      if (v === undefined) continue;
      if (v === "normal") return 400;
      if (v === "bold") return 700;
      if (v === "bolder" || v === "lighter") {
        const parent = parentElement(e);
        const base = parent ? fontWeight(parent) : 400;
        if (v === "bolder") return base < 350 ? 400 : base < 550 ? 700 : 900;
        return base < 550 ? 100 : base < 750 ? 400 : 700;
      }
      return Number(v) || 400;
    }
    return 400;
  }

  function fontOf(el: Element): FontSpec {
    return { family: computed(el, "font-family"), size: fontSize(el), weight: fontWeight(el), style: computed(el, "font-style") };
  }

  function length(el: Element, value: string | null, axis: "x" | "y" = "x"): number {
    if (value === null || value === "") return 0;
    const px = toPx(value, el, () => (axis === "x" ? containerWidth : viewportHeight));
    return px === null || Number.isNaN(px) ? parseFloat(value) || 0 : px;
  }

  function num(el: Element, name: string, axis: "x" | "y" = "x"): number {
    return length(el, el.getAttribute(name), axis);
  }

  // <text>/<tspan> positioning attributes are lists; Mermaid only uses the first value
  function firstLength(el: Element, name: string, axis: "x" | "y"): number | null {
    const v = el.getAttribute(name);
    if (v === null) return null;
    const first = v.trim().split(/[\s,]+/)[0];
    return first ? length(el, first, axis) : null;
  }

  // ---- text -----------------------------------------------------------------

  const fontKey = (f: FontSpec) => `${f.style}|${f.weight}|${f.size}|${f.family}`;

  // Baseline offsets measured from Chromium. text-top and text-bottom have no
  // effect, and before-/after-edge only work as alignment-baseline on a tspan.
  function baselineShift(el: Element, font: FontSpec): number {
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

  // Lays out a <text> element into positioned runs.
  //
  // Positioning attributes (x, y, dx, dy) address characters: each applies to
  // the first character inside its element, and when nested elements address
  // the same character the innermost wins. An absolute x starts a new text
  // chunk; text-anchor aligns each chunk as a whole. Whitespace follows CSS
  // white-space processing, as in Chromium (newlines become spaces).
  function layoutText(textEl: Element): Run[] {
    const runs: Run[] = [];
    const chunks: Array<{ anchor: string; runs: Run[] }> = [];
    let chunk: { anchor: string; runs: Run[] } | null = null;
    let x = 0;
    let y = 0;
    let lastSpace = true;
    let emitted = 0;
    let pending: { x?: number; y?: number; dx?: number; dy?: number; anchorEl?: Element } = {};

    const walk = (el: Element): void => {
      if (specified(el, "display") === "none") return;
      const saved = { ...pending };
      const emittedBefore = emitted;
      for (const [name, axis] of [["x", "x"], ["y", "y"], ["dx", "x"], ["dy", "y"]] as const) {
        const v = firstLength(el, name, axis);
        if (v === null) continue;
        pending[name] = v;
        if (name === "x") pending.anchorEl = el;
      }
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === 3) {
          const preserve = el.getAttribute("xml:space") === "preserve" || computed(el, "white-space") === "pre";
          let text = (child as Text).data.replace(/\r\n?|\n|\t/g, " ");
          if (!preserve) {
            text = text.replace(/ +/g, " ");
            if (lastSpace) text = text.replace(/^ /, "");
          }
          if (!text) continue;
          const positioned = pending.x !== undefined || pending.y !== undefined || pending.dx !== undefined || pending.dy !== undefined;
          if (pending.x !== undefined) {
            x = pending.x;
            chunk = { anchor: computed(pending.anchorEl!, "text-anchor"), runs: [] };
            chunks.push(chunk);
          }
          if (pending.y !== undefined) y = pending.y;
          x += pending.dx ?? 0;
          y += pending.dy ?? 0;
          pending = {};
          if (!chunk) {
            chunk = { anchor: computed(textEl, "text-anchor"), runs: [] };
            chunks.push(chunk);
          }
          lastSpace = text.endsWith(" ");
          emitted += text.length;
          const font = fontOf(el);
          const { ascent, descent } = fontMetrics(font);
          const run: Run = { x, y: y + baselineShift(el, font), text, font, fontKey: fontKey(font), owner: el as El, ascent, descent, positioned, ...measureRun(text, font) };
          runs.push(run);
          chunk.runs.push(run);
          x += run.width;
        } else if (child.nodeType === 1 && ["tspan", "a", "textPath"].includes((child as Element).localName)) {
          walk(child as Element);
        }
      }
      // Attributes on an element that contained no characters address nothing
      if (emitted === emittedBefore) pending = saved;
    };
    walk(textEl);

    // Chromium shapes across element and text-node boundaries when the font
    // and baseline are unchanged (Mermaid builds labels one word per node), so
    // kerning applies across them. Reshape each such group as one string and
    // give each run its share by prefix widths.
    for (let i = 0; i < runs.length; ) {
      let j = i + 1;
      while (j < runs.length && !runs[j].positioned && runs[j].y === runs[i].y && runs[j].fontKey === runs[i].fontKey) j++;
      if (j - i > 1) {
        const x0 = runs[i].x;
        const originalEnd = runs[j - 1].x + runs[j - 1].width;
        let prefix = "";
        let prev = 0;
        for (let k = i; k < j; k++) {
          prefix += runs[k].text;
          const total = measureRun(prefix, runs[i].font).width;
          const overhang = runs[k].inkRight - runs[k].width;
          runs[k].x = x0 + prev;
          runs[k].width = total - prev;
          runs[k].inkRight = runs[k].width + overhang;
          prev = total;
        }
        const delta = x0 + prev - originalEnd;
        for (let k = j; k < runs.length && !runs[k].positioned; k++) runs[k].x += delta;
      }
      i = j;
    }

    // A trailing collapsible space takes no room
    const last = runs[runs.length - 1];
    if (last?.text.endsWith(" ") && computed(textEl, "white-space") !== "pre") {
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

  function runsOf(el: Element): Run[] {
    const textEl = el.localName === "text" ? el : el.closest("text");
    if (!textEl) return [];
    let runs = textCache.get(textEl);
    if (!runs) {
      runs = layoutText(textEl);
      textCache.set(textEl, runs);
    }
    return el === textEl ? runs : runs.filter((r) => el.contains(r.owner));
  }

  // Chromium's text box is the union of the font box (rounded ascent/descent,
  // advance width) and the glyphs' actual ink
  function textBox(el: Element): Rect | null {
    let box: Rect | null = null;
    for (const r of runsOf(el)) {
      const left = r.x + Math.min(0, r.inkLeft);
      const right = r.x + Math.max(r.width, r.inkRight);
      const top = r.y - Math.max(r.ascent, r.inkAscent);
      const bottom = r.y + Math.max(r.descent, r.inkDescent);
      box = union(box, { x: left, y: top, width: right - left, height: bottom - top });
    }
    return box;
  }

  // ---- shapes ---------------------------------------------------------------

  // Box in the element's own user space (its transform excluded). null means
  // "no geometry": Blink skips empty shapes (zero-size rects, paths without
  // segments, text without glyphs) but counts degenerate ones (a lone point).
  function ownBox(el: Element): Rect | null {
    const tag = el.localName;
    if (NON_RENDERED.has(tag)) return null;
    switch (tag) {
      case "rect":
      case "image":
      case "foreignObject": {
        const w = num(el, "width", "x");
        const h = num(el, "height", "y");
        return w > 0 && h > 0 ? { x: num(el, "x", "x"), y: num(el, "y", "y"), width: w, height: h } : null;
      }
      case "circle": {
        const r = num(el, "r");
        return r > 0 ? { x: num(el, "cx", "x") - r, y: num(el, "cy", "y") - r, width: 2 * r, height: 2 * r } : null;
      }
      case "ellipse": {
        const rx = num(el, "rx", "x");
        const ry = num(el, "ry", "y");
        return rx > 0 && ry > 0 ? { x: num(el, "cx", "x") - rx, y: num(el, "cy", "y") - ry, width: 2 * rx, height: 2 * ry } : null;
      }
      case "line":
        return pointsRect([[num(el, "x1", "x"), num(el, "y1", "y")], [num(el, "x2", "x"), num(el, "y2", "y")]]);
      case "polyline":
      case "polygon": {
        const n = (el.getAttribute("points") || "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
        const pts: Array<[number, number]> = [];
        for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
        return pointsRect(pts);
      }
      case "path": {
        const d = el.getAttribute("d");
        if (!d?.trim()) return null;
        try {
          const [x0, y0, x1, y1] = svgPathBbox(d);
          return [x0, y0, x1, y1].every(Number.isFinite) ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
        } catch {
          return null;
        }
      }
      case "text":
      case "tspan":
      case "textPath": {
        // A <text> without glyphs but with child elements still has a
        // zero-size box at its origin
        const box = textBox(el);
        return !box && tag === "text" && el.firstElementChild ? { ...ZERO_RECT } : box;
      }
      case "use": {
        if (el.hasAttribute("width") && el.hasAttribute("height")) {
          return { x: num(el, "x", "x"), y: num(el, "y", "y"), width: num(el, "width", "x"), height: num(el, "height", "y") };
        }
        const href = el.getAttribute("href") || el.getAttribute("xlink:href");
        const target = href?.startsWith("#") ? document.getElementById(href.slice(1)) : null;
        const inner = target ? staticContainerBox(target) : null;
        return inner && transformRect(inner, Matrix.translate(num(el, "x", "x"), num(el, "y", "y")));
      }
      default:
        // Containers report the box their last layout computed; a nested
        // <svg> reports it in its own viewBox units
        return layoutBox(el);
    }
  }

  // <switch> renders only its first child whose conditions pass
  function switchChoice(sw: Element): Element | null {
    for (let child = sw.firstElementChild; child; child = child.nextElementSibling) {
      if (child.namespaceURI !== SVG_NS) continue;
      if (child.getAttribute("requiredExtensions")?.trim()) continue;
      const lang = child.getAttribute("systemLanguage");
      if (lang !== null && !lang.split(",").some((l) => /^en\b/i.test(l.trim()))) continue;
      return child;
    }
    return null;
  }

  // Outside the render tree (display:none, unchosen <switch> branches,
  // resources) there is no geometry, and getBBox reports zeros
  function rendered(el: Element): boolean {
    for (let e: Element | null = el; e && e.namespaceURI === SVG_NS; e = parentElement(e)) {
      if (specified(e, "display") === "none") return false;
      if (e !== el && NON_RENDERED.has(e.localName)) return false;
      const parent = parentElement(e);
      if (parent?.localName === "switch" && switchChoice(parent) !== e) return false;
    }
    return true;
  }

  function localTransform(el: Element): Matrix {
    if (el.localName === "svg" && parentElement(el)?.namespaceURI === SVG_NS) return viewportTransform(el);
    const css = parseInlineStyle(el.getAttribute("style")).get("transform")?.value;
    return parseTransform(css && css !== "none" ? css : el.getAttribute("transform"));
  }

  // x/y offset plus the viewBox-to-viewport mapping of a nested <svg>
  function viewportTransform(el: Element): Matrix {
    const w = el.hasAttribute("width") ? num(el, "width", "x") : containerWidth;
    const h = el.hasAttribute("height") ? num(el, "height", "y") : viewportHeight;
    const m = Matrix.translate(num(el, "x", "x"), num(el, "y", "y"));
    const vb = (el.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    if (vb.length !== 4 || vb.some(Number.isNaN) || vb[2] <= 0 || vb[3] <= 0) return m;
    const [vx, vy, vw, vh] = vb;
    const [align, meetOrSlice] = (el.getAttribute("preserveAspectRatio") || "xMidYMid meet").trim().split(/\s+/);
    if (align === "none") return m.multiply(new Matrix(w / vw, 0, 0, h / vh, (-vx * w) / vw, (-vy * h) / vh));
    const s = meetOrSlice === "slice" ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh);
    const fx = /xMid/.test(align) ? 0.5 : /xMax/.test(align) ? 1 : 0;
    const fy = /YMid/.test(align) ? 0.5 : /YMax/.test(align) ? 1 : 0;
    return m.multiply(new Matrix(s, 0, 0, s, -vx * s + (w - vw * s) * fx, -vy * s + (h - vh * s) * fy));
  }

  // Transform from an element's user space to the outermost <svg>'s
  function ctm(el: Element): Matrix {
    let m = new Matrix();
    for (let e: Element | null = el; e && e.namespaceURI === SVG_NS; e = parentElement(e)) {
      if (e.localName === "svg" && parentElement(e)?.namespaceURI !== SVG_NS) break;
      m = localTransform(e).multiply(m);
    }
    return m;
  }

  // ---- incremental layout -----------------------------------------------------
  //
  // Blink keeps a layout object per rendered element, and a container
  // recomputes its box only when a child reports that its bounds changed, or a
  // child went away (SVGContentContainer::Layout / UpdateBoundingBoxes). A
  // leaf reports a change on its first layout and whenever its box or
  // transform moves; a container only when its recomputed box or transform
  // moves. So a container whose content never "changed" (an empty label at the
  // origin, inside an untransformed group) is never marked valid and doesn't
  // count toward its ancestors' getBBox. That makes getBBox depend on layout
  // history, so we replay the history: each geometry query after a DOM change
  // is a layout pass, and per-element state persists between passes.

  const roots = new WeakMap<Element, number>(); // root <svg> -> style epoch of its last pass

  function kindOf(el: Element): "shape" | "text" | "leaf" | "container" | "hidden" | null {
    if (el.namespaceURI !== SVG_NS) return null;
    const tag = el.localName;
    if (SHAPES.has(tag)) return "shape";
    if (tag === "text") return "text";
    if (tag === "image" || tag === "foreignObject" || tag === "use") return "leaf";
    if (CONTAINERS.has(tag)) return "container";
    if (NON_RENDERED.has(tag)) return "hidden";
    return null;
  }

  function renderedChildren(el: Element): Element[] {
    const only = el.localName === "switch" ? switchChoice(el) : null;
    const out: Element[] = [];
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      if ((!only || c === only) && kindOf(c) && specified(c, "display") !== "none") out.push(c);
    }
    return out;
  }

  // Lays out one element; returns Blink's SVGLayoutResult::bounds_changed.
  // Clean subtrees are skipped: nothing in them changed, so nothing reports.
  function layoutNode(el: Element, isNew: boolean, full: boolean): boolean {
    const kind = kindOf(el);
    let old = layout.get(el);
    // A layout object that is new (inserted, moved, or shown again) starts from
    // scratch, and so does everything under it: Blink rebuilds the subtree
    if (isNew || old?.parent !== el.parentNode) old = undefined;
    const selfDirty = full || !old || layoutDirty.has(el);
    const belowDirty = full || !old || descendantDirty.has(el);
    layoutDirty.delete(el);
    descendantDirty.delete(el);
    if (!selfDirty && !belowDirty) return false;
    let box: Rect;
    let valid: boolean;
    let kids: Element[] | undefined;
    if (kind === "container" || kind === "hidden") {
      kids = selfDirty || !old?.kids ? renderedChildren(el) : old.kids;
      const now = new Set(kids);
      const before = new Set(old?.kids ?? []);
      let childChanged = removedFrom.has(el) || (old?.kids ?? []).some((k) => !now.has(k));
      removedFrom.delete(el);
      for (const c of kids) if (layoutNode(c, !old || !before.has(c as El), full)) childChanged = true;
      if (childChanged) {
        let acc: Rect | null = null;
        for (const c of kids) {
          const cs = layout.get(c);
          if (!cs?.valid || kindOf(c) === "hidden") continue;
          acc = union(acc, transformRect(cs.box, localTransform(c)));
        }
        valid = acc !== null && kind !== "hidden";
        box = acc ?? { ...ZERO_RECT };
      } else {
        box = old?.box ?? { ...ZERO_RECT };
        valid = (old?.valid ?? false) && kind !== "hidden";
      }
    } else {
      const own = ownBox(el);
      valid = kind === "text" ? !!own || !!el.firstElementChild : !!own;
      box = own ?? { ...ZERO_RECT };
    }
    const transform = localTransform(el).key();
    const isLeaf = kind !== "container" && kind !== "hidden";
    const changed = (isLeaf && !old) || !rectEquals(box, old?.box ?? ZERO_RECT) || transform !== (old?.transform ?? "");
    layout.set(el, { box, valid, transform, parent: el.parentNode, kids: kids as El[] | undefined });
    return changed;
  }

  function outermostSvg(el: Element): Element | null {
    let root: Element | null = null;
    for (let e: Element | null = el; e && e.namespaceURI === SVG_NS; e = parentElement(e)) if (e.localName === "svg") root = e;
    return root;
  }

  // Brings the layout of the <svg> tree containing `el` up to date, walking
  // only dirty paths
  function flush(el: Element): Element | null {
    const root = outermostSvg(el);
    if (!root?.isConnected) return null;
    const full = roots.get(root) !== styleEpoch;
    if (full || layoutDirty.has(root) || descendantDirty.has(root) || !layout.has(root)) {
      roots.set(root, styleEpoch);
      layoutNode(root, false, full);
    }
    return root;
  }

  function layoutBox(el: Element): Rect | null {
    return flush(el) ? (layout.get(el)?.box ?? null) : null;
  }

  // Union of children without layout history, for content that has no layout
  // objects of its own (the target of a <use>)
  function staticContainerBox(el: Element): Rect | null {
    let box: Rect | null = null;
    for (const child of renderedChildren(el)) {
      const b = kindOf(child) === "container" ? staticContainerBox(child) : ownBox(child);
      if (b) box = union(box, transformRect(b, localTransform(child)));
    }
    return box;
  }

  // ---- installation on jsdom's prototypes -------------------------------------

  const svgProto = window.SVGElement.prototype;

  // An SVGRect has only x/y/width/height; Mermaid relies on `left` being absent
  svgProto.getBBox = function (this: Element) {
    sync();
    flush(this);
    const b = (rendered(this) && ownBox(this)) || ZERO_RECT;
    return { x: f32(b.x), y: f32(b.y), width: f32(b.width), height: f32(b.height) };
  };
  svgProto.getComputedTextLength = function (this: Element) {
    sync();
    return f32(runsOf(this).reduce((s, r) => s + r.width, 0));
  };
  svgProto.getSubStringLength = function (this: Element, start: number, count: number) {
    sync();
    return f32(measureRun((this.textContent || "").substr(start, count), fontOf(this)).width);
  };
  svgProto.getNumberOfChars = function (this: Element) {
    return (this.textContent || "").length;
  };

  function geometryPath(el: Element): string {
    switch (el.localName) {
      case "path":
        return el.getAttribute("d") || "";
      case "line":
        return `M${num(el, "x1")},${num(el, "y1", "y")}L${num(el, "x2")},${num(el, "y2", "y")}`;
      case "rect": {
        const x = num(el, "x"), y = num(el, "y", "y"), w = num(el, "width"), h = num(el, "height", "y");
        return `M${x},${y}h${w}v${h}h${-w}Z`;
      }
      case "polyline":
      case "polygon":
        return `M${(el.getAttribute("points") || "").trim()}${el.localName === "polygon" ? "Z" : ""}`;
      case "circle": {
        const r = num(el, "r"), cx = num(el, "cx"), cy = num(el, "cy", "y");
        return `M${cx - r},${cy}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;
      }
      default:
        return "";
    }
  }
  svgProto.getTotalLength = function (this: Element) {
    try {
      return f32(new svgPathProperties(geometryPath(this)).getTotalLength());
    } catch {
      return 0;
    }
  };
  svgProto.getPointAtLength = function (this: Element, len: number) {
    try {
      const p = new svgPathProperties(geometryPath(this)).getPointAtLength(len);
      return { x: f32(p.x), y: f32(p.y) };
    } catch {
      return { x: 0, y: 0 };
    }
  };
  svgProto.getCTM = function (this: Element) {
    sync();
    return ctm(this);
  };
  svgProto.getScreenCTM = svgProto.getCTM;

  const htmlRect = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.namespaceURI !== SVG_NS) return htmlRect.call(this);
    sync();
    flush(this);
    const own = rendered(this) ? ownBox(this) : null;
    const b = own ? transformRect(own, ctm(this)) : ZERO_RECT;
    return { x: b.x, y: b.y, width: b.width, height: b.height, top: b.y, left: b.x, right: b.x + b.width, bottom: b.y + b.height };
  };

  // Block-level HTML containers take the full layout width; anything hidden
  // with display:none (or detached) has no box
  const BLOCK = new Set(["div", "body", "html", "section", "main", "pre"]);
  const hidden = (el: Element): boolean => {
    if (!el.isConnected) return true;
    for (let e: Element | null = el; e; e = parentElement(e)) if (specified(e, "display") === "none") return true;
    return false;
  };
  for (const [prop, size] of [["offsetWidth", containerWidth], ["clientWidth", containerWidth], ["offsetHeight", 0], ["clientHeight", 0]] as const) {
    Object.defineProperty(window.HTMLElement.prototype, prop, {
      configurable: true,
      get(this: Element) {
        sync();
        return BLOCK.has(this.localName) && !hidden(this) ? size : 0;
      },
    });
  }

  // getComputedStyle answers font and box properties from our cascade
  const nativeComputed = window.getComputedStyle.bind(window);
  const kebab = (p: string) => p.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  window.getComputedStyle = function (el: Element, pseudo?: string) {
    sync();
    // jsdom's own cascade is slow; it is only consulted for properties we
    // don't model
    let native: CSSStyleDeclaration | null = null;
    const nativeStyle = () => (native ??= nativeComputed(el, pseudo) as CSSStyleDeclaration);
    const resolve = (name: string): string => {
      if (name === "font-size") return `${fontSize(el)}px`;
      if (name === "font-weight") return String(fontWeight(el));
      // Browsers resolve box lengths to "0px", never ""
      if (/^(padding|margin|border)(-(top|right|bottom|left))?(-width)?$/.test(name)) return nativeStyle().getPropertyValue(name) || "0px";
      if (name in INITIAL) return computed(el, name);
      return nativeStyle().getPropertyValue(name);
    };
    const declProto = window.CSSStyleDeclaration.prototype;
    return new Proxy({} as CSSStyleDeclaration, {
      get(_target, prop) {
        if (prop === "getPropertyValue") return resolve;
        if (typeof prop === "string" && /^[a-z]/.test(prop)) {
          const name = kebab(prop);
          // Properties we model answer from our cascade in either spelling
          if (name in INITIAL || name === "font-size" || name === "font-weight" || !(prop in declProto)) return resolve(name);
        }
        const n = nativeStyle();
        const v = Reflect.get(n, prop, n);
        return typeof v === "function" ? v.bind(n) : v;
      },
      getPrototypeOf: () => declProto,
    });
  };

  // Canvas 2D: diagrams only measure text with it (cytoscape also paints into
  // it, which nobody sees), so measurement is real and drawing does nothing
  window.HTMLCanvasElement.prototype.getContext = function (this: any, type: string) {
    if (type !== "2d") return null;
    this.__measuringContext ??= measuringContext();
    return this.__measuringContext;
  };

  return {
    window,
    document,
    specified: (el, prop) => {
      sync();
      return specified(el, prop);
    },
    computed: (el, prop) => {
      sync();
      return computed(el, prop);
    },
    fontOf: (el) => {
      sync();
      return fontOf(el);
    },
  };
}

// A CanvasRenderingContext2D whose measureText is real (Skia) and whose
// drawing calls do nothing
function measuringContext(): unknown {
  const ctx = createCanvas(1, 1).getContext("2d");
  const state: Record<string | symbol, unknown> = { font: "10px sans-serif" };
  const noop: any = new Proxy(function () {}, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => "" : noop),
    apply: () => noop,
  });
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "measureText") {
          return (text: unknown) => {
            ctx.font = String(state.font);
            return ctx.measureText(String(text));
          };
        }
        if (prop === "canvas") return undefined;
        if (prop in state) return state[prop];
        if (prop === "getImageData") return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h });
        return noop;
      },
      set(_t, prop, value) {
        state[prop] = value;
        return true;
      },
    }
  );
}

// Exposes a window's globals the way a browser would, without replacing
// anything Node already defines. Only call this in an isolated context (the
// render worker): libraries change behaviour when they see `window`.
export function installGlobals(window: any): void {
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis || key.startsWith("_")) continue;
    let value: unknown;
    try {
      value = window[key];
    } catch {
      continue;
    }
    Object.defineProperty(globalThis, key, {
      value: typeof value === "function" && !/^[A-Z]/.test(key) ? (value as Function).bind(window) : value,
      configurable: true,
      writable: true,
    });
  }
  for (const key of ["window", "self", "document", "navigator", "getComputedStyle"]) {
    const value = key === "window" || key === "self" ? window : window[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  window.CSSStyleSheet.prototype.replaceSync ??= function () {};
}
