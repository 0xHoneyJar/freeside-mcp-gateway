/**
 * freeside-mcp-gateway — federation gateway for MCP services.
 *
 * One Hono app fronts mcp.0xhoneyjar.xyz and routes path-prefixed requests
 * to upstream tenant services (codex, score, future partners). Streaming
 * bodies (SSE / Streamable-HTTP) pass through transparently — the gateway
 * does NOT buffer responses for tool calls.
 *
 * Routes:
 *   GET  /                              → federation index (HTML)
 *   GET  /.well-known/federation.json   → machine-readable tenant manifest
 *   GET  /healthz                       → ok
 *   GET  /{slug}/.well-known/mcp.json   → proxy + rewrite transports[].url
 *   *    /{slug}/*                      → proxy as-is (streaming-aware)
 *
 * Per [[hono-mcp-double-write-bug]] (memory): when forwarding streaming
 * upstreams, return `new Response(upstream.body, ...)` directly. NEVER
 * `new Response(null, 200)` after streaming starts — that triggers the
 * @hono/node-server double-write bug.
 */

import { Hono } from "hono";
import { TENANTS, findTenant, type Tenant } from "./tenants.js";

const app = new Hono();

const GATEWAY_ORIGIN =
  process.env.GATEWAY_ORIGIN ?? "https://mcp.0xhoneyjar.xyz";

/** Federation manifest schema (custom v0.1 — propose extension when partners adopt). */
type FederationManifest = {
  schemaVersion: "0.1";
  name: string;
  title: string;
  description: string;
  publisher: string;
  origin: string;
  tenants: {
    slug: string;
    name: string;
    description: string;
    publisher: string;
    endpoint: string;
    discovery: string;
    documentation?: string;
    auth: string;
    status: string;
  }[];
};

function buildManifest(): FederationManifest {
  return {
    schemaVersion: "0.1",
    name: "freeside-mcp",
    title: "Freeside MCP Federation",
    description:
      "Federated gateway hosting multiple substrate-truth MCPs under one domain. Path-based routing — /{tenant}/mcp endpoints proxy to upstream services.",
    publisher: "0xHoneyJar",
    origin: GATEWAY_ORIGIN,
    tenants: TENANTS.map((t) => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      publisher: t.publisher,
      endpoint: `/${t.slug}/mcp`,
      discovery: `/${t.slug}/.well-known/mcp.json`,
      documentation: t.documentation,
      auth: t.auth,
      status: t.status,
    })),
  };
}

// ────── meta routes ──────

app.get("/healthz", (c) => c.text("ok"));

app.get("/.well-known/federation.json", (c) => c.json(buildManifest()));

app.get("/", (c) => c.html(renderIndex()));

// ────── proxy routes ──────

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

function pruneRequestHeaders(input: Headers): Headers {
  const out = new Headers();
  input.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.append(key, value);
  });
  return out;
}

function pruneResponseHeaders(input: Headers): Headers {
  const out = new Headers();
  input.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) return;
    if (k === "content-encoding") return; // upstream already decoded for us
    out.append(key, value);
  });
  return out;
}

/** Build the upstream URL from the gateway request, stripping the /{slug} prefix. */
function buildUpstreamUrl(tenant: Tenant, gatewayUrl: URL): string {
  const prefix = `/${tenant.slug}`;
  const path = gatewayUrl.pathname.startsWith(prefix)
    ? gatewayUrl.pathname.slice(prefix.length) || "/"
    : gatewayUrl.pathname;
  return new URL(path + gatewayUrl.search, tenant.upstream).toString();
}

/** Rewrite a tenant's mcp.json discovery card so transports[].url is a gateway-absolute URL. */
function rewriteDiscoveryCard(
  tenant: Tenant,
  body: unknown,
): Record<string, unknown> {
  if (typeof body !== "object" || body === null) return {} as Record<string, unknown>;
  const card = { ...(body as Record<string, unknown>) };
  if (Array.isArray((card as { transports?: unknown[] }).transports)) {
    const transports = (card as { transports: unknown[] }).transports;
    card.transports = transports.map((t) => {
      if (typeof t !== "object" || t === null) return t;
      const obj = t as { url?: string } & Record<string, unknown>;
      const url = obj.url;
      if (typeof url === "string" && url.startsWith("/")) {
        return { ...obj, url: `${GATEWAY_ORIGIN}/${tenant.slug}${url}` };
      }
      return obj;
    });
  }
  // Indicate this card was federated.
  card._federated = {
    via: GATEWAY_ORIGIN,
    tenant: tenant.slug,
  };
  return card;
}

// Mount the proxy LAST so meta routes (/, /healthz, /.well-known/*) win.
app.all("/:slug/*", async (c) => {
  const slug = c.req.param("slug");
  const tenant = findTenant(slug);

  if (!tenant) {
    return c.json(
      { error: "tenant_not_found", slug, available: TENANTS.map((t) => t.slug) },
      404,
    );
  }

  if (tenant.status === "paused") {
    return c.json(
      { error: "tenant_paused", slug, message: "Tenant is temporarily unavailable." },
      503,
    );
  }

  const gatewayUrl = new URL(c.req.url);
  const upstreamUrl = buildUpstreamUrl(tenant, gatewayUrl);
  const isDiscovery = gatewayUrl.pathname.endsWith("/.well-known/mcp.json");

  const headers = pruneRequestHeaders(c.req.raw.headers);
  // Identify the proxy hop for upstream observability + debugging.
  headers.set("x-forwarded-by", `freeside-mcp-gateway/${slug}`);
  headers.set("x-forwarded-host", gatewayUrl.host);

  const init: RequestInit & { duplex?: "half" } = {
    method: c.req.method,
    headers,
  };

  // Only forward bodies for methods that have one. `duplex: "half"` is required
  // for streaming POST bodies (Node 22+ fetch).
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    init.body = c.req.raw.body;
    init.duplex = "half";
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, init as RequestInit);
  } catch (err) {
    return c.json(
      {
        error: "upstream_unreachable",
        slug,
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }

  // Discovery card — buffer + rewrite transports.
  if (isDiscovery && upstreamRes.ok) {
    const card = await upstreamRes.json().catch(() => ({}));
    const rewritten = rewriteDiscoveryCard(tenant, card);
    return c.json(rewritten, upstreamRes.status as 200);
  }

  // Everything else — stream the body through. This is what makes /mcp work
  // for SSE / Streamable-HTTP responses (initialize → result, tools/call →
  // event stream). DO NOT buffer.
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: pruneResponseHeaders(upstreamRes.headers),
  });
});

// ────── HTML index ──────

function renderIndex(): string {
  const rows = TENANTS.map(
    (t) => `
      <tr>
        <td><code>${t.slug}</code></td>
        <td>${escapeHtml(t.name)}</td>
        <td>${escapeHtml(t.description)}</td>
        <td><code>/${t.slug}/mcp</code></td>
        <td>${t.status}</td>
      </tr>`,
  ).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Freeside MCP Federation</title>
  <meta name="description" content="Federation gateway for MCP services. One domain, many tenants." />
  <style>
    :root {
      --bg: oklch(0.838 0.026 75.2);
      --panel: oklch(0.788 0.026 75.2);
      --ink: oklch(0.203 0.01 67.2);
      --ink-muted: oklch(0.456 0.008 67.6);
      --rule: color-mix(in oklch, var(--ink) 20%, transparent);
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: var(--bg);
      color: var(--ink);
      margin: 0;
      padding: 3rem 2rem;
      line-height: 1.6;
    }
    .container { max-width: 60rem; margin: 0 auto; }
    h1 { font-family: Georgia, "Iowan Old Style", serif; font-weight: 400; letter-spacing: -0.01em; margin: 0 0 0.5rem; }
    .lead { color: var(--ink-muted); margin: 0 0 2rem; }
    code {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 0.9em;
      background: var(--panel);
      padding: 0.1em 0.35em;
      border: 1px solid var(--rule);
    }
    table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; }
    th, td { text-align: left; padding: 0.6rem 0.85rem; border: 1px solid var(--rule); }
    th { background: var(--panel); font-weight: 400; font-family: Georgia, serif; }
    .status { color: var(--ink-muted); font-size: 0.9em; }
    a { color: var(--ink); }
  </style>
</head>
<body>
  <div class="container">
    <h1>freeside mcp federation</h1>
    <p class="lead">one gateway, many tenants. each path slug is an MCP service routed through ${escapeHtml(GATEWAY_ORIGIN)}.</p>

    <table>
      <thead>
        <tr><th>slug</th><th>name</th><th>description</th><th>endpoint</th><th>status</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p class="status">machine-readable manifest at <a href="/.well-known/federation.json"><code>/.well-known/federation.json</code></a> · health at <a href="/healthz"><code>/healthz</code></a></p>
    <p class="status">building something MCP-shaped on Mibera and want to wire in? <a href="https://github.com/0xHoneyJar/freeside-mcp-gateway/issues/new">open an issue</a>.</p>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default app;
