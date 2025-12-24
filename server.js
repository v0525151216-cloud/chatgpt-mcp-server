import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mcp-hello", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Return the provided text",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name !== "echo") throw new Error(`Unknown tool: ${name}`);
  const text = typeof args?.text === "string" ? args.text : "";
  return { content: [{ type: "text", text: `echo: ${text}` }] };
});

let transport = null;

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

const httpServer = http.createServer(async (req, res) => {
  const url = req.url || "/";

  // Быстрый health для проверок
  if (req.method === "GET" && (url === "/" || url.startsWith("/health"))) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // SSE: открыть поток
  if (req.method === "GET" && url.startsWith("/sse")) {
    transport = new SSEServerTransport("/sse", res);
    await server.connect(transport);
    return; // transport держит соединение открытым
  }

  // ВАЖНО: принимать сообщения от клиента (ChatGPT)
  if (req.method === "POST" && url.startsWith("/sse")) {
    if (!transport) {
      res.writeHead(409, { "content-type": "text/plain" });
      res.end("SSE transport not initialized yet. Open GET /sse first.");
      return;
    }

    // В разных версиях SDK метод может называться чуть по-разному.
    // Поэтому делаем “умный” вызов по доступному методу.
    const candidates = [
      "handlePost",
      "handlePostRequest",
      "handleRequest",
      "handleMessage",
    ];

    for (const m of candidates) {
      if (typeof transport[m] === "function") {
        await transport[m](req, res);
        return;
      }
    }

    res.writeHead(500, { "content-type": "text/plain" });
    res.end("SSE transport: no POST handler method found on this SDK version.");
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

httpServer.listen(PORT, () => {
  console.log(`✅ MCP SSE server listening on port ${PORT}`);
});
