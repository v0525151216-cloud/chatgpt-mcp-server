// server.js — MCP over SSE (Render-ready) for @modelcontextprotocol/sdk 1.25.x
import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/** ---------------- MCP: tools ---------------- */
const mcp = new Server(
  { name: "mcp-hello", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
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

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name !== "echo") throw new Error(`Unknown tool: ${name}`);
  const text = typeof args?.text === "string" ? args.text : "";
  return { content: [{ type: "text", text: `echo: ${text}` }] };
});

/** ---------------- Helpers ---------------- */
function getSessionId(urlString) {
  try {
    const u = new URL(urlString, "http://localhost");
    return u.searchParams.get("sessionId");
  } catch {
    return null;
  }
}

// sessionId -> transport
const transports = new Map();
// transports opened by GET /sse before we know sessionId (we attach on first POST with sessionId)
const pending = [];

/** ---------------- HTTP server ---------------- */
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

const httpServer = http.createServer(async (req, res) => {
  const url = req.url || "/";
  const method = req.method || "GET";

  // Health
  if (method === "GET" && (url === "/" || url.startsWith("/health"))) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // OPTIONS / HEAD for validators/proxies
  if (url.startsWith("/sse") && method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS,HEAD",
      "Access-Control-Allow-Headers": "content-type, authorization",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  if (url.startsWith("/sse") && method === "HEAD") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.end();
    return;
  }

  // Debug (optional)
  if (method === "GET" && url === "/debug-transport") {
    const proto = SSEServerTransport.prototype;
    const methods = Object.getOwnPropertyNames(proto).filter(
      (n) => typeof proto[n] === "function"
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ methods }, null, 2));
    return;
  }

  // GET /sse -> open SSE stream
  if (method === "GET" && url.startsWith("/sse")) {
    try {
      const transport = new SSEServerTransport("/sse", res);

      // important for your SDK: start() exists and should be called
      await transport.start();

      await mcp.connect(transport);

      pending.push(transport);

      // cleanup on disconnect
      res.on("close", () => {
        // remove from pending if still there
        const i = pending.indexOf(transport);
        if (i >= 0) pending.splice(i, 1);
        // remove from session map if attached
        for (const [sid, t] of transports.entries()) {
          if (t === transport) {
            transports.delete(sid);
            break;
          }
        }
      });

      return; // keep SSE open
    } catch (e) {
      console.error("GET /sse error:", e);
      try {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("SSE init error");
      } catch {}
      return;
    }
  }

  // POST /sse?sessionId=... -> MUST use handlePostMessage(req,res)
  if (method === "POST" && url.startsWith("/sse")) {
    const sid = getSessionId(url);

    try {
      let transport = null;

      if (sid && transports.has(sid)) {
        transport = transports.get(sid);
      } else if (sid) {
        // attach newest pending transport to this sessionId
        transport = pending.pop() || null;
        if (transport) transports.set(sid, transport);
      } else {
        // no sessionId: fallback to latest pending
        transport = pending[pending.length - 1] || null;
      }

      if (!transport) {
        res.writeHead(409, { "content-type": "text/plain" });
        res.end("No active SSE transport. Open GET /sse first.");
        return;
      }

      // ✅ THIS is the correct handler for POST bodies in your build
      await transport.handlePostMessage(req, res);
      return;
    } catch (e) {
      console.error("POST /sse error:", e);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("POST handler error");
      return;
    }
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

// Render: bind all interfaces
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ MCP SSE server listening on port ${PORT}`);
});
