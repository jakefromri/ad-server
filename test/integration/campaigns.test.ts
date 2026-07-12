// CAMPAIGN-INT-01..07, PACING-INT-01..04 (04i, follow-up scoping session).
// test-plan.md § Integration Tests.

import { describe, it, expect, afterAll } from 'vitest';
import { createTenantFixture, createCampaign, registerScreen, jsonRequest, cleanupAll } from '../helpers';

describe('CAMPAIGN-INT', () => {
  afterAll(cleanupAll);

  it('CAMPAIGN-INT-01: tenant isolation — campaign list', async () => {
    const tenantA = await createTenantFixture();
    const tenantB = await createTenantFixture();
    await createCampaign(tenantA.tenantAdmin, { name: 'A only' });
    await createCampaign(tenantB.tenantAdmin, { name: 'B only' });

    const { status, body } = await jsonRequest('/v1/campaigns', { token: tenantA.tenantAdmin.token });
    expect(status).toBe(200);
    expect(body.campaigns).toHaveLength(1);
    expect(body.campaigns[0].name).toBe('A only');
  });

  it('CAMPAIGN-INT-02: edit campaign — happy path, subsequent scoring uses new value', async () => {
    const tenant = await createTenantFixture();
    const created = await createCampaign(tenant.tenantAdmin, { priority_weight: 1.0 });
    const { status, body } = await jsonRequest(`/v1/campaigns/${created.body.campaign.id}`, {
      method: 'PATCH',
      token: tenant.tenantAdmin.token,
      json: { priority_weight: 2.5 },
    });
    expect(status).toBe(200);
    expect(Number(body.campaign.priority_weight)).toBe(2.5);
  });

  it('CAMPAIGN-INT-03: cross-tenant write blocked (404, existence not revealed)', async () => {
    const tenantA = await createTenantFixture();
    const tenantB = await createTenantFixture();
    const bCampaign = await createCampaign(tenantB.tenantAdmin);

    const { status } = await jsonRequest(`/v1/campaigns/${bCampaign.body.campaign.id}`, {
      method: 'PATCH',
      token: tenantA.tenantAdmin.token,
      json: { priority_weight: 3.0 },
    });
    expect(status).toBe(404);
  });

  it('CAMPAIGN-INT-04: pacing endpoint happy path — impression_count populates remaining, nulls sov_*', async () => {
    const tenant = await createTenantFixture();
    const created = await createCampaign(tenant.tenantAdmin, { obligation_type: 'impression_count', obligation_target: 50 });

    const { status, body } = await jsonRequest(`/v1/campaigns/${created.body.campaign.id}/pacing`, { token: tenant.tenantAdmin.token });
    expect(status).toBe(200);
    expect(body.delivered).toBe(0);
    expect(body.remaining).toBe(50);
    expect(body.sov_actual).toBeNull();
    expect(body.sov_target).toBeNull();
  });

  it('CAMPAIGN-INT-05: SOV overselling blocked at creation', async () => {
    const tenant = await createTenantFixture();
    const first = await createCampaign(tenant.tenantAdmin, {
      obligation_type: 'share_of_voice',
      obligation_target: 70,
      status: 'active',
      flight_start: '2026-01-01T00:00:00.000Z',
      flight_end: '2026-01-31T23:59:59.000Z',
    });
    expect(first.status).toBe(201);

    const second = await createCampaign(tenant.tenantAdmin, {
      obligation_type: 'share_of_voice',
      obligation_target: 40,
      status: 'active',
      flight_start: '2026-01-15T00:00:00.000Z',
      flight_end: '2026-02-15T23:59:59.000Z',
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('SOV_OVERSOLD');
    expect(second.body.current_combined_total).toBe(70);
  });

  it('CAMPAIGN-INT-06: SOV overselling allowed for non-overlapping flights', async () => {
    const tenant = await createTenantFixture();
    const first = await createCampaign(tenant.tenantAdmin, {
      obligation_type: 'share_of_voice',
      obligation_target: 70,
      status: 'active',
      flight_start: '2026-01-01T00:00:00.000Z',
      flight_end: '2026-01-31T23:59:59.000Z',
    });
    expect(first.status).toBe(201);

    const second = await createCampaign(tenant.tenantAdmin, {
      obligation_type: 'share_of_voice',
      obligation_target: 40,
      status: 'active',
      flight_start: '2026-03-01T00:00:00.000Z',
      flight_end: '2026-03-31T23:59:59.000Z',
    });
    expect(second.status).toBe(201);
  });

  it('CAMPAIGN-INT-07: SOV overselling re-checked on activation, not just creation', async () => {
    const tenant = await createTenantFixture();

    // Draft 40% campaign, valid at creation time (nothing else active yet).
    const draft = await createCampaign(tenant.tenantAdmin, {
      obligation_type: 'share_of_voice',
      obligation_target: 40,
      status: 'draft',
      flight_start: '2026-01-01T00:00:00.000Z',
      flight_end: '2026-01-31T23:59:59.000Z',
    });
    expect(draft.status).toBe(201);

    // Now activate a competing 70% campaign with an overlapping flight.
    const other = await createCampaign(tenant.tenantAdmin, {
      obligation_type: 'share_of_voice',
      obligation_target: 70,
      status: 'active',
      flight_start: '2026-01-01T00:00:00.000Z',
      flight_end: '2026-01-31T23:59:59.000Z',
    });
    expect(other.status).toBe(201);

    // Attempting to activate the original 40% draft should now be blocked.
    const activate = await jsonRequest(`/v1/campaigns/${draft.body.campaign.id}`, {
      method: 'PATCH',
      token: tenant.tenantAdmin.token,
      json: { status: 'active' },
    });
    expect(activate.status).toBe(409);
    expect(activate.body.code).toBe('SOV_OVERSOLD');
  });
});

describe('PACING-INT', () => {
  afterAll(cleanupAll);

  it('PACING-INT-01: no_eligible_screens — true when targeting matches no registered screen', async () => {
    const tenant = await createTenantFixture();
    await registerScreen(tenant.tenantAdmin, { state: 'CA' });
    const created = await createCampaign(tenant.tenantAdmin, { targeting: { geo: { type: 'state', values: ['NY'] } } });

    const { status, body } = await jsonRequest(`/v1/campaigns/${created.body.campaign.id}/pacing`, { token: tenant.tenantAdmin.token });
    expect(status).toBe(200);
    expect(body.no_eligible_screens).toBe(true);
  });

  it('PACING-INT-02: no_eligible_screens — false once a matching screen exists', async () => {
    const tenant = await createTenantFixture();
    await registerScreen(tenant.tenantAdmin, { state: 'CA' });
    const created = await createCampaign(tenant.tenantAdmin, { targeting: { geo: { type: 'state', values: ['NY'] } } });

    const before = await jsonRequest(`/v1/campaigns/${created.body.campaign.id}/pacing`, { token: tenant.tenantAdmin.token });
    expect(before.body.no_eligible_screens).toBe(true);

    await registerScreen(tenant.tenantAdmin, { state: 'NY' });
    const after = await jsonRequest(`/v1/campaigns/${created.body.campaign.id}/pacing`, { token: tenant.tenantAdmin.token });
    expect(after.status).toBe(200);
    expect(after.body.no_eligible_screens).toBe(false);
  });

  it('PACING-INT-03: no_eligible_screens — true for a daypart window with zero time coverage', async () => {
    const tenant = await createTenantFixture();
    await registerScreen(tenant.tenantAdmin);
    const created = await createCampaign(tenant.tenantAdmin, {
      targeting: { daypart: [{ start: '09:00', end: '09:00' }], geo: { type: 'all' } },
    });
    expect(created.status).toBe(201);

    const { status, body } = await jsonRequest(`/v1/campaigns/${created.body.campaign.id}/pacing`, { token: tenant.tenantAdmin.token });
    expect(status).toBe(200);
    expect(body.no_eligible_screens).toBe(true);
  });

  it('PACING-INT-04: no_eligible_screens — inactive screens do not count as eligible', async () => {
    const tenant = await createTenantFixture();
    const screen = await registerScreen(tenant.tenantAdmin, { state: 'CA' });
    await jsonRequest(`/v1/screens/${screen.body.screen.id}`, {
      method: 'PATCH',
      token: tenant.tenantAdmin.token,
      json: { status: 'inactive' },
    });
    const created = await createCampaign(tenant.tenantAdmin, { targeting: { geo: { type: 'state', values: ['CA'] } } });

    const { status, body } = await jsonRequest(`/v1/campaigns/${created.body.campaign.id}/pacing`, { token: tenant.tenantAdmin.token });
    expect(status).toBe(200);
    expect(body.no_eligible_screens).toBe(true);
  });
});
