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
  // Map browser level to info for MCP logging
  const mcpLevel = level === "browser" ? "info" : level as "error" | "info" | "debug" | "warning" | "critical" | "emergency";
  
  server.sendLoggingMessage({
    level: mcpLevel,
    data: message
  });
  
  // Use different console methods based on level
  if (level === "error") {
    console.error(`${level} - ${message}`);
  } else if (level === "browser") {
    console.log(`browser - ${message}`);
  } else {
    console.log(`${level} - ${message}`);
  }
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
      theme: {
        type: "string",
        enum: ["default", "forest", "dark", "neutral"],
        description: "Theme for the diagram (optional)"
      },
      backgroundColor: {
        type: "string",
        description: "Background color for the diagram, e.g. 'white', 'transparent', '#F0F0F0' (optional)"
      }
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
  theme?: 'default' | 'forest' | 'dark' | 'neutral';
  backgroundColor?: string;
} {
  return (
    typeof args === 'object' &&
    args !== null &&
    'code' in args &&
    typeof (args as any).code === 'string' &&
    (!(args as any).theme || ['default', 'forest', 'dark', 'neutral'].includes((args as any).theme)) &&
    (!(args as any).backgroundColor || typeof (args as any).backgroundColor === 'string')
  );
}

async function renderMermaidPng(code: string, config: {
  theme?: 'default' | 'forest' | 'dark' | 'neutral';
  backgroundColor?: string;
} = {}): Promise<string> {
  log("info", "Launching Puppeteer");
  
  // Resolve the path to the local mermaid.js file
  const distPath = path.dirname(url.fileURLToPath(resolve('mermaid', import.meta.url)));
  const mermaidPath = path.resolve(distPath, 'mermaid.min.js');

  const browser = await puppeteer.launch({
    headless: true,
  });
  
  // Declare page outside try block so it's accessible in catch and finally
  let page: puppeteer.Page | null = null;
  // Store console messages for error reporting
  const consoleMessages: string[] = [];
  
  try {
    page = await browser.newPage();
    
    // Capture browser console messages for better error reporting
    page.on('console', (msg) => {
      const text = msg.text();
      consoleMessages.push(text);
      log("browser", text);
    });
    
    // Create a simple HTML template without the CDN reference
    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Mermaid Renderer</title>
      <style>
        body { 
          background: ${config.backgroundColor || 'white'};
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
      <div id="container"></div>
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
    
    // Render the mermaid diagram using a more robust approach similar to the CLI
    const screenshot = await page.$eval('#container', async (container, mermaidCode, mermaidConfig) => {
      try {
        // @ts-ignore - mermaid is loaded by the script tag
        window.mermaid.initialize({
          startOnLoad: false,
          theme: mermaidConfig.theme || 'default',
          securityLevel: 'loose',
          logLevel: 5
        });
        
        // This will throw an error if the mermaid syntax is invalid
        // @ts-ignore - mermaid is loaded by the script tag
        const { svg: svgText } = await window.mermaid.render('mermaid-svg', mermaidCode, container);
        container.innerHTML = svgText;
        
        const svg = container.querySelector('svg');
        if (!svg) {
          throw new Error('SVG element not found after rendering');
        }
        
        // Apply any necessary styling to the SVG
        svg.style.backgroundColor = mermaidConfig.backgroundColor || 'white';
        
        // Return the dimensions for screenshot
        const rect = svg.getBoundingClientRect();
        return {
          width: Math.ceil(rect.width),
          height: Math.ceil(rect.height),
          success: true
        };
      } catch (error) {
        // Return the error to be handled outside
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }, code, { theme: config.theme, backgroundColor: config.backgroundColor });
    
    // Check if rendering was successful
    if (!screenshot.success) {
      throw new Error(`Mermaid rendering failed: ${screenshot.error}`);
    }
    
    // Take a screenshot of the SVG
    const svgElement = await page.$('#container svg');
    if (!svgElement) {
      throw new Error('SVG element not found');
    }
    
    // Take a screenshot with the correct dimensions
    const base64Image = await svgElement.screenshot({
      omitBackground: false,
      type: 'png',
      encoding: 'base64'
    });
    
    // Clean up the temporary file
    fs.unlinkSync(tempHtmlPath);
    
    log("info", "Mermaid rendered successfully");
    
    return base64Image;
  } catch (error) {
    log("error", `Error in renderMermaidPng: ${error instanceof Error ? error.message : String(error)}`);
    log("error", `Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`);
    
    // Include console messages in the error for better debugging
    if (page && page.isClosed() === false) {
      log("error", "Browser console messages:");
      consoleMessages.forEach(msg => log("error", `  ${msg}`));
    }
    
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
      
      try {
        const base64Image = await renderMermaidPng(args.code, {
          theme: args.theme,
          backgroundColor: args.backgroundColor
        });
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
      } catch (error) {
        // Specific handling for Mermaid syntax errors
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isSyntaxError = errorMessage.includes("Syntax error") || 
                             errorMessage.includes("Parse error") || 
                             errorMessage.includes("Mermaid rendering failed");
        
        return {
          content: [
            {
              type: "text",
              text: isSyntaxError 
                ? `Mermaid syntax error: ${errorMessage}\n\nPlease check your diagram syntax.` 
                : `Error generating diagram: ${errorMessage}`,
            }
          ],
          isError: true,
        };
      }
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