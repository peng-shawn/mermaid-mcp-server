// Drives a built Docker image over stdio like an MCP client would.
//   node test/docker-smoke.mjs [image]
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const image = process.argv[2] ?? "mermaid-mcp:test";
const client = new Client({ name: "docker-smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "docker", args: ["run", "-i", "--rm", image], stderr: "inherit" }));
const cases = {
  flowchart: "flowchart TD\n  A[Start] --> B{Valid?}\n  B -->|Yes| C[Done]",
  sequence: "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi",
  class: "classDiagram\n  Animal <|-- Dog",
  gantt: "gantt\n  dateFormat YYYY-MM-DD\n  section A\n  Task :a1, 2026-01-01, 3d",
};
for (const [name, code] of Object.entries(cases)) {
  const r = await client.callTool({ name: "render_mermaid", arguments: { code } });
  assert.ok(!r.isError, `${name}: ${JSON.stringify(r.content)}`);
  const png = Buffer.from(r.content.find((c) => c.type === "image").data, "base64");
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  console.log(`ok ${name} ${r.structuredContent.width}x${r.structuredContent.height}`);
}
const svg = await client.callTool({ name: "render_mermaid", arguments: { code: cases.flowchart, format: "svg" } });
assert.match(svg.content.find((c) => c.type === "resource").resource.text, /DejaVu Sans/, "falls back to the bundled font");
console.log("ok bundled font fallback");
await client.close();
