# Rendering Mermaid without a browser

Mermaid is a browser library. Every server-side Mermaid renderer to date either ships a browser (mermaid-cli, this project until 0.3) or reimplements Mermaid (beautiful-mermaid, mmdr), trading fidelity for speed. This document describes a third way: run the **official** Mermaid in Node, and answer the questions it asks the browser the way Chromium would.

## Results

On the 520 `mermaid-example` blocks in Mermaid 12.2's own documentation (all 33 diagram types; `test/accuracy/corpus-docs.json`), compared with the same Mermaid build running in Chromium:

| | macOS | Linux |
| --- | --- | --- |
| Structurally identical SVG (same elements, same attributes) | 520 / 520 | 520 / 520 |
| Every coordinate within 0.05 px | 507 (97.5%) | 486 (93.5%) |
| Every coordinate within 1 px | 519 (99.8%) | 518 (99.6%) |
| PNG pixels differing from Chromium's screenshot (share of drawn pixels) | median 0.60%, p90 2.6% | |

macOS: Apple Chromium with system fonts. Linux: Debian's Chromium in a container with DejaVu and Liberation fonts. The remaining exceptions are venn's randomized layout and, on Linux, one 2 px offset in an xychart.

The PNG comparison is end to end: our layout, CSS flattening and resvg against Chromium's layout and painting. Most residual pixels are antialiasing and sub-pixel glyph placement.

## The insight: Mermaid only needs geometry

Mermaid parses text, builds a graph, asks the DOM how big things are, runs a layout algorithm (dagre, ELK, cytoscape and others), and writes SVG. jsdom provides the DOM but answers every size question with zero. So what exactly does Mermaid ask? Instrumenting Chromium while rendering one diagram of each type gives a short list:

| API | Used by |
| --- | --- |
| `getBBox` | almost everything |
| `getComputedTextLength` | label wrapping, timeline, C4, mindmap |
| `getBoundingClientRect` | pie, journey, xychart |
| `getTotalLength`, `getPointAtLength` | edge labels and markers |
| `getComputedStyle` | class diagrams, cytoscape containers |
| `offsetWidth`, `clientWidth`, `screen.availWidth` | gantt width, C4 row wrapping |
| `CanvasRenderingContext2D.measureText` | architecture (cytoscape) |
| `CSS.supports` | sequence box colors |

Answer these exactly as Blink does and Mermaid produces the same SVG it produces in Chrome. `src/engine/dom.ts` is that answer: about 1,000 lines on top of jsdom.

## Method: Chromium as the oracle

Every rule in the engine was found by measuring Chromium, not by reading specs. Specs and Blink disagree more often than one would hope. Four instruments, all in `test/accuracy` (with the original probes in `experiments/browserless`):

1. **SVG diff** (`run.mjs`). Render a corpus in Chromium and in Node with identical configuration, seeded randomness and a frozen clock. Tokenize both SVGs into structure and numbers, then compare.
2. **Call trace** (`trace.mjs`). Wrap every geometry API in both environments and print the first call whose answer differs. "The flowchart is 12 px too wide" becomes "`getBBox` on this `<g>` returned the label box without its rect".
3. **Element oracle**. Load Chromium's SVG into both environments and compare `getBBox` for every element. This tests the engine on real Mermaid output, independent of Mermaid's control flow.
4. **Probes**. Minimal SVG fragments that isolate one question ("does an empty `<rect>` count toward its parent's box?"), answered by Chromium.

Each answer became a rule in the engine and a test in `test/engine.test.mjs`.

## What Blink does (that you might not expect)

**`getBBox` returns an `SVGRect`**: x, y, width and height, nothing else. Mermaid's cylinder shape computes `bbox.x - (bbox.left ?? 0)`; returning a DOMRect-like object with `left` misplaces every database node.

**Empty shapes don't count; degenerate ones do.** A zero-size `<rect>`, a `<path>` without segments, or a `<text>` without glyphs is skipped when computing a group's box. A path that is a single point, or a zero-length line, still counts.

**A text box is the font box united with the ink.** Height is the font's ascent plus descent, rounded to whole pixels, unless a glyph's ink reaches further, as a 'g' does in Arial at 16px: 17.367, not 17. Horizontally it's the advance, or the ink if a glyph overhangs.

**Text is shaped as a run, kerned across spaces and element boundaries.** Chromium's `<canvas>` shapes word by word, so "A label" measures 49.74 px there and 48.86 px in SVG, where the A-space kerning pair applies. Mermaid builds labels one word per `<tspan>`, and Chromium still shapes across them. Skia's `measureText` matches canvas, not SVG; fontkit, given the right face, matches SVG to within 0.01 px. Emoji followed by U+FE0F switch to the color emoji font.

**Positioning attributes address characters.** `dy` on a `<text>` and on its first `<tspan>` both address the first character, and the innermost wins rather than the two adding up. Newlines in text become spaces (CSS white-space), not deletions (SVG 1.1).

**Baselines.** For each keyword (ascent and descent rounded):

| Keyword | Shift |
| --- | --- |
| `middle` | x-height / 2 |
| `central` | (ascent − descent) / 2 |
| `mathematical` | ascent / 2 |
| `hanging` | 0.8 × ascent |
| `text-top`, `text-bottom` | none: they have no effect |
| `before-edge`, `after-edge` | only work as `alignment-baseline` on a `<tspan>` |

**Geometry is single precision.** `SVGRect`, `getComputedTextLength` and `getTotalLength` return float32. Mermaid deduplicates edge points by exact comparison, so 72.6 and 72.5999984741211 decide whether an edge gets a redundant point.

**`getBBox` depends on layout history.** Blink keeps a layout object per element. A container recomputes its box only when a child reports `bounds_changed`. A leaf reports that on its first layout and whenever it moves; a container reports it only when its box or transform moves. An empty label created at the origin inside an untransformed group never reports a change, so the group is never valid and never counts toward its ancestors. The same markup can therefore have different boxes depending on the order it was built in. The engine replays this: per-element layout state persists across geometry calls, a node that moves or reappears is rebuilt with its whole subtree, and removed children force a recompute (`bounds_dirty_from_removed_child_`). This fixed a whole class of 8–16 px margin errors in mindmap, state, class, agentflow and usecase diagrams.

**The environment is part of the layout.** Chromium's defaults are a 800×600 viewport with an 8 px body margin; Gantt charts size to their container (784 px), C4 wraps rows at `screen.availWidth`, and an SVG with no font rules inherits the page's default font (Times). jsdom has no `window.CSS`, and Mermaid's fallback color check rejects `Purple` (it compares against the lowercased value).

**Fonts resolve like Chromium's.** A family list resolves to the first installed family. On Linux, fontconfig's metric-compatible substitutes (Arial → Liberation Sans) are accepted and others are not. Generic families follow Chromium's per-platform defaults (Linux: Times New Roman, Arial, Monospace), and a list that matches nothing falls back to the standard font, which is serif. The x-height used by `middle` comes from the font's OS/2 table, not from measuring a hinted "x". Glyphs the face lacks are drawn by a fallback face, CoreText's cascade on macOS and fontconfig's order elsewhere. Their ink counts toward the text box but their metrics don't. Running the suite in a Linux container took Linux from 84.8% to 99.6% within 1 px.

Other rules, verified the same way: CSS custom properties and `!important`; specificity, inline-style parsing that skips empty declarations; `<switch>` renders one child; a nested `<svg>` reports its box in viewBox units and maps it through its viewport; `display:none` subtrees have no geometry; fontconfig's metric aliases (Arial → Liberation Sans) are accepted on Linux, other substitutes are not.

## Making the output portable

A browser can show Mermaid's SVG; most other consumers can't. `src/engine/flatten.ts` turns it into an SVG that renders the same everywhere:

- **Resolve the CSS cascade** (the same engine that measured the text) and write each winning value as a presentation attribute, then drop the `<style>`.
- **Colors as `#rrggbb` plus `*-opacity`.** Mermaid's themes compute values like `hsl(-79.41, 100%, 93.33%)` and `rgb(11.0000000001, 34, 0)`; resvg rejects them and paints black.
- **Exact font family names.** resvg matches families case-sensitively (`trebuchet ms` silently becomes the default font, and bold is lost). Each family list is rewritten to the concrete face the measurement used.
- **Canonical tag names.** jsdom's HTML parser leaves `feDropShadow` lowercase; an unknown filter primitive makes the filtered element disappear, which hid every actor in sequence diagrams.
- **XML serialization**, because HTML serialization emits `&nbsp;`, which XML doesn't define.
- **CSS `drop-shadow()` becomes SVG 1.1 filters** with a tight region from `getBBox`. It's readable by tools that don't parse CSS filter functions, and rasterizes 2–3× faster: Mermaid shadows every node, and the default filter region is 20% larger than the element on each axis.
- **Color emoji** become images drawn by Skia, positioned from our layout, because resvg can't draw bitmap emoji fonts (PNG only; SVG keeps the characters).

Fonts are resolved once per family list to one installed face, by CSS font matching over an index of the system's fonts. That same face is used for shaping (fontkit), ink measurement (Skia) and drawing (resvg). When nothing in the list is installed, the bundled DejaVu faces are used, so a bare container renders correctly.

## Architecture

```
MCP client ── stdio ──▶ server (src/server.ts, SDK v2)
                          │  queue, timeout, recycle
                          ▼
                 render process (src/worker.ts)
                   Mermaid 12 + geometry DOM (jsdom)
                   flatten ─▶ resvg ─▶ PNG / tiles
```

Rendering runs in a **child process**, not a worker thread. A Rust panic in a native module calls `abort()` and takes its whole process down (a cropped viewBox once made resvg panic). In a child process that's a failed render and a restart; in the server it would be an outage. It also keeps jsdom's browser globals out of the server, makes a runaway layout killable (`MERMAID_RENDER_TIMEOUT_MS`), and bounds memory: the process runs with a 512 MB V8 heap cap, so V8 collects early instead of growing toward its default limit, and it is recycled every 250 renders. Over 600 renders of the docs corpus, resident memory stays under about 720 MB. The font index reads only each font's name and OS/2 tables; reading whole files (Apple Color Emoji alone is ~180 MB) cost 630 MB of resident memory. The end-to-end tests kill the child mid-render and expect the next call to succeed.

Images returned to a model are capped at 1568 px on the long side; beyond that, vision models downscale anyway. A 470×5981 sequence diagram scaled to fit would be 123 px wide and unreadable, so elongated diagrams are returned as up to six overlapping tiles at a legible scale. The tiles are cut from one raster in pixel space, not by cropping the viewBox, because the cropped viewBox is what made resvg panic.

## Performance

Geometry calls arrive between DOM mutations, hundreds per render. The first version recomputed styles and layout from scratch on every call. The current one works like Blink's dirty bits:

- **Mutation records drive invalidation.** Records are processed both when delivered to the observer (at microtask boundaries) and when taken synchronously. Dropping delivered records, the first attempt, left stale layout whenever Mermaid awaited between a change and a measurement, and the accuracy suite caught it. Only touched elements are restyled (their subtrees when a class, id or selector-relevant attribute changes), and layout walks only dirty paths.
- **CSS rules are bucketed** by the rightmost compound's id, class or tag, as browsers do. Properties no stylesheet declares skip selector matching altogether.
- **No `HTMLCollection` iteration.** jsdom's live collections do a named-item lookup per indexed access, which is O(n²) over a container's children. Sibling walks are O(n).

Warm layout time, against Mermaid in an already running Chromium (`bench/vs-chromium.mjs`):

| | Chromium | Here |
| --- | --- | --- |
| small flowchart | 24 ms | 59 ms |
| 120-message sequence | 59 ms | 168 ms |
| 40 classes | 290 ms | 912 ms |
| 400-node chain | 646 ms | 1.6 s |
| 40 subgraphs, 400 nodes | 940 ms | 2.3 s |

For typical diagrams the gap doesn't matter: end to end, a server that starts no browser answers in about 90 ms where 0.3 took 1.3 s. On the largest diagrams it does, and 0.3 is faster there (2.6 s against 4.2 s for 40 subgraphs). Profiles of both engines show the same hotspot: Mermaid's `getConfig()` deep-copies the whole configuration on every call. That's 34% of Chromium's time on this diagram, and 40% of ours, where V8 runs it about twice as slowly. That is an upstream fix (memoizing the config) rather than something to patch in Mermaid's bundle.

## Protocol

Built on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`). With the 2026-07-28 revision, server-to-client logging is deprecated and servers must not send log notifications unless the request asks for them, so this server logs only to stderr. Tools declare output schemas and annotations (`validate_mermaid` is read-only and idempotent), and return structured content alongside the image. Mermaid's syntax docs are resources, and errors point to the one to read.

## Limits and next steps

- **HTML labels are off.** Labels are SVG text. Markdown in labels still works through Mermaid's SVG text path; arbitrary HTML in labels does not render.
- **Venn layouts differ** from Chromium's. Both are valid optima of venn.js's randomized optimizer, which draws a different number of random values before it runs.
- **Large diagrams**: the `getConfig` fix belongs upstream; the next local win is caching text layout across word-by-word label construction.
- **Linux fonts**: Chromium's fallback for glyphs missing from every listed font goes through fontconfig, which the engine approximates. The CI accuracy job runs on Linux to keep this honest.
- **An in-chat viewer** (an MCP App rendering with the client's own Mermaid) would complement file output for clients that support it.
