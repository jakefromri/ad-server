// SOV-UNIT-01: checkSovOverselling in isolation (still hits the real DB —
// it's a query-building function, not pure, but no HTTP layer involved).
// QUOTA-UNIT-01: the fulfillment handler's fast unlocked quota pre-check
// must short-circuit before the campaign-eligibility query runs.

import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { checkSovOverselling } from '../../server/sov';
import { supabaseAdmin } from '../../server/supabase';
import { createTenantFixture, createCampaign, jsonRequest, registerScreen, cleanupAll } from '../helpers';

describe('SOV-UNIT-01: overselling check sums only flight-overlapping active SOV campaigns', () => {
  afterAll(cleanupAll);

  it('non-overlapping flights do not count against each other', async () => {
    const tenant = await createTenantFixture();
    const existing = await createCampaign(tenant.tenantAdmin, {
      obligation_type: 'share_of_voice',
      obligation_target: 70,
      status: 'active',
      flight_start: '2026-01-01T00:00:00.000Z',
      flight_end: '2026-01-31T23:59:59.000Z',
    });
    expect(existing.status).toBe(201);

    const result = await checkSovOverselling({
      tenant_id: tenant.tenantId,
      obligation_target: 40,
      flight_start: '2026-03-01T00:00:00.000Z',
      flight_end: '2026-03-31T23:59:59.000Z',
    });

    expect(result.ok).toBe(true);
    expect(result.currentCombinedTotal).toBe(0);
  });

  it('overlapping flights are summed and can block', async () => {
    const tenant = await createTenantFixture();
    const existing = await createCampaign(tenant.tenantAdmin, {
      obligation_type: 'share_of_voice',
      obligation_target: 70,
      status: 'active',
      flight_start: '2026-01-01T00:00:00.000Z',
      flight_end: '2026-01-31T23:59:59.000Z',
    });
    expect(existing.status).toBe(201);

    const result = await checkSovOverselling({
      tenant_id: tenant.tenantId,
      obligation_target: 40,
      flight_start: '2026-01-15T00:00:00.000Z',
      flight_end: '2026-02-15T23:59:59.000Z',
    });

    expect(result.ok).toBe(false);
    expect(result.currentCombinedTotal).toBe(70);
  });
});

describe('QUOTA-UNIT-01: quota pre-check runs before the campaign query', () => {
  afterAll(cleanupAll);
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('short-circuits to 429 without ever querying campaigns', async () => {
    const tenant = await createTenantFixture({ fulfillment_quota: 1 });
    const campaign = await createCampaign(tenant.tenantAdmin, { obligation_type: 'impression_count', obligation_target: 100 });
    expect(campaign.status).toBe(201);
    const screen = await registerScreen(tenant.tenantAdmin);
    expect(screen.status).toBe(201);
    const deviceKey = screen.body.device_api_key;

    // Consume the tenant's only unit of quota first.
    const first = await jsonRequest('/v1/fulfillments', { method: 'POST', token: deviceKey });
    expect(first.status).toBe(201);

    const fromSpy = vi.spyOn(supabaseAdmin, 'from');

    const second = await jsonRequest('/v1/fulfillments', { method: 'POST', token: deviceKey });
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('QUOTA_EXCEEDED');

    const queriedTables = fromSpy.mock.calls.map((call) => call[0]);
    expect(queriedTables).not.toContain('campaigns');
  });
});
