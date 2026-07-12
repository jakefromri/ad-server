// POST /api/invites/accept — public, no auth. Must be mounted outside any
// route glob the human-auth middleware guards (Builder spec's public-routes
// checklist item). Reused as-is from ComposableAuth
// (hello-world/apps/api/src/routes/invites.ts), adapted to ad-server's
// shared types/error codes. Converted to createRoute/OpenAPIHono in 04i (see
// server/openapi.ts) so it's documented at GET /v1/openapi.json.

import { ErrorCode } from '../types';
import { supabaseAdmin } from './supabase';
import { newRouter, createRoute, z, errorResponses, type RouteContext } from './openapi';

const router = newRouter();

const acceptSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: z.string().min(10, 'Password must be at least 10 characters'),
});

const acceptRoute = createRoute({
  method: 'post',
  path: '/accept',
  tags: ['Invites'],
  summary: 'Accept a tenant_admin invite',
  request: {
    body: { content: { 'application/json': { schema: acceptSchema } } },
  },
  responses: {
    201: {
      description: 'Invite accepted, Supabase Auth user created',
      content: { 'application/json': { schema: z.object({ user: z.object({ id: z.string(), email: z.string() }) }) } },
    },
    ...errorResponses(400, 409),
  },
});

// Handler param is `c: RouteContext`, here and in every other 04i-converted route —
// @hono/zod-openapi's typed-response system requires every `c.json(...)`
// call in a handler to structurally match one declared `responses` status
// entry, verified via TS overload resolution across the whole function body.
// That breaks down across handlers with several differently-shaped
// success/error branches (a rough edge in the library's typing, not a
// runtime concern — request validation and the actual response body are
// unaffected either way; `c.req.valid(...)` still returns the right runtime
// value, just untyped). `route`'s `responses` object is still exactly what
// GET /v1/openapi.json / GET /docs render, so documentation accuracy isn't
// affected by loosening the handler's own parameter type.
router.openapi(acceptRoute, async (c: RouteContext) => {
  const { token, password } = c.req.valid('json');

  const { data: invite, error: inviteError } = await supabaseAdmin
    .from('invites')
    .select('*')
    .eq('token', token)
    .single();

  if (inviteError || !invite) {
    return c.json({ error: 'Invite not found', code: ErrorCode.NOT_FOUND }, 400);
  }

  if (invite.accepted_at) {
    return c.json({ error: 'Invite already accepted', code: ErrorCode.VALIDATION_ERROR }, 409);
  }

  if (new Date(invite.expires_at) < new Date()) {
    return c.json({ error: 'Invite has expired', code: ErrorCode.VALIDATION_ERROR }, 400);
  }

  const { data: newUser, error: signupError } = await supabaseAdmin.auth.admin.createUser({
    email: invite.email,
    password,
    app_metadata: {
      role: invite.role,
      tenant_id: invite.tenant_id,
    },
    email_confirm: true,
  });

  if (signupError || !newUser.user) {
    if (signupError?.message.includes('already been registered')) {
      return c.json({ error: 'Email already registered', code: ErrorCode.VALIDATION_ERROR }, 409);
    }
    return c.json({ error: signupError?.message ?? 'Failed to create user', code: ErrorCode.VALIDATION_ERROR }, 400);
  }

  await supabaseAdmin.from('memberships').insert({
    tenant_id: invite.tenant_id,
    user_id: newUser.user.id,
    role: invite.role,
  });

  await supabaseAdmin.from('invites').update({ accepted_at: new Date().toISOString() }).eq('id', invite.id);

  return c.json({ user: { id: newUser.user.id, email: invite.email } }, 201);
});

export default router;
