// ADMIN-INT-03, ADMIN-INT-06..09, USAGE-INT-01..03, FULFILL-ATTEMPT-INT-01
// — 04i, follow-up scoping session. test-plan.md § Integration Tests.
// (docs.ts/OpenAPI — OPENAPI-UNIT-01, both DOCS-INT-01 entries — was
// attempted and reverted in this same phase; see build-report.md's 04i
// section and api/index.ts's header comment for why.)

import { describe, it, expect, afterAll } from 'vitest';
import {
  createTenantFixture,
  createTenantViaSuperadmin,
  createCampaign,
  registerScreen,
  jsonRequest,
  cleanupAll,
  supabaseAdmin,
  trackUser,
  waitUntil,
} from '../helpers';

describe('ADMIN-INT-06/07: reinvite', () => {
  afterAll(cleanupAll);

  it('ADMIN-INT-06: happy path — new invite issued, old token no longer accepts, new one does', async () => {
    const onboarding = await createTenantViaSuperadmin();

    const { status, body } = await jsonRequest(`/api/admin/tenants/${onboarding.tenantId}/reinvite`, {
      method: 'POST',
      token: onboarding.superadmin.token,
    });
    expect(status).toBe(200);
    expect(body.invite.invite_url).toBeTruthy();
    expect(body.invite.expires_at).toBeTruthy();

    const oldAccept = await jsonRequest('/api/invites/accept', {
      method: 'POST',
      json: { token: onboarding.inviteToken, password: 'ReinviteTest123!' },
    });
    expect(oldAccept.status).not.toBe(201);

    const newToken = new URL(body.invite.invite_url).searchParams.get('token');
    const newAccept = await jsonRequest('/api/invites/accept', {
      method: 'POST',
      json: { token: newToken, password: 'ReinviteTest123!' },
    });
    expect(newAccept.status).toBe(201);
    trackUser(newAccept.body.user.id);
  });

  it('ADMIN-INT-07: blocked once a tenant_admin already exists', async () => {
    const tenant = await createTenantFixture();
    const { status, body } = await jsonRequest(`/api/admin/tenants/${tenant.tenantId}/reinvite`, {
      method: 'POST',
      token: tenant.superadmin.token,
    });
    expect(status).toBe(400);
    expect(body.code).toBe('TENANT_ALREADY_HAS_ADMIN');
  });
});

describe('ADMIN-INT-08/09: tenant detail endpoint', () => {
  afterAll(cleanupAll);

  it('ADMIN-INT-08: happy path — combined tenant + campaigns + screens fetch', async () => {
    const tenant = await createTenantFixture();
    await createCampaign(tenant.tenantAdmin);
    await createCampaign(tenant.tenantAdmin);
    await registerScreen(tenant.tenantAdmin);
    await registerScreen(tenant.tenantAdmin);
    await registerScreen(tenant.tenantAdmin);

    const { status, body } = await jsonRequest(`/api/admin/tenants/${tenant.tenantId}`, { token: tenant.superadmin.token });
    expect(status).toBe(200);
    expect(body.tenant.id).toBe(tenant.tenantId);
    expect(body.campaigns).toHaveLength(2);
    expect(body.screens).toHaveLength(3);
  });

  it('ADMIN-INT-09: non-superadmin blocked', async () => {
    const tenant = await createTenantFixture();
    const { status } = await jsonRequest(`/api/admin/tenants/${tenant.tenantId}`, { token: tenant.tenantAdmin.token });
    expect(status).toBe(403);
  });
});

describe('USAGE-INT: per-screen usage breakdown', () => {
  afterAll(cleanupAll);

  it('USAGE-INT-01: happy path — counts per screen, default 24h window', async () => {
    const tenant = await createTenantFixture({ fulfillment_quota: 100 });
    await createCampaign(tenant.tenantAdmin);
    const screenA = await registerScreen(tenant.tenantAdmin, { label: 'Screen A' });
    const screenB = await registerScreen(tenant.tenantAdmin, { label: 'Screen B' });

    for (let i = 0; i < 8; i++) await jsonRequest('/v1/fulfillments', { method: 'POST', token: screenA.body.device_api_key });
    for (let i = 0; i < 2; i++) await jsonRequest('/v1/fulfillments', { method: 'POST', token: screenB.body.device_api_key });

    const { status, body } = await jsonRequest('/v1/tenant/usage/by-screen', { token: tenant.tenantAdmin.token });
    expect(status).toBe(200);
    expect(body.window_hours).toBe(24);
    const byId = new Map(body.screens.map((s: any) => [s.screen_id, s.count]));
    expect(byId.get(screenA.body.screen.id)).toBe(8);
    expect(byId.get(screenB.body.screen.id)).toBe(2);
  });

  it('USAGE-INT-02: window excludes old activity', async () => {
    const tenant = await createTenantFixture({ fulfillment_quota: 100 });
    const { body: campaignBody } = await createCampaign(tenant.tenantAdmin);
    const screen = await registerScreen(tenant.tenantAdmin);

    // Directly insert old rows (48h ago) — driving 5 real fulfillment
    // requests just to backdate them isn't possible through the API
    // (requested_at defaults to now()), so this seeds history directly,
    // same as other specs do when they need specific historical state.
    // campaign_id is NOT NULL on fulfillments (0001 schema), so this reuses a
    // real campaign row rather than null.
    const oldRows = Array.from({ length: 5 }, () => ({
      tenant_id: tenant.tenantId,
      campaign_id: campaignBody.campaign.id,
      screen_id: screen.body.screen.id,
      media_ref: 'backfill.mp4',
      status: 'confirmed',
      requested_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      reserved_expires_at: new Date(Date.now() - 48 * 60 * 60 * 1000 + 60_000).toISOString(),
    }));
    await supabaseAdmin.from('fulfillments').insert(oldRows);

    await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });

    const { status, body } = await jsonRequest('/v1/tenant/usage/by-screen?window_hours=24', { token: tenant.tenantAdmin.token });
    expect(status).toBe(200);
    const entry = body.screens.find((s: any) => s.screen_id === screen.body.screen.id);
    expect(entry.count).toBe(1);
  });

  it('USAGE-INT-03: tenant isolation', async () => {
    const tenantA = await createTenantFixture({ fulfillment_quota: 10 });
    const tenantB = await createTenantFixture({ fulfillment_quota: 10 });
    await createCampaign(tenantA.tenantAdmin);
    await createCampaign(tenantB.tenantAdmin);
    const screenA = await registerScreen(tenantA.tenantAdmin);
    const screenB = await registerScreen(tenantB.tenantAdmin);
    await jsonRequest('/v1/fulfillments', { method: 'POST', token: screenA.body.device_api_key });
    await jsonRequest('/v1/fulfillments', { method: 'POST', token: screenB.body.device_api_key });

    const { status, body } = await jsonRequest('/v1/tenant/usage/by-screen', { token: tenantA.tenantAdmin.token });
    expect(status).toBe(200);
    expect(body.screens.map((s: any) => s.screen_id)).toEqual([screenA.body.screen.id]);
  });
});

describe('FULFILL-ATTEMPT-INT-01: every outcome writes a fulfillment_attempts row', () => {
  afterAll(cleanupAll);

  it('fulfilled, no_eligible_campaigns, quota_exceeded, auth_error each log distinctly', async () => {
    const tenant = await createTenantFixture({ fulfillment_quota: 1 });
    await createCampaign(tenant.tenantAdmin);
    const screen = await registerScreen(tenant.tenantAdmin);

    const fulfilled = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(fulfilled.status).toBe(201);

    const overQuota = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(overQuota.status).toBe(429);

    const emptyTenant = await createTenantFixture();
    const emptyScreen = await registerScreen(emptyTenant.tenantAdmin);
    const noEligible = await jsonRequest('/v1/fulfillments', { method: 'POST', token: emptyScreen.body.device_api_key });
    expect(noEligible.status).toBe(200);
    expect(noEligible.body.fulfilled).toBe(false);

    const authError = await jsonRequest('/v1/fulfillments', { method: 'POST', token: 'device_deadbeefdeadbeefdeadbeef' });
    expect(authError.status).toBe(401);

    // Async write via c.executionCtx.waitUntil (or its no-ExecutionContext
    // fallback in this test environment) — poll rather than assert on the
    // very next read, per ADMIN-INT-03's note in test-plan.md.
    const knownScreenRows = await waitUntil(async () => {
      const { data } = await supabaseAdmin
        .from('fulfillment_attempts')
        .select('outcome, tenant_id, screen_id')
        .in('screen_id', [screen.body.screen.id, emptyScreen.body.screen.id]);
      return data && data.length >= 3 ? data : null;
    });
    const outcomes = knownScreenRows.map((r: any) => r.outcome).sort();
    expect(outcomes).toEqual(['fulfilled', 'no_eligible_campaigns', 'quota_exceeded'].sort());

    const authErrorRow = await waitUntil(async () => {
      const { data } = await supabaseAdmin
        .from('fulfillment_attempts')
        .select('tenant_id, screen_id')
        .eq('outcome', 'auth_error')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    });
    expect(authErrorRow.tenant_id).toBeNull();
    expect(authErrorRow.screen_id).toBeNull();
  });
});

describe('ADMIN-INT-03: system health endpoint', () => {
  afterAll(cleanupAll);

  it('happy path — numeric rates reflecting recent activity', async () => {
    const tenant = await createTenantFixture();
    await createCampaign(tenant.tenantAdmin);
    const screen = await registerScreen(tenant.tenantAdmin);
    await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });

    const health = await waitUntil(async () => {
      const { status, body } = await jsonRequest('/api/admin/system-health', { token: tenant.superadmin.token });
      if (status !== 200) return null;
      return body.request_rate_per_min > 0 ? body : null;
    });

    expect(typeof health.request_rate_per_min).toBe('number');
    expect(typeof health.error_rate).toBe('number');
    expect(typeof health.reservation_timeout_rate).toBe('number');
    expect(typeof health.no_eligible_campaign_rate).toBe('number');
  });
});
