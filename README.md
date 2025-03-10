# Mermaid MCP Server

[![smithery badge](https://smithery.ai/badge/@peng-shawn/mermaid-mcp-server)](https://smithery.ai/server/@peng-shawn/mermaid-mcp-server)

A Model Context Protocol (MCP) server that converts Mermaid diagrams to PNG images. This server allows AI assistants and other applications to generate visual diagrams from textual descriptions using the Mermaid markdown syntax.

## Features

- Converts Mermaid diagram code to PNG images
- Supports multiple diagram themes (default, forest, dark, neutral)
- Customizable background colors
- Uses Puppeteer for high-quality headless browser rendering
- Implements the MCP protocol for seamless integration with AI assistants
- Flexible output options: return images directly or save to disk
- Error handling with detailed error messages

## How It Works

The server uses Puppeteer to launch a headless browser, render the Mermaid diagram to SVG, and capture a screenshot of the rendered diagram. The process involves:

1. Launching a headless browser instance
2. Creating an HTML template with the Mermaid code
3. Loading the Mermaid.js library
4. Rendering the diagram to SVG
5. Taking a screenshot of the rendered SVG as PNG
6. Either returning the image directly or saving it to disk

## Build

```bash
npx tsc
```

## Usage

### Installing via Smithery

To install Mermaid Diagram Generator for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@peng-shawn/mermaid-mcp-server):

```bash
npx -y @smithery/cli install @peng-shawn/mermaid-mcp-server --client claude
```

### Use with Claude desktop

```json
"mcpServers": {
  "mermaid": {
    "command": "npx",
    "args": [
      npx @peng-shawn/mermaid-mcp-server@0.1.2
    ]
  }
}
```

### Use with Cursor and Cline

```bash
env CONTENT_IMAGE_SUPPORTED=false npx @peng-shawn/mermaid-mcp-server@0.1.2
```

You can find a list of mermaid diagrams under `./diagrams`, they are created using Cursor agent with prompt: "generate mermaid diagrams and save them in a separate diagrams folder explaining how renderMermaidPng work"

### Run with inspector

Run the server with inspector for testing and debugging:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

The server will start and listen on stdio for MCP protocol messages.

Learn more about inspector [here](https://modelcontextprotocol.io/docs/tools/inspector).

## API

The server exposes a single tool:

- `generate`: Converts Mermaid diagram code to a PNG image
  - Parameters:
    - `code`: The Mermaid diagram code to render
    - `theme`: (optional) Theme for the diagram. Options: "default", "forest", "dark", "neutral"
    - `backgroundColor`: (optional) Background color for the diagram, e.g. 'white', 'transparent', '#F0F0F0'
    - `name`: Name for the generated file (required when CONTENT_IMAGE_SUPPORTED=false)
    - `folder`: Absolute path to save the image to (required when CONTENT_IMAGE_SUPPORTED=false)

The behavior of the `generate` tool depends on the `CONTENT_IMAGE_SUPPORTED` environment variable:

- When `CONTENT_IMAGE_SUPPORTED=true` (default): The tool returns the image directly in the response
- When `CONTENT_IMAGE_SUPPORTED=false`: The tool saves the image to the specified folder and returns the file path

## Environment Variables

- `CONTENT_IMAGE_SUPPORTED`: Controls whether images are returned directly in the response or saved to disk
  - `true` (default): Images are returned directly in the response
  - `false`: Images are saved to disk, requiring `name` and `folder` parameters

## Examples

### Basic Usage

```javascript
// Generate a flowchart with default settings
{
  "code": "flowchart TD\n    A[Start] --> B{Is it?}\n    B -->|Yes| C[OK]\n    B -->|No| D[End]"
}
```

### With Theme and Background Color

```javascript
// Generate a sequence diagram with forest theme and light gray background
{
  "code": "sequenceDiagram\n    Alice->>John: Hello John, how are you?\n    John-->>Alice: Great!",
  "theme": "forest",
  "backgroundColor": "#F0F0F0"
}
```

### Saving to Disk (when CONTENT_IMAGE_SUPPORTED=false)

```javascript
// Generate a class diagram and save it to disk
{
  "code": "classDiagram\n    Class01 <|-- AveryLongClass\n    Class03 *-- Class04\n    Class05 o-- Class06",
  "theme": "dark",
  "name": "class_diagram",
  "folder": "/path/to/diagrams"
}
```

## FAQ

### Doesn't Claude desktop already support mermaid via canvas?

Yes, but it doesn't support the `theme` and `backgroundColor` options. Plus, having a dedicated server makes it easier to create mermaid diagrams with different MCP clients.

### Why do I need to specify CONTENT_IMAGE_SUPPORTED=false when using with Cursor?

Cursor doesn't support inline images in responses yet.

## License

MIT
