// Color emoji for the rasterizer.
//
// resvg can't draw bitmap color-emoji fonts (Apple Color Emoji and friends),
// so emoji would vanish from PNGs. Skia can. Before rasterizing, each <text>
// that contains emoji is rewritten from our own layout (which already knows
// where every run sits): the text becomes absolutely positioned <tspan>s
// without the emoji, and each emoji becomes an <image> drawn by Skia at the
// exact advance and baseline. Only the PNG path does this; SVG output keeps
// real emoji characters for viewers that can draw them.
import { createCanvas } from "@napi-rs/canvas";
import type { GeometryDom } from "./dom.js";
import { serializeSvg } from "./flatten.js";
import { emojiFamily, measureRun, type FontSpec } from "./fonts.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const EMOJI = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})\uFE0F?)*|\p{Regional_Indicator}{2}/gu;
const HAS_EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;
// Pictographs whose default presentation is text (©, ™, ↔), written without
// U+FE0F, stay text
const textPresentation = (s: string) => !s.includes("\uFE0F") && !/\p{Emoji_Presentation}/u.test(s);

// Presentation attributes a rebuilt <tspan> must carry to look like its run
const INHERITED_PAINT = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "opacity", "text-decoration", "letter-spacing"];

export function needsEmojiInlining(svg: string): boolean {
  return HAS_EMOJI.test(svg) && emojiFamily() !== null;
}

function emojiImage(text: string, size: number, scale: number): { href: string; width: number; ascent: number; height: number } {
  const family = emojiFamily()!;
  const k = Math.max(2, scale * 2); // render above the output resolution
  const ctx = createCanvas(1, 1).getContext("2d");
  ctx.font = `${size * k}px "${family}"`;
  const m = ctx.measureText(text);
  const ascent = m.fontBoundingBoxAscent / k;
  const descent = m.fontBoundingBoxDescent / k;
  const width = m.width / k;
  const canvas = createCanvas(Math.max(1, Math.ceil(width * k)), Math.max(1, Math.ceil((ascent + descent) * k)));
  const g = canvas.getContext("2d");
  g.font = ctx.font;
  g.textBaseline = "alphabetic";
  g.fillText(text, 0, ascent * k);
  return { href: `data:image/png;base64,${canvas.toBuffer("image/png").toString("base64")}`, width, ascent, height: ascent + descent };
}

function setFont(el: Element, font: FontSpec): void {
  el.setAttribute("font-family", font.family);
  el.setAttribute("font-size", String(font.size));
  el.setAttribute("font-weight", String(font.weight));
  el.setAttribute("font-style", font.style);
}

// Nearest value of an attribute from `el` up to (not including) `stop`
function inherited(el: Element | null, stop: Element, name: string): string | null {
  for (let e = el; e && e !== stop; e = e.parentElement) if (e.hasAttribute(name)) return e.getAttribute(name);
  return null;
}

export function inlineEmoji(dom: GeometryDom, svg: string, scale: number): string {
  const { document } = dom;
  const host = document.createElement("div");
  host.innerHTML = svg;
  document.body.appendChild(host);
  try {
    for (const text of Array.from(host.querySelectorAll("text"))) {
      if (!HAS_EMOJI.test(text.textContent || "") || text.querySelector("textPath")) continue;
      const runs = dom.textRuns(text);
      const pieces: Array<{ kind: "text" | "emoji"; s: string; x: number; y: number; font: FontSpec; owner: Element }> = [];
      for (const run of runs) {
        let last = 0;
        // Leading and trailing spaces are dropped and folded into x: renderers
        // differ on whitespace in positioned tspans (resvg ignores xml:space there)
        const pushText = (s: string, start: number) => {
          const lead = s.length - s.trimStart().length;
          const body = s.trim();
          if (!body) return;
          const x = run.x + (start + lead ? measureRun(run.text.slice(0, start + lead), run.font).width : 0);
          pieces.push({ kind: "text", s: body, x, y: run.y, font: run.font, owner: run.owner });
        };
        for (const m of run.text.matchAll(EMOJI)) {
          if (textPresentation(m[0])) continue;
          pushText(run.text.slice(last, m.index), last);
          pieces.push({ kind: "emoji", s: m[0], x: run.x + measureRun(run.text.slice(0, m.index), run.font).width, y: run.y, font: run.font, owner: run.owner });
          last = m.index! + m[0].length;
        }
        pushText(run.text.slice(last), last);
      }
      if (!pieces.some((p) => p.kind === "emoji")) continue;

      const parent = text.parentNode!;
      const images: Element[] = [];
      const tspans: Element[] = [];
      for (const p of pieces) {
        if (p.kind === "text") {
          const t = document.createElementNS(SVG_NS, "tspan");
          t.setAttribute("x", String(p.x));
          t.setAttribute("y", String(p.y));
          setFont(t, p.font);
          for (const a of INHERITED_PAINT) {
            const v = inherited(p.owner, text, a);
            if (v !== null) t.setAttribute(a, v);
          }
          t.textContent = p.s;
          tspans.push(t);
        } else {
          const img = emojiImage(p.s, p.font.size, scale);
          const el = document.createElementNS(SVG_NS, "image");
          for (const [k, v] of Object.entries({ x: p.x, y: p.y - img.ascent, width: img.width, height: img.height, href: img.href })) el.setAttribute(k, String(v));
          if (text.hasAttribute("transform")) el.setAttribute("transform", text.getAttribute("transform")!);
          images.push(el);
        }
      }
      // Positions are absolute and baselines already applied
      for (const a of ["x", "y", "dx", "dy", "text-anchor", "dominant-baseline", "alignment-baseline"]) text.removeAttribute(a);
      text.setAttribute("text-anchor", "start");
      while (text.firstChild) text.firstChild.remove();
      for (const t of tspans) text.appendChild(t);
      for (const img of images) parent.insertBefore(img, text.nextSibling);
    }
    return serializeSvg(dom, host.querySelector("svg")!);
  } finally {
    host.remove();
  }
}
