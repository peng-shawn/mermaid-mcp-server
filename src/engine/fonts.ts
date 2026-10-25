// Fonts: finding faces, measuring text the way Chromium's SVG text does, and
// making sure the face we measure with is the face the rasterizer draws with.
//
// Three engines touch text: fontkit (shaping: advances with kerning, across
// spaces, as Chromium's SVG text shapes whole runs), Skia (ink extents, and
// glyphs the matched face lacks), and resvg (drawing). Each matches font
// families slightly differently, so every family list is resolved once, here,
// to one concrete installed face, and all three are pointed at it. When no
// listed family is installed, the bundled DejaVu faces are used, so output is
// complete and deterministic even in a bare container.
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import * as fontkit from "fontkit";

export interface FontSpec {
  family: string; // CSS family list as written
  size: number; // px
  weight: number; // 100..900
  style: string; // normal | italic | oblique
}

interface Face {
  families: string[];
  weight: number;
  italic: boolean;
  file: string;
  index: number;
  bundled: boolean;
}

export const BUNDLED_SANS = "DejaVu Sans";
export const BUNDLED_MONO = "DejaVu Sans Mono";

export function bundledFontDir(): string {
  // dist/engine/fonts.js -> <package>/assets/fonts/dejavu (also works from src/)
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../assets/fonts/dejavu");
}

export function bundledFontFiles(): string[] {
  const dir = bundledFontDir();
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".ttf")).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

// ---- face discovery ----------------------------------------------------------

function systemFontDirs(): string[] {
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", path.join(home, "Library/Fonts")];
    case "win32":
      return [path.join(process.env.WINDIR || "C:\\Windows", "Fonts"), path.join(process.env.LOCALAPPDATA || "", "Microsoft/Windows/Fonts")];
    default:
      return ["/usr/share/fonts", "/usr/local/share/fonts", path.join(home, ".fonts"), path.join(home, ".local/share/fonts")];
  }
}

function listFontFiles(dir: string, out: string[], depth = 0): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) listFontFiles(p, out, depth + 1);
    else if (/\.(ttf|otf|ttc|otc)$/i.test(e.name)) out.push(p);
  }
}

// Reads family, weight and slant from an sfnt's name and OS/2 tables, reading
// only those bytes: fonts can be hundreds of megabytes (color emoji), and
// reading whole files to index them would cost that much resident memory.
type Read = (offset: number, length: number) => Buffer;

function readFace(read: Read, offset: number, file: string, index: number, bundled: boolean): Face | null {
  const numTables = read(offset + 4, 2).readUInt16BE(0);
  const dir = read(offset + 12, numTables * 16);
  const tables = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < numTables; i++) {
    tables.set(dir.toString("latin1", i * 16, i * 16 + 4), { off: dir.readUInt32BE(i * 16 + 8), len: dir.readUInt32BE(i * 16 + 12) });
  }
  const nameTable = tables.get("name");
  if (!nameTable) return null;
  const buf = read(nameTable.off, nameTable.len);
  const count = buf.readUInt16BE(2);
  const strings = buf.readUInt16BE(4);
  const names: Record<number, string> = {};
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    const platform = buf.readUInt16BE(r);
    const lang = buf.readUInt16BE(r + 4);
    const id = buf.readUInt16BE(r + 6);
    if (id !== 1 && id !== 2 && id !== 16 && id !== 17) continue;
    const english = (platform === 3 && (lang & 0xff) === 0x09) || (platform === 1 && lang === 0) || platform === 0;
    if (!english || (names[id] && platform !== 3)) continue;
    const start = strings + buf.readUInt16BE(r + 10);
    const bytes = buf.subarray(start, start + buf.readUInt16BE(r + 8));
    let s = "";
    if (platform === 1) s = bytes.toString("latin1");
    else for (let j = 0; j + 1 < bytes.length; j += 2) s += String.fromCharCode(bytes.readUInt16BE(j));
    names[id] = s;
  }
  let weight = 400;
  let italic = false;
  const os2 = tables.get("OS/2");
  if (os2 && os2.len >= 64) {
    const t = read(os2.off, 64);
    weight = t.readUInt16BE(4);
    italic = (t.readUInt16BE(62) & 1) === 1;
  }
  if (/italic|oblique/i.test(names[17] || names[2] || "")) italic = true;
  const families = [...new Set([names[16], names[1]].filter((n): n is string => !!n))];
  return families.length ? { families, weight, italic, file, index, bundled } : null;
}

let faceIndex: Map<string, Face[]> | null = null;

function indexFile(file: string, bundled: boolean, into: Map<string, Face[]>): void {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return;
  }
  try {
    const read: Read = (offset, length) => {
      const b = Buffer.alloc(length);
      if (fs.readSync(fd, b, 0, length, offset) < length) throw new Error("truncated font");
      return b;
    };
    const head = read(0, 12);
    let offsets = [0];
    if (head.toString("latin1", 0, 4) === "ttcf") {
      // A collection: the header lists each face's offset
      const count = head.readUInt32BE(8);
      const table = read(12, count * 4);
      offsets = Array.from({ length: count }, (_, i) => table.readUInt32BE(i * 4));
    }
    offsets.forEach((off, index) => {
      const face = readFace(read, off, file, index, bundled);
      if (!face) return;
      for (const fam of face.families) {
        const key = fam.toLowerCase();
        const list = into.get(key) ?? [];
        list.push(face);
        into.set(key, list);
      }
    });
  } catch {
    // unreadable or not an sfnt
  } finally {
    fs.closeSync(fd);
  }
}

function faces(): Map<string, Face[]> {
  if (faceIndex) return faceIndex;
  faceIndex = new Map();
  const files: string[] = [];
  for (const dir of systemFontDirs()) listFontFiles(dir, files);
  for (const f of files) indexFile(f, false, faceIndex);
  for (const f of bundledFontFiles()) {
    indexFile(f, true, faceIndex);
    GlobalFonts.registerFromPath(f);
  }
  return faceIndex;
}

// Builds the face index ahead of the first render (a few hundred ms on a
// desktop with many fonts)
export function warmFonts(): void {
  faces();
}

// Chromium's default font settings per platform (standard = serif). On Linux
// they name Times New Roman, Arial and Monospace, which fontconfig resolves to
// metric-compatible Liberation faces when present.
const GENERIC: Record<string, Record<string, string[]>> = {
  darwin: { "sans-serif": ["Helvetica"], serif: ["Times"], monospace: ["Courier"], "system-ui": ["Helvetica"], cursive: ["Apple Chancery"], fantasy: ["Papyrus"] },
  win32: { "sans-serif": ["Arial"], serif: ["Times New Roman"], monospace: ["Consolas", "Courier New"], "system-ui": ["Segoe UI"], cursive: ["Comic Sans MS"], fantasy: ["Impact"] },
  linux: {
    "sans-serif": ["Arial", "Liberation Sans", "Arimo", "DejaVu Sans", "Noto Sans"],
    serif: ["Times New Roman", "Liberation Serif", "Tinos", "DejaVu Serif", "Noto Serif"],
    monospace: ["DejaVu Sans Mono", "Liberation Mono", "Cousine", "Noto Sans Mono"],
    "system-ui": ["DejaVu Sans", "Noto Sans"],
  },
};

// Metric-compatible substitutes (fontconfig's 30-metric-aliases), which
// Chromium on Linux accepts for a named family that isn't installed; any other
// substitute makes it move on to the next family in the list
const METRIC_ALIASES: Record<string, string[]> = {
  arial: ["Liberation Sans", "Arimo"],
  helvetica: ["Liberation Sans", "Arimo"],
  "times new roman": ["Liberation Serif", "Tinos"],
  times: ["Liberation Serif", "Tinos"],
  "courier new": ["Liberation Mono", "Cousine"],
  courier: ["Liberation Mono", "Cousine"],
  calibri: ["Carlito"],
  cambria: ["Caladea"],
};

function splitFamilies(list: string): string[] {
  return list
    .split(",")
    .map((f) => f.trim().replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
}

// CSS Fonts 4 matching on style and weight
function pickFace(candidates: Face[], weight: number, italic: boolean): Face {
  const styled = candidates.filter((f) => f.italic === italic);
  const pool = styled.length ? styled : candidates;
  const distance = (f: Face): number => {
    if (f.weight === weight) return 0;
    if (weight >= 400 && weight <= 500) {
      if (f.weight >= weight && f.weight <= 500) return f.weight - weight;
      if (f.weight < weight) return 1000 + (weight - f.weight);
      return 2000 + f.weight;
    }
    if (weight < 400) return f.weight <= weight ? weight - f.weight : 1000 + f.weight;
    return f.weight >= weight ? f.weight - weight : 1000 + (weight - f.weight);
  };
  return pool.reduce((best, f) => (distance(f) < distance(best) ? f : best), pool[0]);
}

interface Resolved {
  family: string; // concrete family name, exact casing
  face: Face;
}

const resolveCache = new Map<string, Resolved>();

// The installed face a CSS family list selects, or the bundled fallback
export function resolveFont(familyList: string, weight: number, style: string): Resolved {
  const key = `${familyList}|${weight}|${style}`;
  const hit = resolveCache.get(key);
  if (hit) return hit;
  const index = faces();
  const generic = GENERIC[process.platform] ?? GENERIC.linux;
  const italic = style === "italic" || style === "oblique";
  let result: Resolved | null = null;
  let wantsMono = false;
  for (const fam of splitFamilies(familyList)) {
    const lower = fam.toLowerCase();
    if (lower === "monospace") wantsMono = true;
    const names = generic[lower] ?? [fam, ...(METRIC_ALIASES[lower] ?? [])];
    for (const name of names) {
      const cands = index.get(name.toLowerCase());
      if (cands?.length) {
        const face = pickFace(cands, weight, italic);
        result = { family: face.families.find((f) => f.toLowerCase() === name.toLowerCase()) ?? face.families[0], face };
        break;
      }
    }
    if (result) break;
  }
  // A list that matches nothing falls back to the browser's standard font (serif)
  if (!result) {
    for (const name of wantsMono ? generic.monospace : generic.serif) {
      const cands = index.get(name.toLowerCase());
      if (cands?.length) {
        const face = pickFace(cands, weight, italic);
        result = { family: face.families.find((f) => f.toLowerCase() === name.toLowerCase()) ?? face.families[0], face };
        break;
      }
    }
  }
  if (!result) {
    const fallback = wantsMono ? BUNDLED_MONO : BUNDLED_SANS;
    const cands = index.get(fallback.toLowerCase()) ?? [];
    if (!cands.length) throw new Error(`Bundled font ${fallback} is missing from ${bundledFontDir()}`);
    result = { family: fallback, face: pickFace(cands, weight, italic) };
  }
  resolveCache.set(key, result);
  return result;
}

// ---- measurement --------------------------------------------------------------

const ctx = createCanvas(1, 1).getContext("2d");

function skiaFont(spec: FontSpec, family: string): string {
  return `${spec.style === "normal" ? "" : spec.style + " "}${spec.weight} ${spec.size}px "${family}"`;
}

function skiaMeasure(text: string, font: string) {
  ctx.font = font;
  return ctx.measureText(text);
}

export interface FontMetrics {
  ascent: number;
  descent: number;
  xHeight: number;
}

const metricsCache = new Map<string, FontMetrics>();

// Blink rounds ascent and descent to whole pixels for layout. Its x-height
// is the font's own (OS/2 sxHeight, via Skia's fXHeight); measuring a hinted
// "x" instead is off by up to half a pixel on Linux.
export function fontMetrics(spec: FontSpec): FontMetrics {
  const { family, face } = resolveFont(spec.family, spec.weight, spec.style);
  const key = skiaFont(spec, family);
  let m = metricsCache.get(key);
  if (!m) {
    const t = skiaMeasure("x", key);
    const font = shaper(face);
    const xHeight = font?.xHeight ? (font.xHeight * spec.size) / font.unitsPerEm : t.actualBoundingBoxAscent;
    m = { ascent: Math.round(t.fontBoundingBoxAscent), descent: Math.round(t.fontBoundingBoxDescent), xHeight };
    metricsCache.set(key, m);
  }
  return m;
}

const opened = new Map<string, fontkit.Font | null>();
function shaper(face: Face): fontkit.Font | null {
  const key = `${face.file}#${face.index}`;
  let f = opened.get(key);
  if (f === undefined) {
    try {
      const o = fontkit.openSync(face.file) as fontkit.Font | fontkit.FontCollection;
      f = "fonts" in o ? (o.fonts[face.index] ?? null) : o;
    } catch {
      f = null;
    }
    opened.set(key, f);
  }
  return f;
}

const EMOJI_FAMILIES = ["Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji", "Twemoji Mozilla"];
let emoji: string | null | undefined;
export function emojiFamily(): string | null {
  if (emoji === undefined) emoji = EMOJI_FAMILIES.find((f) => faces().has(f.toLowerCase())) ?? null;
  return emoji;
}

type SegmentKind = "face" | "emoji" | "fallback";
interface Segment {
  kind: SegmentKind;
  text: string;
}

// Splits text into what the resolved face draws, what the emoji font draws
// (emoji presentation, as Chromium does even when the face has a text-style
// glyph), and what system fallback draws
function segment(text: string, font: fontkit.Font): Segment[] {
  const chars = [...text];
  const kinds: SegmentKind[] = chars.map((ch, i) => {
    const isEmoji = chars[i + 1] === "\uFE0F" ? /\p{Extended_Pictographic}/u.test(ch) : /\p{Emoji_Presentation}/u.test(ch);
    if (isEmoji) return "emoji";
    return /\s/.test(ch) || font.hasGlyphForCodePoint(ch.codePointAt(0)!) ? "face" : "fallback";
  });
  for (let i = 1; i < chars.length; i++) if (/[\uFE0E\uFE0F\u200D]/.test(chars[i])) kinds[i] = kinds[i - 1];
  const out: Segment[] = [];
  chars.forEach((ch, i) => {
    const last = out[out.length - 1];
    if (last && last.kind === kinds[i]) last.text += ch;
    else out.push({ kind: kinds[i], text: ch });
  });
  return out;
}

// Whether any text since the last reset needed glyphs from outside the
// resolved faces; the rasterizer then also loads system fonts (slow)
let fallbackSeen = false;
export function takeFallbackSeen(): boolean {
  const seen = fallbackSeen;
  fallbackSeen = false;
  return seen;
}

// Glyphs the resolved face lacks. Chromium on macOS asks CoreText's cascade,
// which Skia's own fallback reproduces. Elsewhere it asks fontconfig; we follow
// fontconfig's usual order, then any installed face that has the glyph.
const FALLBACK_ORDER = [
  "DejaVu Sans", "Noto Sans", "Noto Sans CJK SC", "Noto Sans CJK JP", "Noto Sans CJK KR", "Noto Sans CJK TC",
  "Noto Sans Arabic", "Noto Sans Hebrew", "Noto Sans Devanagari", "Noto Sans Thai", "Noto Sans Symbols",
  "Noto Sans Symbols 2", "Liberation Sans", "Segoe UI", "Segoe UI Symbol", "Microsoft YaHei", "Yu Gothic",
  "Malgun Gothic", "Nirmala UI", "Arial Unicode MS",
];
const fallbackCache = new Map<string, Face | null>();
const fallbackFaces = new Set<Face>();

function fallbackFace(cp: number, weight: number, italic: boolean): Face | null {
  const key = `${cp}|${weight}|${italic}`;
  const hit = fallbackCache.get(key);
  if (hit !== undefined) return hit;
  const index = faces();
  let found: Face | null = null;
  for (const name of FALLBACK_ORDER) {
    const cands = index.get(name.toLowerCase());
    if (!cands?.length) continue;
    const face = pickFace(cands, weight, italic);
    if (shaper(face)?.hasGlyphForCodePoint(cp)) {
      found = face;
      break;
    }
  }
  if (!found) {
    const seen = new Set<string>();
    outer: for (const list of index.values()) {
      for (const face of list) {
        const id = `${face.file}#${face.index}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (shaper(face)?.hasGlyphForCodePoint(cp)) {
          found = face;
          break outer;
        }
      }
    }
  }
  if (found) fallbackFaces.add(found);
  fallbackCache.set(key, found);
  return found;
}

// Splits a run the resolved face can't draw by the fallback face of each character
function fallbackRuns(text: string, spec: FontSpec): Array<{ text: string; face: Face | null }> {
  const out: Array<{ text: string; face: Face | null }> = [];
  for (const ch of text) {
    const face = fallbackFace(ch.codePointAt(0)!, spec.weight, spec.style !== "normal");
    const last = out[out.length - 1];
    if (last && last.face === face) last.text += ch;
    else out.push({ text: ch, face });
  }
  return out;
}

export interface RunMetrics {
  width: number; // advance
  inkLeft: number; // relative to the run's start; negative extends left
  inkRight: number;
  inkAscent: number;
  inkDescent: number;
  usesFallback?: boolean;
}

const runCache = new Map<string, RunMetrics>();

// Advance and ink extents of a run of text in one font
export function measureRun(text: string, spec: FontSpec): RunMetrics {
  const { family, face } = resolveFont(spec.family, spec.weight, spec.style);
  const key = `${skiaFont(spec, family)}\u0000${text}`;
  const hit = runCache.get(key);
  if (hit) {
    if (hit.usesFallback) fallbackSeen = true;
    return hit;
  }
  const font = shaper(face);
  const segments: Segment[] = font ? segment(text, font) : [{ kind: "fallback", text }];
  if (segments.some((s) => s.kind !== "face")) fallbackSeen = true;
  const emojiFont = emojiFamily();
  const m: RunMetrics = { width: 0, inkLeft: Infinity, inkRight: -Infinity, inkAscent: 0, inkDescent: 0 };
  let x = 0;
  // Outside macOS, fallback segments are shaped with the face fontconfig would pick
  const pieces: Array<{ text: string; kind: SegmentKind; face?: Face | null }> = [];
  for (const seg of segments) {
    if (seg.kind === "fallback" && process.platform !== "darwin") for (const r of fallbackRuns(seg.text, spec)) pieces.push({ text: r.text, kind: "fallback", face: r.face });
    else pieces.push(seg);
  }
  for (const seg of pieces) {
    const fb = seg.face ? shaper(seg.face) : null;
    const fontStr = seg.kind === "emoji" && emojiFont ? `${spec.size}px "${emojiFont}"` : fb ? skiaFont(spec, seg.face!.families[0]) : skiaFont(spec, family);
    const skia = skiaMeasure(seg.text, fontStr);
    let advance = skia.width;
    if (seg.kind === "face" && font) advance = (font.layout(seg.text).advanceWidth * spec.size) / font.unitsPerEm;
    else if (fb) {
      advance = (fb.layout(seg.text).advanceWidth * spec.size) / fb.unitsPerEm;
    }
    m.inkLeft = Math.min(m.inkLeft, x - skia.actualBoundingBoxLeft);
    // Right ink is the overhang past the last advance, anchored at the shaped
    // end (Skia's own layout of the segment may be unkerned)
    m.inkRight = Math.max(m.inkRight, x + advance + (skia.actualBoundingBoxRight - skia.width));
    m.inkAscent = Math.max(m.inkAscent, skia.actualBoundingBoxAscent);
    m.inkDescent = Math.max(m.inkDescent, skia.actualBoundingBoxDescent);
    x += advance;
  }
  m.width = x;
  m.usesFallback = segments.some((s) => s.kind !== "face");
  if (!Number.isFinite(m.inkLeft)) m.inkLeft = m.inkRight = 0;
  if (runCache.size > 50000) runCache.clear();
  runCache.set(key, m);
  return m;
}

// Font files the rasterizer needs: bundled faces, every face resolved so far,
// and fallback faces. Not the emoji font: resvg can't draw bitmap emoji (they
// are inlined as images), and loading it (~180 MB on macOS) per render is costly.
export function resolvedFontFiles(): string[] {
  const files = new Set(bundledFontFiles());
  for (const r of resolveCache.values()) files.add(r.face.file);
  for (const f of fallbackFaces) files.add(f.file);
  return [...files];
}

// Rewrites a CSS family list to the concrete family the measurement used
export function concreteFamily(familyList: string, weight: number, style: string): string {
  return resolveFont(familyList, weight, style).family;
}
