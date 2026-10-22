# Browserless research record

The original spike that established how Chromium answers Mermaid's geometry
questions. The production engine is `src/engine`; this directory is kept for
its probes, which are the evidence behind the engine's rules:

| Probe | Question it answers |
| --- | --- |
| `blink-probe.mjs` | Which empty or degenerate shapes count toward a group's `getBBox` |
| `validity-probe.mjs` | When a container is valid on first layout (Blink's `bounds_changed` propagation) |
| `fontprobe.mjs`, `fontprobe2.mjs` | Text box = rounded font metrics united with glyph ink |
| `shaping-probe.mjs` | SVG text kerns across spaces; `<canvas>` (and Skia) don't |
| `baseline-probe.mjs` | Offsets for every `dominant-baseline` / `alignment-baseline` keyword |
| `empty-text-probe.mjs` | Empty `<text>` with child elements |

Run any of them with `node <probe>.mjs` (needs the Puppeteer dev dependency's
Chrome). The accuracy tooling that grew out of this spike lives in
`test/accuracy`.
