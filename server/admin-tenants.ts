// GET/POST /api/admin/tenants, PATCH /api/admin/tenants/:id. Mounted at
// /api/admin/tenants behind humanAuthMiddleware + requireRole('superadmin').

import { Hono } from 'hono';
import { z } from 'zod';
import { ErrorCode } from '../types';
import { supabaseAdmin } from './supabase';
import { generateApiKey, hashApiKey } from './hash';
import { humanAuthMiddleware, requireRole } from './human-auth';

const router = new Hono();
router.use('*', humanAuthMiddleware, requireRole('superadmin'));

router.get('/', async (c) => {
  const { data: tenants, error } = await supabaseAdmin.from('tenants').select('*');
  if (error) return c.json({ error: error.message, code: ErrorCode.VALIDATION_ERROR }, 400);

  const ids = (tenants ?? []).map((t) => t.id);
  const usageByTenant = new Map<string, number>();
  const campaignCountByTenant = new Map<string, number>();
  const screenCountByTenant = new Map<string, number>();

  if (ids.length > 0) {
    const [{ data: usageRows }, { data: campaignRows }, { data: screenRows }] = await Promise.all([
      supabaseAdmin.from('fulfillment_quota_usage').select('tenant_id, used_count').in('tenant_id', ids),
      supabaseAdmin.from('campaigns').select('tenant_id').in('tenant_id', ids),
      supabaseAdmin.from('screens').select('tenant_id').in('tenant_id', ids),
    ]);

    for (const r of usageRows ?? []) usageByTenant.set(r.tenant_id, r.used_count);
    for (const r of campaignRows ?? []) campaignCountByTenant.set(r.tenant_id, (campaignCountByTenant.get(r.tenant_id) ?? 0) + 1);
    for (const r of screenRows ?? []) screenCountByTenant.set(r.tenant_id, (screenCountByTenant.get(r.tenant_id) ?? 0) + 1);
  }

  const result = (tenants ?? []).map((t) => ({
    ...t,
    used_count: usageByTenant.get(t.id) ?? 0,
    campaign_count: campaignCountByTenant.get(t.id) ?? 0,
    screen_count: screenCountByTenant.get(t.id) ?? 0,
  }));

  return c.json({ tenants: result });
});

const createTenantSchema = z.object({
  name: z.string().min(1),
  fulfillment_quota: z.number().int().nonnegative(),
  admin_email: z.string().email(),
});

function generateInviteToken(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

router.post('/', async (c) => {
  const auth = c.get('auth');
  const parsed = createTenantSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request', code: ErrorCode.VALIDATION_ERROR }, 400);
  }
  const body = parsed.data;

  // Tenant + tenant_api_keys row + first tenant_admin invite, atomic in
  // intent (architecture.md § Auth Model: "invite failure rolls back the
  // tenant"). supabase-js has no multi-table transaction primitive without a
  // Postgres RPC function, so this is sequential service-role calls with an
  // explicit compensating delete on failure — every child row (tenant_api_keys,
  // invites) has `on delete cascade` back to tenants (0001_initial_schema.sql),
  // so deleting the tenant row alone is enough to undo whatever was created.
  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from('tenants')
    .insert({ name: body.name, fulfillment_quota: body.fulfillment_quota })
    .select()
    .single();

  if (tenantError || !tenant) {
    return c.json({ error: tenantError?.message ?? 'Failed to create tenant', code: ErrorCode.VALIDATION_ERROR }, 400);
  }

  const { plaintextKey, keyPrefix } = generateApiKey('tenant');
  const keyHash = await hashApiKey(plaintextKey);

  const { error: keyError } = await supabaseAdmin
    .from('tenant_api_keys')
    .insert({ tenant_id: tenant.id, key_hash: keyHash, key_prefix: keyPrefix });

  if (keyError) {
    await supabaseAdmin.from('tenants').delete().eq('id', tenant.id);
    return c.json({ error: 'Failed to provision tenant API key', code: ErrorCode.VALIDATION_ERROR }, 400);
  }

  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

  const { data: invite, error: inviteError } = await supabaseAdmin
    .from('invites')
    .insert({
      tenant_id: tenant.id,
      email: body.admin_email,
      role: 'tenant_admin',
      token,
      expires_at: expiresAt,
      created_by: auth.user_id,
    })
    .select()
    .single();

  if (inviteError || !invite) {
    await supabaseAdmin.from('tenants').delete().eq('id', tenant.id);
    return c.json({ error: 'Failed to create tenant invite', code: ErrorCode.VALIDATION_ERROR }, 400);
  }

  // Ported from ComposableAuth's invite-URL pattern (hello-world/apps/api/src/routes/admin.ts).
  const inviteUrl = `${process.env.APP_URL ?? 'http://localhost:5173'}/invite?token=${token}`;

  return c.json(
    {
      tenant,
      invite: { invite_url: inviteUrl, expires_at: invite.expires_at },
      api_key: plaintextKey,
    },
    201
  );
});

const patchTenantSchema = z
  .object({
    status: z.enum(['active', 'deactivated']).optional(),
    fulfillment_quota: z.number().int().nonnegative().optional(),
    reservation_timeout_seconds: z.number().int().positive().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });

router.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const parsed = patchTenantSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request', code: ErrorCode.VALIDATION_ERROR }, 400);
  }
  const patch = parsed.data;

  const { data: tenant, error } = await supabaseAdmin.from('tenants').update(patch).eq('id', id).select().single();

  if (error || !tenant) {
    return c.json({ error: 'Tenant not found', code: ErrorCode.NOT_FOUND }, 404);
  }

  // scope.md § admin panel (Agent 03 flag): surface in-flight reservations
  // when deactivating, so the action isn't taken blind. Always 0 in 04c since
  // no fulfillment endpoint exists yet to create 'reserved' rows — the query
  // is correct and forward-compatible with 04d.
  if (patch.status === 'deactivated') {
    const { count } = await supabaseAdmin
      .from('fulfillments')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', id)
      .eq('status', 'reserved')
      .gt('reserved_expires_at', new Date().toISOString());

    return c.json({ tenant, in_flight_reservations: count ?? 0 });
  }

  return c.json({ tenant });
});

export default router;
