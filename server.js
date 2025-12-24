// server.js — MCP over SSE (Render-ready) for @modelcontextprotocol/sdk 1.25.x
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// -------------------- MCP server + tools --------------------
const mcp = new Server(
  { name: "mcp-hello", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
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

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name !== "echo") {
    throw new Error(`Unknown tool: ${name}`);
  }

  const text = typeof args?.text === "string" ? args.text : "";
  return {
    content: [{ type: "text", text: `echo: ${text}` }],
  };
});

// -------------------- HTTP + SSE wiring --------------------
//
// IMPORTANT: ChatGPT connector flow usually does:
// 1) GET  /sse        -> opens SSE stream, server returns endpoint event with /sse?sessionId=...
// 2) POST /sse?...    -> sends MCP messages to the server
//
// So we MUST handle both GET and POST for /sse.
//
// We'll keep the latest active transport (enough for base level).
// If you later want multiple parallel sessions, we can store transports in a Map by sessionId.
//
let activeTransport = null;

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

const httpServer = http.createServer(async (req, res) => {
  const url = req.url || "/";

  // ---- quick health endpoints (Render, browser checks) ----
  if (req.method === "GET" && (url === "/" || url.startsWith("/health"))) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // ---- debug: see what methods exist on SSEServerTransport (optional) ----
  if (req.method === "GET" && url === "/debug-transport") {
    const proto = SSEServerTransport.prototype;
    const methods = Object.getOwnPropertyNames(proto).filter(
      (n) => typeof proto[n] === "function"
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ methods }, null, 2));
    return;
  }

  // ---- GET /sse : open SSE stream ----
  if (req.method === "GET" && url.startsWith("/sse")) {
    // Create a new transport bound to the /sse base path
    activeTransport = new SSEServerTransport("/sse", res);

    // Connect MCP server to this transport
    await mcp.connect(activeTransport);

    // DO NOT end the response; SSE transport keeps it open
    return;
  }

  // ---- POST /sse : accept client->server MCP messages ----
  // ChatGPT will POST either to /sse or /sse?sessionId=...
  if (req.method === "POST" && url.startsWith("/sse")) {
    if (!activeTransport) {
      res.writeHead(409, { "content-type": "text/plain" });
      res.end("SSE not initialized. Open GET /sse first.");
      return;
    }

    // Different SDK builds used different method names.
    // We call the first matching handler that exists.
    const candidates = [
      "handlePostRequest",
      "handlePost",
      "handleRequest",
      "handleMessage",
    ];

    for (const m of candidates) {
      if (typeof activeTransport[m] === "function") {
        await activeTransport[m](req, res);
        return;
      }
    }

    // If we get here, SDK changed and we need to adjust handler name.
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(
      "No POST handler found on SSEServerTransport. Open /debug-transport and check available methods."
    );
    return;
  }

  // ---- everything else ----
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

// IMPORTANT for Render: listen on 0.0.0.0 (not 127.0.0.1)
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ MCP SSE server listening on port ${PORT}`);
});
