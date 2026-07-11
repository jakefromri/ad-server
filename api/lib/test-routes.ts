// 04b-only scaffolding to prove the three auth middlewares work end to end
// before the real screen-registration (04c) and campaign (04c) endpoints
// exist. Not in architecture.md's API Endpoints list — delete or fold into
// 04c's real routes once /v1/screens exists (POST /v1/screens will replace
// the issue side of this).

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ErrorCode } from '../../types';
import { supabaseAdmin } from './supabase';
import { generateApiKey, hashApiKey } from './hash';
import { humanAuthMiddleware, requireRole } from './human-auth';
import { deviceAuthMiddleware } from './device-auth';
import { tenantKeyAuthMiddleware } from './tenant-key-auth';

const router = new Hono();

// GET /api/_test/whoami — human JWT only. Proves a superadmin is
// distinguishable from a tenant_admin via JWT claims.
router.get('/whoami', humanAuthMiddleware, (c) => c.json(c.get('auth')));

// POST /api/_test/device-key { tenant_id } — superadmin only. Creates a
// throwaway screen for that tenant and issues a working device key.
router.post('/device-key', humanAuthMiddleware, requireRole('superadmin'), async (c) => {
  const body = await c.req.json<{ tenant_id?: string }>();
  if (!body.tenant_id) {
    throw new HTTPException(400, {
      message: JSON.stringify({ error: 'tenant_id is required', code: ErrorCode.VALIDATION_ERROR }),
    });
  }

  const { data: screen, error: screenError } = await supabaseAdmin
    .from('screens')
    .insert({
      tenant_id: body.tenant_id,
      label: '04b test screen',
      aspect_ratio: '16:9',
      resolution: '1920x1080',
      orientation: 'landscape',
      is_simulated: true,
    })
    .select('id')
    .single();

  if (screenError || !screen) {
    throw new HTTPException(400, {
      message: JSON.stringify({ error: screenError?.message ?? 'Failed to create screen', code: ErrorCode.VALIDATION_ERROR }),
    });
  }

  const { plaintextKey, keyPrefix } = generateApiKey('device');
  const keyHash = await hashApiKey(plaintextKey);

  await supabaseAdmin.from('device_api_keys').insert({
    screen_id: screen.id,
    tenant_id: body.tenant_id,
    key_hash: keyHash,
    key_prefix: keyPrefix,
  });

  return c.json({ screen_id: screen.id, device_api_key: plaintextKey }, 201);
});

// GET /api/_test/device-key/verify — device key only. Proves issue -> verify.
router.get('/device-key/verify', deviceAuthMiddleware, (c) => c.json(c.get('device')));

// POST /api/_test/tenant-key { tenant_id } — superadmin only. Issues (or
// rotates) that tenant's tenant_api_keys row.
router.post('/tenant-key', humanAuthMiddleware, requireRole('superadmin'), async (c) => {
  const body = await c.req.json<{ tenant_id?: string }>();
  if (!body.tenant_id) {
    throw new HTTPException(400, {
      message: JSON.stringify({ error: 'tenant_id is required', code: ErrorCode.VALIDATION_ERROR }),
    });
  }

  const { plaintextKey, keyPrefix } = generateApiKey('tenant');
  const keyHash = await hashApiKey(plaintextKey);

  const { error } = await supabaseAdmin
    .from('tenant_api_keys')
    .upsert({ tenant_id: body.tenant_id, key_hash: keyHash, key_prefix: keyPrefix, status: 'active' });

  if (error) {
    throw new HTTPException(400, {
      message: JSON.stringify({ error: error.message, code: ErrorCode.VALIDATION_ERROR }),
    });
  }

  return c.json({ tenant_api_key: plaintextKey }, 201);
});

// GET /api/_test/tenant-key/verify — tenant key only. Proves issue -> verify.
router.get('/tenant-key/verify', tenantKeyAuthMiddleware, (c) => c.json(c.get('auth')));

export default router;
