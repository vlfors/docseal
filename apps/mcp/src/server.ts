import { McpServer } from "@modelcontextprotocol/server";
import manifest from "../package.json" with { type: "json" };

export const NAME = "docseal-mcp";
export const VERSION = manifest.version;

/** One server instance; the stdio entry asks for one per connection. Tools are added in later tasks. */
export function createServer(): McpServer {
  return new McpServer(
    { name: NAME, version: VERSION },
    {
      capabilities: { tools: {} },
      // Tool arguments are a path and a few strings; anything far larger is not a real call.
      maxToolInputElements: 1024,
    },
  );
}
