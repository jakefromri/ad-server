// Device API key auth — screen identity. Fully separate from Supabase Auth;
// devices are machines, never get a Supabase session (architecture.md § Auth
// Model, mechanism 3).

import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { ErrorCode } from '../types';
import { supabaseAdmin, supabaseAuth } from './supabase';
import { hashApiKey } from './hash';

export interface DeviceContext {
  screen_id: string;
  tenant_id: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    device: DeviceContext;
  }
}

export const deviceAuthMiddleware = createMiddleware(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HTTPException(401, {
      message: JSON.stringify({ error: 'Missing device API key', code: ErrorCode.UNAUTHORIZED }),
    });
  }

  const presentedKey = authHeader.slice(7);
  const keyHash = await hashApiKey(presentedKey);

  const { data: deviceKey } = await supabaseAdmin
    .from('device_api_keys')
    .select('screen_id, tenant_id, status')
    .eq('key_hash', keyHash)
    .single();

  if (!deviceKey || deviceKey.status !== 'active') {
    // Recognize a valid-but-wrong-scope credential before giving up — the
    // "vice versa" half of architecture.md § Auth Model, mechanism 3 ("403 if
    // a device tries a management endpoint, and vice versa"). Mirrors
    // tenantAccessMiddleware's fix in 04c, which only covered the reverse
    // direction (no device-only route existed yet to exercise this side).
    const { data: tenantKey } = await supabaseAdmin.from('tenant_api_keys').select('status').eq('key_hash', keyHash).single();
    if (tenantKey && tenantKey.status === 'active') {
      throw new HTTPException(403, {
        message: JSON.stringify({ error: 'Tenant API keys cannot access device endpoints', code: ErrorCode.FORBIDDEN }),
      });
    }

    const { data: jwtData, error: jwtError } = await supabaseAuth.auth.getUser(presentedKey);
    if (!jwtError && jwtData.user) {
      throw new HTTPException(403, {
        message: JSON.stringify({ error: 'Human credentials cannot access device endpoints', code: ErrorCode.FORBIDDEN }),
      });
    }

    throw new HTTPException(401, {
      message: JSON.stringify({ error: 'Invalid or revoked device key', code: ErrorCode.UNAUTHORIZED }),
    });
  }

  // Deactivated tenant check — applies to device-key auth the same as human
  // and tenant-key paths (architecture.md § Tenancy Implementation).
  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('status')
    .eq('id', deviceKey.tenant_id)
    .single();

  if (tenant?.status === 'deactivated') {
    throw new HTTPException(403, {
      message: JSON.stringify({ error: 'This organization is no longer active', code: ErrorCode.TENANT_DEACTIVATED }),
    });
  }

  c.set('device', { screen_id: deviceKey.screen_id, tenant_id: deviceKey.tenant_id });
  await next();
});
