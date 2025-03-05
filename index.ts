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

/**
 * Mermaid MCP Server
 * 
 * This server provides a tool to render Mermaid diagrams as PNG images.
 * 
 * Environment Variables:
 * - MERMAID_LOG_VERBOSITY: Controls the verbosity of logging (default: 2)
 *   0 = EMERGENCY - Only the most critical errors
 *   1 = CRITICAL - Critical errors that require immediate attention
 *   2 = ERROR - Error conditions (default)
 *   3 = WARNING - Warning conditions
 *   4 = INFO - Informational messages
 *   5 = DEBUG - Debug-level messages
 * 
 * Example:
 *   MERMAID_LOG_VERBOSITY=2 node index.js  # Only show ERROR and more severe logs (default)
 *   MERMAID_LOG_VERBOSITY=4 node index.js  # Show INFO and more severe logs
 *   MERMAID_LOG_VERBOSITY=5 node index.js  # Show DEBUG and more severe logs
 */

// __dirname is not available in ESM modules by default
const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

// Define log levels with numeric values for comparison
enum LogLevel {
  EMERGENCY = 0,
  CRITICAL = 1,
  ERROR = 2,
  WARNING = 3,
  INFO = 4,
  DEBUG = 5,
}

// Get verbosity level from environment variable, default to ERROR (2)
const LOG_VERBOSITY = process.env.MERMAID_LOG_VERBOSITY 
  ? parseInt(process.env.MERMAID_LOG_VERBOSITY, 10) 
  : LogLevel.ERROR;

// Convert LogLevel to MCP log level string
function getMcpLogLevel(level: LogLevel): "error" | "info" | "debug" | "warning" | "critical" | "emergency" {
  switch (level) {
    case LogLevel.EMERGENCY: return "emergency";
    case LogLevel.CRITICAL: return "critical";
    case LogLevel.ERROR: return "error";
    case LogLevel.WARNING: return "warning";
    case LogLevel.DEBUG: return "debug";
    case LogLevel.INFO: 
    default: return "info";
  }
}

function log(level: LogLevel, message: string) {
  // Only log if the current level is less than or equal to the verbosity setting
  if (level <= LOG_VERBOSITY) {
    // Get the appropriate MCP log level
    const mcpLevel = getMcpLogLevel(level);
    
    server.sendLoggingMessage({
      level: mcpLevel,
      data: message
    });
    
    // Only console.error is consumed by MCP inspector
    console.error(`${LogLevel[level]} - ${message}`);
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
  }
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
  log(LogLevel.INFO, "Launching Puppeteer");
  log(LogLevel.DEBUG, `Rendering with config: ${JSON.stringify(config)}`);
  
  // Resolve the path to the local mermaid.js file
  const distPath = path.dirname(url.fileURLToPath(resolve('mermaid', import.meta.url)));
  const mermaidPath = path.resolve(distPath, 'mermaid.min.js');
  log(LogLevel.DEBUG, `Using Mermaid from: ${mermaidPath}`);

  const browser = await puppeteer.launch({
    headless: true,
  });
  
  // Declare page outside try block so it's accessible in catch and finally
  let page: puppeteer.Page | null = null;
  // Store console messages for error reporting
  const consoleMessages: string[] = [];
  
  try {
    page = await browser.newPage();
    log(LogLevel.DEBUG, "Browser page created");
    
    // Capture browser console messages for better error reporting
    page.on('console', (msg) => {
      const text = msg.text();
      consoleMessages.push(text);
      log(LogLevel.DEBUG, text);
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
    
    log(LogLevel.INFO, `Rendering mermaid code: ${code.substring(0, 50)}...`);
    log(LogLevel.DEBUG, `Full mermaid code: ${code}`);
    
    // Navigate to the HTML file
    await page.goto(`file://${tempHtmlPath}`);
    log(LogLevel.DEBUG, "Navigated to HTML template");
    
    // Add the mermaid script to the page
    await page.addScriptTag({ path: mermaidPath });
    log(LogLevel.DEBUG, "Added Mermaid script to page");
    
    // Render the mermaid diagram using a more robust approach similar to the CLI
    log(LogLevel.DEBUG, "Starting Mermaid rendering in browser");
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
      log(LogLevel.ERROR, `Mermaid rendering failed in browser: ${screenshot.error}`);
      throw new Error(`Mermaid rendering failed: ${screenshot.error}`);
    }
    
    log(LogLevel.DEBUG, "Mermaid rendered successfully in browser");
    
    // Take a screenshot of the SVG
    const svgElement = await page.$('#container svg');
    if (!svgElement) {
      log(LogLevel.ERROR, "SVG element not found after successful rendering");
      throw new Error('SVG element not found');
    }
    
    log(LogLevel.DEBUG, "Taking screenshot of SVG");
    // Take a screenshot with the correct dimensions
    const base64Image = await svgElement.screenshot({
      omitBackground: false,
      type: 'png',
      encoding: 'base64'
    });
    
    // Clean up the temporary file
    fs.unlinkSync(tempHtmlPath);
    log(LogLevel.DEBUG, "Temporary HTML file cleaned up");
    
    log(LogLevel.INFO, "Mermaid rendered successfully");
    
    return base64Image;
  } catch (error) {
    log(LogLevel.ERROR, `Error in renderMermaidPng: ${error instanceof Error ? error.message : String(error)}`);
    log(LogLevel.ERROR, `Error stack: ${error instanceof Error ? error.stack : 'No stack trace'}`);
    
    // Include console messages in the error for better debugging
    if (page && page.isClosed() === false) {
      log(LogLevel.ERROR, "Browser console messages:");
      consoleMessages.forEach(msg => log(LogLevel.ERROR, `  ${msg}`));
    }
    
    throw error;
  } finally {
    await browser.close();
    log(LogLevel.DEBUG, "Puppeteer browser closed");
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

    log(LogLevel.INFO, `Received request: ${name} with args: ${JSON.stringify(args)}`);

    if (name === "generate") {
      log(LogLevel.INFO, "Rendering Mermaid PNG");
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
  log(LogLevel.INFO, "Mermaid MCP Server running on stdio");
}

runServer().catch((error) => {
  log(LogLevel.CRITICAL, `Fatal error running server: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});