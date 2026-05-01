/**
 * Tenant routing table — Effect.Schema edition.
 *
 * Replaces hand-written TypeScript types with `Effect.Schema` definitions.
 * Schema gives us, in one place:
 *   - the static TS type      (via Schema.Schema.Type<typeof X>)
 *   - runtime validation       (via Schema.decodeUnknownSync — throws on invalid)
 *   - field-level refinement   (Schema.pattern, Schema.maxLength, ...)
 *   - JSON Schema export       (via JSONSchema.make — used by /schema/*.json)
 *
 * Why this matters for a federation gateway:
 *   - a partner submitting a tenant gets a typed config + a published JSON
 *     Schema they can validate against (via constructs.network registry,
 *     via PR review, via their own CI).
 *   - decode-at-boot is fast-fail: if `tenants.ts` is malformed, the gateway
 *     refuses to boot rather than serve broken routes.
 *   - additive: when we add fields (e.g. `auth: "x402"`, per-tenant rate
 *     limits, owner contact), the Schema is the single source of truth.
 *
 * Everything else in the file is shape-identical to the prior hand-typed
 * version — same `TENANTS` array, same `findTenant` lookup. Only the
 * type-source-of-truth moved.
 */

import { Schema } from "effect";

// ────── primitive schemas ──────

/** Tenant slug — lowercase kebab-ish; appears in URLs as `/{slug}/...`. */
const SlugSchema = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9-]*$/, {
    message: () => "slug must be lowercase a-z, digits, dashes; starting with a letter",
  }),
  Schema.maxLength(40),
);

/** Upstream URL — must be https:// (we do not proxy plaintext). */
const UpstreamUrlSchema = Schema.String.pipe(
  Schema.pattern(/^https:\/\/[^\s/]+/, {
    message: () => "upstream must be an https:// origin (no trailing slash)",
  }),
);

/** Auth kinds the upstream advertises. v1 = "none" for all tenants. */
const AuthKindSchema = Schema.Literal("none", "api-key", "jwt");

/** Operational status — `paused` returns 503 from gateway without removing the tenant from the manifest. */
const TenantStatusSchema = Schema.Literal("live", "paused");

// ────── tenant schema ──────

/**
 * One tenant row. Field comments propagate into the JSON Schema export
 * via `description` — partner authors see them in their tooling.
 */
export const TenantSchema = Schema.Struct({
  slug: SlugSchema.annotations({ description: "Path slug appearing in URLs as /{slug}/..." }),
  name: Schema.String.pipe(Schema.maxLength(80)).annotations({
    description: "Human-readable name (federation index + manifest)",
  }),
  description: Schema.String.pipe(Schema.maxLength(280)).annotations({
    description: "Short description of what the MCP serves (≤280 chars)",
  }),
  publisher: Schema.String.pipe(Schema.maxLength(80)).annotations({
    description: "Org/author publishing the upstream MCP",
  }),
  upstream: UpstreamUrlSchema.annotations({
    description: "Origin of the upstream service (https://, no trailing slash)",
  }),
  auth: AuthKindSchema.annotations({
    description: "Auth kind the upstream advertises",
  }),
  documentation: Schema.optional(Schema.String).annotations({
    description: "Documentation URL (repo, README, or live docs)",
  }),
  status: TenantStatusSchema.annotations({
    description: "Operational status — `paused` returns 503 without removing the tenant from the manifest",
  }),
}).annotations({
  identifier: "Tenant",
  description: "One MCP tenant served by the federation gateway",
});

/** Static TS type derived from the Schema — single source of truth. */
export type Tenant = Schema.Schema.Type<typeof TenantSchema>;

/** Authoritative array schema (used by decode-at-boot + JSON schema export). */
export const TenantsSchema = Schema.Array(TenantSchema).annotations({
  identifier: "Tenants",
  description: "Federation gateway tenant routing table",
});

// ────── decode at module load ──────

/**
 * Raw config — the data the operator/partner edits. Stays a plain JS array
 * so it diffs cleanly in PRs. The decode step on the next line ensures
 * any change here is type-checked + runtime-validated before the gateway
 * boots.
 */
const RAW_TENANTS: ReadonlyArray<unknown> = [
  {
    slug: "codex",
    name: "Mibera Codex",
    description:
      "Anti-hallucination lookup MCP for Mibera lore — zones, archetypes, factors, grails, miberas. Read by narrative bots and operator harnesses.",
    publisher: "0xHoneyJar",
    upstream: "https://codex-mcp-production.up.railway.app",
    auth: "none",
    documentation: "https://codex.0xhoneyjar.xyz",
    status: "live",
  },
];

/**
 * Decode-at-boot. `decodeUnknownSync` throws a `ParseError` with a
 * structured message if anything is malformed. The thrown error
 * crashes the Node process at module load, which is what we want —
 * a misconfigured gateway should refuse to start.
 */
export const TENANTS: ReadonlyArray<Tenant> = Schema.decodeUnknownSync(TenantsSchema)(
  RAW_TENANTS,
);

export function findTenant(slug: string): Tenant | undefined {
  return TENANTS.find((t) => t.slug === slug);
}
