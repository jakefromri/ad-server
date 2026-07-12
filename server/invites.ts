// POST /api/invites/accept — public, no auth. Must be mounted outside any
// route glob the human-auth middleware guards (Builder spec's public-routes
// checklist item). Reused as-is from ComposableAuth
// (hello-world/apps/api/src/routes/invites.ts), adapted to ad-server's
// shared types/error codes.

import { Hono } from 'hono';
import { z } from 'zod';
import { ErrorCode } from '../types';
import { supabaseAdmin } from './supabase';

const router = new Hono();

const acceptSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: z.string().min(10, 'Password must be at least 10 characters'),
});

router.post('/accept', async (c) => {
  const parsed = acceptSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request', code: ErrorCode.VALIDATION_ERROR }, 400);
  }
  const { token, password } = parsed.data;

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
