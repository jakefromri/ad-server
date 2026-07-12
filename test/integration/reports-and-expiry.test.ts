// REPORT-INT-01..06, EXPIRY-INT-01..02. test-plan.md § Integration Tests.

import { describe, it, expect, afterAll } from 'vitest';
import { createTenantFixture, createCampaign, registerScreen, jsonRequest, cleanupAll, supabaseAdmin, app } from '../helpers';

async function reserve(tenant: Awaited<ReturnType<typeof createTenantFixture>>, campaignOverrides = {}) {
  const campaign = await createCampaign(tenant.tenantAdmin, campaignOverrides);
  const screen = await registerScreen(tenant.tenantAdmin);
  const fulfillment = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
  return { campaign, screen, fulfillment };
}

describe('REPORT-INT', () => {
  afterAll(cleanupAll);

  it('REPORT-INT-01: successful report confirms the reservation', async () => {
    const tenant = await createTenantFixture();
    const { screen, fulfillment } = await reserve(tenant);
    expect(fulfillment.status).toBe(201);

    const { status, body } = await jsonRequest(`/v1/fulfillments/${fulfillment.body.fulfillment_id}/report`, {
      method: 'POST',
      token: screen.body.device_api_key,
      json: { outcome: 'played', played_duration_ms: 15000 },
    });
    expect(status).toBe(200);
    expect(body.status).toBe('confirmed');

    const { data: row } = await supabaseAdmin.from('fulfillments').select('*').eq('id', fulfillment.body.fulfillment_id).single();
    expect(row?.status).toBe('confirmed');
    expect(row?.reported_at).toBeTruthy();
    expect(row?.played_duration_ms).toBe(15000);
  });

  it('REPORT-INT-02: failed/skipped report releases the reservation', async () => {
    const tenant = await createTenantFixture();
    const { screen, fulfillment, campaign } = await reserve(tenant, { obligation_type: 'impression_count', obligation_target: 1 });
    const { status, body } = await jsonRequest(`/v1/fulfillments/${fulfillment.body.fulfillment_id}/report`, {
      method: 'POST',
      token: screen.body.device_api_key,
      json: { outcome: 'failed' },
    });
    expect(status).toBe(200);
    expect(body.status).toBe('released');

    const { data: row } = await supabaseAdmin.from('fulfillments').select('status').eq('id', fulfillment.body.fulfillment_id).single();
    expect(row?.status).toBe('failed');

    // The released obligation must be free again for a new reservation.
    const screen2 = await registerScreen(tenant.tenantAdmin);
    const second = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen2.body.device_api_key });
    expect(second.status).toBe(201);
    expect(second.body.campaign_id).toBe(campaign.body.campaign.id);
  });

  it('REPORT-INT-03: quota not decremented on failed report', async () => {
    const tenant = await createTenantFixture();
    const { screen, fulfillment } = await reserve(tenant);

    const before = await jsonRequest('/v1/tenant/usage', { token: tenant.tenantAdmin.token });
    await jsonRequest(`/v1/fulfillments/${fulfillment.body.fulfillment_id}/report`, {
      method: 'POST',
      token: screen.body.device_api_key,
      json: { outcome: 'failed' },
    });
    const after = await jsonRequest('/v1/tenant/usage', { token: tenant.tenantAdmin.token });

    expect(after.body.used).toBe(before.body.used);
  });

  it('REPORT-INT-04: late report after expiry rejected, obligation not re-reserved', async () => {
    const tenant = await createTenantFixture();
    const { screen, fulfillment, campaign } = await reserve(tenant, { obligation_type: 'impression_count', obligation_target: 1 });

    // Force the reservation into the past rather than waiting out a real
    // 300s timeout — same lazy-expiry rule either way (reserved_expires_at
    // < now, regardless of how status column reads).
    await supabaseAdmin
      .from('fulfillments')
      .update({ reserved_expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', fulfillment.body.fulfillment_id);

    const { status, body } = await jsonRequest(`/v1/fulfillments/${fulfillment.body.fulfillment_id}/report`, {
      method: 'POST',
      token: screen.body.device_api_key,
      json: { outcome: 'played' },
    });
    expect(status).toBe(409);
    expect(body.code).toBe('LATE_REPORT');

    const { data: pacingRow } = await supabaseAdmin.from('campaign_pacing').select('confirmed_count').eq('campaign_id', campaign.body.campaign.id).maybeSingle();
    expect(pacingRow?.confirmed_count ?? 0).toBe(0);
  });

  it('REPORT-INT-05: duplicate report rejected', async () => {
    const tenant = await createTenantFixture();
    const { screen, fulfillment } = await reserve(tenant);
    const first = await jsonRequest(`/v1/fulfillments/${fulfillment.body.fulfillment_id}/report`, {
      method: 'POST',
      token: screen.body.device_api_key,
      json: { outcome: 'played' },
    });
    expect(first.status).toBe(200);

    const second = await jsonRequest(`/v1/fulfillments/${fulfillment.body.fulfillment_id}/report`, {
      method: 'POST',
      token: screen.body.device_api_key,
      json: { outcome: 'played' },
    });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ALREADY_REPORTED');
  });

  it('REPORT-INT-06: report for another screen\'s fulfillment rejected', async () => {
    const tenant = await createTenantFixture();
    const { fulfillment } = await reserve(tenant);
    const otherScreen = await registerScreen(tenant.tenantAdmin);

    const { status } = await jsonRequest(`/v1/fulfillments/${fulfillment.body.fulfillment_id}/report`, {
      method: 'POST',
      token: otherScreen.body.device_api_key,
      json: { outcome: 'played' },
    });
    expect(status).toBe(403);
  });
});

describe('EXPIRY-INT', () => {
  afterAll(cleanupAll);

  it('EXPIRY-INT-01: unreported reservation returns to the pool after timeout (lazy check)', async () => {
    const tenant = await createTenantFixture();
    const campaign = await createCampaign(tenant.tenantAdmin, { obligation_type: 'impression_count', obligation_target: 1 });
    const screen = await registerScreen(tenant.tenantAdmin);

    const first = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(first.status).toBe(201);

    // Simulate timeout elapsing without waiting the real 300s.
    await supabaseAdmin
      .from('fulfillments')
      .update({ reserved_expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', first.body.fulfillment_id);

    const second = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(second.status).toBe(201);
    expect(second.body.campaign_id).toBe(campaign.body.campaign.id);

    // Never more than obligation_target rows counted as live at once —
    // exactly 2 fulfillment rows exist (one expired-by-lazy-check, one
    // fresh), not evidence of leakage.
    const { count } = await supabaseAdmin.from('fulfillments').select('id', { count: 'exact', head: true }).eq('campaign_id', campaign.body.campaign.id);
    expect(count).toBe(2);
  });

  it('EXPIRY-INT-02: cron sweep marks expired reservations', async () => {
    const tenant = await createTenantFixture();
    const { fulfillment } = await reserve(tenant);
    await supabaseAdmin
      .from('fulfillments')
      .update({ reserved_expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq('id', fulfillment.body.fulfillment_id);

    const res = await app.request('/api/cron/expire-reservations');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.swept).toBeGreaterThanOrEqual(1);

    const { data: row } = await supabaseAdmin.from('fulfillments').select('status').eq('id', fulfillment.body.fulfillment_id).single();
    expect(row?.status).toBe('expired');
  });
});
