// FULFILL-INT-01..08, RACE-INT-01..03, QUOTA-INT-01,02,04. test-plan.md §
// Integration Tests. RACE-INT-02/03 test genuine race-condition-under-lock
// behavior — real concurrent requests against the real dev DB (per this
// repo's convention of never mocking the database), not instrumented
// call-count mocks, since reserve_fulfillment's row locking is exactly the
// thing under test and a mock would just assert against itself.

import { describe, it, expect, afterAll } from 'vitest';
import { createTenantFixture, createCampaign, registerScreen, jsonRequest, cleanupAll, isoOffset, supabaseAdmin } from '../helpers';

describe('FULFILL-INT', () => {
  afterAll(cleanupAll);

  it('FULFILL-INT-01: picks an eligible campaign and reserves it', async () => {
    const tenant = await createTenantFixture();
    await createCampaign(tenant.tenantAdmin, { creative_media_path: 'https://example.com/ad-1.mp4' });
    const screen = await registerScreen(tenant.tenantAdmin);

    const before = Date.now();
    const { status, body } = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(status).toBe(201);
    expect(body.fulfillment_id).toBeTruthy();
    expect(body.media_ref).toBe('https://example.com/ad-1.mp4');
    const expiresIn = new Date(body.reserved_expires_at).getTime() - before;
    expect(expiresIn).toBeGreaterThan(290_000); // default reservation_timeout_seconds=300
    expect(expiresIn).toBeLessThan(320_000);

    const { data: row } = await supabaseAdmin.from('fulfillments').select('status').eq('id', body.fulfillment_id).single();
    expect(row?.status).toBe('reserved');
  });

  it('FULFILL-INT-02: no eligible campaign returns a clean non-error response, no row created', async () => {
    const tenant = await createTenantFixture();
    await createCampaign(tenant.tenantAdmin, { targeting: { geo: { type: 'state', values: ['NY'] } } });
    const screen = await registerScreen(tenant.tenantAdmin, { state: 'TX' });

    const { status, body } = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(status).toBe(200);
    expect(body.fulfilled).toBe(false);
    expect(body.reason).toBe('no_eligible_campaigns');

    const { count } = await supabaseAdmin
      .from('fulfillments')
      .select('id', { count: 'exact', head: true })
      .eq('screen_id', screen.body.screen.id);
    expect(count).toBe(0);
  });

  it('FULFILL-INT-03: expired campaign (outside flight window) excluded', async () => {
    const tenant = await createTenantFixture();
    await createCampaign(tenant.tenantAdmin, { flight_start: isoOffset(-120), flight_end: isoOffset(-60) });
    const screen = await registerScreen(tenant.tenantAdmin);

    const { status, body } = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(status).toBe(200);
    expect(body.fulfilled).toBe(false);
  });

  it('FULFILL-INT-04: paused campaign excluded', async () => {
    const tenant = await createTenantFixture();
    await createCampaign(tenant.tenantAdmin, { status: 'paused' });
    const screen = await registerScreen(tenant.tenantAdmin);

    const { status, body } = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(status).toBe(200);
    expect(body.fulfilled).toBe(false);
  });

  it('FULFILL-INT-05: impression-count campaign stops serving at zero remaining obligation', async () => {
    const tenant = await createTenantFixture();
    await createCampaign(tenant.tenantAdmin, { obligation_type: 'impression_count', obligation_target: 1 });
    const screen = await registerScreen(tenant.tenantAdmin);

    // Reserve and confirm the one unit of obligation.
    const first = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(first.status).toBe(201);
    const report = await jsonRequest(`/v1/fulfillments/${first.body.fulfillment_id}/report`, {
      method: 'POST',
      token: screen.body.device_api_key,
      json: { outcome: 'played', played_duration_ms: 1000 },
    });
    expect(report.status).toBe(200);

    const second = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(second.status).toBe(200);
    expect(second.body.fulfilled).toBe(false);
  });

  it('FULFILL-INT-06: SOV campaign wins over a behind-pace impression-count campaign', async () => {
    const tenant = await createTenantFixture();
    const impressionCampaign = await createCampaign(tenant.tenantAdmin, {
      obligation_type: 'impression_count',
      obligation_target: 1000,
    });
    const sovCampaign = await createCampaign(tenant.tenantAdmin, {
      obligation_type: 'share_of_voice',
      obligation_target: 40,
    });
    const screen = await registerScreen(tenant.tenantAdmin);

    const { status, body } = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(status).toBe(201);
    expect(body.campaign_id).toBe(sovCampaign.body.campaign.id);
    expect(body.campaign_id).not.toBe(impressionCampaign.body.campaign.id);
  });

  it('FULFILL-INT-07: impression-count wins the remnant once SOV is satisfied', async () => {
    const tenant = await createTenantFixture();
    const screen = await registerScreen(tenant.tenantAdmin);

    // SOV campaign at 0% target -> pressure = 0 - actualShare <= 0 always,
    // i.e. always "satisfied" from the very first request (never behind
    // pace), so Tier 2 is reached immediately and deterministically.
    await createCampaign(tenant.tenantAdmin, { obligation_type: 'share_of_voice', obligation_target: 0 });
    const impressionCampaign = await createCampaign(tenant.tenantAdmin, {
      obligation_type: 'impression_count',
      obligation_target: 1000,
    });

    const { status, body } = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(status).toBe(201);
    expect(body.campaign_id).toBe(impressionCampaign.body.campaign.id);
  });

  it('FULFILL-INT-08: satisfied SOV still serves when nothing else is eligible (floor, not ceiling)', async () => {
    const tenant = await createTenantFixture();
    const screen = await registerScreen(tenant.tenantAdmin);
    const sovCampaign = await createCampaign(tenant.tenantAdmin, { obligation_type: 'share_of_voice', obligation_target: 0 });

    const { status, body } = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(status).toBe(201);
    expect(body.campaign_id).toBe(sovCampaign.body.campaign.id);
  });
});

describe('RACE-INT', () => {
  afterAll(cleanupAll);

  it('RACE-INT-01: concurrent requests for the last unit of obligation never double-reserve', async () => {
    const tenant = await createTenantFixture();
    const campaign = await createCampaign(tenant.tenantAdmin, { obligation_type: 'impression_count', obligation_target: 1 });
    const screenX = await registerScreen(tenant.tenantAdmin);
    const screenY = await registerScreen(tenant.tenantAdmin);

    const [resX, resY] = await Promise.all([
      jsonRequest('/v1/fulfillments', { method: 'POST', token: screenX.body.device_api_key }),
      jsonRequest('/v1/fulfillments', { method: 'POST', token: screenY.body.device_api_key }),
    ]);

    const statuses = [resX.status, resY.status].sort();
    // Exactly one 201 (reserved); the other is a clean 200 fulfilled:false
    // (no other eligible campaign to fall back to).
    expect(statuses).toEqual([200, 201]);
    const loser = resX.status === 200 ? resX : resY;
    expect(loser.body.fulfilled).toBe(false);

    const { count } = await supabaseAdmin.from('fulfillments').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.body.campaign.id);
    expect(count).toBe(1);
  });

  it('RACE-INT-02/03: retries against fresh data under high contention never over-reserve past obligation_target', async () => {
    // Real concurrency test standing in for the mocked-lock-failure scenario
    // in test-plan.md's RACE-INT-02/03: rather than instrumenting the lock
    // to fail deterministically (this codebase has no seam for that without
    // changing production code), fire many more concurrent requests than
    // the campaign's remaining obligation against a real DB. The row lock +
    // full-loop retry (fresh query, fresh lock, MAX_ATTEMPTS=3 cap) is
    // exactly what's needed to keep total reservations from ever exceeding
    // the target under this load, which is the externally-observable
    // guarantee those two cases exist to protect.
    const tenant = await createTenantFixture({ fulfillment_quota: 100 });
    const campaign = await createCampaign(tenant.tenantAdmin, { obligation_type: 'impression_count', obligation_target: 5 });
    const screens = await Promise.all(Array.from({ length: 20 }, () => registerScreen(tenant.tenantAdmin)));

    const results = await Promise.all(
      screens.map((s) => jsonRequest('/v1/fulfillments', { method: 'POST', token: s.body.device_api_key }))
    );

    const reserved = results.filter((r) => r.status === 201);
    const notEligible = results.filter((r) => r.status === 200 && r.body.fulfilled === false);
    expect(reserved.length).toBe(5);
    expect(reserved.length + notEligible.length).toBe(20);

    const { count } = await supabaseAdmin.from('fulfillments').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.body.campaign.id);
    expect(count).toBe(5);
  });
});

describe('QUOTA-INT', () => {
  afterAll(cleanupAll);

  it('QUOTA-INT-01: requests beyond quota rejected, no row created, used_count unchanged', async () => {
    const tenant = await createTenantFixture({ fulfillment_quota: 3 });
    await createCampaign(tenant.tenantAdmin, { obligation_type: 'impression_count', obligation_target: 1000 });
    const screen = await registerScreen(tenant.tenantAdmin);

    for (let i = 0; i < 3; i++) {
      const res = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
      expect(res.status).toBe(201);
    }

    const beforeUsage = await jsonRequest('/v1/tenant/usage', { token: tenant.tenantAdmin.token });
    expect(beforeUsage.body.used).toBe(3);

    const fourth = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(fourth.status).toBe(429);
    expect(fourth.body.code).toBe('QUOTA_EXCEEDED');

    const afterUsage = await jsonRequest('/v1/tenant/usage', { token: tenant.tenantAdmin.token });
    expect(afterUsage.body.used).toBe(3);
  });

  it('QUOTA-INT-02: request exactly at the quota boundary is served, not rejected', async () => {
    const tenant = await createTenantFixture({ fulfillment_quota: 3 });
    await createCampaign(tenant.tenantAdmin, { obligation_type: 'impression_count', obligation_target: 1000 });
    const screen = await registerScreen(tenant.tenantAdmin);

    await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });

    const third = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(third.status).toBe(201);

    const usage = await jsonRequest('/v1/tenant/usage', { token: tenant.tenantAdmin.token });
    expect(usage.body.used).toBe(3);

    const fourth = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(fourth.status).toBe(429);
  });

  it('QUOTA-INT-04: quota check is atomic with the increment under concurrency — no overshoot', async () => {
    const tenant = await createTenantFixture({ fulfillment_quota: 10 });
    await createCampaign(tenant.tenantAdmin, { obligation_type: 'impression_count', obligation_target: 1000 });
    const screens = await Promise.all(Array.from({ length: 9 }, () => registerScreen(tenant.tenantAdmin)));
    for (const s of screens) {
      const res = await jsonRequest('/v1/fulfillments', { method: 'POST', token: s.body.device_api_key });
      expect(res.status).toBe(201);
    }
    const usageBefore = await jsonRequest('/v1/tenant/usage', { token: tenant.tenantAdmin.token });
    expect(usageBefore.body.used).toBe(9);

    const screenX = await registerScreen(tenant.tenantAdmin);
    const screenY = await registerScreen(tenant.tenantAdmin);
    const [resX, resY] = await Promise.all([
      jsonRequest('/v1/fulfillments', { method: 'POST', token: screenX.body.device_api_key }),
      jsonRequest('/v1/fulfillments', { method: 'POST', token: screenY.body.device_api_key }),
    ]);

    const statuses = [resX.status, resY.status].sort();
    expect(statuses).toEqual([201, 429]);

    const usageAfter = await jsonRequest('/v1/tenant/usage', { token: tenant.tenantAdmin.token });
    expect(usageAfter.body.used).toBe(10);
  });
});
