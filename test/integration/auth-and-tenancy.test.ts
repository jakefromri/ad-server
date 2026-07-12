// AUTH-INT-01..06, TENANCY-INT-01..02. test-plan.md § Integration Tests.

import { describe, it, expect, afterAll } from 'vitest';
import {
  createTenantFixture,
  createTenantViaSuperadmin,
  createCampaign,
  registerScreen,
  jsonRequest,
  cleanupAll,
  supabaseAdmin,
} from '../helpers';

describe('AUTH-INT: invite acceptance', () => {
  afterAll(cleanupAll);

  it('AUTH-INT-04: happy path creates a working tenant_admin', async () => {
    const onboarding = await createTenantViaSuperadmin();
    const { status, body } = await jsonRequest('/api/invites/accept', {
      method: 'POST',
      json: { token: onboarding.inviteToken, password: 'a-valid-password-123' },
    });
    expect(status).toBe(201);
    expect(body.user.email).toBe(onboarding.inviteEmail);

    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(body.user.id);
    expect(authUser.user?.app_metadata.tenant_id).toBe(onboarding.tenantId);
    expect(authUser.user?.app_metadata.role).toBe('tenant_admin');

    const { data: membership } = await supabaseAdmin
      .from('memberships')
      .select('*')
      .eq('tenant_id', onboarding.tenantId)
      .eq('user_id', body.user.id)
      .maybeSingle();
    expect(membership).toBeTruthy();

    const { data: invite } = await supabaseAdmin.from('invites').select('accepted_at').eq('token', onboarding.inviteToken).single();
    expect(invite?.accepted_at).toBeTruthy();
  });

  it('AUTH-INT-05: expired token rejected', async () => {
    const onboarding = await createTenantViaSuperadmin();
    await supabaseAdmin.from('invites').update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('token', onboarding.inviteToken);

    const { status } = await jsonRequest('/api/invites/accept', {
      method: 'POST',
      json: { token: onboarding.inviteToken, password: 'a-valid-password-123' },
    });
    expect(status).toBe(400);
  });

  it('AUTH-INT-06: already-accepted token rejected', async () => {
    const onboarding = await createTenantViaSuperadmin();
    const first = await jsonRequest('/api/invites/accept', {
      method: 'POST',
      json: { token: onboarding.inviteToken, password: 'a-valid-password-123' },
    });
    expect(first.status).toBe(201);

    const second = await jsonRequest('/api/invites/accept', {
      method: 'POST',
      json: { token: onboarding.inviteToken, password: 'a-different-password-456' },
    });
    expect(second.status).toBe(409);
  });
});

describe('AUTH-INT: dual auth, role enforcement, unauthenticated', () => {
  afterAll(cleanupAll);

  it('AUTH-INT-01: tenant API key authenticates management endpoints, scoped to that tenant', async () => {
    const tenant = await createTenantFixture();
    await createCampaign(tenant.tenantAdmin);

    const { status, body } = await jsonRequest('/v1/campaigns', { token: tenant.tenantApiKey });
    expect(status).toBe(200);
    expect(body.campaigns.length).toBeGreaterThan(0);
    expect(body.campaigns.every((c: any) => c.tenant_id === tenant.tenantId)).toBe(true);
  });

  it('AUTH-INT-02: tenant_admin cannot access superadmin routes', async () => {
    const tenant = await createTenantFixture();
    const { status } = await jsonRequest('/api/admin/tenants', { token: tenant.tenantAdmin.token });
    expect(status).toBe(403);
  });

  it('AUTH-INT-03: unauthenticated fulfillment request blocked', async () => {
    const { status } = await jsonRequest('/v1/fulfillments', { method: 'POST' });
    expect(status).toBe(401);
  });
});

describe('TENANCY-INT: cross-tenant isolation', () => {
  afterAll(cleanupAll);

  it('TENANCY-INT-01: reconciliation pool never spans tenants', async () => {
    const tenantA = await createTenantFixture();
    const tenantB = await createTenantFixture();

    // Identically-targeted active campaign for both tenants.
    await createCampaign(tenantA.tenantAdmin, { name: 'A campaign' });
    await createCampaign(tenantB.tenantAdmin, { name: 'B campaign' });

    const screenA = await registerScreen(tenantA.tenantAdmin);
    const { status, body } = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screenA.body.device_api_key });

    expect(status).toBe(201);
    // The reserved campaign must be Tenant A's, never Tenant B's.
    const { data: reservedCampaign } = await supabaseAdmin.from('campaigns').select('tenant_id').eq('id', body.campaign_id).single();
    expect(reservedCampaign?.tenant_id).toBe(tenantA.tenantId);
  });

  it('TENANCY-INT-02: deactivated tenant blocks fulfillment', async () => {
    const tenant = await createTenantFixture();
    await createCampaign(tenant.tenantAdmin);
    const screen = await registerScreen(tenant.tenantAdmin);

    const patchRes = await jsonRequest(`/api/admin/tenants/${tenant.tenantId}`, {
      method: 'PATCH',
      token: tenant.superadmin.token,
      json: { status: 'deactivated' },
    });
    expect(patchRes.status).toBe(200);

    const { status, body } = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(status).toBe(403);
    expect(body.code).toBe('TENANT_DEACTIVATED');
  });
});
