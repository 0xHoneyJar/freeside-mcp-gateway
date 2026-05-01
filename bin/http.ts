import { serve } from "@hono/node-server";
import app from "../src/app.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(
    `[freeside-mcp-gateway] listening on http://0.0.0.0:${info.port} · gateway-origin=${process.env.GATEWAY_ORIGIN ?? "https://mcp.0xhoneyjar.xyz"}`,
  );
});
