# Mermaid MCP Server

A Model Context Protocol (MCP) server that converts Mermaid diagrams to PNG images.

## Features

- Converts Mermaid diagram code to PNG images
- Uses Puppeteer for headless browser rendering
- Implements the MCP protocol for integration with AI assistants

## Build

```bash
npx tsc
```

### Use with Claude desktop

```
  "mcpServers": {
    "mermaid": {
      "command": "node",
      "args": [
        "<PROJECT_ROOT>/mermaid-mcp-server/dist/index.js"
      ]
    }
  }
```


## Run with inspector

Run the server with inspector

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

## License

MIT