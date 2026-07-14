// Build-time OpenAPI 3.0 spec generator — 04j (re-scope of 04i's reverted
// docs.ts). Run via `npm run generate:openapi` (also wired as a `prebuild`
// step). Writes a static, committed `server/openapi.generated.json` that
// `server/docs.ts` serves as-is at runtime.
//
// Deliberately does NOT use `@hono/zod-openapi` — that package's
// `hono/utils/url` import broke Vercel's Edge Function deploy-time
// validator in 04i and was reverted (see build-report.md's 04i section,
// PROJECT_PLAN.md's 04j section). This script — and its `zod-to-json-schema`
// dependency — only ever runs here, at build time via `tsx`; neither is
// imported by anything under `api/` or `server/` that ends up in the
// deployed Edge Function bundle.
//
// Route coverage (OPENAPI-UNIT-01) is enforced mechanically, not by a
// hand-maintained checklist: this script reads the real `app.routes` from
// `api/index.ts` and throws if any registered route lacks a metadata entry
// below, so a route added later and forgotten here fails the build instead
// of silently missing from the docs.

import { loadEnv } from 'vite';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

// "type": "module" (package.json) means no CJS __dirname — derive it from
// import.meta.url instead.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// api/index.ts's supabaseAdmin import throws at construction time without
// these — same loadEnv pattern vitest.config.ts uses, since tsx (like
// vitest) doesn't auto-load .env. Local `.env` (if present) still wins.
const env = loadEnv('development', process.cwd(), '');
for (const [key, value] of Object.entries(env)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

// This script only ever calls `app.routes` (a static registration list) —
// it never queries Supabase, so a real project URL/key isn't needed to run
// it, only a value that satisfies `createClient()`'s constructor-time URL
// validation (`server/supabase.ts`). Vercel's build environment doesn't
// expose Preview/Production secrets to arbitrary build-script processes,
// only to the deployed function's own runtime — requiring the real ones
// here would make spec generation depend on secrets it has no actual need
// for. Placeholders only backfill what local `.env`/`vercel env pull` did
// not already provide; a real local `.env` (or `vercel build`'s own env)
// always wins.
// `??=` alone isn't enough — Vercel's build environment sets these to `""`
// (not undefined) when the target environment scope has no value
// configured, and an empty string isn't nullish.
if (!process.env.SUPABASE_URL) process.env.SUPABASE_URL = 'https://placeholder.supabase.co';
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder-service-role-key';

async function main() {
  const { app } = await import('../api/index');
  const { createCampaignSchema, patchCampaignSchema } = await import('../server/campaigns');
  const { screenBaseSchema, patchScreenSchema } = await import('../server/screens');
  const { createTenantSchema, patchTenantSchema } = await import('../server/admin-tenants');
  const { reportSchema } = await import('../server/fulfillments');
  const { acceptSchema } = await import('../server/invites');

  const toJsonSchema = (schema: ZodTypeAny) => zodToJsonSchema(schema, { target: 'openApi3', $refStrategy: 'none' });

  // Every auth mechanism in this API (server/human-auth.ts,
  // server/tenant-access.ts, server/tenant-key-auth.ts,
  // server/device-auth.ts, server/cron.ts) reads the same `Authorization:
  // Bearer <token>` header — just with a different token type/role per
  // route. Declaring these as `http`/`bearer` security schemes (not just
  // descriptive text) is what makes Swagger UI show an "Authorize" button:
  // without it, "Try it out" has nowhere to put a token and every
  // non-public request 401s with "Missing device API key" / similar, even
  // though the endpoint itself is working correctly.
  const securitySchemes = {
    superadminAuth: { type: 'http', scheme: 'bearer', description: 'Supabase Auth JWT for a superadmin user' },
    tenantAuth: { type: 'http', scheme: 'bearer', description: 'tenant_admin JWT or tenant API key — server/tenant-access.ts accepts either' },
    deviceAuth: { type: 'http', scheme: 'bearer', description: 'Device API key issued at screen registration (POST /v1/screens)' },
    cronAuth: { type: 'http', scheme: 'bearer', description: 'CRON_SECRET — only enforced when that env var is set' },
  } as const;
  type SecurityScheme = keyof typeof securitySchemes;

  interface RouteDoc {
    method: 'get' | 'post' | 'patch' | 'delete';
    /** OpenAPI-style path — Hono's `:id` becomes `{id}`. */
    path: string;
    tags: string[];
    summary: string;
    auth: string;
    /** Omitted for public routes — no Authorize entry needed. */
    securityScheme?: SecurityScheme;
    requestSchema?: ZodTypeAny;
    responseExample?: unknown;
  }

  const routes: RouteDoc[] = [
    { method: 'get', path: '/api/health', tags: ['Health'], summary: 'Liveness check', auth: 'None (public)', responseExample: { status: 'ok', timestamp: '2026-07-12T00:00:00.000Z' } },
    { method: 'post', path: '/api/invites/accept', tags: ['Auth'], summary: 'Accept a tenant invite', auth: 'None (public)', requestSchema: acceptSchema, responseExample: { user: { id: 'uuid', email: 'admin@example.com' } } },
    { method: 'get', path: '/api/admin/tenants', tags: ['Superadmin — Tenants'], summary: 'List all tenants', auth: 'superadmin', securityScheme: 'superadminAuth', responseExample: { tenants: [] } },
    { method: 'post', path: '/api/admin/tenants', tags: ['Superadmin — Tenants'], summary: 'Create a tenant (atomically creates first tenant_admin invite)', auth: 'superadmin', securityScheme: 'superadminAuth', requestSchema: createTenantSchema, responseExample: { tenant: {}, invite: { invite_url: 'https://...', expires_at: '2026-07-19T00:00:00.000Z' }, api_key: 'plaintext-shown-once' } },
    { method: 'patch', path: '/api/admin/tenants/{id}', tags: ['Superadmin — Tenants'], summary: 'Update tenant status/quota/timeout', auth: 'superadmin', securityScheme: 'superadminAuth', requestSchema: patchTenantSchema, responseExample: { tenant: {} } },
    { method: 'get', path: '/api/admin/tenants/{id}', tags: ['Superadmin — Tenants'], summary: 'Get a tenant with its campaigns and screens', auth: 'superadmin', securityScheme: 'superadminAuth', responseExample: { tenant: {}, campaigns: [], screens: [] } },
    { method: 'post', path: '/api/admin/tenants/{id}/reinvite', tags: ['Superadmin — Tenants'], summary: 'Re-invite a tenant with no accepted tenant_admin', auth: 'superadmin', securityScheme: 'superadminAuth', responseExample: { invite: { invite_url: 'https://...', expires_at: '2026-07-19T00:00:00.000Z' } } },
    { method: 'get', path: '/api/admin/ledger', tags: ['Superadmin — Ledger'], summary: 'Cross-tenant fulfillment ledger (paginated)', auth: 'superadmin', securityScheme: 'superadminAuth', responseExample: { fulfillments: [], next_cursor: null } },
    { method: 'get', path: '/api/admin/system-health', tags: ['Superadmin — Ledger'], summary: 'Windowed system health metrics', auth: 'superadmin', securityScheme: 'superadminAuth', responseExample: { request_rate_per_min: 0, error_rate: 0, reservation_timeout_rate: 0, no_eligible_campaign_rate: 0 } },
    { method: 'get', path: '/v1/campaigns', tags: ['Tenant — Campaigns'], summary: 'List campaigns', auth: 'tenant_admin JWT or tenant API key', securityScheme: 'tenantAuth', responseExample: { campaigns: [] } },
    { method: 'post', path: '/v1/campaigns', tags: ['Tenant — Campaigns'], summary: 'Create a campaign', auth: 'tenant_admin JWT or tenant API key', securityScheme: 'tenantAuth', requestSchema: createCampaignSchema, responseExample: { campaign: {} } },
    { method: 'patch', path: '/v1/campaigns/{id}', tags: ['Tenant — Campaigns'], summary: 'Update a campaign', auth: 'tenant_admin JWT or tenant API key', securityScheme: 'tenantAuth', requestSchema: patchCampaignSchema, responseExample: { campaign: {} } },
    { method: 'get', path: '/v1/campaigns/{id}/pacing', tags: ['Tenant — Campaigns'], summary: 'Campaign pacing / delivery progress', auth: 'tenant_admin JWT or tenant API key', securityScheme: 'tenantAuth', responseExample: { delivered: 0, remaining: null, sov_actual: null, sov_target: null, no_eligible_screens: false } },
    { method: 'get', path: '/v1/screens', tags: ['Tenant — Screens'], summary: 'List screens', auth: 'tenant_admin JWT or tenant API key', securityScheme: 'tenantAuth', responseExample: { screens: [] } },
    { method: 'post', path: '/v1/screens', tags: ['Tenant — Screens'], summary: 'Register a screen', auth: 'tenant_admin JWT or tenant API key', securityScheme: 'tenantAuth', requestSchema: screenBaseSchema, responseExample: { screen: {}, device_api_key: 'plaintext-shown-once' } },
    { method: 'patch', path: '/v1/screens/{id}', tags: ['Tenant — Screens'], summary: 'Update a screen', auth: 'tenant_admin JWT or tenant API key', securityScheme: 'tenantAuth', requestSchema: patchScreenSchema, responseExample: { screen: {} } },
    { method: 'post', path: '/v1/screens/{id}/rotate-key', tags: ['Tenant — Screens'], summary: 'Rotate a screen device API key', auth: 'tenant_admin JWT or tenant API key', securityScheme: 'tenantAuth', responseExample: { device_api_key: 'plaintext-shown-once' } },
    { method: 'get', path: '/v1/tenant/api-key', tags: ['Tenant — API key & usage'], summary: 'View tenant API key status', auth: 'tenant_admin JWT or tenant API key', securityScheme: 'tenantAuth', responseExample: { key_prefix: 'abcd1234', status: 'active' } },
    { method: 'post', path: '/v1/tenant/api-key/rotate', tags: ['Tenant — API key & usage'], summary: 'Rotate tenant API key', auth: 'tenant_admin JWT or tenant API key', securityScheme: 'tenantAuth', responseExample: { api_key: 'plaintext-shown-once' } },
    { method: 'get', path: '/v1/tenant/usage', tags: ['Tenant — API key & usage'], summary: 'Tenant-wide fulfillment quota usage', auth: 'tenant_admin JWT or tenant API key', securityScheme: 'tenantAuth', responseExample: { used: 0, quota: 1000 } },
    { method: 'get', path: '/v1/tenant/usage/by-screen', tags: ['Tenant — API key & usage'], summary: 'Windowed fulfillment usage broken down per screen', auth: 'tenant_admin JWT or tenant API key', securityScheme: 'tenantAuth', responseExample: { window_hours: 24, screens: [] } },
    { method: 'get', path: '/v1/tenant/play-log', tags: ['Tenant — Play log'], summary: 'Cursor-paginated log of media plays (fulfillments) with campaign/screen info', auth: 'tenant_admin JWT or tenant API key', securityScheme: 'tenantAuth', responseExample: { entries: [], next_cursor: null } },
    { method: 'get', path: '/v1/tenant/play-log/export', tags: ['Tenant — Play log'], summary: 'CSV download of the play log for the past day/week/month', auth: 'tenant_admin JWT or tenant API key', securityScheme: 'tenantAuth', responseExample: 'text/csv attachment' },
    { method: 'post', path: '/v1/fulfillments', tags: ['Device — Fulfillment'], summary: 'Request a fulfillment (reserve an eligible campaign)', auth: 'device API key', securityScheme: 'deviceAuth', responseExample: { fulfillment_id: 'uuid', campaign_id: 'uuid', media_ref: 'https://...', reserved_expires_at: '2026-07-12T00:05:00.000Z' } },
    { method: 'post', path: '/v1/fulfillments/{id}/report', tags: ['Device — Fulfillment'], summary: 'Report a fulfillment outcome', auth: 'device API key', securityScheme: 'deviceAuth', requestSchema: reportSchema, responseExample: { status: 'confirmed' } },
    { method: 'get', path: '/api/cron/expire-reservations', tags: ['Cron'], summary: 'Vercel Cron backstop for reservation expiry', auth: 'CRON_SECRET header (only enforced when set)', securityScheme: 'cronAuth', responseExample: { expired: 0 } },
    { method: 'get', path: '/v1/openapi.json', tags: ['Docs'], summary: 'This OpenAPI 3.0 spec', auth: 'None (public)' },
    { method: 'get', path: '/docs', tags: ['Docs'], summary: 'Swagger UI over the spec above', auth: 'None (public)' },
  ];

  // --- Coverage check: every route Hono actually registers must have a doc entry. ---
  const registered = app.routes
    .filter((r) => r.method !== 'ALL' && !r.path.includes('*'))
    .map((r) => `${r.method.toLowerCase()} ${r.path.replace(/:([a-zA-Z_]+)/g, '{$1}')}`);
  const documented = new Set(routes.map((r) => `${r.method} ${r.path}`));
  // Docs routes (/v1/openapi.json, /docs) aren't mounted on `app` until
  // server/docs.ts is wired into api/index.ts — accept their absence from
  // `registered` without failing the generator (they're still included in
  // the spec itself, and OPENAPI-UNIT-01's test covers the post-wiring state).
  const missing = registered.filter((r) => !documented.has(r));
  if (missing.length > 0) {
    throw new Error(`generate-openapi: route(s) registered in api/index.ts have no doc entry — add them to scripts/generate-openapi.ts's routes[] array:\n${missing.join('\n')}`);
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    paths[route.path] ??= {};
    const parameters = [...route.path.matchAll(/\{([a-zA-Z_]+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));
    paths[route.path][route.method] = {
      tags: route.tags,
      summary: route.summary,
      description: `**Auth:** ${route.auth}`,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.securityScheme ? { security: [{ [route.securityScheme]: [] }] } : {}),
      ...(route.requestSchema
        ? { requestBody: { required: true, content: { 'application/json': { schema: toJsonSchema(route.requestSchema) } } } }
        : {}),
      responses: {
        ...(route.responseExample !== undefined
          ? { '200': { description: 'Success', content: { 'application/json': { example: route.responseExample } } } }
          : { '200': { description: 'Success' } }),
      },
    };
  }

  const spec = {
    openapi: '3.0.3',
    info: {
      title: 'ad-server API',
      version: '1.0.0',
      description:
        'Multi-tenant ad-serving API for digital signage / DOOH inventory. Generated at build time from this repo\'s Zod request schemas — see PROJECT_PLAN.md\'s 04j section for how and why.',
    },
    servers: [{ url: '/', description: 'Same origin as this spec' }],
    tags: [...new Set(routes.flatMap((r) => r.tags))].map((name) => ({ name })),
    paths,
    components: { securitySchemes },
  };

  const outPath = path.join(__dirname, '..', 'server', 'openapi.generated.json');
  writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n');
  console.log(`Wrote ${Object.keys(paths).length} paths to ${path.relative(process.cwd(), outPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
