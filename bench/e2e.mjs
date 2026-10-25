// End-to-end latency as an MCP client sees it: spawn the server, connect,
// first render (cold), then warm renders, over stdio.
//
//   node bench/e2e.mjs [server entry] [--tool generate|render_mermaid] [--env K=V ...]
//
// Defaults to this checkout's dist/index.js with render_mermaid. Pass another
// server (e.g. a 0.x install) to compare.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import cases from "./cases.mjs";

const args = process.argv.slice(2);
const entry = args[0] && !args[0].startsWith("--") ? args[0] : new URL("../dist/index.js", import.meta.url).pathname;
const tool = args.includes("--tool") ? args[args.indexOf("--tool") + 1] : "render_mermaid";
const env = { ...process.env };
for (let i = 0; i < args.length; i++) if (args[i] === "--env") Object.assign(env, Object.fromEntries([args[i + 1].split("=")]));
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const t0 = performance.now();
const client = new Client({ name: "bench", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: "ignore" }));
const connected = performance.now() - t0;
const render = async (code) => {
  const t = performance.now();
  const r = await client.callTool({ name: tool, arguments: { code } });
  if (r.isError) throw new Error(r.content.map((c) => c.text).join(" "));
  return performance.now() - t;
};
const first = await render(cases.small);
console.log(`connect ${connected.toFixed(0)}ms, first render ${first.toFixed(0)}ms (cold start ${(connected + first).toFixed(0)}ms)`);
for (const [name, code] of Object.entries(cases)) {
  const times = [];
  for (let i = 0; i < 3; i++) times.push(await render(code));
  console.log(`${name.padEnd(13)} ${median(times).toFixed(0).padStart(6)}ms`);
}
const t = performance.now();
await Promise.all(Array.from({ length: 8 }, (_, i) => render(`flowchart LR\n  A${i} --> B${i} --> C${i}`)));
console.log(`8 concurrent small renders: ${(performance.now() - t).toFixed(0)}ms`);
await client.close();
