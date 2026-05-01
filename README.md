# freeside-mcp-gateway

> federation gateway for MCP services. one domain, many tenants.

```
mcp.0xhoneyjar.xyz/
├── /                              federation index (HTML)
├── /.well-known/federation.json   machine-readable tenant manifest
├── /healthz                       ok
├── /codex/mcp                     proxies → codex-mcp upstream
├── /codex/.well-known/mcp.json    proxies → codex-mcp discovery (rewritten)
├── /codex/healthz                 proxies → codex-mcp healthz
└── /{tenant}/...                  routing-table lookup; 404 if not found
```

## why

per [`constructs-mcp-deployment-topology`](https://github.com/0xHoneyJar/construct-mibera-codex/blob/main/grimoires) Path C:

- compute-shaped MCPs (score, indexers) self-host
- data-shaped MCPs (codex, partner registries) belong behind a gateway
- gateway gives one install line, one cert, one observability layer
- streaming bodies (SSE / Streamable-HTTP) pass through transparently

per [`substrate-over-narrative`](https://github.com/0xHoneyJar/construct-mibera-codex/blob/main/grimoires) doctrine: every tenant is a substrate-truth surface; the gateway is a routing layer, not a substrate of its own.

## stack

- hono 4 · streamable-http-aware proxy
- node 22 alpine · railway hosted
- pnpm 8 · tsx for dev · tsc for build

## adding a tenant

edit `src/tenants.ts`. status `live` exposes the tenant; status `paused` returns 503 without removing it from the manifest.

```ts
{
  slug: "score",
  name: "Score Mibera",
  description: "Factor metadata + behavioral signals.",
  publisher: "0xHoneyJar",
  upstream: "https://score-mibera-production.up.railway.app",
  auth: "none",
  status: "live",
}
```

## local dev

```bash
pnpm install
pnpm dev          # port 3000
pnpm smoke        # in another terminal — hits localhost:3000
```

`pnpm smoke` exercises:

1. `GET /healthz`
2. `GET /.well-known/federation.json`
3. `GET /codex/.well-known/mcp.json` (discovery rewriting)
4. `POST /codex/mcp` (MCP `initialize` round-trip via streaming proxy)

## environment

| var | default | what |
| --- | --- | --- |
| `PORT` | `3000` | listen port |
| `GATEWAY_ORIGIN` | `https://mcp.0xhoneyjar.xyz` | absolute origin used in rewritten discovery cards + manifest |

## deploy

railway picks up `railway.toml` automatically. healthcheck at `/healthz`. node 22 alpine.

```bash
railway up        # deploy
railway logs      # tail
```

DNS: point `mcp.0xhoneyjar.xyz` at the railway service via `railway domain add`.

## phases

| phase | scope | status |
| --- | --- | --- |
| 0 | gateway proxies codex only · federation index · discovery rewriting | shipping |
| 1 | add score, freeside-character, future tenants | as upstreams harden |
| 2 | x402 instrumentation per tool call (rev split prep) | first paying consumer |
| 3 | per-tenant analytics + partner onboarding flow | partner adoption signal |

## related

- [`construct-mibera-codex`](https://github.com/0xHoneyJar/construct-mibera-codex) — codex tenant; first MCP adopting this gateway
- [`construct-freeside`](https://github.com/0xHoneyJar/construct-freeside) — operations director (KRANZ); gateway cutovers fall under coordinating-cutover skill
- [`construct-beacon`](https://github.com/0xHoneyJar/construct-beacon) — defining-mcp-tools skill; tenant authors use this to scaffold their MCP

## license

MIT
