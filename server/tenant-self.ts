// GET /v1/tenant/api-key, POST /v1/tenant/api-key/rotate, GET /v1/tenant/usage,
// GET /v1/tenant/usage/by-screen. Mounted at /v1/tenant behind
// tenantAccessMiddleware (JWT-or-tenant-key).

import { ErrorCode } from '../types';
import { supabaseAdmin } from './supabase';
import { generateApiKey, hashApiKey } from './hash';
import { tenantAccessMiddleware } from './tenant-access';
import { getQuotaUsage } from './quota';
import { newRouter, createRoute, z, errorResponses, type RouteContext } from './openapi';

const router = newRouter();
router.use('*', tenantAccessMiddleware);

const apiKeyRoute = createRoute({
  method: 'get',
  path: '/api-key',
  tags: ['Tenant'],
  summary: "This tenant's API key prefix/status (never the hash or plaintext)",
  responses: {
    200: { description: 'Key prefix/status', content: { 'application/json': { schema: z.object({ key_prefix: z.string(), status: z.string() }) } } },
    ...errorResponses(401, 403, 404),
  },
});

// Handler param is `c: RouteContext`, here and in every other 04i-converted route —
// @hono/zod-openapi's typed-response system requires every `c.json(...)`
// call in a handler to structurally match one declared `responses` status
// entry, verified via TS overload resolution across the whole function
// body. That breaks down across handlers with several differently-shaped
// success/error branches (a rough edge in the library's typing, not a
// runtime concern — request validation and the actual response body are
// unaffected either way; `c.req.valid(...)` still returns the right runtime
// value, just untyped).
router.openapi(apiKeyRoute, async (c: RouteContext) => {
  const auth = c.get('auth');
  const { data, error } = await supabaseAdmin
    .from('tenant_api_keys')
    .select('key_prefix, status')
    .eq('tenant_id', auth.tenant_id)
    .single();

  if (error || !data) {
    return c.json({ error: 'No API key found', code: ErrorCode.NOT_FOUND }, 404);
  }

  return c.json(data);
});

const rotateRoute = createRoute({
  method: 'post',
  path: '/api-key/rotate',
  tags: ['Tenant'],
  summary: 'Rotate this tenant\'s API key (old key stops working immediately)',
  responses: {
    200: { description: 'New plaintext API key', content: { 'application/json': { schema: z.object({ api_key: z.string() }) } } },
    ...errorResponses(400, 401, 403),
  },
});

router.openapi(rotateRoute, async (c: RouteContext) => {
  const auth = c.get('auth');
  const { plaintextKey, keyPrefix } = generateApiKey('tenant');
  const keyHash = await hashApiKey(plaintextKey);

  // Single row per tenant (PK = tenant_id) — an in-place overwrite is enough,
  // no revoke-then-insert history needed like device_api_keys
  // (architecture.md: "old plaintext key stops working immediately, no grace
  // period in MVP").
  const { error } = await supabaseAdmin
    .from('tenant_api_keys')
    .update({ key_hash: keyHash, key_prefix: keyPrefix, status: 'active', rotated_at: new Date().toISOString() })
    .eq('tenant_id', auth.tenant_id);

  if (error) {
    return c.json({ error: 'Failed to rotate API key', code: ErrorCode.VALIDATION_ERROR }, 400);
  }

  return c.json({ api_key: plaintextKey });
});

const usageRoute = createRoute({
  method: 'get',
  path: '/usage',
  tags: ['Tenant'],
  summary: 'Tenant-wide fulfillment usage vs. quota',
  responses: {
    200: { description: 'Usage vs. quota', content: { 'application/json': { schema: z.object({ used: z.number(), quota: z.number() }) } } },
    ...errorResponses(401, 403),
  },
});

router.openapi(usageRoute, async (c: RouteContext) => {
  const auth = c.get('auth');
  const usage = await getQuotaUsage(auth.tenant_id as string);
  return c.json(usage);
});

// GET /v1/tenant/usage/by-screen (04i, follow-up scoping session) —
// scope.md's "broken down per screen/device — not just the tenant-wide
// aggregate", tied to the device-key-compromise blast-radius concern. Reads
// straight from fulfillments (windowed, not all-time — that table is
// unbounded); no new table needed, `fulfillments_tenant_screen_requested_idx`
// (migration 0005) covers this grouped-and-windowed query.
const usageByScreenRoute = createRoute({
  method: 'get',
  path: '/usage/by-screen',
  tags: ['Tenant'],
  summary: 'Per-screen fulfillment usage over a recent window (default 24h)',
  request: { query: z.object({ window_hours: z.string().optional() }) },
  responses: {
    200: {
      description: 'Per-screen usage',
      content: {
        'application/json': {
          schema: z.object({
            window_hours: z.number(),
            screens: z.array(z.object({ screen_id: z.string(), label: z.string(), count: z.number() })),
          }),
        },
      },
    },
    ...errorResponses(400, 401, 403),
  },
});

router.openapi(usageByScreenRoute, async (c: RouteContext) => {
  const auth = c.get('auth');
  const { window_hours: windowHoursParam } = c.req.valid('query');

  let windowHours = 24;
  if (windowHoursParam !== undefined) {
    const parsed = Number(windowHoursParam);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return c.json({ error: 'window_hours must be a positive number', code: ErrorCode.VALIDATION_ERROR }, 400);
    }
    windowHours = parsed;
  }

  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  // supabase-js has no GROUP BY primitive — fetch the (bounded-by-window)
  // screen_id column and aggregate in JS, same pattern admin-tenants.ts's
  // GET '/' already uses for campaign/screen counts per tenant.
  const { data: rows, error } = await supabaseAdmin
    .from('fulfillments')
    .select('screen_id')
    .eq('tenant_id', auth.tenant_id)
    .gte('requested_at', windowStart);

  if (error) return c.json({ error: error.message, code: ErrorCode.VALIDATION_ERROR }, 400);

  const countsByScreen = new Map<string, number>();
  for (const row of rows ?? []) {
    countsByScreen.set(row.screen_id, (countsByScreen.get(row.screen_id) ?? 0) + 1);
  }

  const screenIds = [...countsByScreen.keys()];
  const labelsByScreen = new Map<string, string>();
  if (screenIds.length > 0) {
    const { data: screenRows } = await supabaseAdmin.from('screens').select('id, label').in('id', screenIds);
    for (const s of screenRows ?? []) labelsByScreen.set(s.id, s.label);
  }

  const screens = screenIds.map((screenId) => ({
    screen_id: screenId,
    label: labelsByScreen.get(screenId) ?? 'Unknown screen',
    count: countsByScreen.get(screenId) as number,
  }));

  return c.json({ window_hours: windowHours, screens });
});

export default router;
