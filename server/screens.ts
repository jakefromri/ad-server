// GET/POST /v1/screens, PATCH /v1/screens/:id, POST /v1/screens/:id/rotate-key.
// Mounted at /v1/screens behind tenantAccessMiddleware (JWT-or-tenant-key) —
// same dual-auth chain as campaigns, since the "API docs" external-script use
// case (and the k6 simulator, 04e) registers screens via a tenant API key.

import { ErrorCode } from '../types';
import { supabaseAdmin } from './supabase';
import { generateApiKey, hashApiKey } from './hash';
import { tenantAccessMiddleware } from './tenant-access';
import { newRouter, createRoute, z, errorResponses, type RouteContext } from './openapi';

const router = newRouter();
router.use('*', tenantAccessMiddleware);

const screenSchema = z.record(z.unknown());

const screenBaseSchema = z.object({
  label: z.string().min(1),
  state: z.string().length(2).optional().nullable(),
  zip: z.string().min(1).optional().nullable(),
  aspect_ratio: z.string().min(1),
  resolution: z.string().min(1),
  orientation: z.enum(['landscape', 'portrait']),
  // Not in architecture.md's documented POST /v1/screens request shape —
  // added in 04e so the k6 simulator's attribute-generator can flag its own
  // registrations. `is_simulated` has existed on the `screens` table since
  // 04a for exactly this purpose (dashboard real-vs-virtual distinction,
  // SIM-INT-01) but nothing ever wrote `true` to it until now. Optional,
  // defaults false, so every existing caller (dashboard, docs examples) is
  // unaffected.
  is_simulated: z.boolean().optional(),
});

const patchScreenSchema = screenBaseSchema
  .omit({ is_simulated: true })
  .partial()
  .extend({
    status: z.enum(['active', 'inactive']).optional(),
  });

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Screens'],
  summary: 'List this tenant\'s screens',
  responses: {
    200: { description: 'Screen list', content: { 'application/json': { schema: z.object({ screens: z.array(screenSchema) }) } } },
    ...errorResponses(401, 403),
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
router.openapi(listRoute, async (c: RouteContext) => {
  const auth = c.get('auth');
  const { data: screens, error } = await supabaseAdmin.from('screens').select('*').eq('tenant_id', auth.tenant_id);
  if (error) return c.json({ error: error.message, code: ErrorCode.VALIDATION_ERROR }, 400);

  const ids = (screens ?? []).map((s) => s.id);
  const keysByScreen = new Map<string, { status: string; key_prefix: string }>();

  if (ids.length > 0) {
    const { data: keys } = await supabaseAdmin
      .from('device_api_keys')
      .select('screen_id, status, key_prefix')
      .in('screen_id', ids)
      .eq('status', 'active');
    for (const k of keys ?? []) keysByScreen.set(k.screen_id, { status: k.status, key_prefix: k.key_prefix });
  }

  const result = (screens ?? []).map((s) => ({
    ...s,
    device_key_status: keysByScreen.get(s.id)?.status ?? 'revoked',
    device_key_prefix: keysByScreen.get(s.id)?.key_prefix ?? null,
  }));

  return c.json({ screens: result });
});

const createRoute_ = createRoute({
  method: 'post',
  path: '/',
  tags: ['Screens'],
  summary: 'Register a screen (issues a device API key)',
  request: { body: { content: { 'application/json': { schema: screenBaseSchema } } } },
  responses: {
    201: {
      description: 'Screen registered',
      content: { 'application/json': { schema: z.object({ screen: screenSchema, device_api_key: z.string() }) } },
    },
    ...errorResponses(400, 401, 403),
  },
});

router.openapi(createRoute_, async (c: RouteContext) => {
  const auth = c.get('auth');
  const body = c.req.valid('json');

  const { data: screen, error } = await supabaseAdmin
    .from('screens')
    .insert({
      tenant_id: auth.tenant_id,
      label: body.label,
      state: body.state ?? null,
      zip: body.zip ?? null,
      aspect_ratio: body.aspect_ratio,
      resolution: body.resolution,
      orientation: body.orientation,
      is_simulated: body.is_simulated ?? false,
    })
    .select()
    .single();

  if (error || !screen) {
    return c.json({ error: error?.message ?? 'Failed to create screen', code: ErrorCode.VALIDATION_ERROR }, 400);
  }

  const { plaintextKey, keyPrefix } = generateApiKey('device');
  const keyHash = await hashApiKey(plaintextKey);

  const { error: keyError } = await supabaseAdmin.from('device_api_keys').insert({
    screen_id: screen.id,
    tenant_id: auth.tenant_id,
    key_hash: keyHash,
    key_prefix: keyPrefix,
  });

  if (keyError) {
    // Compensating rollback — a screen with no working device key is worse
    // than no screen at all (an operator would have no way to notice).
    await supabaseAdmin.from('screens').delete().eq('id', screen.id);
    return c.json({ error: 'Failed to issue device key', code: ErrorCode.VALIDATION_ERROR }, 400);
  }

  return c.json({ screen, device_api_key: plaintextKey }, 201);
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Screens'],
  summary: 'Edit a screen',
  request: { params: z.object({ id: z.string() }), body: { content: { 'application/json': { schema: patchScreenSchema } } } },
  responses: {
    200: { description: 'Updated screen', content: { 'application/json': { schema: z.object({ screen: screenSchema }) } } },
    ...errorResponses(400, 401, 403, 404),
  },
});

router.openapi(patchRoute, async (c: RouteContext) => {
  const auth = c.get('auth');
  const { id } = c.req.valid('param');
  const patch = c.req.valid('json');

  const { data, error } = await supabaseAdmin
    .from('screens')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', auth.tenant_id)
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: 'Screen not found', code: ErrorCode.NOT_FOUND }, 404);
  }

  return c.json({ screen: data });
});

const rotateKeyRoute = createRoute({
  method: 'post',
  path: '/{id}/rotate-key',
  tags: ['Screens'],
  summary: 'Revoke the current device API key and issue a new one',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: 'New device API key', content: { 'application/json': { schema: z.object({ device_api_key: z.string() }) } } },
    ...errorResponses(401, 403, 404),
  },
});

router.openapi(rotateKeyRoute, async (c: RouteContext) => {
  const auth = c.get('auth');
  const { id } = c.req.valid('param');

  const { data: screen, error: screenError } = await supabaseAdmin
    .from('screens')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', auth.tenant_id)
    .single();

  if (screenError || !screen) {
    return c.json({ error: 'Screen not found', code: ErrorCode.NOT_FOUND }, 404);
  }

  // Revoke-then-insert, per architecture.md's device_api_keys note ("only one
  // active row per screen enforced at the application layer, rotate =
  // revoke-then-insert in one transaction"). This is two sequential
  // service-role calls, not a real DB transaction — supabase-js has no
  // multi-statement transaction primitive without a Postgres RPC function
  // (same constraint noted on tenant+invite creation in admin-tenants.ts).
  // Revoke-first means a failed insert leaves the screen locked out rather
  // than leaving two simultaneously-active keys.
  await supabaseAdmin
    .from('device_api_keys')
    .update({ status: 'revoked', revoked_at: new Date().toISOString() })
    .eq('screen_id', id)
    .eq('status', 'active');

  const { plaintextKey, keyPrefix } = generateApiKey('device');
  const keyHash = await hashApiKey(plaintextKey);

  const { error: insertError } = await supabaseAdmin.from('device_api_keys').insert({
    screen_id: id,
    tenant_id: auth.tenant_id,
    key_hash: keyHash,
    key_prefix: keyPrefix,
  });

  if (insertError) {
    return c.json({ error: 'Failed to rotate device key', code: ErrorCode.VALIDATION_ERROR }, 400);
  }

  return c.json({ device_api_key: plaintextKey });
});

export default router;
