// Composed auth for tenant-scoped management endpoints (campaigns, screens,
// tenant api-key/usage): JWT checked first, falls through to tenant API key
// only if no/invalid Bearer JWT was presented (architecture.md § Auth Model,
// mechanism 2 — "JWT checked first, falls through to API-key check if
// no/invalid Bearer JWT"). A *valid* JWT with the wrong role does not fall
// through — it's a resolved identity, just an insufficiently-privileged one.
//
// If neither JWT nor tenant key match, the credential is checked against
// device_api_keys before giving up: a *valid* device key must be rejected
// with 403 (a recognized identity hitting the wrong scope of endpoint), not
// 401 (architecture.md § Auth Model, mechanism 3 — "403 if a device tries a
// management endpoint, and vice versa"; SCREEN-INT-03, APIKEY-INT-02).

import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { ErrorCode } from '../../types';
import { supabaseAdmin, supabaseAuth } from './supabase';
import { hashApiKey } from './hash';
import type { AuthContext } from './human-auth';

export const tenantAccessMiddleware = createMiddleware(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HTTPException(401, {
      message: JSON.stringify({ error: 'Missing authorization', code: ErrorCode.UNAUTHORIZED }),
    });
  }

  const token = authHeader.slice(7);
  const { data: jwtData, error: jwtError } = await supabaseAuth.auth.getUser(token);

  let auth: AuthContext;

  if (!jwtError && jwtData.user) {
    const meta = jwtData.user.app_metadata as Partial<{ role: AuthContext['role']; tenant_id: string | null }>;
    if (meta.role !== 'tenant_admin') {
      throw new HTTPException(403, {
        message: JSON.stringify({ error: 'Insufficient permissions', code: ErrorCode.FORBIDDEN }),
      });
    }
    auth = { user_id: jwtData.user.id, role: 'tenant_admin', tenant_id: meta.tenant_id ?? null };
  } else {
    const keyHash = await hashApiKey(token);
    const { data: tenantKey } = await supabaseAdmin
      .from('tenant_api_keys')
      .select('tenant_id, status')
      .eq('key_hash', keyHash)
      .single();

    if (!tenantKey || tenantKey.status !== 'active') {
      const { data: deviceKey } = await supabaseAdmin
        .from('device_api_keys')
        .select('status')
        .eq('key_hash', keyHash)
        .single();

      if (deviceKey && deviceKey.status === 'active') {
        throw new HTTPException(403, {
          message: JSON.stringify({ error: 'Device keys cannot access management endpoints', code: ErrorCode.FORBIDDEN }),
        });
      }

      throw new HTTPException(401, {
        message: JSON.stringify({ error: 'Invalid or expired token', code: ErrorCode.UNAUTHORIZED }),
      });
    }

    auth = { user_id: null, role: 'tenant_admin', tenant_id: tenantKey.tenant_id };
  }

  if (!auth.tenant_id) {
    throw new HTTPException(403, {
      message: JSON.stringify({ error: 'Insufficient permissions', code: ErrorCode.FORBIDDEN }),
    });
  }

  // Deactivated tenant check — same as the other two auth paths
  // (architecture.md § Tenancy Implementation).
  const { data: tenant } = await supabaseAdmin.from('tenants').select('status').eq('id', auth.tenant_id).single();
  if (tenant?.status === 'deactivated') {
    throw new HTTPException(403, {
      message: JSON.stringify({ error: 'This organization is no longer active', code: ErrorCode.TENANT_DEACTIVATED }),
    });
  }

  c.set('auth', auth);
  await next();
});
