// PLAY-LOG-INT-01..04 — tenant-scoped play log (GET /v1/tenant/play-log,
// GET /v1/tenant/play-log/export). Not part of test-plan.md (feature added
// directly, not via the Ralph Loop — see CLAUDE.md's "single-feature
// additions to existing personal projects" carve-out), but follows this
// suite's existing conventions (real DB, no mocks; fixture helpers from
// test/helpers.ts).

import { describe, it, expect, afterAll } from 'vitest';
import { createTenantFixture, createCampaign, registerScreen, jsonRequest, apiRequest, cleanupAll } from '../helpers';

async function reserve(tenant: Awaited<ReturnType<typeof createTenantFixture>>, campaignOverrides: Record<string, unknown> = {}) {
  const campaign = await createCampaign(tenant.tenantAdmin, campaignOverrides);
  const screen = await registerScreen(tenant.tenantAdmin);
  const fulfillment = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
  return { campaign, screen, fulfillment };
}

describe('PLAY-LOG-INT', () => {
  afterAll(cleanupAll);

  it('PLAY-LOG-INT-01: lists a tenant\'s own plays with campaign/screen info joined in, excludes other tenants', async () => {
    const tenant = await createTenantFixture();
    const other = await createTenantFixture();

    const { campaign, screen, fulfillment } = await reserve(tenant, { name: 'PlayLog Campaign' });
    await reserve(other, { name: 'Other Tenant Campaign' });

    const { status, body } = await jsonRequest('/v1/tenant/play-log', { token: tenant.tenantAdmin.token });
    expect(status).toBe(200);
    expect(body.entries.length).toBeGreaterThanOrEqual(1);
    expect(body.entries.every((e: any) => e.campaign_name !== 'Other Tenant Campaign')).toBe(true);

    const entry = body.entries.find((e: any) => e.id === fulfillment.body.fulfillment_id);
    expect(entry).toBeTruthy();
    expect(entry.campaign_id).toBe(campaign.body.campaign.id);
    expect(entry.campaign_name).toBe('PlayLog Campaign');
    expect(entry.screen_id).toBe(screen.body.screen.id);
    expect(entry.screen_label).toBe(screen.body.screen.label);
    expect(entry.status).toBe('reserved');
  });

  it('PLAY-LOG-INT-02: cursor pagination returns disjoint pages covering all rows', async () => {
    const tenant = await createTenantFixture();
    for (let i = 0; i < 3; i++) {
      await reserve(tenant, { name: `Pagination Campaign ${i}`, obligation_target: 10 });
    }

    const page1 = await jsonRequest('/v1/tenant/play-log?limit=2', { token: tenant.tenantAdmin.token });
    expect(page1.status).toBe(200);
    expect(page1.body.entries.length).toBe(2);
    expect(page1.body.next_cursor).toBeTruthy();

    const page2 = await jsonRequest(`/v1/tenant/play-log?limit=2&cursor=${encodeURIComponent(page1.body.next_cursor)}`, {
      token: tenant.tenantAdmin.token,
    });
    expect(page2.status).toBe(200);

    const page1Ids = new Set(page1.body.entries.map((e: any) => e.id));
    for (const entry of page2.body.entries) {
      expect(page1Ids.has(entry.id)).toBe(false);
    }
  });

  it('PLAY-LOG-INT-03: CSV export returns a header + one row per fulfillment, filename reflects window', async () => {
    const tenant = await createTenantFixture();
    await reserve(tenant, { name: 'CSV Export Campaign' });

    const res = await apiRequest('/v1/tenant/play-log/export?window=day', { token: tenant.tenantAdmin.token });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('play-log-day-');

    const csv = await res.text();
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('requested_at,campaign,screen,status,report_outcome,played_duration_ms,media_ref');
    expect(lines.some((l) => l.includes('CSV Export Campaign'))).toBe(true);
  });

  it('PLAY-LOG-INT-04: export rejects an invalid window', async () => {
    const tenant = await createTenantFixture();
    const res = await apiRequest('/v1/tenant/play-log/export?window=year', { token: tenant.tenantAdmin.token });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('window must be one of');
  });
});
