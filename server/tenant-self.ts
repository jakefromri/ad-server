// GET /v1/tenant/api-key, POST /v1/tenant/api-key/rotate, GET /v1/tenant/usage.
// Mounted at /v1/tenant behind tenantAccessMiddleware (JWT-or-tenant-key).

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

export default router;
