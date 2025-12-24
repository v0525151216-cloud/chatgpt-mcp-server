import http from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/* ---------------- MCP server ---------------- */

const mcp = new Server(
  { name: "chatgpt-mcp-server", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Return the provided text (sanity check tool).",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    {
      name: "respond",
      description:
        "Return a custom response controlled by JSON input (text/markdown/multi).",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["text", "markdown", "multi"] },
          title: { type: "string" },
          text: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
          json: { type: "object" },
          repeat: { type: "integer", minimum: 1, maximum: 5 },
        },
        required: ["text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  // Log every tool call (to prove requests hit your server)
  console.log("TOOL CALL:", name, JSON.stringify(args ?? {}));

  if (name === "echo") {
    const text = typeof args?.text === "string" ? args.text : "";
    return { content: [{ type: "text", text: `echo: ${text}` }] };
  }

  if (name === "respond") {
    const mode = typeof args?.mode === "string" ? args.mode : "text";
    const title = typeof args?.title === "string" ? args.title : "";
    const text = typeof args?.text === "string" ? args.text : "";
    const bullets = Array.isArray(args?.bullets)
      ? args.bullets.filter((x) => typeof x === "string")
      : [];
    const repeatRaw = Number.isInteger(args?.repeat) ? args.repeat : 1;
    const repeat = Math.max(1, Math.min(5, repeatRaw));

    let out = text;

    if (title) out = `${title}\n\n${out}`;
    if (bullets.length) out += `\n\n- ${bullets.join("\n- ")}`;

    if (args?.json && typeof args.json === "object") {
      out += `\n\n\`\`\`json\n${JSON.stringify(args.json, null, 2)}\n\`\`\``;
    }

    if (mode === "multi") {
      const content = [];
      for (let i = 0; i < repeat; i++) content.push({ type: "text", text: out });
      return { content };
    }

    // "markdown" is returned as text; ChatGPT will render markdown
    return { content: [{ type: "text", text: out }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

/* ---------------- SSE plumbing ---------------- */

// sessionId -> transport
const transports = new Map();
// transports opened by GET /sse before we know sessionId (attach on first POST with sessionId)
const pending = [];

function getSessionId(urlString) {
  try {
    const u = new URL(urlString, "http://localhost");
    return u.searchParams.get("sessionId");
  } catch {
    return null;
  }
}

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

  // Some validators/proxies do OPTIONS preflight
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

  // Some validators do HEAD checks
  if (url.startsWith("/sse") && method === "HEAD") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.end();
    return;
  }

  // Debug helper (optional)
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

      // IMPORTANT: In your SDK, Server.connect() calls transport.start() automatically.
      await mcp.connect(transport);

      pending.push(transport);

      // cleanup on disconnect
      res.on("close", () => {
        const i = pending.indexOf(transport);
        if (i >= 0) pending.splice(i, 1);

        for (const [sid, t] of transports.entries()) {
          if (t === transport) {
            transports.delete(sid);
            break;
          }
        }
      });

      return; // keep connection open
    } catch (e) {
      console.error("GET /sse error:", e);
      try {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("SSE init error");
      } catch {}
      return;
    }
  }

  // POST /sse?sessionId=... -> deliver client->server messages into transport
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

      // ✅ Correct method for your SDK (you confirmed it exists)
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

// Render: bind on all interfaces
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ MCP SSE server listening on port ${PORT}`);
});
