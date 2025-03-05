#!/usr/bin/env node

import puppeteer from 'puppeteer';
import path from 'path';
import url from 'url';
import fs from 'fs';
import { resolve } from 'import-meta-resolve';
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

// __dirname is not available in ESM modules by default
const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

function log(level: string, message: string) {
  server.sendLoggingMessage({
    level: level as "error" | "info" | "debug" | "warning" | "critical" | "emergency",
    data: message
  });
  console.error(`${level} - ${message}`);
}

// Define tools
const GENERATE_TOOL: Tool = {
  name: "generate",
  description: "Generate PNG image from mermaid markdown",
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "The mermaid markdown to generate an image from"
      },
    },
    required: ["code"]
  }
};

// Server implementation
const server = new Server(
  {
    name: "mermaid-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      logging: {}
    },
  },
);

function isGenerateArgs(args: unknown): args is {
  code: string;
} {
  return typeof args === "object" && args !== null && "code" in args;
}

async function renderMermaidPng(code: string): Promise<string> {
  log("info", "Launching Puppeteer");
  
  // Resolve the path to the local mermaid.js file
  const distPath = path.dirname(url.fileURLToPath(resolve('mermaid', import.meta.url)));
  const mermaidPath = path.resolve(distPath, 'mermaid.min.js');

  const browser = await puppeteer.launch({
    headless: true,
  });
  
  try {
    const page = await browser.newPage();
    
    // Create a simple HTML template without the CDN reference
    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Mermaid Renderer</title>
      <style>
        body { 
          background: white;
          margin: 0;
          padding: 0;
        }
        #container {
          padding: 0;
          margin: 0;
        }
      </style>
    </head>
    <body>
      <div id="container" class="mermaid">
        ${code}
      </div>
    </body>
    </html>
    `;
    
    // Write the HTML to a temporary file
    const tempHtmlPath = path.join(__dirname, 'temp-mermaid.html');
    fs.writeFileSync(tempHtmlPath, htmlContent);
    
    log("info", `Rendering mermaid code: ${code.substring(0, 50)}...`);
    
    // Navigate to the HTML file
    await page.goto(`file://${tempHtmlPath}`);
    
    // Add the mermaid script to the page
    await page.addScriptTag({ path: mermaidPath });
    
    // Initialize mermaid
    await page.evaluate(() => {
      // @ts-ignore - mermaid is loaded by the script tag
      window.mermaid.initialize({
        startOnLoad: true,
        theme: 'default',
        securityLevel: 'loose',
        logLevel: 5
      });
      // @ts-ignore - mermaid is loaded by the script tag
      window.mermaid.init(undefined, document.querySelector('.mermaid'));
    });
    
    // Wait for mermaid to render
    await page.waitForSelector('.mermaid svg');
    
    // Get the SVG element
    const svgElement = await page.$('.mermaid svg');
    if (!svgElement) {
      throw new Error('SVG element not found');
    }
    
    // Get the bounding box of the SVG
    const boundingBox = await svgElement.boundingBox();
    if (!boundingBox) {
      throw new Error('Could not get SVG bounding box');
    }
    
    // Take a screenshot of just the SVG
    const screenshot = await svgElement.screenshot({
      omitBackground: false,
      type: 'png',
      encoding: 'base64'
    });
    
    // Clean up the temporary file
    fs.unlinkSync(tempHtmlPath);
    
    log("info", "Mermaid rendered successfully");
    
    return screenshot;
  } catch (error) {
    log("error", `Error in renderMermaidPng: ${error instanceof Error ? error.message : String(error)}`);
    log("error", `Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`);
    throw error;
  } finally {
    await browser.close();
    log("info", "Puppeteer browser closed");
  }
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [GENERATE_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (!args) {
      throw new Error("No arguments provided");
    }

    log("info", `Received request: ${name} with args: ${JSON.stringify(args)}`);

    if (name === "generate") {
      log("info", "Rendering Mermaid PNG");
      if (!isGenerateArgs(args)) {
        throw new Error("Invalid arguments for generate");
      }
      const base64Image = await renderMermaidPng(args.code);
      return {
        content: [
          {
            type: "text",
            text: "Here is the generated image",
          },
          {
            type: "image",
            data: base64Image,
            mimeType: "image/png",
          },
        ],
        isError: false,
      };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Mermaid MCP Server running on stdio");
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});