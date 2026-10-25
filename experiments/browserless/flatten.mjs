// Flattens Mermaid's CSS into SVG presentation attributes.
//
// Mermaid styles diagrams with a <style> block of id/class selectors, CSS
// custom properties, !important and inline style attributes. Browsers handle
// that; most other SVG consumers (resvg, Inkscape, PowerPoint, Figma import,
// image previews) handle only part of it. Resolving the cascade once, here,
// and writing the winning value of each property as an attribute produces an
// SVG that renders the same everywhere.
import { GlobalFonts } from "@napi-rs/canvas";
import { createDom, parseInlineStyle } from "./dom.mjs";

// Properties that SVG accepts as presentation attributes
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
const COLOR_PROPS = ["fill", "stroke", "stop-color", "flood-color", "lighting-color"];
const WEIGHTS = { normal: 400, bold: 700 };
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);

// CSS matches font families case-insensitively (and so does the Skia
// measurement), but resvg matches exactly. Rewrite each family to the exact
// installed name so the renderer draws with the font we measured.
let familyIndex;
function canonicalFamily(name) {
  familyIndex ??= new Map(GlobalFonts.families.map((f) => [f.family.toLowerCase(), f.family]));
  const bare = name.trim().replace(/^["']|["']$/g, "");
  if (GENERIC.has(bare.toLowerCase())) return bare.toLowerCase();
  const real = familyIndex.get(bare.toLowerCase()) ?? bare;
  return /[^\w-]/.test(real) ? `"${real}"` : real;
}
function canonicalFamilies(value) {
  return value.split(",").map(canonicalFamily).join(", ");
}

let shared;
function env() {
  shared ??= createDom();
  return shared;
}

export function flattenSvg(svg) {
  const { document, cascade } = env();
  const host = document.createElement("div");
  host.innerHTML = svg;
  document.body.appendChild(host);
  try {
    cascade.fresh();
    const root = host.querySelector("svg");
    const sheetProps = collectSheetProperties(root);
    const elements = [root, ...root.querySelectorAll("*")];

    // Resolve everything first, then write, so writes cannot feed back into the cascade
    const writes = [];
    for (const el of elements) {
      if (el.localName === "style") continue;
      const props = new Set(sheetProps);
      const inline = parseInlineStyle(el.getAttribute("style") || "");
      for (const name of inline.keys()) props.add(name);
      const out = {};
      for (const prop of props) {
        if (!PRESENTATION.has(prop)) continue;
        let v = cascade.specified(el, prop);
        if (v === undefined || v === "") continue;
        v = resolveVars(cascade, el, v);
        if (prop === "font-weight") v = resolveWeight(cascade, el, v);
        if (prop === "font-family") v = canonicalFamilies(v);
        if (COLOR_PROPS.includes(prop) && /currentcolor/i.test(v)) v = resolveVars(cascade, el, String(cascade.computed(el, "color") ?? "black"));
        if (prop === "transform" && el.hasAttribute("transform") && !inline.has("transform")) continue;
        out[prop] = v;
      }
      writes.push([el, out]);
    }
    for (const [el, out] of writes) {
      // Browsers ignore empty presentation attributes (font-weight=""); other
      // renderers may not, so drop them
      for (const attr of [...el.attributes]) if (PRESENTATION.has(attr.name) && attr.value.trim() === "") el.removeAttribute(attr.name);
      for (const [prop, v] of Object.entries(out)) el.setAttribute(prop, v);
      el.removeAttribute("style");
    }
    for (const style of root.querySelectorAll("style")) style.remove();
    return host.innerHTML;
  } finally {
    host.remove();
  }
}

// Every property any rule in the document's sheets declares
function collectSheetProperties(root) {
  const props = new Set();
  for (const style of root.querySelectorAll("style")) {
    for (const [, name] of (style.textContent || "").matchAll(/([a-z-]+)\s*:/g)) props.add(name);
  }
  return props;
}

function customProperty(cascade, el, name) {
  for (let e = el; e && e.nodeType === 1; e = e.parentNode) {
    const v = cascade.specified(e, name);
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

function resolveVars(cascade, el, value, depth = 0) {
  if (!value.includes("var(") || depth > 8) return value;
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, name, fallback) => {
    const v = customProperty(cascade, el, name) ?? fallback ?? "";
    return resolveVars(cascade, el, v.trim(), depth + 1);
  });
}

// bolder/lighter are relative to the parent's weight (CSS Fonts 4 table)
function resolveWeight(cascade, el, v) {
  if (v !== "bolder" && v !== "lighter") return v;
  const parent = el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null;
  let base = parent ? cascade.computed(parent, "font-weight") : "normal";
  base = WEIGHTS[base] ?? (Number(base) || 400);
  if (v === "bolder") return String(base < 350 ? 400 : base < 550 ? 700 : 900);
  return String(base < 550 ? 100 : base < 750 ? 400 : 700);
}
