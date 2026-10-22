#!/usr/bin/env node

import puppeteer, { type Page } from "puppeteer";
import path from "path";
import url from "url";
import fs from "fs";
import { resolve } from "import-meta-resolve";
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
 * This server provides a tool to render Mermaid diagrams as PNG images or SVG files.
 *
 * Environment Variables:
 * - MERMAID_LOG_VERBOSITY: Controls the verbosity of logging (default: 2)
 *   0 = EMERGENCY - Only the most critical errors
 *   1 = CRITICAL - Critical errors that require immediate attention
 *   2 = ERROR - Error conditions (default)
 *   3 = WARNING - Warning conditions
 *   4 = INFO - Informational messages
 *   5 = DEBUG - Debug-level messages
 * - CONTENT_IMAGE_SUPPORTED: Controls whether images can be returned directly in the response (default: true)
 *   When set to 'false', the 'name' and 'folder' parameters become mandatory, and all images must be saved to disk.
 * - MERMAID_OUTPUT_DIR: If set, 'folder' must resolve to this directory or a subdirectory of it (default: unset)
 * - MERMAID_DISABLE_SANDBOX: Set to 'true' to launch Chromium with --no-sandbox (default: false).
 *   Only use this when the sandbox cannot work, e.g. in a container running as root.
 *
 * Example:
 *   MERMAID_LOG_VERBOSITY=2 node index.js  # Only show ERROR and more severe logs (default)
 *   MERMAID_LOG_VERBOSITY=4 node index.js  # Show INFO and more severe logs
 *   MERMAID_LOG_VERBOSITY=5 node index.js  # Show DEBUG and more severe logs
 *   CONTENT_IMAGE_SUPPORTED=false node index.js  # Require all images to be saved to disk
 *
 * Tool Parameters:
 * - code: The mermaid markdown to generate an image from (required)
 * - theme: Theme for the diagram (optional, one of: "default", "forest", "dark", "neutral")
 * - backgroundColor: Background color for the diagram (optional, e.g., "white", "transparent", "#F0F0F0")
 * - outputFormat: Output format for the diagram (optional, "png" or "svg", defaults to "png")
 * - name: Name for the generated file (required when saving to folder or when CONTENT_IMAGE_SUPPORTED=false)
 * - folder: Folder path to save the image to (optional, but required when CONTENT_IMAGE_SUPPORTED=false)
 *
 * File Saving Behavior:
 * - When 'folder' is specified, the image will be saved to disk instead of returned in the response
 * - The 'name' parameter is required when 'folder' is specified
 * - If a file with the same name already exists, a timestamp will be appended to the filename
 * - When CONTENT_IMAGE_SUPPORTED=false, all images must be saved to disk, and 'name' and 'folder' are required
 * - SVG files are saved as .svg text files, PNG files are saved as .png binary files
 */

// Define log levels with numeric values for comparison
enum LogLevel {
  EMERGENCY = 0,
  CRITICAL = 1,
  ERROR = 2,
  WARNING = 3,
  INFO = 4,
  DEBUG = 5,
}

// Get verbosity level from environment variable, default to INFO (4)
const LOG_VERBOSITY = process.env.MERMAID_LOG_VERBOSITY
  ? parseInt(process.env.MERMAID_LOG_VERBOSITY, 10)
  : LogLevel.ERROR;

// Check if content images are supported (default: true)
const CONTENT_IMAGE_SUPPORTED = process.env.CONTENT_IMAGE_SUPPORTED !== "false";

// Optional base directory that all saved files must live under
const OUTPUT_DIR = process.env.MERMAID_OUTPUT_DIR
  ? path.resolve(process.env.MERMAID_OUTPUT_DIR)
  : undefined;

// Chromium sandbox is on unless explicitly disabled
const DISABLE_SANDBOX = process.env.MERMAID_DISABLE_SANDBOX === "true";

// Upper bounds to keep a single request from exhausting resources
const MAX_CODE_LENGTH = 100_000;
const RENDER_TIMEOUT_MS = 30_000;

// Accepts named colors, hex colors and rgb()/rgba()/hsl()/hsla() with numeric arguments
const COLOR_PATTERN =
  /^(?:[a-zA-Z]{1,30}|#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%]+(?:\s*[,\s/]\s*[0-9.%]+){2,3}\s*\))$/;

// File names may only contain safe characters and must not start with a dot
const NAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;

// Convert LogLevel to MCP log level string
function getMcpLogLevel(
  level: LogLevel
): "error" | "info" | "debug" | "warning" | "critical" | "emergency" {
  switch (level) {
    case LogLevel.EMERGENCY:
      return "emergency";
    case LogLevel.CRITICAL:
      return "critical";
    case LogLevel.ERROR:
      return "error";
    case LogLevel.WARNING:
      return "warning";
    case LogLevel.DEBUG:
      return "debug";
    case LogLevel.INFO:
    default:
      return "info";
  }
}

function log(level: LogLevel, message: string) {
  // Only log if the current level is less than or equal to the verbosity setting
  if (level <= LOG_VERBOSITY) {
    // Get the appropriate MCP log level
    const mcpLevel = getMcpLogLevel(level);

    server.sendLoggingMessage({
      level: mcpLevel,
      data: message,
    });

    // Only console.error is consumed by MCP inspector
    console.error(`${LogLevel[level]} - ${message}`);
  }
}

// Define tools
const GENERATE_TOOL: Tool = {
  name: "generate",
  description: "Generate PNG image or SVG from mermaid markdown",
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "The mermaid markdown to generate an image from",
      },
      theme: {
        type: "string",
        enum: ["default", "forest", "dark", "neutral"],
        description: "Theme for the diagram (optional)",
      },
      backgroundColor: {
        type: "string",
        description:
          "Background color for the diagram, e.g. 'white', 'transparent', '#F0F0F0' (optional)",
      },
      outputFormat: {
        type: "string",
        enum: ["png", "svg"],
        description: "Output format for the diagram (optional, defaults to 'png')",
      },
      name: {
        type: "string",
        description: CONTENT_IMAGE_SUPPORTED
          ? "Name of the diagram (optional)"
          : "Name for the generated file (required)",
      },
      folder: {
        type: "string",
        description: CONTENT_IMAGE_SUPPORTED
          ? "Absolute path to save the image to (optional)"
          : "Absolute path to save the image to (required)",
      },
    },
    required: CONTENT_IMAGE_SUPPORTED ? ["code"] : ["code", "name", "folder"],
  },
};

// Server implementation
const server = new Server(
  {
    name: "mermaid-mcp-server",
    version: "0.3.0",
  },
  {
    capabilities: {
      tools: {},
      logging: {},
    },
  }
);

function isGenerateArgs(args: unknown): args is {
  code: string;
  theme?: "default" | "forest" | "dark" | "neutral";
  backgroundColor?: string;
  outputFormat?: "png" | "svg";
  name?: string;
  folder?: string;
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "code" in args &&
    typeof (args as any).code === "string" &&
    (!(args as any).theme ||
      ["default", "forest", "dark", "neutral"].includes((args as any).theme)) &&
    (!(args as any).backgroundColor ||
      (typeof (args as any).backgroundColor === "string" &&
        COLOR_PATTERN.test((args as any).backgroundColor))) &&
    (!(args as any).outputFormat ||
      ["png", "svg"].includes((args as any).outputFormat)) &&
    (args as any).code.length <= MAX_CODE_LENGTH &&
    (!(args as any).name || typeof (args as any).name === "string") &&
    (!(args as any).folder || typeof (args as any).folder === "string")
  );
}

async function renderMermaid(
  code: string,
  config: {
    theme?: "default" | "forest" | "dark" | "neutral";
    backgroundColor?: string;
    outputFormat?: "png" | "svg";
  } = {}
): Promise<{ data: string; svg?: string }> {
  log(LogLevel.INFO, "Launching Puppeteer");
  log(LogLevel.DEBUG, `Rendering with config: ${JSON.stringify(config)}`);

  // Resolve the path to the local mermaid.js file
  const distPath = path.dirname(
    url.fileURLToPath(resolve("mermaid", import.meta.url))
  );
  const mermaidPath = path.resolve(distPath, "mermaid.min.js");
  log(LogLevel.DEBUG, `Using Mermaid from: ${mermaidPath}`);

  const browser = await puppeteer.launch({
    headless: true,
    // Use the bundled browser instead of looking for Chrome on the system
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: DISABLE_SANDBOX ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });

  // Declare page outside try block so it's accessible in catch and finally
  let page: Page | null = null;
  // Store console messages for error reporting
  const consoleMessages: string[] = [];

  try {
    page = await browser.newPage();
    log(LogLevel.DEBUG, "Browser page created");

    // Capture browser console messages for better error reporting
    page.on("console", (msg) => {
      const text = msg.text();
      consoleMessages.push(text);
      log(LogLevel.DEBUG, text);
    });

    page.setDefaultTimeout(RENDER_TIMEOUT_MS);

    // Block all network and file access; the page only needs inline content
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const reqUrl = req.url();
      if (reqUrl.startsWith("data:") || reqUrl === "about:blank") {
        req.continue();
      } else {
        log(LogLevel.WARNING, `Blocked request from renderer: ${reqUrl}`);
        req.abort();
      }
    });

    // Static HTML template; user-supplied values are never interpolated into it
    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Mermaid Renderer</title>
      <style>
        body {
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
    // Note: Must be set before loading content to ensure the page renders with the correct dimensions from the start
    await page.setViewport({
      width: 1200, // Keep the same viewport size as before
      height: 800,
      deviceScaleFactor: 3, // 2~4 is fine, the larger the PNG, the clearer and larger it is
    });

    log(LogLevel.INFO, `Rendering mermaid code: ${code.substring(0, 50)}...`);
    log(LogLevel.DEBUG, `Full mermaid code: ${code}`);

    // Load the template in-memory (about:blank origin) rather than from a file:// URL
    await page.setContent(htmlContent);
    log(LogLevel.DEBUG, "Loaded HTML template");

    // Add the mermaid script to the page
    await page.addScriptTag({ path: mermaidPath });
    log(LogLevel.DEBUG, "Added Mermaid script to page");

    // Render the mermaid diagram using a more robust approach similar to the CLI
    log(LogLevel.DEBUG, "Starting Mermaid rendering in browser");
    const screenshot = await page.$eval(
      "#container",
      async (container, mermaidCode, mermaidConfig) => {
        try {
          // Set via the style API so the value is never parsed as HTML/CSS source
          document.body.style.background =
            mermaidConfig.backgroundColor || "white";

          // @ts-ignore - mermaid is loaded by the script tag
          window.mermaid.initialize({
            startOnLoad: false,
            theme: mermaidConfig.theme || "default",
            securityLevel: "strict",
            logLevel: 5,
          });

          // This will throw an error if the mermaid syntax is invalid
          // @ts-ignore - mermaid is loaded by the script tag
          const { svg: svgText } = await window.mermaid.render(
            "mermaid-svg",
            mermaidCode,
            container
          );
          container.innerHTML = svgText;

          const svg = container.querySelector("svg");
          if (!svg) {
            throw new Error("SVG element not found after rendering");
          }

          // Apply any necessary styling to the SVG
          svg.style.backgroundColor = mermaidConfig.backgroundColor || "white";

          // Return the dimensions for screenshot
          const rect = svg.getBoundingClientRect();
          return {
            width: Math.ceil(rect.width),
            height: Math.ceil(rect.height),
            success: true,
          };
        } catch (error) {
          // Return the error to be handled outside
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      code,
      { theme: config.theme, backgroundColor: config.backgroundColor }
    );

    // Check if rendering was successful
    if (!screenshot.success) {
      log(
        LogLevel.ERROR,
        `Mermaid rendering failed in browser: ${screenshot.error}`
      );
      throw new Error(`Mermaid rendering failed: ${screenshot.error}`);
    }

    log(LogLevel.DEBUG, "Mermaid rendered successfully in browser");

    // Get the SVG content if needed
    let svgContent: string | undefined;
    if (config.outputFormat === "svg") {
      svgContent = await page.$eval("#container svg", (svg) => {
        return svg.outerHTML;
      });
      log(LogLevel.DEBUG, "SVG content extracted");
    }

    // Take a screenshot of the SVG for PNG output
    let base64Image = "";
    if (config.outputFormat === "png" || config.outputFormat === undefined) {
      const svgElement = await page.$("#container svg");
      if (!svgElement) {
        log(LogLevel.ERROR, "SVG element not found after successful rendering");
        throw new Error("SVG element not found");
      }

      log(LogLevel.DEBUG, "Taking screenshot of SVG");
      // Take a screenshot with the correct dimensions
      base64Image = await svgElement.screenshot({
        omitBackground: false,
        type: "png",
        encoding: "base64",
      });
    }

    log(LogLevel.INFO, "Mermaid rendered successfully");

    return { data: base64Image, svg: svgContent };
  } catch (error) {
    log(
      LogLevel.ERROR,
      `Error in renderMermaid: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    log(
      LogLevel.ERROR,
      `Error stack: ${error instanceof Error ? error.stack : "No stack trace"}`
    );

    // Include console messages in the error for better debugging
    if (page && page.isClosed() === false) {
      log(LogLevel.ERROR, "Browser console messages:");
      consoleMessages.forEach((msg) => log(LogLevel.ERROR, `  ${msg}`));
    }

    throw error;
  } finally {
    await browser.close();
    log(LogLevel.DEBUG, "Puppeteer browser closed");
  }
}

/**
 * Validates the requested output location and returns the resolved folder
 *
 * @param name - The name to use for the file (without extension)
 * @param folder - The folder to save the file in
 * @returns The resolved absolute folder path
 */
function resolveOutputFolder(name: string, folder: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      "Invalid name: use only letters, digits, '.', '_' and '-' (no path separators, must not start with '.')"
    );
  }
  if (!path.isAbsolute(folder)) {
    throw new Error("Invalid folder: must be an absolute path");
  }

  const resolved = path.resolve(folder);
  if (OUTPUT_DIR) {
    const relative = path.relative(OUTPUT_DIR, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Invalid folder: must be inside ${OUTPUT_DIR}`);
    }
  }
  return resolved;
}

/**
 * Saves generated diagram content to a file, never overwriting an existing one
 *
 * @param content - The file content (PNG bytes or SVG text)
 * @param name - The name to use for the file (without extension)
 * @param folder - The folder to save the file in
 * @param extension - The file extension ("png" or "svg")
 * @returns The full path to the saved file
 */
async function saveMermaidFile(
  content: Buffer | string,
  name: string,
  folder: string,
  extension: "png" | "svg"
): Promise<string> {
  const resolvedFolder = resolveOutputFolder(name, folder);

  // Create the folder if it doesn't exist
  if (!fs.existsSync(resolvedFolder)) {
    log(LogLevel.INFO, `Creating folder: ${resolvedFolder}`);
    fs.mkdirSync(resolvedFolder, { recursive: true });
  }

  // Generate a filename, adding timestamp if file already exists
  let fullPath = path.join(resolvedFolder, `${name}.${extension}`);
  if (fs.existsSync(fullPath)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    fullPath = path.join(resolvedFolder, `${name}-${timestamp}.${extension}`);
    log(LogLevel.INFO, `File already exists, using: ${fullPath}`);
  }

  // "wx" fails if the path exists (including a symlink), so nothing is overwritten
  fs.writeFileSync(fullPath, content, { flag: "wx" });

  log(LogLevel.INFO, `${extension.toUpperCase()} saved to: ${fullPath}`);
  return fullPath;
}

/**
 * Handles Mermaid syntax errors and other errors
 *
 * @param error - The error that occurred
 * @returns A response object with the error message
 */
function handleMermaidError(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const isSyntaxError =
    errorMessage.includes("Syntax error") ||
    errorMessage.includes("Parse error") ||
    errorMessage.includes("Mermaid rendering failed");

  return {
    content: [
      {
        type: "text",
        text: isSyntaxError
          ? `Mermaid syntax error: ${errorMessage}\n\nPlease check your diagram syntax.`
          : `Error generating diagram: ${errorMessage}`,
      },
    ],
    isError: true,
  };
}

/**
 * Processes a generate request to create a Mermaid diagram
 *
 * @param args - The arguments for the generate request
 * @returns A response object with the generated image or file path
 */
async function processGenerateRequest(args: {
  code: string;
  theme?: "default" | "forest" | "dark" | "neutral";
  backgroundColor?: string;
  outputFormat?: "png" | "svg";
  name?: string;
  folder?: string;
}): Promise<{
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError: boolean;
}> {
  try {
    const outputFormat = args.outputFormat || "png";
    const result = await renderMermaid(args.code, {
      theme: args.theme,
      backgroundColor: args.backgroundColor,
      outputFormat: outputFormat,
    });

    // Check if we need to save the file to a folder
    if (!CONTENT_IMAGE_SUPPORTED) {
      if (!args.folder) {
        throw new Error(
          "Folder parameter is required when CONTENT_IMAGE_SUPPORTED is false"
        );
      }
      if (!args.name) {
        throw new Error(
          "Name parameter is required when CONTENT_IMAGE_SUPPORTED is false"
        );
      }

      // Save the file based on format
      let fullPath: string;
      if (outputFormat === "svg") {
        if (!result.svg) {
          throw new Error("SVG content not available");
        }
        fullPath = await saveMermaidFile(
          result.svg,
          args.name!,
          args.folder!,
          "svg"
        );
      } else {
        fullPath = await saveMermaidFile(
          Buffer.from(result.data, "base64"),
          args.name!,
          args.folder!,
          "png"
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `${outputFormat.toUpperCase()} saved to: ${fullPath}`,
          },
        ],
        isError: false,
      };
    }

    // If folder is provided and CONTENT_IMAGE_SUPPORTED is true, save the file to the folder
    // but also return the content in the response
    let savedMessage = "";
    if (args.folder && args.name) {
      try {
        let fullPath: string;
        if (outputFormat === "svg") {
          if (!result.svg) {
            throw new Error("SVG content not available");
          }
          fullPath = await saveMermaidFile(
            result.svg,
            args.name,
            args.folder,
            "svg"
          );
        } else {
          fullPath = await saveMermaidFile(
            Buffer.from(result.data, "base64"),
            args.name,
            args.folder,
            "png"
          );
        }
        savedMessage = `${outputFormat.toUpperCase()} also saved to: ${fullPath}`;
        log(LogLevel.INFO, savedMessage);
      } catch (saveError) {
        log(
          LogLevel.ERROR,
          `Failed to save ${outputFormat} to folder: ${(saveError as Error).message}`
        );
        savedMessage = `Note: Failed to save ${outputFormat} to folder: ${
          (saveError as Error).message
        }`;
      }
    }

    // Return the appropriate content based on format
    if (outputFormat === "svg") {
      if (!result.svg) {
        throw new Error("SVG content not available");
      }
      return {
        content: [
          {
            type: "text",
            text: savedMessage
              ? `Here is the generated SVG:\n\n${result.svg}\n\n${savedMessage}`
              : `Here is the generated SVG:\n\n${result.svg}`,
          },
        ],
        isError: false,
      };
    } else {
      // Return the PNG image in the response
      return {
        content: [
          {
            type: "text",
            text: savedMessage
              ? `Here is the generated image. ${savedMessage}`
              : "Here is the generated image",
          },
          {
            type: "image",
            data: result.data,
            mimeType: "image/png",
          },
        ],
        isError: false,
      };
    }
  } catch (error) {
    return handleMermaidError(error);
  }
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [GENERATE_TOOL],
}));

// Set up the request handler for tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (!args) {
      throw new Error("No arguments provided");
    }

    log(LogLevel.INFO, `Received request: ${name}`);
    log(LogLevel.DEBUG, `Request args: ${JSON.stringify(args)}`);

    if (name === "generate") {
      log(LogLevel.INFO, "Rendering Mermaid PNG");
      if (!isGenerateArgs(args)) {
        throw new Error("Invalid arguments for generate");
      }

      // Process the generate request
      return await processGenerateRequest(args);
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
          text: `Error: ${
            error instanceof Error ? error.message : String(error)
          }`,
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
  log(
    LogLevel.CRITICAL,
    `Fatal error running server: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
  process.exit(1);
});
