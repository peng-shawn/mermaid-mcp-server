// Sustained load: renders the docs corpus repeatedly through one server and
// samples the render process's memory, to check that recycling bounds it.
//   node bench/soak.mjs [renders]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const total = Number(process.argv[2] ?? 600);
const corpus = Object.values(JSON.parse(fs.readFileSync(new URL("../test/accuracy/corpus-docs.json", import.meta.url), "utf8")));
const transport = new StdioClientTransport({ command: process.execPath, args: [new URL("../dist/index.js", import.meta.url).pathname], stderr: "ignore" });
const client = new Client({ name: "soak", version: "0" });
await client.connect(transport);
const rss = () => {
  try {
    const pids = execFileSync("pgrep", ["-P", String(transport.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    return pids.map((p) => Number(execFileSync("ps", ["-o", "rss=", "-p", p], { encoding: "utf8" }).trim()) / 1024).reduce((a, b) => a + b, 0);
  } catch {
    return 0;
  }
};
let errors = 0;
const t0 = performance.now();
for (let i = 0; i < total; i++) {
  const r = await client.callTool({ name: "render_mermaid", arguments: { code: corpus[i % corpus.length] } });
  if (r.isError && !/syntax|No diagram type/i.test(r.content[0].text)) errors++;
  if (i % 50 === 0) console.log(`render ${String(i).padStart(4)}  worker RSS ${rss().toFixed(0)} MB`);
}
console.log(`${total} renders in ${((performance.now() - t0) / 1000).toFixed(0)}s, ${errors} non-syntax errors, final worker RSS ${rss().toFixed(0)} MB`);
await client.close();
