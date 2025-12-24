// server.js (MCP SSE minimal, SDK 1.25.x style)
import http from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

// В разных версиях SDK схемы лежат в разных модулях.
// Для 1.25.x обычно это "@modelcontextprotocol/sdk/types.js" или "@modelcontextprotocol/sdk/types".
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mcp-hello", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

// 1) Сообщаем модели, какие tools есть
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
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
  };
});

// 2) Реализация вызова tool
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name !== "echo") {
    throw new Error(`Unknown tool: ${name}`);
  }

  const text = typeof args?.text === "string" ? args.text : "";
  return {
    content: [{ type: "text", text: `echo: ${text}` }],
  };
});

// SSE endpoint
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

const httpServer = http.createServer(async (req, res) => {
  if (!req.url) return;

  if (req.method === "GET" && req.url.startsWith("/sse")) {
    // Поднимаем SSE-транспорт на этот запрос
    const transport = new SSEServerTransport("/sse", res);
    await server.connect(transport);
    return;
  }

  // простая заглушка
  res.writeHead(404);
  res.end("Not found");
});

httpServer.listen(PORT, () => {
  console.log(`✅ MCP SSE server listening on port ${PORT}`);
});
