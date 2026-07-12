// Two tests flagged in build-report.md's 04g "For 04h picking up cold"
// section — not in test-plan.md, added directly per that note: (1) cache
// correctness for loadActiveCampaigns' 5s TTL (a campaign CRUD change
// should become visible within ~5s, not instantly), and (2) the
// campaign_confirmed_counts trigger's exactly-once guarantee under
// concurrent confirms (migration 0004_campaign_confirmed_counter.sql).

import { describe, it, expect, afterAll } from 'vitest';
import { createTenantFixture, createCampaign, registerScreen, jsonRequest, cleanupAll, sleep, supabaseAdmin } from '../helpers';

describe('loadActiveCampaigns cache — 5s TTL correctness', () => {
  afterAll(cleanupAll);

  it(
    'a campaign CRUD change is invisible to fulfillment within the TTL window, then visible after it expires',
    async () => {
      const tenant = await createTenantFixture();
      const campaign = await createCampaign(tenant.tenantAdmin, { obligation_type: 'impression_count', obligation_target: 1000 });
      const screen1 = await registerScreen(tenant.tenantAdmin);
      const screen2 = await registerScreen(tenant.tenantAdmin);
      const screen3 = await registerScreen(tenant.tenantAdmin);

      // First request for this tenant populates the module-scope cache.
      const first = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen1.body.device_api_key });
      expect(first.status).toBe(201);

      // Pause the campaign — DB is updated immediately, but the cached
      // "active campaigns" snapshot (fetched with .eq('status','active'))
      // still holds the pre-pause row for up to 5s.
      const patch = await jsonRequest(`/v1/campaigns/${campaign.body.campaign.id}`, {
        method: 'PATCH',
        token: tenant.tenantAdmin.token,
        json: { status: 'paused' },
      });
      expect(patch.status).toBe(200);

      // Within the TTL window: still served from the stale-but-accepted
      // cached snapshot (the doc's explicitly accepted tradeoff — "a 5s
      // stale campaign definition" — not a bug).
      const second = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen2.body.device_api_key });
      expect(second.status).toBe(201);
      expect(second.body.campaign_id).toBe(campaign.body.campaign.id);

      // After the TTL expires, a fresh query correctly excludes the now-paused campaign.
      await sleep(5200);
      const third = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen3.body.device_api_key });
      expect(third.status).toBe(200);
      expect(third.body.fulfilled).toBe(false);
    },
    15000
  );
});

describe('campaign_confirmed_counts trigger — exactly-once under concurrent confirms', () => {
  afterAll(cleanupAll);

  it('concurrent confirms of different rows against the same campaign sum correctly, no double-count', async () => {
    const tenant = await createTenantFixture();
    const campaign = await createCampaign(tenant.tenantAdmin, { obligation_type: 'impression_count', obligation_target: 100 });
    const screens = await Promise.all(Array.from({ length: 15 }, () => registerScreen(tenant.tenantAdmin)));

    const reservations = [];
    for (const s of screens) {
      const res = await jsonRequest('/v1/fulfillments', { method: 'POST', token: s.body.device_api_key });
      expect(res.status).toBe(201);
      reservations.push({ deviceKey: s.body.device_api_key, fulfillmentId: res.body.fulfillment_id });
    }

    const reportResults = await Promise.all(
      reservations.map((r) =>
        jsonRequest(`/v1/fulfillments/${r.fulfillmentId}/report`, {
          method: 'POST',
          token: r.deviceKey,
          json: { outcome: 'played' },
        })
      )
    );
    expect(reportResults.every((r) => r.status === 200)).toBe(true);

    const { data: counterRow } = await supabaseAdmin
      .from('campaign_confirmed_counts')
      .select('confirmed_count')
      .eq('campaign_id', campaign.body.campaign.id)
      .single();
    expect(counterRow?.confirmed_count).toBe(15);

    const { count: confirmedRowCount } = await supabaseAdmin
      .from('fulfillments')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaign.body.campaign.id)
      .eq('status', 'confirmed');
    expect(confirmedRowCount).toBe(15);
  });

  it('two concurrent report calls on the same fulfillment row only count once', async () => {
    const tenant = await createTenantFixture();
    const campaign = await createCampaign(tenant.tenantAdmin, { obligation_type: 'impression_count', obligation_target: 100 });
    const screen = await registerScreen(tenant.tenantAdmin);
    const reserved = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(reserved.status).toBe(201);

    const [a, b] = await Promise.all([
      jsonRequest(`/v1/fulfillments/${reserved.body.fulfillment_id}/report`, {
        method: 'POST',
        token: screen.body.device_api_key,
        json: { outcome: 'played' },
      }),
      jsonRequest(`/v1/fulfillments/${reserved.body.fulfillment_id}/report`, {
        method: 'POST',
        token: screen.body.device_api_key,
        json: { outcome: 'played' },
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const { data: counterRow } = await supabaseAdmin
      .from('campaign_confirmed_counts')
      .select('confirmed_count')
      .eq('campaign_id', campaign.body.campaign.id)
      .single();
    expect(counterRow?.confirmed_count).toBe(1);
  });
});
