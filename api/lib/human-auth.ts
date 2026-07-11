// Human auth (superadmin / tenant_admin) — Supabase Auth JWT. Reused from
// ComposableAuth (hello-world/apps/api/src/middleware/auth.ts) as-is per
// architecture.md § Auth Model.

import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { JwtClaims } from '../../types';
import { ErrorCode } from '../../types';
import { supabaseAuth, supabaseAdmin } from './supabase';

export interface AuthContext {
  user_id: string | null;
  role: JwtClaims['role'];
  tenant_id: string | null;
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

export const humanAuthMiddleware = createMiddleware(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new HTTPException(401, {
      message: JSON.stringify({ error: 'Missing authorization token', code: ErrorCode.UNAUTHORIZED }),
    });
  }

  const token = authHeader.slice(7);
  const { data, error } = await supabaseAuth.auth.getUser(token);

  if (error || !data.user) {
    throw new HTTPException(401, {
      message: JSON.stringify({ error: 'Invalid or expired token', code: ErrorCode.UNAUTHORIZED }),
    });
  }

  const meta = data.user.app_metadata as Partial<JwtClaims>;
  const role = meta.role;
  const tenant_id = meta.tenant_id ?? null;

  if (!role) {
    throw new HTTPException(401, {
      message: JSON.stringify({ error: 'Token missing role claim', code: ErrorCode.UNAUTHORIZED }),
    });
  }

  // Deactivated tenant check — immediately after tenant resolution, before any
  // business logic (architecture.md § Tenancy Implementation). Superadmin has
  // no tenant_id, so this only ever applies to tenant_admin.
  if (tenant_id && role !== 'superadmin') {
    const { data: tenant } = await supabaseAdmin.from('tenants').select('status').eq('id', tenant_id).single();

    if (tenant?.status === 'deactivated') {
      throw new HTTPException(403, {
        message: JSON.stringify({
          error: 'This organization is no longer active',
          code: ErrorCode.TENANT_DEACTIVATED,
        }),
      });
    }
  }

  c.set('auth', { user_id: data.user.id, role, tenant_id });
  await next();
});

export const requireRole = (...roles: JwtClaims['role'][]) =>
  createMiddleware(async (c, next) => {
    const auth = c.get('auth');
    if (!roles.includes(auth.role)) {
      throw new HTTPException(403, {
        message: JSON.stringify({ error: 'Insufficient permissions', code: ErrorCode.FORBIDDEN }),
      });
    }
    await next();
  });
