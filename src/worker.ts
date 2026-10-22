// Render process. Owns the jsdom window and Mermaid, whose browser globals
// must not leak into the server, and the native rasterizer, whose crashes
// (a Rust panic aborts the process) must not take the server down.
import { flattenSvg, type FlattenResult } from "./engine/flatten.js";
import { takeFallbackSeen, warmFonts } from "./engine/fonts.js";
import { MermaidEngine, MermaidSyntaxError } from "./engine/mermaid.js";
import { rasterize, rasterizeTiles } from "./engine/raster.js";
import type { PngImage, RenderJob, RenderOutput, Request, Response, Validation } from "./protocol.js";

if (!process.send) throw new Error("worker.js must be started by the server (child_process.fork)");
const send = (msg: Response) => process.send!(msg);

// Below this scale, 16px labels drop under ~10px and become hard to read
const LEGIBLE_SCALE = 0.6;
const MAX_TILES = 6;
// CSS px repeated between tiles so a label on a boundary is whole in one tile
const TILE_OVERLAP = 16;

async function render(engine: MermaidEngine, job: RenderJob): Promise<RenderOutput> {
  const warnings: string[] = [];
  const t0 = performance.now();
  takeFallbackSeen();
  const { svg: raw, diagramType } = await engine.render(job.code, { theme: job.theme, look: job.look });
  const t1 = performance.now();
  const flat = flattenSvg(engine.dom, raw, { background: job.background });
  const systemFonts = takeFallbackSeen();
  const t2 = performance.now();
  if (flat.svg.includes("<foreignObject")) warnings.push("This diagram uses HTML content (<foreignObject>); outside browsers, that content is not drawn.");
  const out: RenderOutput = { diagramType, svg: flat.svg, width: flat.width, height: flat.height, warnings, timings: { renderMs: t1 - t0, flattenMs: t2 - t1, rasterMs: 0 } };
  if (job.format === "png") {
    Object.assign(out, rasterizeJob(flat, job, systemFonts, warnings));
    out.timings.rasterMs = performance.now() - t2;
  }
  return out;
}

function rasterizeJob(flat: FlattenResult, job: RenderJob, systemFonts: boolean, warnings: string[]): Partial<RenderOutput> {
  const vb = flat.viewBox;
  const long = Math.max(vb.width, vb.height);
  const short = Math.min(vb.width, vb.height);
  const fit = Math.min(job.scale, job.maxPixels / long);
  const toImage = (p: { data: Buffer; width: number; height: number }): PngImage => ({ data: new Uint8Array(p.data), width: p.width, height: p.height });
  if (fit >= LEGIBLE_SCALE || !job.tile) {
    if (fit < job.scale) warnings.push(`Scaled to ${fit.toFixed(2)}x (instead of ${job.scale}x) to keep the image within ${job.maxPixels}px.`);
    return { images: [toImage(rasterize(flat.svg, { scale: fit, background: job.background, systemFonts }))], scale: fit };
  }
  // Elongated diagram: tile along the long axis, each tile as large as allowed
  // As large as one tile allows across the short side, then small enough
  // that the long side fits in MAX_TILES overlapping tiles
  let scale = Math.min(job.scale, job.maxPixels / short);
  // (1% margin: the rasterizer rounds sizes up)
  scale = Math.min(scale, (0.99 * MAX_TILES * job.maxPixels) / (long + (MAX_TILES - 1) * TILE_OVERLAP));
  const vertical = vb.height >= vb.width;
  const tiles = rasterizeTiles(flat.svg, { scale, background: job.background, systemFonts }, vertical ? "vertical" : "horizontal", job.maxPixels, Math.round(TILE_OVERLAP * scale));
  const images = tiles.map(toImage);
  warnings.push(`The diagram is ${Math.round(vb.width)}x${Math.round(vb.height)}px, so it is shown as ${images.length} ${vertical ? "top-to-bottom" : "left-to-right"} parts at ${scale.toFixed(2)}x to keep labels readable.`);
  return { images, tiledAlong: vertical ? "vertical" : "horizontal", scale };
}

async function validate(engine: MermaidEngine, code: string): Promise<Validation> {
  try {
    return { valid: true, diagramType: await engine.parse(code) };
  } catch (err) {
    if (err instanceof MermaidSyntaxError) return { valid: false, error: err.issue };
    throw err;
  }
}

async function main(): Promise<void> {
  let engine: MermaidEngine;
  try {
    warmFonts();
    engine = await MermaidEngine.create();
  } catch (err) {
    send({ fatal: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    return;
  }
  process.on("message", async (req: Request) => {
    try {
      const result: RenderOutput | Validation = req.op === "render" ? await render(engine, req.job) : await validate(engine, req.code);
      send({ id: req.id, ok: true, result });
    } catch (err) {
      if (err instanceof MermaidSyntaxError) send({ id: req.id, ok: false, error: { kind: "syntax", issue: err.issue } });
      else send({ id: req.id, ok: false, error: { kind: "internal", message: err instanceof Error ? err.message : String(err) } });
    }
  });
  send({ ready: true });
}

void main();
