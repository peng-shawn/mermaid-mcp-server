// SVG to PNG without a browser, via resvg (Rust).
import { Resvg } from "@resvg/resvg-js";
import { createCanvas, ImageData } from "@napi-rs/canvas";
import { resolvedFontFiles } from "./fonts.js";

export interface RasterOptions {
  scale: number;
  background?: string;
  // Load every system font (slow, ~300ms): only needed when some text uses
  // glyphs outside the faces the measurement resolved
  systemFonts?: boolean;
}

export interface Png {
  data: Buffer;
  width: number;
  height: number;
}

function render(svg: string, { scale, background, systemFonts = false }: RasterOptions) {
  return new Resvg(svg, {
    fitTo: { mode: "zoom", value: scale },
    background: background && background !== "transparent" ? background : undefined,
    font: { loadSystemFonts: systemFonts, fontFiles: resolvedFontFiles(), defaultFontFamily: "DejaVu Sans" },
    shapeRendering: 2, // geometricPrecision
    textRendering: 1, // optimizeLegibility
  }).render();
}

// `svg` must be flattened (flattenSvg): resvg's CSS support is partial and it
// matches font families case-sensitively, both of which flattening handles
export function rasterize(svg: string, options: RasterOptions): Png {
  const image = render(svg, options);
  return { data: Buffer.from(image.asPng()), width: image.width, height: image.height };
}

// Renders once and cuts the result into tiles along one axis (in output
// pixels). Tiling in pixel space rather than by cropping the viewBox: resvg
// panics on some cropped viewBoxes, and a panic aborts the whole process.
export function rasterizeTiles(svg: string, options: RasterOptions, axis: "vertical" | "horizontal", tileLength: number, overlap: number): Png[] {
  const image = render(svg, options);
  const { width, height } = image;
  const pixels = image.pixels;
  const total = axis === "vertical" ? height : width;
  // Fewest tiles that fit, all the same length, rather than a sliver at the end
  const count = Math.max(1, Math.ceil((total - overlap) / (tileLength - overlap)));
  const step = Math.ceil((total - overlap) / count);
  const tiles: Png[] = [];
  for (let start = 0; start < total; start += step) {
    const len = Math.min(step + overlap, total - start);
    const w = axis === "vertical" ? width : len;
    const h = axis === "vertical" ? len : height;
    const x0 = axis === "vertical" ? 0 : start;
    const y0 = axis === "vertical" ? start : 0;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      const from = ((y0 + row) * width + x0) * 4;
      rgba.set(pixels.subarray(from, from + w * 4), row * w * 4);
    }
    const canvas = createCanvas(w, h);
    canvas.getContext("2d").putImageData(new ImageData(rgba, w, h), 0, 0);
    tiles.push({ data: canvas.toBuffer("image/png"), width: w, height: h });
    if (start + len >= total) break;
  }
  return tiles;
}
