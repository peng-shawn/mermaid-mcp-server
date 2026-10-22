// Flattens Mermaid's CSS into SVG presentation attributes.
//
// Mermaid styles diagrams with a <style> block of id/class selectors, CSS
// custom properties, !important and inline style attributes. Browsers handle
// all of it; most other SVG consumers (resvg, Inkscape, PowerPoint, Figma
// import, image previews) handle only part. Resolving the cascade once, with
// the same engine that measured the text, and writing the winning value of
// each property as an attribute gives an SVG that renders the same anywhere.
import type { GeometryDom } from "./dom.js";
import { parseInlineStyle } from "./css.js";
import { parseColor } from "./color.js";
import { concreteFamily } from "./fonts.js";

// Properties SVG accepts as presentation attributes
const PRESENTATION = new Set([
  "alignment-baseline", "baseline-shift", "clip-path", "clip-rule", "color", "color-interpolation",
  "color-interpolation-filters", "direction", "display", "dominant-baseline", "fill", "fill-opacity",
  "fill-rule", "filter", "flood-color", "flood-opacity", "font-family", "font-size", "font-size-adjust",
  "font-stretch", "font-style", "font-variant", "font-weight", "image-rendering", "letter-spacing",
  "lighting-color", "marker-end", "marker-mid", "marker-start", "mask", "opacity", "overflow",
  "paint-order", "pointer-events", "shape-rendering", "stop-color", "stop-opacity", "stroke",
  "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit",
  "stroke-opacity", "stroke-width", "text-anchor", "text-decoration", "text-rendering", "transform",
  "unicode-bidi", "vector-effect", "visibility", "word-spacing", "writing-mode", "mix-blend-mode",
]);
const COLOR_PROPS = new Set(["fill", "stroke", "stop-color", "flood-color", "lighting-color"]);
// Where a color's alpha goes once the color itself is written as #rrggbb
const OPACITY_OF: Record<string, string> = { fill: "fill-opacity", stroke: "stroke-opacity", "stop-color": "stop-opacity", "flood-color": "flood-opacity" };

// SVG element names with capitals. HTML parsers restore them from a table,
// and jsdom's table lacks some (feDropShadow), leaving lowercase names that
// SVG renderers ignore; an unknown filter primitive then hides the element.
const SVG_NAMES = [
  "altGlyph", "altGlyphDef", "altGlyphItem", "animateColor", "animateMotion", "animateTransform", "clipPath",
  "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting",
  "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR",
  "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight",
  "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence", "foreignObject", "glyphRef", "linearGradient",
  "radialGradient", "textPath",
];
const CANONICAL = new Map(SVG_NAMES.map((n) => [n.toLowerCase(), n]));
const LOWERCASE_TAG = new RegExp(`<(/?)(${SVG_NAMES.map((n) => n.toLowerCase()).join("|")})(?=[\\s/>])`, "g");

// XML serialization (HTML serialization emits entities like &nbsp; that XML
// doesn't define) with canonical SVG element names
export function serializeSvg(dom: GeometryDom, root: Element): string {
  return new dom.window.XMLSerializer().serializeToString(root).replace(LOWERCASE_TAG, (_m: string, slash: string, name: string) => `<${slash}${CANONICAL.get(name)}`);
}

export interface FlattenOptions {
  // Background painted behind the diagram; omitted or "transparent" for none
  background?: string;
}

export interface FlattenResult {
  svg: string;
  width: number;
  height: number;
  viewBox: { x: number; y: number; width: number; height: number };
}

export function flattenSvg(dom: GeometryDom, markup: string, options: FlattenOptions = {}): FlattenResult {
  const { document } = dom;
  const host = document.createElement("div");
  host.innerHTML = markup;
  document.body.appendChild(host);
  try {
    const root = host.querySelector("svg");
    if (!root) throw new Error("Renderer produced no <svg> element");
    const sheetProps = declaredProperties(root);

    // Resolve everything, then write, so writes can't feed back into the cascade
    const writes: Array<[Element, Map<string, string>]> = [];
    for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
      if (el.localName === "style") continue;
      const inline = parseInlineStyle(el.getAttribute("style"));
      const out = new Map<string, string>();
      for (const prop of new Set([...sheetProps, ...inline.keys()])) {
        if (!PRESENTATION.has(prop)) continue;
        // Custom properties are already substituted by the cascade
        let v = dom.specified(el, prop);
        if (v === undefined) continue;
        if (prop === "font-weight") v = String(dom.fontOf(el).weight);
        else if (prop === "font-family") {
          const font = dom.fontOf(el);
          v = `"${concreteFamily(v, font.weight, font.style)}", ${v}`;
        } else if (COLOR_PROPS.has(prop) && /currentcolor/i.test(v)) v = dom.computed(el, "color") || "black";
        // A CSS transform from a sheet would override the attribute Mermaid
        // positions elements with; only inline CSS transforms win
        if (prop === "transform" && !inline.has("transform")) continue;
        out.set(prop, v);
      }
      // The root names its font even when no rule does: other renderers'
      // defaults differ from the browser default the text was measured with
      if (el === root && !out.has("font-family")) {
        const font = dom.fontOf(el);
        out.set("font-family", `"${concreteFamily(font.family, font.weight, font.style)}", ${font.family}`);
      }
      writes.push([el, out]);
    }
    // Colors as #rrggbb plus opacity: the form every consumer parses
    for (const [el, out] of writes) {
      for (const prop of Object.keys(OPACITY_OF).concat("lighting-color")) {
        const raw = out.get(prop) ?? (out.has(prop) ? undefined : el.getAttribute(prop) ?? undefined);
        const c = raw ? parseColor(raw) : null;
        if (!c) continue;
        out.set(prop, c.hex);
        const op = OPACITY_OF[prop];
        if (op && c.alpha < 1) {
          const existing = parseFloat(out.get(op) ?? el.getAttribute(op) ?? "1");
          out.set(op, String(+((Number.isFinite(existing) ? existing : 1) * c.alpha).toFixed(4)));
        }
      }
    }
    for (const [el, out] of writes) {
      // Browsers ignore empty presentation attributes (font-weight=""); other
      // renderers may not
      for (const attr of Array.from(el.attributes)) if (PRESENTATION.has(attr.name) && !attr.value.trim()) el.removeAttribute(attr.name);
      for (const [prop, v] of out) el.setAttribute(prop, v);
      el.removeAttribute("style");
    }
    for (const style of Array.from(root.querySelectorAll("style"))) style.remove();

    // Give the root a concrete size (Mermaid emits width="100%" and a
    // max-width style, which only mean something inside a web page)
    const [vx, vy, vw, vh] = (root.getAttribute("viewBox") || "0 0 0 0").trim().split(/[\s,]+/).map(Number);
    const width = Math.max(1, Math.ceil(vw || 0));
    const height = Math.max(1, Math.ceil(vh || 0));
    root.setAttribute("width", String(width));
    root.setAttribute("height", String(height));
    if (options.background && options.background !== "transparent") {
      const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      for (const [k, v] of Object.entries({ x: vx || 0, y: vy || 0, width: vw || width, height: vh || height, fill: options.background })) bg.setAttribute(k, String(v));
      root.insertBefore(bg, root.firstChild);
    }
    const svg = serializeSvg(dom, root);
    return { svg, width, height, viewBox: { x: vx || 0, y: vy || 0, width: vw || width, height: vh || height } };
  } finally {
    host.remove();
  }
}

// Every property any rule in the document's sheets declares
function declaredProperties(root: Element): Set<string> {
  const props = new Set<string>();
  for (const style of Array.from(root.querySelectorAll("style"))) {
    for (const [, name] of (style.textContent || "").matchAll(/([a-z-]+)\s*:/g)) props.add(name);
  }
  return props;
}
