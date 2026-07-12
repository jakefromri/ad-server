// CAMPAIGN-UNIT-01..04 — obligation type/target and flight-window
// validation on POST /v1/campaigns. test-plan.md places these under "Unit
// Tests" even though they exercise the live validator through the route
// handler (there's no standalone exported validator function to call
// directly — validateObligationAndFlight is private to campaigns.ts), so
// these go through createTenantFixture + createCampaign like an
// integration test, same DB-per-request approach as the rest of the suite.

import { describe, it, expect, afterAll } from 'vitest';
import { createTenantFixture, createCampaign, jsonRequest, cleanupAll, isoOffset } from '../helpers';

describe('campaign obligation/flight validation', () => {
  afterAll(cleanupAll);

  it('CAMPAIGN-UNIT-01: negative/non-integer impression_count target rejected', async () => {
    const tenant = await createTenantFixture();
    const res = await createCampaign(tenant.tenantAdmin, { obligation_type: 'impression_count', obligation_target: -5 });
    expect(res.status).toBe(400);
  });

  it('CAMPAIGN-UNIT-01b: non-integer impression_count target rejected', async () => {
    const tenant = await createTenantFixture();
    const res = await createCampaign(tenant.tenantAdmin, { obligation_type: 'impression_count', obligation_target: 4.5 });
    expect(res.status).toBe(400);
  });

  it('CAMPAIGN-UNIT-02: share_of_voice target outside 0-100 rejected', async () => {
    const tenant = await createTenantFixture();
    const res = await createCampaign(tenant.tenantAdmin, { obligation_type: 'share_of_voice', obligation_target: 150 });
    expect(res.status).toBe(400);
  });

  it('CAMPAIGN-UNIT-03: flight_end before flight_start rejected', async () => {
    const tenant = await createTenantFixture();
    const res = await createCampaign(tenant.tenantAdmin, {
      flight_start: isoOffset(60),
      flight_end: isoOffset(-60),
    });
    expect(res.status).toBe(400);
  });

  it('CAMPAIGN-UNIT-04: obligation_type must be exactly impression_count or share_of_voice', async () => {
    const tenant = await createTenantFixture();
    const { status, body } = await jsonRequest('/v1/campaigns', {
      method: 'POST',
      token: tenant.tenantAdmin.token,
      json: {
        name: 'Invalid obligation type',
        creative_media_path: 'https://example.com/x.mp4',
        obligation_type: 'both',
        obligation_target: 100,
        flight_start: isoOffset(-60),
        flight_end: isoOffset(60),
      },
    });
    expect(status).toBe(400);
    expect(body.error).toBeTruthy();
  });
});
