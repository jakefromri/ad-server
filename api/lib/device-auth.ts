// Device API key auth — screen identity. Fully separate from Supabase Auth;
// devices are machines, never get a Supabase session (architecture.md § Auth
// Model, mechanism 3).

import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { ErrorCode } from '../../types';
import { supabaseAdmin } from './supabase';
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
