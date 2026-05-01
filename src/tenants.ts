/**
 * Tenant routing table.
 *
 * Each entry maps a path-prefix slug to an upstream MCP service. The gateway
 * forwards `/{slug}/...` requests to `{upstream}/...`, preserving streaming
 * (Streamable-HTTP / SSE) bodies transparently.
 *
 * Add a tenant by appending a row. Status `live` exposes the tenant; `paused`
 * returns 503 (so the gateway can absorb partner outages without flapping the
 * federation manifest).
 */

export type TenantStatus = "live" | "paused";

export type AuthKind = "none" | "api-key" | "jwt";

export type Tenant = {
  /** Path slug — appears in URLs as `/{slug}/...`. Lowercase, kebab-case. */
  slug: string;
  /** Human-readable name (used in federation index + manifest). */
  name: string;
  /** Short description (≤200 chars). */
  description: string;
  /** Org/author publishing the upstream MCP. */
  publisher: string;
  /** Origin of the upstream service (no trailing slash). */
  upstream: string;
  /** Auth kind the upstream advertises. v1 = none for all. */
  auth: AuthKind;
  /** Documentation URL (repo, README, or live docs). */
  documentation?: string;
  /** Operational status. `paused` returns 503 from gateway without removing the tenant from the manifest. */
  status: TenantStatus;
};

export const TENANTS: Tenant[] = [
  {
    slug: "codex",
    name: "Mibera Codex",
    description:
      "Anti-hallucination lookup MCP for Mibera lore — zones, archetypes, factors, grails, miberas. Read by narrative bots and operator harnesses.",
    publisher: "0xHoneyJar",
    upstream: "https://codex-mcp-production.up.railway.app",
    auth: "none",
    documentation: "https://docs-iota-cyan.vercel.app",
    status: "live",
  },
];

export function findTenant(slug: string): Tenant | undefined {
  return TENANTS.find((t) => t.slug === slug);
}
