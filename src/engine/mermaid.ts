// Runs the official Mermaid library on the geometry-faithful DOM. Installs
// browser globals, so it must run in its own context (the render worker).
import { createDom, installGlobals, type GeometryDom } from "./dom.js";

export const DEFAULT_FONT_FAMILY = '"trebuchet ms", verdana, arial, sans-serif';
export const THEMES = ["default", "neutral", "dark", "forest", "base", "neo", "neo-dark", "redux", "redux-dark", "redux-color", "redux-dark-color"] as const;
export const LOOKS = ["classic", "neo", "handDrawn"] as const;

export interface DiagramOptions {
  theme?: string;
  look?: string;
  fontFamily?: string;
}

export interface SyntaxIssue {
  message: string;
  line?: number;
  column?: number;
  expected?: string[];
}

// A diagram the parser rejected, with positions when Mermaid provides them
export class MermaidSyntaxError extends Error {
  constructor(readonly issue: SyntaxIssue) {
    super(issue.message);
    this.name = "MermaidSyntaxError";
  }
}

// xorshift32: Mermaid draws random ids (gitGraph commits) and random layout
// seeds (venn); a fixed sequence per render makes output reproducible
function seededRandom(): () => void {
  let s = 0x2545f491;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  Math.random = next;
  return () => {
    s = 0x2545f491;
  };
}

function baseConfig(options: DiagramOptions): Record<string, unknown> {
  const fontFamily = options.fontFamily || DEFAULT_FONT_FAMILY;
  return {
    startOnLoad: false,
    securityLevel: "strict",
    // HTML labels are <foreignObject>s that only browsers can draw. SVG text
    // labels render everywhere, and `secure` stops diagrams turning them back on.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    class: { htmlLabels: false },
    state: { htmlLabels: false },
    secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "htmlLabels"],
    deterministicIds: true,
    handDrawnSeed: 1,
    theme: options.theme || "default",
    ...(options.look ? { look: options.look } : {}),
    fontFamily,
    themeVariables: { fontFamily },
    maxTextSize: 200_000,
  };
}

export class MermaidEngine {
  private constructor(
    readonly dom: GeometryDom,
    private readonly mermaid: any,
    private readonly resetRandom: () => void
  ) {}

  static async create(): Promise<MermaidEngine> {
    const dom = createDom();
    installGlobals(dom.window);
    const resetRandom = seededRandom();
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize(baseConfig({}));
    return new MermaidEngine(dom, mermaid, resetRandom);
  }

  // Parses without laying out; resolves to the diagram type
  async parse(code: string): Promise<string> {
    this.mermaid.initialize(baseConfig({}));
    try {
      const result = await this.mermaid.parse(code);
      return result.diagramType;
    } catch (err) {
      throw toSyntaxError(err);
    }
  }

  // Renders to Mermaid's own SVG markup (not yet flattened)
  async render(code: string, options: DiagramOptions): Promise<{ svg: string; diagramType: string }> {
    this.mermaid.initialize(baseConfig(options));
    let diagramType: string;
    try {
      diagramType = (await this.mermaid.parse(code)).diagramType;
    } catch (err) {
      throw toSyntaxError(err);
    }
    this.resetRandom();
    try {
      const { svg } = await this.mermaid.render("mermaid-svg", code);
      return { svg, diagramType };
    } catch (err) {
      throw toSyntaxError(err);
    } finally {
      // Mermaid leaves temporary containers behind on failure
      for (const el of Array.from(this.dom.document.body.children)) el.remove();
    }
  }
}

// Mermaid's grammars are a mix of Jison (positions in err.hash) and Langium
// (lexer/parser error lists); normalize both
export function toSyntaxError(err: unknown): MermaidSyntaxError | Error {
  if (!(err instanceof Error) && typeof err !== "object") return new Error(String(err));
  const e = err as any;
  const message: string = String(e?.message ?? e?.str ?? e).trim();
  if (e?.hash) {
    const h = e.hash;
    return new MermaidSyntaxError({
      message,
      line: h.loc?.first_line ?? (typeof h.line === "number" ? h.line + 1 : undefined),
      column: h.loc?.first_column !== undefined ? h.loc.first_column + 1 : undefined,
      expected: Array.isArray(h.expected) ? h.expected.map((t: string) => t.replace(/^'|'$/g, "")) : undefined,
    });
  }
  const langium = e?.result?.parserErrors?.[0] ?? e?.result?.lexerErrors?.[0];
  if (langium) {
    const tok = langium.token ?? langium;
    return new MermaidSyntaxError({ message, line: tok.startLine ?? tok.line, column: tok.startColumn ?? tok.column });
  }
  const m = /line (\d+)(?:, column (\d+))?/i.exec(message);
  if (/parse error|syntax error|lexical error|no diagram type detected|parsing failed|expecting/i.test(message)) {
    return new MermaidSyntaxError({ message, line: m ? Number(m[1]) : undefined, column: m?.[2] ? Number(m[2]) : undefined });
  }
  return err instanceof Error ? err : new Error(message);
}
