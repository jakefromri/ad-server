// ADMIN-INT-01,02,04,05, ONBOARD-INT-01,02, MEDIA-INT-01, SIM-INT-01.
// test-plan.md § Integration Tests. (ADMIN-INT-03/06-09, USAGE-*, DOCS-*,
// FULFILL-ATTEMPT-INT-01 are 04i scope — those endpoints/fields don't exist
// on this branch yet, see SESSION_HANDOFF.md.)

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import {
  createTenantFixture,
  createTenantViaSuperadmin,
  createSuperadminSession,
  createCampaign,
  registerScreen,
  jsonRequest,
  cleanupAll,
  supabaseAdmin,
} from '../helpers';

describe('ADMIN-INT', () => {
  afterAll(cleanupAll);

  it('ADMIN-INT-01: update tenant quota — happy path, reflected immediately on tenant usage', async () => {
    const tenant = await createTenantFixture({ fulfillment_quota: 10 });
    const { status, body } = await jsonRequest(`/api/admin/tenants/${tenant.tenantId}`, {
      method: 'PATCH',
      token: tenant.superadmin.token,
      json: { fulfillment_quota: 500 },
    });
    expect(status).toBe(200);
    expect(Number(body.tenant.fulfillment_quota)).toBe(500);

    const usage = await jsonRequest('/v1/tenant/usage', { token: tenant.tenantAdmin.token });
    expect(usage.body.quota).toBe(500);
  });

  it('ADMIN-INT-02: invalid status value rejected', async () => {
    const tenant = await createTenantFixture();
    const { status } = await jsonRequest(`/api/admin/tenants/${tenant.tenantId}`, {
      method: 'PATCH',
      token: tenant.superadmin.token,
      json: { status: 'archived' },
    });
    expect(status).toBe(400);
  });

  it('ADMIN-INT-04: ledger endpoint — pagination and tenant filter', async () => {
    const tenantA = await createTenantFixture();
    const tenantB = await createTenantFixture();
    await createCampaign(tenantA.tenantAdmin);
    await createCampaign(tenantB.tenantAdmin);
    const screenA1 = await registerScreen(tenantA.tenantAdmin);
    const screenA2 = await registerScreen(tenantA.tenantAdmin);
    const screenB = await registerScreen(tenantB.tenantAdmin);
    await jsonRequest('/v1/fulfillments', { method: 'POST', token: screenA1.body.device_api_key });
    await jsonRequest('/v1/fulfillments', { method: 'POST', token: screenA2.body.device_api_key });
    await jsonRequest('/v1/fulfillments', { method: 'POST', token: screenB.body.device_api_key });

    const { status, body } = await jsonRequest(`/api/admin/ledger?tenant_id=${tenantA.tenantId}&limit=1`, { token: tenantA.superadmin.token });
    expect(status).toBe(200);
    expect(body.fulfillments).toHaveLength(1);
    expect(body.fulfillments[0].tenant_id).toBe(tenantA.tenantId);
    expect(body.next_cursor).toBeTruthy();
  });

  it('ADMIN-INT-05: non-superadmin blocked from ledger', async () => {
    const tenant = await createTenantFixture();
    const { status } = await jsonRequest('/api/admin/ledger', { token: tenant.tenantAdmin.token });
    expect(status).toBe(403);
  });
});

describe('ONBOARD-INT', () => {
  afterAll(cleanupAll);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ONBOARD-INT-01: tenant creation is atomic with invite — invite failure rolls back the tenant', async () => {
    const superadmin = await createSuperadminSession();

    // Force the invites insert specifically to fail, passing every other
    // table through to the real client — exercises admin-tenants.ts's
    // actual compensating-delete path (`if (inviteError || !invite) { ...
    // delete tenant ... }`) rather than just asserting the documented
    // invariant holds on the happy path.
    const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
    vi.spyOn(supabaseAdmin, 'from').mockImplementation((table: string) => {
      if (table === 'invites') {
        return {
          insert: () => ({
            select: () => ({
              single: async () => ({ data: null, error: { message: 'forced invite failure for ONBOARD-INT-01' } }),
            }),
          }),
        } as any;
      }
      return originalFrom(table as any);
    });

    const { status } = await jsonRequest('/api/admin/tenants', {
      method: 'POST',
      token: superadmin.token,
      json: { name: 'Atomic Rollback Test Tenant', fulfillment_quota: 10, admin_email: 'atomic-test@example.com' },
    });
    expect(status).toBe(400);

    vi.restoreAllMocks();
    const { data: orphanedTenant } = await supabaseAdmin.from('tenants').select('id').eq('name', 'Atomic Rollback Test Tenant').maybeSingle();
    expect(orphanedTenant).toBeNull();
  });

  it('ONBOARD-INT-02: new tenant receives quota, API key, and invite in one response', async () => {
    const onboarding = await createTenantViaSuperadmin({ fulfillment_quota: 42 });
    expect(onboarding.raw.tenant.fulfillment_quota).toBe(42);
    expect(onboarding.raw.invite.invite_url).toBeTruthy();
    expect(onboarding.raw.invite.expires_at).toBeTruthy();
    expect(onboarding.raw.api_key).toMatch(/^tenant_/);
  });
});

describe('MEDIA-INT-01: creative path stored and returned as-is, never validated', () => {
  afterAll(cleanupAll);

  it('an obviously-fake media path is accepted at creation and returned verbatim at fulfillment', async () => {
    const tenant = await createTenantFixture();
    const created = await createCampaign(tenant.tenantAdmin, { creative_media_path: 'not-a-real-path' });
    expect(created.status).toBe(201);

    const screen = await registerScreen(tenant.tenantAdmin);
    const { status, body } = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(status).toBe(201);
    expect(body.media_ref).toBe('not-a-real-path');
  });
});

describe('SIM-INT-01: simulator-registered screens are flagged', () => {
  afterAll(cleanupAll);

  it('is_simulated: true persists and is returned on GET /v1/screens', async () => {
    const tenant = await createTenantFixture();
    await registerScreen(tenant.tenantAdmin, { is_simulated: true, label: 'Sim Screen 0001' });

    const { status, body } = await jsonRequest('/v1/screens', { token: tenant.tenantAdmin.token });
    expect(status).toBe(200);
    const simScreen = body.screens.find((s: any) => s.label === 'Sim Screen 0001');
    expect(simScreen?.is_simulated).toBe(true);
  });
});
