// Settings from the environment.
import path from "path";

export interface Config {
  // When set, files may only be written inside this directory
  outputDir?: string;
  renderTimeoutMs: number;
  // Longest edge of PNGs returned inline (vision models downscale beyond ~1.5k)
  inlineMaxPixels: number;
  // Longest edge of PNGs written to disk
  fileMaxPixels: number;
  // 0.x compatibility: the `generate` tool and its CONTENT_IMAGE_SUPPORTED switch
  legacyTool: boolean;
  contentImageSupported: boolean;
  // 0 emergency .. 5 debug; messages go to stderr
  logVerbosity: number;
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max}, got "${raw}"`);
  return Math.round(n);
}

export function loadConfig(): Config {
  return {
    outputDir: process.env.MERMAID_OUTPUT_DIR ? path.resolve(process.env.MERMAID_OUTPUT_DIR) : undefined,
    renderTimeoutMs: int("MERMAID_RENDER_TIMEOUT_MS", 30_000, 1_000, 600_000),
    inlineMaxPixels: int("MERMAID_INLINE_MAX_PIXELS", 1568, 256, 8192),
    fileMaxPixels: int("MERMAID_FILE_MAX_PIXELS", 8192, 256, 16384),
    legacyTool: process.env.MERMAID_LEGACY_TOOL !== "false",
    contentImageSupported: process.env.CONTENT_IMAGE_SUPPORTED !== "false",
    logVerbosity: int("MERMAID_LOG_VERBOSITY", 2, 0, 5),
  };
}
