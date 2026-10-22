// CSS color values to the simplest form every SVG consumer reads: #rrggbb plus
// a separate opacity. Mermaid's themes compute colors such as
// hsl(-79.41, 100%, 93.33%) and rgb(11.0000000001, 34, 0), which browsers
// accept and stricter parsers (resvg among them) reject, falling back to black.

export interface Rgba {
  hex: string;
  alpha: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const hex2 = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");

function channel(s: string, max: number): number {
  return s.trim().endsWith("%") ? (parseFloat(s) / 100) * max : parseFloat(s);
}

function alphaOf(s: string | undefined): number {
  if (s === undefined) return 1;
  return clamp(s.trim().endsWith("%") ? parseFloat(s) / 100 : parseFloat(s), 0, 1);
}

function hue(s: string): number {
  const v = parseFloat(s);
  const unit = s.trim().replace(/^[-+\d.e]+/i, "").toLowerCase();
  const deg = unit === "rad" ? (v * 180) / Math.PI : unit === "grad" ? v * 0.9 : unit === "turn" ? v * 360 : v;
  return ((deg % 360) + 360) % 360;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

// Arguments of rgb()/hsl() in legacy comma or modern space/slash syntax
function args(inner: string): { parts: string[]; alpha?: string } {
  const [main, slashAlpha] = inner.split("/");
  const parts = main.split(/[\s,]+/).filter(Boolean);
  return parts.length === 4 ? { parts: parts.slice(0, 3), alpha: parts[3] } : { parts, alpha: slashAlpha?.trim() };
}

// Parses a color, or returns null for anything that isn't one (none, url(),
// keywords handled elsewhere) or is a named color, which needs no rewriting
export function parseColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase();
  if (v === "transparent") return { hex: "#000000", alpha: 0 };
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return { hex: `#${h.slice(0, 6)}`, alpha: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
  }
  m = /^(rgba?|hsla?)\((.*)\)$/.exec(v);
  if (!m) return null;
  const { parts, alpha } = args(m[2]);
  if (parts.length !== 3) return null;
  let rgb: [number, number, number];
  if (m[1].startsWith("rgb")) rgb = [channel(parts[0], 255), channel(parts[1], 255), channel(parts[2], 255)];
  else rgb = hslToRgb(hue(parts[0]), clamp(parseFloat(parts[1]) / 100, 0, 1), clamp(parseFloat(parts[2]) / 100, 0, 1));
  if (rgb.some((c) => Number.isNaN(c))) return null;
  return { hex: `#${rgb.map(hex2).join("")}`, alpha: alphaOf(alpha) };
}
