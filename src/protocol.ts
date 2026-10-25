// Messages between the server and its render worker.
import type { SyntaxIssue } from "./engine/mermaid.js";

export type OutputFormat = "png" | "svg";

export interface RenderJob {
  code: string;
  format: OutputFormat;
  theme?: string;
  look?: string;
  background?: string;
  scale: number;
  // Largest PNG edge in pixels; the scale is reduced to fit
  maxPixels: number;
  // Split very elongated diagrams into several images that each stay legible
  // (for previews returned to a model, never for files)
  tile?: boolean;
}

export interface PngImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface RenderOutput {
  diagramType: string;
  svg: string;
  // Diagram size in CSS pixels
  width: number;
  height: number;
  // One image, or several tiles in reading order (top-to-bottom or left-to-right)
  images?: PngImage[];
  tiledAlong?: "vertical" | "horizontal";
  // Scale actually used for the PNG after the size limit
  scale?: number;
  warnings: string[];
  timings: { renderMs: number; flattenMs: number; rasterMs: number };
}

export interface Validation {
  valid: boolean;
  diagramType?: string;
  error?: SyntaxIssue;
}

export type Request = { id: number; op: "render"; job: RenderJob } | { id: number; op: "validate"; code: string };

export type WorkerError = { kind: "syntax"; issue: SyntaxIssue } | { kind: "internal"; message: string };

export type Response = { id: number; ok: true; result: RenderOutput | Validation } | { id: number; ok: false; error: WorkerError } | { ready: true } | { fatal: string };
