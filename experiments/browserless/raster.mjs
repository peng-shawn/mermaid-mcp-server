// SVG to PNG without a browser, via resvg (Rust).
import { Resvg } from "@resvg/resvg-js";

// Mermaid emits width="100%" plus a viewBox; give the root a concrete size so
// the rasterizer has a viewport, and scale with `scale`.
export function normalizeRoot(svg) {
  const m = /<svg\b[^>]*>/.exec(svg);
  if (!m) return svg;
  const tag = m[0];
  const vb = /viewBox="([^"]+)"/.exec(tag)?.[1].trim().split(/[\s,]+/).map(Number);
  if (!vb || vb.length !== 4) return svg;
  let fixed = tag
    .replace(/\swidth="[^"]*"/, "")
    .replace(/\sheight="[^"]*"/, "")
    .replace(/\sstyle="[^"]*"/, "")
    .replace(/^<svg/, `<svg width="${vb[2]}" height="${vb[3]}"`);
  return svg.slice(0, m.index) + fixed + svg.slice(m.index + tag.length);
}

export function toPng(svg, { scale = 2, background = "white", fontFiles = [], loadSystemFonts = true, defaultFontFamily } = {}) {
  const r = new Resvg(normalizeRoot(svg), {
    fitTo: { mode: "zoom", value: scale },
    background,
    font: { loadSystemFonts, fontFiles, ...(defaultFontFamily ? { defaultFontFamily } : {}) },
    shapeRendering: 2,
    textRendering: 1,
  });
  const img = r.render();
  return { png: img.asPng(), width: img.width, height: img.height };
}
