// Shared Mermaid config for both the Chromium oracle and the browserless renderer.
// htmlLabels is off so every label is SVG <text> (no foreignObject), which a
// non-browser rasterizer can draw.
export const FONT_FAMILY = '"trebuchet ms", verdana, arial, sans-serif';
export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  class: { htmlLabels: false },
  state: { htmlLabels: false },
  theme: "default",
  themeVariables: { fontFamily: FONT_FAMILY },
  fontFamily: FONT_FAMILY,
  deterministicIds: true,
  handDrawnSeed: 1,
};

// Mermaid uses Math.random for some ids (e.g. gitGraph commit hashes). A fixed
// PRNG makes output reproducible: same diagram in, same bytes out.
export const SEEDED_RANDOM_SRC = `(() => {
  let s = 0x2545f491;
  Math.random = () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
})()`;

// Freezes "now" (gantt draws a today marker) so oracle and browserless agree
export const FROZEN_CLOCK_SRC = `(() => {
  if (globalThis.__frozenDate) return;
  const Real = Date;
  const NOW = Real.UTC(2026, 0, 15, 12, 0, 0);
  class FrozenDate extends Real {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  globalThis.__frozenDate = Real;
  globalThis.Date = FrozenDate;
})()`;
