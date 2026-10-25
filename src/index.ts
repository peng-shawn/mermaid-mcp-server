#!/usr/bin/env node
// Mermaid MCP server over stdio.
import fs from "fs";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { Renderer } from "./renderer.js";
import { createServer } from "./server.js";

const LEVELS = ["EMERGENCY", "CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"];

function packageVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return pkg.version;
}

async function main(): Promise<void> {
  const config = loadConfig();
  // stdout carries the protocol; logs go to stderr
  const log = (level: number, message: string) => {
    if (level <= config.logVerbosity) process.stderr.write(`${LEVELS[level]} - ${message}\n`);
  };
  const renderer = new Renderer({ timeoutMs: config.renderTimeoutMs, log: (m) => log(3, m) });
  // Load Mermaid and index fonts while the client is still connecting
  renderer.start().then(
    () => log(4, "renderer ready"),
    (err) => log(1, `renderer failed to start: ${err instanceof Error ? err.message : err}`)
  );
  const server = createServer(renderer, config, packageVersion());
  await server.connect(new StdioServerTransport());
  log(4, "Mermaid MCP server running on stdio");

  const shutdown = async () => {
    await renderer.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((err) => {
  process.stderr.write(`CRITICAL - ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
