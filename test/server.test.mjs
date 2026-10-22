// End-to-end: the built server, spoken to over stdio by the MCP client SDK.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const SERVER = new URL("../dist/index.js", import.meta.url).pathname;
const PNG_SIGNATURE = "89504e470d0a1a0a";

async function connect(env = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...process.env, MERMAID_LOG_VERBOSITY: "0", ...env }, stderr: "ignore" });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return { client, transport };
}

const call = (client, name, args) => client.callTool({ name, arguments: args });
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const images = (r) => r.content.filter((c) => c.type === "image").map((c) => Buffer.from(c.data, "base64"));
const pngSize = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];

let client, transport, tmp;
before(async () => {
  ({ client, transport } = await connect());
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mermaid-mcp-test-"));
});
after(async () => {
  await client?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("advertises tools, annotations and syntax resources", async () => {
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ["generate", "render_mermaid", "validate_mermaid"]);
  assert.equal(byName.validate_mermaid.annotations.readOnlyHint, true);
  assert.ok(byName.render_mermaid.outputSchema, "render_mermaid has an output schema");
  const { resources } = await client.listResources();
  assert.ok(resources.length >= 30);
  const pie = await client.readResource({ uri: "mermaid://syntax/pie" });
  assert.match(pie.contents[0].text, /pie/i);
});

test("renders PNG with structured output", async () => {
  const r = await call(client, "render_mermaid", { code: "flowchart LR\n  A[Start] --> B[End]" });
  assert.ok(!r.isError, text(r));
  const [png] = images(r);
  assert.equal(png.subarray(0, 8).toString("hex"), PNG_SIGNATURE);
  const { diagramType, width, height, format } = r.structuredContent;
  assert.equal(diagramType, "flowchart-v2");
  assert.equal(format, "png");
  const [pw, ph] = pngSize(png);
  assert.ok(Math.abs(pw - width * 2) <= 2 && Math.abs(ph - height * 2) <= 2, `${pw}x${ph} for ${width}x${height} at 2x`);
});

test("renders portable SVG: no <style>, concrete size", async () => {
  const r = await call(client, "render_mermaid", { code: "classDiagram\n  Animal <|-- Dog", format: "svg" });
  assert.ok(!r.isError, text(r));
  const svg = r.content.find((c) => c.type === "resource").resource.text;
  assert.match(svg, /^<svg[^>]*\swidth="\d+"[^>]*\sheight="\d+"/);
  assert.doesNotMatch(svg, /<style/);
  assert.doesNotMatch(svg, /<foreignObject/);
});

test("same input, same bytes", async () => {
  const code = "gitGraph\n  commit\n  branch dev\n  commit\n  checkout main\n  merge dev";
  const a = images(await call(client, "render_mermaid", { code }))[0];
  const b = images(await call(client, "render_mermaid", { code }))[0];
  assert.ok(a.equals(b));
});

test("validate_mermaid reports positions and the syntax reference", async () => {
  const ok = await call(client, "validate_mermaid", { code: "sequenceDiagram\n  A->>B: hi" });
  assert.deepEqual(ok.structuredContent, { valid: true, diagramType: "sequence", syntaxReference: "mermaid://syntax/sequence" });
  const bad = await call(client, "validate_mermaid", { code: "sequenceDiagram\n  A->>: hi" });
  assert.equal(bad.structuredContent.valid, false);
  assert.equal(bad.structuredContent.error.line, 2);
  assert.ok(bad.structuredContent.error.expected.length > 0);
  const pie = await call(client, "validate_mermaid", { code: 'pie\n  "Dogs" 386' });
  assert.equal(pie.structuredContent.error.line, 2);
  assert.equal(pie.structuredContent.syntaxReference, "mermaid://syntax/pie");
});

test("render errors are tool errors with guidance", async () => {
  const r = await call(client, "render_mermaid", { code: "flowchart TD\n  A --> " });
  assert.equal(r.isError, true);
  assert.match(text(r), /syntax error, line \d+/i);
  assert.match(text(r), /mermaid:\/\/syntax\/flowchart/);
  const bad = await call(client, "render_mermaid", { code: "flowchart LR\n A-->B", background: "red; fill: url(x)" });
  assert.equal(bad.isError, true);
});

test("saves files safely", async () => {
  const target = path.join(tmp, "out", "d.png");
  const first = await call(client, "render_mermaid", { code: "flowchart LR\n A-->B", outputPath: target });
  assert.equal(first.structuredContent.path, target);
  assert.equal(images(first).length, 0, "no image unless includeImage");
  assert.equal(fs.readFileSync(target).subarray(0, 8).toString("hex"), PNG_SIGNATURE);
  const second = await call(client, "render_mermaid", { code: "flowchart LR\n A-->B", outputPath: target, includeImage: true });
  assert.equal(second.structuredContent.path, path.join(tmp, "out", "d-1.png"));
  assert.equal(images(second).length, 1);
  for (const outputPath of ["relative/d.png", path.join(tmp, "d.svg")]) {
    const r = await call(client, "render_mermaid", { code: "flowchart LR\n A-->B", outputPath });
    assert.equal(r.isError, true, outputPath);
  }
});

test("MERMAID_OUTPUT_DIR confines writes, through symlinks too", async () => {
  const root = path.join(tmp, "allowed");
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, "escape"));
  const { client: c } = await connect({ MERMAID_OUTPUT_DIR: root });
  try {
    const ok = await call(c, "render_mermaid", { code: "flowchart LR\n A-->B", outputPath: path.join(root, "ok.svg"), format: "svg" });
    assert.ok(!ok.isError, text(ok));
    for (const p of [path.join(outside, "x.svg"), path.join(root, "..", "x.svg"), path.join(root, "escape", "x.svg")]) {
      const r = await call(c, "render_mermaid", { code: "flowchart LR\n A-->B", outputPath: p, format: "svg" });
      assert.equal(r.isError, true, p);
    }
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    await c.close();
  }
});

test("tall diagrams come back as legible tiles", async () => {
  const lines = ["sequenceDiagram", ...Array.from({ length: 120 }, (_, i) => `  A->>B: message ${i}`)];
  const r = await call(client, "render_mermaid", { code: lines.join("\n") });
  const tiles = images(r);
  assert.ok(tiles.length > 1 && tiles.length <= 6, `${tiles.length} tiles`);
  for (const t of tiles) assert.ok(Math.max(...pngSize(t)) <= 1568);
  assert.match(text(r), /top-to-bottom parts/);
});

test("legacy generate keeps the 0.x contract", async () => {
  const r = await call(client, "generate", { code: "flowchart LR\n A-->B" });
  assert.equal(text(r), "Here is the generated image");
  assert.equal(images(r).length, 1);
  const svg = await call(client, "generate", { code: "flowchart LR\n A-->B", outputFormat: "svg" });
  assert.match(text(svg), /^Here is the generated SVG:\n\n<svg/);
  const { client: c } = await connect({ CONTENT_IMAGE_SUPPORTED: "false" });
  try {
    const saved = await call(c, "generate", { code: "flowchart LR\n A-->B", name: "legacy", folder: tmp });
    assert.equal(text(saved), `PNG saved to: ${path.join(tmp, "legacy.png")}`);
    const missing = await call(c, "generate", { code: "flowchart LR\n A-->B" });
    assert.equal(missing.isError, true);
  } finally {
    await c.close();
  }
});

test("survives the renderer crashing mid-render", async () => {
  const { client: c, transport: t } = await connect();
  try {
    await call(c, "render_mermaid", { code: "flowchart LR\n A-->B" });
    const child = () => execFileSync("pgrep", ["-P", String(t.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const lines = ["flowchart TD", ...Array.from({ length: 400 }, (_, i) => `  N${i} --> N${i + 1}`)];
    const pending = call(c, "render_mermaid", { code: lines.join("\n") });
    await new Promise((r) => setTimeout(r, 100));
    for (const pid of child()) process.kill(Number(pid), "SIGKILL");
    const crashed = await pending;
    assert.equal(crashed.isError, true);
    assert.match(text(crashed), /crashed/);
    const after = await call(c, "render_mermaid", { code: "flowchart LR\n A-->B" });
    assert.ok(!after.isError, text(after));
  } finally {
    await c.close();
  }
});

test("stops runaway renders and recovers", async () => {
  const { client: c } = await connect({ MERMAID_RENDER_TIMEOUT_MS: "1000" });
  try {
    await call(c, "validate_mermaid", { code: "flowchart LR\n A-->B" }); // worker warm
    // 40 subgraphs of 10 nodes: several seconds of layout
    const lines = ["flowchart TD", ...Array.from({ length: 40 }, (_, g) => [`  subgraph S${g}`, ...Array.from({ length: 10 }, (_, i) => `    G${g}N${i} --> G${g}N${(i + 1) % 10}`), "  end"]).flat()];
    const slow = await call(c, "render_mermaid", { code: lines.join("\n") });
    assert.equal(slow.isError, true);
    assert.match(text(slow), /longer than 1s/);
    const after = await call(c, "render_mermaid", { code: "flowchart LR\n A-->B" });
    assert.ok(!after.isError, text(after));
  } finally {
    await c.close();
  }
});
