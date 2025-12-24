// server.js — MCP over SSE (Render-ready) with sessionId support
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

// -------------------- Helpers --------------------
function parseSessionId(urlString) {
  // Works for "/sse?sessionId=..." or "/sse&sessionId=..." (just in case)
  try {
    const u = new URL(urlString, "http://localhost");
    return u.searchParams.get("sessionId");
  } catch {
    return null;
  }
}

// Store transports per sessionId to support parallel sessions safely
const transports = new Map(); // sessionId -> SSEServerTransport

function cleanupTransport(sessionId) {
  const t = transports.get(sessionId);
  if (!t) return;
  try {
    t.close?.();
  } catch {}
  transports.delete(sessionId);
}

// -------------------- HTTP server --------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;

const httpServer = http.createServer(async (req, res) => {
  const url = req.url || "/";
  const method = req.method || "GET";

  // Health / root
  if (method === "GET" && (url === "/" || url.startsWith("/health"))) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // Optional: debug available methods on transport (to verify in prod)
  if (method === "GET" && url === "/debug-transport") {
    const proto = SSEServerTransport.prototype;
    const methods = Object.getOwnPropertyNames(proto).filter(
      (n) => typeof proto[n] === "function"
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ methods }, null, 2));
    return;
  }

  // GET /sse -> open SSE stream; transport will emit "endpoint" with sessionId
  if (method === "GET" && url.startsWith("/sse")) {
    try {
      const transport = new SSEServerTransport("/sse", res);

      // start() exists in твоей версии (ты видел в debug-transport)
      await transport.start();

      // Connect MCP server to this transport
      await mcp.connect(transport);

      // Try to capture sessionId from request (usually absent on first GET),
      // BUT transport will send endpoint event with sessionId to client.
      // We'll store this transport under a temporary key until we see a sessionId on POST.
      // To keep it simple: store by a generated key for now.
      const tempKey = `__pending__${Date.now()}_${Math.random()}`;
      transports.set(tempKey, transport);

      // If the connection closes, cleanup
      res.on("close", () => {
        // remove whichever key currently points to this transport
        for (const [k, v] of transports.entries()) {
          if (v === transport) {
            cleanupTransport(k);
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

  // POST /sse?sessionId=... -> deliver messages into the right transport
  if (method === "POST" && url.startsWith("/sse")) {
    const sessionId = parseSessionId(url);

    try {
      let transport = null;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId);
      } else if (sessionId) {
        // We don't have it mapped yet. Most likely first POST after GET.
        // Attach the newest pending transport to this sessionId.
        // Pick the most recently created pending transport.
        const pendingKeys = [...transports.keys()].filter((k) =>
          k.startsWith("__pending__")
        );
        const latestPendingKey = pendingKeys.sort().at(-1);

        if (latestPendingKey) {
          transport = transports.get(latestPendingKey);
          transports.delete(latestPendingKey);
          transports.set(sessionId, transport);
        }
      } else {
        // No sessionId in POST. Fall back to any single transport (debug / legacy behavior).
        // Prefer latest pending.
        const anyKey = [...transports.keys()].sort().at(-1);
        if (anyKey) transport = transports.get(anyKey);
      }

      if (!transport) {
        res.writeHead(409, { "content-type": "text/plain" });
        res.end("No active SSE transport. Open GET /sse first.");
        return;
      }

      // Your SDK has this exact method (from debug-transport):
      await transport.handlePostMessage(req, res);
      return;
    } catch (e) {
      console.error("POST /sse error:", e);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("POST handler error");
      return;
    }
  }

  // Everything else
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

// Render requires listening on all interfaces
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ MCP SSE server listening on port ${PORT}`);
});
