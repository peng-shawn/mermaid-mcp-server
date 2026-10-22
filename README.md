# Mermaid MCP Server

An MCP server that renders [Mermaid](https://mermaid.js.org) diagrams to PNG and SVG, and checks their syntax, using the official Mermaid library. **No browser required.**

Earlier versions drove a headless Chrome. 1.0 runs Mermaid itself in Node on a DOM whose geometry answers match Chromium's, and draws PNGs with [resvg](https://github.com/linebender/resvg). Measured against Chromium on the 520 examples in Mermaid's own documentation, the layouts are structurally identical, 99.8% are within 1px, and the PNGs differ from Chromium's screenshots in a median 0.6% of drawn pixels. See [how it works](docs/design.md).

|                                | 0.3 (Chrome)               | 1.0 (browserless)       |
| ------------------------------ | -------------------------- | ----------------------- |
| Install                        | 22 s, 825 MB (576 MB Chrome) | 8 s, 276 MB           |
| First diagram after start      | 8.1 s                      | 1.6 s                   |
| Small diagram                  | 1.27 s                     | 0.11 s                  |
| 8 small diagrams at once       | 5.3 s                      | 0.6 s                   |
| 120-message sequence diagram   | 1.7 s                      | 0.5 s                   |
| 400 nodes in 40 subgraphs      | 2.6 s                      | 4.2 s ([why](docs/design.md#performance)) |

<sub>End to end over stdio (`bench/e2e.mjs`), Apple M1 Max, Node 22.</sub>

## Quick start

Claude Desktop, Claude Code, Cursor, VS Code and other MCP clients:

```json
{
  "mcpServers": {
    "mermaid": {
      "command": "npx",
      "args": ["-y", "@peng-shawn/mermaid-mcp-server@latest"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add mermaid -- npx -y @peng-shawn/mermaid-mcp-server@latest
```

Requires Node.js 22.12 or later (Mermaid 12 needs it).

## Tools

### `render_mermaid`

Renders Mermaid code and returns the image, so the model can look at the result, or saves it to a file.

| Parameter | Description |
| --- | --- |
| `code` | Mermaid source (required) |
| `format` | `png` (default) or `svg` |
| `theme` | `default`, `neutral`, `dark`, `forest`, `base`, `neo`, `neo-dark`, `redux`, `redux-dark`, `redux-color`, `redux-dark-color` |
| `look` | `classic`, `neo` or `handDrawn` |
| `background` | CSS color or `transparent`; PNGs default to white |
| `scale` | PNG pixel density, 0.5 to 4 (default 2) |
| `outputPath` | Absolute path to save the file. Existing files are never overwritten; a numbered name is used instead |
| `includeImage` | With `outputPath`, also return the image |

Returns the image plus `{ diagramType, format, width, height, path?, warnings }` as structured content.

- Images returned to the model are at most 1568px on the long side, where vision models stop gaining detail. Very tall or wide diagrams come back as several tiles at a readable size instead of one unreadable strip.
- SVGs have Mermaid's CSS resolved into plain attributes, so they look the same in Inkscape, PowerPoint, Figma or an image viewer as in a browser.
- Output is deterministic: the same code gives the same bytes.

### `validate_mermaid`

Parses without rendering, in milliseconds. Returns the diagram type, or the error with line, column, expected tokens and the syntax reference to read:

```json
{ "valid": false,
  "error": { "message": "Parse error on line 2: ...", "line": 2, "column": 4, "expected": ["link", "+", "-", "()", "ACTOR"] },
  "syntaxReference": "mermaid://syntax/sequence" }
```

### `generate` (0.x compatibility)

The original tool, with the same parameters and responses, now rendered without a browser. Prefer `render_mermaid`. Set `MERMAID_LEGACY_TOOL=false` to hide it.

## Resources

Mermaid's syntax reference for every diagram type, from the Mermaid docs, at `mermaid://syntax/<type>`: `flowchart`, `sequence`, `class`, `state`, `er`, `gantt`, `pie`, `mindmap`, `timeline`, `gitgraph`, `architecture`, `wardley`, `venn`, `kanban` and 20 more. Errors point to the one to read, which helps with the newer diagram types models haven't seen much of.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `MERMAID_OUTPUT_DIR` | unset | Files may only be written inside this directory (checked on the real path, so symlinks can't escape it) |
| `MERMAID_RENDER_TIMEOUT_MS` | 30000 | A render taking longer is stopped and the renderer restarted |
| `MERMAID_INLINE_MAX_PIXELS` | 1568 | Longest edge of images returned to the model |
| `MERMAID_FILE_MAX_PIXELS` | 8192 | Longest edge of saved PNGs |
| `MERMAID_LOG_VERBOSITY` | 2 | 0 (emergencies) to 5 (debug), to stderr |
| `MERMAID_LEGACY_TOOL` | true | Offer the 0.x `generate` tool |
| `CONTENT_IMAGE_SUPPORTED` | true | 0.x: when false, `generate` saves files and requires `name` and `folder` |

## Fonts

Text is measured and drawn with the font the diagram asks for, resolved the way Chromium resolves it: Mermaid's default `"trebuchet ms", verdana, arial, sans-serif` uses Trebuchet MS on macOS and Windows. When none of the listed fonts is installed, the bundled DejaVu Sans is used, so rendering works in a bare container. For CJK text or color emoji on Linux, install `fonts-noto-cjk` or `fonts-noto-color-emoji`.

## Docker

```bash
docker build -t mermaid-mcp .
docker run -i --rm mermaid-mcp
```

No browser and no system fonts needed in the image.

## Upgrading from 0.x

- Chrome is gone, so `PUPPETEER_EXECUTABLE_PATH`, `PUPPETEER_*` and `MERMAID_DISABLE_SANDBOX` no longer do anything.
- `generate` keeps its parameters and responses. PNGs are now capped at 8192px on the long side.
- HTML labels are off: labels are SVG text so they render outside browsers. Diagrams can't turn them back on (`htmlLabels` is a secure setting).

## How it works

Mermaid needs a browser for one thing: measuring. It asks how wide text is and how big shapes are, and lays out the diagram from the answers. This server answers those questions in Node the way Blink does. That covers font shaping with kerning, Chromium's rules for text boxes, baselines and empty shapes, and its incremental layout history, which is observable through `getBBox`. Every rule was found by probing Chromium and is checked against it continuously. [docs/design.md](docs/design.md) has the details and numbers.

## Development

```bash
npm ci
npm run build
npm test                      # engine rules + end-to-end server tests
node test/accuracy/run.mjs    # layouts vs Chromium on Mermaid's docs (needs Puppeteer's Chrome)
node test/accuracy/pixels.mjs # PNGs vs Chromium screenshots
node bench/e2e.mjs            # latency over stdio
```

Run with the MCP inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Releases: `scripts/release.sh <patch|minor|major|version>` tags and pushes; the publish workflow tests, builds and stages the package on npm for 2FA approval (trusted publishing, no token).

## License

MIT. Bundles DejaVu fonts (Bitstream Vera license, `assets/fonts/dejavu/LICENSE`) and Mermaid's syntax documentation (MIT, `assets/syntax/LICENSE`).

[![smithery badge](https://smithery.ai/badge/@peng-shawn/mermaid-mcp-server)](https://smithery.ai/server/@peng-shawn/mermaid-mcp-server)
