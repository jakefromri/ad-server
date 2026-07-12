// Tenant API key auth — programmatic management access (external scripts, the
// "API docs" use case), held by the tenant_admin (architecture.md § Auth
// Model, mechanism 2). Attaches the same `auth` context shape as a
// tenant_admin JWT so downstream route handlers don't need to know which
// mechanism authenticated the request.

import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { ErrorCode } from '../types';
import { supabaseAdmin } from './supabase';
import { hashApiKey } from './hash';
import type { AuthContext } from './human-auth';

export const tenantKeyAuthMiddleware = createMiddleware(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HTTPException(401, {
      message: JSON.stringify({ error: 'Missing tenant API key', code: ErrorCode.UNAUTHORIZED }),
    });
  }

  const presentedKey = authHeader.slice(7);
  const keyHash = await hashApiKey(presentedKey);

  const { data: tenantKey } = await supabaseAdmin
    .from('tenant_api_keys')
    .select('tenant_id, status')
    .eq('key_hash', keyHash)
    .single();

  if (!tenantKey || tenantKey.status !== 'active') {
    throw new HTTPException(401, {
      message: JSON.stringify({ error: 'Invalid or revoked tenant API key', code: ErrorCode.UNAUTHORIZED }),
    });
  }

  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('status')
    .eq('id', tenantKey.tenant_id)
    .single();

  if (tenant?.status === 'deactivated') {
    throw new HTTPException(403, {
      message: JSON.stringify({ error: 'This organization is no longer active', code: ErrorCode.TENANT_DEACTIVATED }),
    });
  }

  const auth: AuthContext = { user_id: null, role: 'tenant_admin', tenant_id: tenantKey.tenant_id };
  c.set('auth', auth);
  await next();
});
