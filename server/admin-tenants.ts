// GET/POST /api/admin/tenants, PATCH /api/admin/tenants/:id,
// GET /api/admin/tenants/:id, POST /api/admin/tenants/:id/reinvite. Mounted
// at /api/admin/tenants behind humanAuthMiddleware + requireRole('superadmin').

import { ErrorCode } from '../types';
import { supabaseAdmin } from './supabase';
import { generateApiKey, hashApiKey } from './hash';
import { humanAuthMiddleware, requireRole } from './human-auth';
import { newRouter, createRoute, z, errorResponses, type RouteContext } from './openapi';

const router = newRouter();
router.use('*', humanAuthMiddleware, requireRole('superadmin'));

const tenantSchema = z.record(z.unknown());

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Admin — Tenants'],
  summary: 'List all tenants with quota usage and campaign/screen counts',
  responses: {
    200: { description: 'Tenant list', content: { 'application/json': { schema: z.object({ tenants: z.array(tenantSchema) }) } } },
    ...errorResponses(401, 403),
  },
});

router.openapi(listRoute, async (c: RouteContext) => {
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

function buildInviteUrl(token: string): string {
  // Ported from ComposableAuth's invite-URL pattern (hello-world/apps/api/src/routes/admin.ts).
  return `${process.env.APP_URL ?? 'http://localhost:5173'}/invite?token=${token}`;
}

// Shared by POST '/' (first invite, atomic with tenant creation) and POST
// '/:id/reinvite' (04i, follow-up scoping session) — architecture.md's
// reinvite design explicitly says to extract this rather than duplicate it.
async function createTenantAdminInvite(params: { tenantId: string; email: string; createdBy: string }) {
  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

  return supabaseAdmin
    .from('invites')
    .insert({
      tenant_id: params.tenantId,
      email: params.email,
      role: 'tenant_admin',
      token,
      expires_at: expiresAt,
      created_by: params.createdBy,
    })
    .select()
    .single();
}

const createRoute_ = createRoute({
  method: 'post',
  path: '/',
  tags: ['Admin — Tenants'],
  summary: 'Create a tenant, its first tenant API key, and its first tenant_admin invite (atomic)',
  request: { body: { content: { 'application/json': { schema: createTenantSchema } } } },
  responses: {
    201: {
      description: 'Tenant created',
      content: {
        'application/json': {
          schema: z.object({
            tenant: tenantSchema,
            invite: z.object({ invite_url: z.string(), expires_at: z.string() }),
            api_key: z.string(),
          }),
        },
      },
    },
    ...errorResponses(400, 401, 403),
  },
});

// Handler param is `c: RouteContext`, here and in every other 04i-converted route —
// @hono/zod-openapi's typed-response system requires every `c.json(...)`
// call in a handler to structurally match one declared `responses` status
// entry, verified via TS overload resolution across the whole function
// body. That breaks down across handlers with several differently-shaped
// success/error branches (a rough edge in the library's typing, not a
// runtime concern — request validation and the actual response body are
// unaffected either way; `c.req.valid(...)` still returns the right runtime
// value, just untyped).
router.openapi(createRoute_, async (c: RouteContext) => {
  const auth = c.get('auth');
  const body = c.req.valid('json');

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

  const { data: invite, error: inviteError } = await createTenantAdminInvite({
    tenantId: tenant.id,
    email: body.admin_email,
    createdBy: auth.user_id as string,
  });

  if (inviteError || !invite) {
    await supabaseAdmin.from('tenants').delete().eq('id', tenant.id);
    return c.json({ error: 'Failed to create tenant invite', code: ErrorCode.VALIDATION_ERROR }, 400);
  }

  return c.json(
    {
      tenant,
      invite: { invite_url: buildInviteUrl(invite.token), expires_at: invite.expires_at },
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

const patchRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Admin — Tenants'],
  summary: 'Update a tenant (status, quota, reservation timeout)',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: patchTenantSchema } } },
  },
  responses: {
    200: {
      description: 'Updated tenant (includes in_flight_reservations if deactivating)',
      content: { 'application/json': { schema: z.object({ tenant: tenantSchema, in_flight_reservations: z.number().optional() }) } },
    },
    ...errorResponses(400, 401, 403, 404),
  },
});

router.openapi(patchRoute, async (c: RouteContext) => {
  const { id } = c.req.valid('param');
  const patch = c.req.valid('json');

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

// GET /api/admin/tenants/:id (04i, follow-up scoping session) — one combined
// fetch of tenant + campaigns + screens rather than three round trips, since
// a superadmin JWT gets 403 on GET /v1/campaigns / GET /v1/screens directly
// (tenantAccessMiddleware only accepts tenant_admin-role JWTs). This route
// bypasses that restriction deliberately, scoped to this one superadmin-only
// endpoint — architecture.md explicitly says not to loosen
// tenantAccessMiddleware itself for this.
const detailRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Admin — Tenants'],
  summary: 'Tenant detail — tenant + all campaigns + all screens',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Tenant, campaigns, screens',
      content: {
        'application/json': { schema: z.object({ tenant: tenantSchema, campaigns: z.array(tenantSchema), screens: z.array(tenantSchema) }) },
      },
    },
    ...errorResponses(401, 403, 404),
  },
});

router.openapi(detailRoute, async (c: RouteContext) => {
  const { id } = c.req.valid('param');

  const { data: tenant, error } = await supabaseAdmin.from('tenants').select('*').eq('id', id).single();
  if (error || !tenant) {
    return c.json({ error: 'Tenant not found', code: ErrorCode.NOT_FOUND }, 404);
  }

  const [{ data: campaigns }, { data: screens }] = await Promise.all([
    supabaseAdmin.from('campaigns').select('*').eq('tenant_id', id),
    supabaseAdmin.from('screens').select('*').eq('tenant_id', id),
  ]);

  return c.json({ tenant, campaigns: campaigns ?? [], screens: screens ?? [] });
});

// POST /api/admin/tenants/:id/reinvite (04i, follow-up scoping session) —
// closes the gap flagged since 04c/04d: scope.md already lists this as MVP
// superadmin capability, no endpoint shape existed before this phase.
const reinviteRoute = createRoute({
  method: 'post',
  path: '/{id}/reinvite',
  tags: ['Admin — Tenants'],
  summary: 'Re-send a tenant_admin invite for a tenant with no accepted admin yet',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'New invite issued',
      content: { 'application/json': { schema: z.object({ invite: z.object({ invite_url: z.string(), expires_at: z.string() }) }) } },
    },
    ...errorResponses(400, 401, 403, 404),
  },
});

router.openapi(reinviteRoute, async (c: RouteContext) => {
  const auth = c.get('auth');
  const { id } = c.req.valid('param');

  const { data: tenant, error: tenantError } = await supabaseAdmin.from('tenants').select('id').eq('id', id).single();
  if (tenantError || !tenant) {
    return c.json({ error: 'Tenant not found', code: ErrorCode.NOT_FOUND }, 404);
  }

  // Only valid when the tenant has no accepted tenant_admin yet — covers both
  // an expired/unused invite and no invite ever having been accepted.
  const { data: adminMembership } = await supabaseAdmin
    .from('memberships')
    .select('id')
    .eq('tenant_id', id)
    .eq('role', 'tenant_admin')
    .maybeSingle();

  if (adminMembership) {
    return c.json({ error: 'Tenant already has an accepted tenant_admin', code: ErrorCode.TENANT_ALREADY_HAS_ADMIN }, 400);
  }

  // Grab the target email off the most recent unaccepted invite before
  // invalidating it — POST '/' always creates one atomically with the
  // tenant, so there's always at least one to read from here.
  const { data: priorInvite } = await supabaseAdmin
    .from('invites')
    .select('email')
    .eq('tenant_id', id)
    .is('accepted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!priorInvite) {
    return c.json({ error: 'No pending invite found for this tenant', code: ErrorCode.NOT_FOUND }, 404);
  }

  // Invalidate every prior unaccepted invite — architecture.md: "mark
  // status = 'superseded' or delete, either is safe since an unaccepted
  // invite has no dependent state." invites has no status column (0001
  // schema), so delete is the simpler of the two safe options.
  await supabaseAdmin.from('invites').delete().eq('tenant_id', id).is('accepted_at', null);

  const { data: invite, error: inviteError } = await createTenantAdminInvite({
    tenantId: id,
    email: priorInvite.email,
    createdBy: auth.user_id as string,
  });

  if (inviteError || !invite) {
    return c.json({ error: 'Failed to create invite', code: ErrorCode.VALIDATION_ERROR }, 400);
  }

  return c.json({ invite: { invite_url: buildInviteUrl(invite.token), expires_at: invite.expires_at } });
});

export default router;
