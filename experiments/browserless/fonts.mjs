// Text shaping the way Chromium's SVG text does it: whole runs shaped on the
// matched font face (so kerning across spaces applies, both GPOS and legacy
// 'kern' tables), with per-character fallback for glyphs the face lacks.
//
// Skia's canvas measureText (the fallback path) matches Chromium's <canvas>,
// which shapes word by word and so loses kerning pairs that involve a space.
// SVG text is shaped as a run, and resvg draws it that way too. fontkit's
// layout matches Chromium's SVG advances to within 0.01px on our probes.
import fs from "fs";
import os from "os";
import path from "path";
import * as fontkit from "fontkit";

// ---- font discovery --------------------------------------------------------

function fontDirs() {
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

function walk(dir, out, depth = 0) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) walk(p, out, depth + 1);
    else if (/\.(ttf|otf|ttc|otc)$/i.test(e.name)) out.push(p);
  }
}

function readU16(b, o) {
  return b.readUInt16BE(o);
}
function readU32(b, o) {
  return b.readUInt32BE(o);
}

function decodeName(buf, platform, encoding, off, len) {
  const bytes = buf.subarray(off, off + len);
  if (platform === 3 || platform === 0) {
    let s = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes.readUInt16BE(i));
    return s;
  }
  return bytes.toString("latin1");
}

// Reads family/style metadata from one sfnt (or one face of a collection)
function readFace(buf, offset, file, index) {
  const numTables = readU16(buf, offset + 4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const rec = offset + 12 + i * 16;
    tables[buf.toString("latin1", rec, rec + 4)] = { off: readU32(buf, rec + 8), len: readU32(buf, rec + 12) };
  }
  const name = tables["name"];
  if (!name) return null;
  const count = readU16(buf, name.off + 2);
  const strOff = name.off + readU16(buf, name.off + 4);
  const names = {};
  for (let i = 0; i < count; i++) {
    const r = name.off + 6 + i * 12;
    const platform = readU16(buf, r), encoding = readU16(buf, r + 2), lang = readU16(buf, r + 4), id = readU16(buf, r + 6);
    if (![1, 2, 16, 17].includes(id)) continue;
    const english = (platform === 3 && (lang & 0xff) === 0x09) || (platform === 1 && lang === 0) || platform === 0;
    if (!english) continue;
    if (names[id] && platform !== 3) continue;
    names[id] = decodeName(buf, platform, encoding, strOff + readU16(buf, r + 10), readU16(buf, r + 8));
  }
  let weight = 400, italic = false;
  const os2 = tables["OS/2"];
  if (os2 && os2.len >= 64) {
    weight = readU16(buf, os2.off + 4);
    italic = (readU16(buf, os2.off + 62) & 1) === 1;
  }
  const sub = (names[17] || names[2] || "").toLowerCase();
  if (/italic|oblique/.test(sub)) italic = true;
  const families = [...new Set([names[16], names[1]].filter(Boolean))];
  return { families, weight, italic, file, index };
}

let faces = null;
function faceIndex() {
  if (faces) return faces;
  faces = new Map(); // lowercase family -> [face]
  const files = [];
  for (const d of fontDirs()) walk(d, files);
  for (const file of files) {
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      continue;
    }
    try {
      const tag = buf.toString("latin1", 0, 4);
      const offsets = tag === "ttcf" ? Array.from({ length: readU32(buf, 8) }, (_, i) => readU32(buf, 12 + i * 4)) : [0];
      offsets.forEach((off, index) => {
        const face = readFace(buf, off, file, index);
        if (!face) return;
        for (const fam of face.families) {
          const key = fam.toLowerCase();
          if (!faces.has(key)) faces.set(key, []);
          faces.get(key).push(face);
        }
      });
    } catch {
      // not a font we can read
    }
  }
  return faces;
}

const GENERIC = {
  darwin: { "sans-serif": ["Helvetica"], serif: ["Times"], monospace: ["Courier"], "system-ui": ["Helvetica"] },
  win32: { "sans-serif": ["Arial"], serif: ["Times New Roman"], monospace: ["Courier New"], "system-ui": ["Segoe UI"] },
  linux: {
    "sans-serif": ["DejaVu Sans", "Liberation Sans", "Noto Sans"],
    serif: ["DejaVu Serif", "Liberation Serif", "Noto Serif"],
    monospace: ["DejaVu Sans Mono", "Liberation Mono", "Noto Sans Mono"],
    "system-ui": ["DejaVu Sans", "Noto Sans"],
  },
};

// CSS Fonts 4 font matching, restricted to style and weight
function pickFace(cands, weight, italic) {
  const styled = cands.filter((f) => f.italic === italic);
  const pool = styled.length ? styled : cands;
  const w = Number(weight) || 400;
  const score = (f) => {
    if (f.weight === w) return 0;
    if (w >= 400 && w <= 500) {
      if (f.weight >= w && f.weight <= 500) return f.weight - w;
      if (f.weight < w) return 1000 + (w - f.weight);
      return 2000 + f.weight;
    }
    if (w < 400) return f.weight <= w ? w - f.weight : 1000 + f.weight;
    return f.weight >= w ? f.weight - w : 1000 + (w - f.weight);
  };
  return pool.slice().sort((a, b) => score(a) - score(b))[0];
}

const matchCache = new Map();
export function matchFace(familyList, weight, style) {
  const key = `${familyList}|${weight}|${style}`;
  if (matchCache.has(key)) return matchCache.get(key);
  const idx = faceIndex();
  const generic = GENERIC[process.platform] ?? GENERIC.linux;
  let face = null;
  for (let fam of familyList.split(",")) {
    fam = fam.trim().replace(/^["']|["']$/g, "").toLowerCase();
    const names = generic[fam] ? generic[fam].map((n) => n.toLowerCase()) : [fam];
    for (const n of names) {
      const cands = idx.get(n);
      if (cands?.length) {
        face = pickFace(cands, weight, style === "italic" || style === "oblique");
        break;
      }
    }
    if (face) break;
  }
  matchCache.set(key, face);
  return face;
}

// ---- shaping -----------------------------------------------------------------

const opened = new Map();
function fkFont(face) {
  const key = `${face.file}#${face.index}`;
  let f = opened.get(key);
  if (f === undefined) {
    try {
      const o = fontkit.openSync(face.file);
      f = o.fonts ? o.fonts[face.index] : o;
    } catch {
      f = null;
    }
    opened.set(key, f);
  }
  return f;
}

const EMOJI_FAMILIES = ["Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji", "Twemoji Mozilla"];
let emojiFamily;
export function emojiFont() {
  if (emojiFamily !== undefined) return emojiFamily;
  emojiFamily = EMOJI_FAMILIES.find((f) => faceIndex().has(f.toLowerCase())) ?? null;
  return emojiFamily;
}

const widthCache = new Map();

// Splits a run into segments drawn by the matched face, by the emoji font, or
// by system fallback, and gives each face segment its shaped advance width.
// Returns null when no face matches (callers then use Skia alone).
export function segmentRun(text, font) {
  const face = matchFace(font.family, font.weight, font.style);
  const f = face && fkFont(face);
  if (!f) return null;
  const units = [...text];
  const marks = units.map((ch, i) => {
    const cp = ch.codePointAt(0);
    const next = units[i + 1];
    // Emoji presentation goes to the emoji font even if the face has a
    // text-style glyph, as in Chromium
    const emoji = next === "\uFE0F" ? /\p{Extended_Pictographic}/u.test(ch) : /\p{Emoji_Presentation}/u.test(ch);
    return { ch, kind: emoji ? "emoji" : f.hasGlyphForCodePoint(cp) || /\s/.test(ch) ? "face" : "fallback" };
  });
  // Variation selectors and joiners stay with the preceding character
  for (let i = 1; i < marks.length; i++) if (/[\uFE0F\uFE0E\u200D]/.test(marks[i].ch)) marks[i].kind = marks[i - 1].kind;
  const segments = [];
  for (const m of marks) {
    const last = segments[segments.length - 1];
    if (last && last.kind === m.kind) last.text += m.ch;
    else segments.push({ kind: m.kind, text: m.ch });
  }
  for (const seg of segments) {
    if (seg.kind !== "face") continue;
    const key = `${face.file}#${face.index}|${seg.text}`;
    let units = widthCache.get(key);
    if (units === undefined) {
      units = f.layout(seg.text).advanceWidth;
      if (widthCache.size > 50000) widthCache.clear();
      widthCache.set(key, units);
    }
    seg.width = (units * font.size) / f.unitsPerEm;
  }
  return segments;
}
