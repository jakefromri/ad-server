// GET /v1/tenant/api-key, POST /v1/tenant/api-key/rotate, GET /v1/tenant/usage,
// GET /v1/tenant/usage/by-screen. Mounted at /v1/tenant behind
// tenantAccessMiddleware (JWT-or-tenant-key).

import { Hono } from 'hono';
import { ErrorCode } from '../types';
import { supabaseAdmin } from './supabase';
import { generateApiKey, hashApiKey } from './hash';
import { tenantAccessMiddleware } from './tenant-access';
import { getQuotaUsage } from './quota';

const router = new Hono();
router.use('*', tenantAccessMiddleware);

router.get('/api-key', async (c) => {
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

router.post('/api-key/rotate', async (c) => {
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

router.get('/usage', async (c) => {
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
router.get('/usage/by-screen', async (c) => {
  const auth = c.get('auth');
  const windowHoursParam = c.req.query('window_hours');

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
