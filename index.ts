#!/usr/bin/env node

import puppeteer from "puppeteer";
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

// __dirname is not available in ESM modules by default
const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

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
    version: "0.2.0",
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
      typeof (args as any).backgroundColor === "string") &&
    (!(args as any).outputFormat ||
      ["png", "svg"].includes((args as any).outputFormat)) &&
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
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  // Declare page outside try block so it's accessible in catch and finally
  let page: puppeteer.Page | null = null;
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

    // Create a simple HTML template without the CDN reference
    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Mermaid Renderer</title>
      <style>
        body { 
          background: ${config.backgroundColor || "white"};
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
    // Note: Must be set before page.goto() to ensure the page renders with the correct dimensions from the start
    await page.setViewport({
      width: 1200, // Keep the same viewport size as before
      height: 800,
      deviceScaleFactor: 3, // 2~4 is fine, the larger the PNG, the clearer and larger it is
    });

    // Write the HTML to a temporary file
    const tempHtmlPath = path.join(__dirname, "temp-mermaid.html");
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
    const screenshot = await page.$eval(
      "#container",
      async (container, mermaidCode, mermaidConfig) => {
        try {
          // @ts-ignore - mermaid is loaded by the script tag
          window.mermaid.initialize({
            startOnLoad: false,
            theme: mermaidConfig.theme || "default",
            securityLevel: "loose",
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

    // Clean up the temporary file
    fs.unlinkSync(tempHtmlPath);
    log(LogLevel.DEBUG, "Temporary HTML file cleaned up");

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
 * Saves a generated Mermaid diagram to a file
 *
 * @param base64Image - The base64-encoded PNG image
 * @param name - The name to use for the file (without extension)
 * @param folder - The folder to save the file in
 * @returns The full path to the saved file
 */
async function saveMermaidImageToFile(
  base64Image: string,
  name: string,
  folder: string
): Promise<string> {
  // Create the folder if it doesn't exist
  if (!fs.existsSync(folder)) {
    log(LogLevel.INFO, `Creating folder: ${folder}`);
    fs.mkdirSync(folder, { recursive: true });
  }

  // Generate a filename, adding timestamp if file already exists
  let filename = `${name}.png`;
  const filePath = path.join(folder, filename);

  if (fs.existsSync(filePath)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    filename = `${name}-${timestamp}.png`;
    log(LogLevel.INFO, `File already exists, using filename: ${filename}`);
  }

  // Save the image to the file
  const imageBuffer = Buffer.from(base64Image, "base64");
  const fullPath = path.join(folder, filename);
  fs.writeFileSync(fullPath, imageBuffer);

  log(LogLevel.INFO, `Image saved to: ${fullPath}`);
  return fullPath;
}

/**
 * Saves a generated Mermaid SVG to a file
 *
 * @param svgContent - The SVG content as a string
 * @param name - The name to use for the file (without extension)
 * @param folder - The folder to save the file in
 * @returns The full path to the saved file
 */
async function saveMermaidSvgToFile(
  svgContent: string,
  name: string,
  folder: string
): Promise<string> {
  // Create the folder if it doesn't exist
  if (!fs.existsSync(folder)) {
    log(LogLevel.INFO, `Creating folder: ${folder}`);
    fs.mkdirSync(folder, { recursive: true });
  }

  // Generate a filename, adding timestamp if file already exists
  let filename = `${name}.svg`;
  const filePath = path.join(folder, filename);

  if (fs.existsSync(filePath)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    filename = `${name}-${timestamp}.svg`;
    log(LogLevel.INFO, `File already exists, using filename: ${filename}`);
  }

  // Save the SVG to the file
  const fullPath = path.join(folder, filename);
  fs.writeFileSync(fullPath, svgContent, "utf-8");

  log(LogLevel.INFO, `SVG saved to: ${fullPath}`);
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

      // Save the file based on format
      let fullPath: string;
      if (outputFormat === "svg") {
        if (!result.svg) {
          throw new Error("SVG content not available");
        }
        fullPath = await saveMermaidSvgToFile(
          result.svg,
          args.name!,
          args.folder!
        );
      } else {
        fullPath = await saveMermaidImageToFile(
          result.data,
          args.name!,
          args.folder!
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
          fullPath = await saveMermaidSvgToFile(
            result.svg,
            args.name,
            args.folder
          );
        } else {
          fullPath = await saveMermaidImageToFile(
            result.data,
            args.name,
            args.folder
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

    log(
      LogLevel.INFO,
      `Received request: ${name} with args: ${JSON.stringify(args)}`
    );

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
