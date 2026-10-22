// MCP surface: tools to render and validate Mermaid, the legacy `generate`
// tool, and Mermaid's syntax reference as resources.
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "./config.js";
import { LOOKS, THEMES } from "./engine/mermaid.js";
import { legacyOutputPath, OutputPathError, resolveOutput, writeOutput } from "./files.js";
import type { RenderOutput } from "./protocol.js";
import { DiagramSyntaxError, RenderTimeoutError, type Renderer } from "./renderer.js";
import { docForCode, readSyntaxDoc, syntaxDocs, syntaxUri } from "./syntax.js";

export const SERVER_NAME = "mermaid-mcp-server";

// Named colors, hex, and rgb()/hsl() with numeric arguments; nothing that
// could smuggle CSS or markup
const COLOR = /^(?:[a-zA-Z]{1,30}|#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%]+(?:\s*[,\s/]\s*[0-9.%]+){2,3}\s*\))$/;
const MAX_CODE = 100_000;

const INSTRUCTIONS = `Renders Mermaid diagrams with the official Mermaid library, without a browser.
- validate_mermaid: fast syntax check. Use it before writing Mermaid into docs or code.
- render_mermaid: draws the diagram. Look at the returned image to check the layout reads well; pass outputPath to save a PNG or SVG file.
- Syntax references for every diagram type are resources at mermaid://syntax/<type>; errors name the one to read.`;

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; text: string } }
  | { type: "resource_link"; uri: string; name: string; mimeType: string };

const issueSchema = z.object({
  message: z.string(),
  line: z.number().optional(),
  column: z.number().optional(),
  expected: z.array(z.string()).optional(),
});

export function createServer(renderer: Renderer, config: Config, version: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions: INSTRUCTIONS });

  // ---- render_mermaid ---------------------------------------------------------
  server.registerTool(
    "render_mermaid",
    {
      title: "Render Mermaid diagram",
      description:
        "Render Mermaid code to a PNG or SVG image. Returns the image so you can see the result, " +
        "or saves it when outputPath is given. Supports every Mermaid diagram type. " +
        "On a syntax error, returns the line, column and expected tokens.",
      inputSchema: z.object({
        code: z.string().min(1).max(MAX_CODE).describe("Mermaid source, e.g. \"flowchart LR\\n  A --> B\""),
        format: z.enum(["png", "svg"]).default("png").describe("png (default) or svg"),
        theme: z.enum(THEMES).optional().describe("Mermaid theme; default is 'default'"),
        look: z.enum(LOOKS).optional().describe("Drawing style: classic, neo or handDrawn"),
        background: z.string().regex(COLOR, "Use a color name, #hex, rgb() or hsl()").optional().describe("Background color, or 'transparent'. Default: white for PNG, none for SVG"),
        scale: z.number().min(0.5).max(4).default(2).describe("PNG pixel density (default 2). Reduced automatically for very large diagrams"),
        outputPath: z.string().max(4096).optional().describe("Absolute path to save the image (.png or .svg). Existing files are never overwritten; a numbered name is used instead"),
        includeImage: z.boolean().optional().describe("With outputPath, also return the image (default false)"),
      }),
      outputSchema: z.object({
        diagramType: z.string(),
        format: z.enum(["png", "svg"]),
        width: z.number().describe("Diagram width in CSS pixels"),
        height: z.number().describe("Diagram height in CSS pixels"),
        path: z.string().optional(),
        warnings: z.array(z.string()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const saving = !!args.outputPath;
      const background = args.background ?? (args.format === "png" ? "white" : undefined);
      try {
        if (saving) resolveOutput(args.outputPath!, args.format, config.outputDir);
        const out = await renderer.render({
          code: args.code,
          format: args.format,
          theme: args.theme,
          look: args.look,
          background,
          scale: args.scale,
          maxPixels: saving ? config.fileMaxPixels : config.inlineMaxPixels,
          tile: !saving,
        });
        const content: Content[] = [];
        let savedPath: string | undefined;
        if (saving) {
          const data = args.format === "png" ? out.images![0].data : out.svg;
          const written = writeOutput(args.outputPath!, data, args.format, config.outputDir);
          savedPath = written.path;
          content.push({ type: "text", text: `Saved ${describe(out, args.format)} to ${written.path}${written.renamed ? " (the requested file already existed)" : ""}` });
          content.push({ type: "resource_link", uri: `file://${written.path}`, name: written.path.split(/[\\/]/).pop()!, mimeType: mime(args.format) });
        } else {
          content.push({ type: "text", text: `Rendered ${describe(out, args.format)}` });
        }
        if (!saving || args.includeImage) content.push(...imageContent(out, args.format));
        for (const w of out.warnings) content.push({ type: "text", text: `Note: ${w}` });
        return {
          content,
          structuredContent: { diagramType: out.diagramType, format: args.format, width: out.width, height: out.height, ...(savedPath ? { path: savedPath } : {}), warnings: out.warnings },
        };
      } catch (err) {
        return failure(err, args.code);
      }
    }
  );

  // ---- validate_mermaid ---------------------------------------------------------
  server.registerTool(
    "validate_mermaid",
    {
      title: "Validate Mermaid syntax",
      description:
        "Check Mermaid code for syntax errors without rendering (fast). Returns the diagram type, " +
        "or the error with line, column, expected tokens and the syntax reference to consult.",
      inputSchema: z.object({ code: z.string().min(1).max(MAX_CODE).describe("Mermaid source") }),
      outputSchema: z.object({
        valid: z.boolean(),
        diagramType: z.string().optional(),
        error: issueSchema.optional(),
        syntaxReference: z.string().optional().describe("Resource URI with the syntax of this diagram type"),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ code }) => {
      try {
        const v = await renderer.validate(code);
        const doc = docForCode(code);
        const reference = doc ? syntaxUri(doc.slug) : undefined;
        const text = v.valid ? `Valid ${v.diagramType} diagram.` : `Invalid: ${formatIssue(v.error!)}${guidance(code)}`;
        return { content: [{ type: "text", text }], structuredContent: { valid: v.valid, diagramType: v.diagramType, error: v.error, syntaxReference: reference } };
      } catch (err) {
        return failure(err, code);
      }
    }
  );

  // ---- generate (0.x compatibility) -------------------------------------------
  if (config.legacyTool) registerLegacyTool(server, renderer, config);

  // ---- syntax resources ---------------------------------------------------------
  for (const doc of syntaxDocs()) {
    server.registerResource(
      `syntax-${doc.slug}`,
      syntaxUri(doc.slug),
      { title: doc.title, description: `Mermaid syntax reference: ${doc.title}. Starts with: ${doc.keywords.join(", ")}`, mimeType: "text/markdown" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: readSyntaxDoc(doc.slug) ?? "" }] })
    );
  }

  return server;
}

function registerLegacyTool(server: McpServer, renderer: Renderer, config: Config): void {
  const saveRequired = !config.contentImageSupported;
  server.registerTool(
    "generate",
    {
      title: "Generate Mermaid image (legacy)",
      description: "Generate PNG image or SVG from mermaid markdown. Kept for compatibility with 0.x; prefer render_mermaid.",
      inputSchema: z.object({
        code: z.string().min(1).max(MAX_CODE).describe("The mermaid markdown to generate an image from"),
        theme: z.enum(["default", "forest", "dark", "neutral"]).optional().describe("Theme for the diagram (optional)"),
        backgroundColor: z.string().regex(COLOR).optional().describe("Background color for the diagram, e.g. 'white', 'transparent', '#F0F0F0' (optional)"),
        outputFormat: z.enum(["png", "svg"]).optional().describe("Output format for the diagram (optional, defaults to 'png')"),
        name: saveRequired ? z.string().describe("Name for the generated file (required)") : z.string().optional().describe("Name of the diagram (optional)"),
        folder: saveRequired ? z.string().describe("Absolute path to save the image to (required)") : z.string().optional().describe("Absolute path to save the image to (optional)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const format = args.outputFormat ?? "png";
      try {
        if (saveRequired && (!args.name || !args.folder)) throw new OutputPathError("name and folder are required when CONTENT_IMAGE_SUPPORTED is false");
        if (args.folder && !args.name) throw new OutputPathError("name is required when folder is given");
        const target = args.folder && args.name ? resolveOutput(legacyOutputPath(args.name, args.folder, format), format, config.outputDir) : undefined;
        const background = args.backgroundColor ?? "white";
        const out = await renderer.render({ code: args.code, format, theme: args.theme, background, scale: 3, maxPixels: config.fileMaxPixels });
        let saved = "";
        if (target) {
          const written = writeOutput(target, format === "png" ? out.images![0].data : out.svg, format, config.outputDir);
          saved = `${format.toUpperCase()} saved to: ${written.path}`;
        }
        if (saveRequired) return { content: [{ type: "text", text: saved }] };
        if (format === "svg") return { content: [{ type: "text", text: `Here is the generated SVG:\n\n${out.svg}${saved ? `\n\n${saved}` : ""}` }] };
        return {
          content: [
            { type: "text", text: saved ? `Here is the generated image. ${saved.replace("saved to", "also saved to")}` : "Here is the generated image" },
            { type: "image", data: Buffer.from(out.images![0].data).toString("base64"), mimeType: "image/png" },
          ],
        };
      } catch (err) {
        return failure(err, args.code);
      }
    }
  );
}

function describe(out: RenderOutput, format: "png" | "svg"): string {
  const img = out.images?.[0];
  const px = format === "png" && img && out.images!.length === 1 ? `, ${img.width}x${img.height} px` : "";
  return `${out.diagramType} diagram as ${format.toUpperCase()} (${Math.round(out.width)}x${Math.round(out.height)}${px})`;
}

const mime = (format: "png" | "svg") => (format === "png" ? "image/png" : "image/svg+xml");

function imageContent(out: RenderOutput, format: "png" | "svg"): Content[] {
  if (format === "png") return out.images!.map((i) => ({ type: "image" as const, data: Buffer.from(i.data).toString("base64"), mimeType: "image/png" }));
  return [{ type: "resource", resource: { uri: "mermaid://render/diagram.svg", mimeType: "image/svg+xml", text: out.svg } }];
}

// Where to look next: the syntax reference for the diagram's type, or, when
// the type itself wasn't recognized, the keywords a diagram can start with
function guidance(code: string): string {
  const doc = docForCode(code);
  if (doc) return `\nSyntax reference: ${syntaxUri(doc.slug)}`;
  const keywords = syntaxDocs().map((d) => d.keywords[0]).filter(Boolean);
  return `\nA diagram starts with its type, one of: ${keywords.join(", ")}`;
}

function formatIssue(issue: { message: string; line?: number; column?: number; expected?: string[] }): string {
  const where = issue.line ? `line ${issue.line}${issue.column ? `, column ${issue.column}` : ""}: ` : "";
  const expected = issue.expected?.length ? `\nExpected one of: ${issue.expected.slice(0, 12).join(", ")}` : "";
  return `${where}${issue.message}${expected}`;
}

function failure(err: unknown, code: string) {
  let text: string;
  if (err instanceof DiagramSyntaxError) {
    text = `Mermaid syntax error, ${formatIssue(err.issue)}${guidance(code)}`;
  } else if (err instanceof OutputPathError || err instanceof RenderTimeoutError) {
    text = err.message;
  } else {
    text = `Rendering failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return { content: [{ type: "text" as const, text }], isError: true };
}
