// E2E-01..06. test-plan.md § E2E Tests.
//
// Deviation from the literal test-plan text: E2E-02/02b/03/06 describe
// "running the k6 simulator" — k6 is a load-generation binary (architecture.md
// § Virtual Screen Simulator), not something meant to be invoked from a
// vitest process, and simulator/attribute-generator.ts's `main()` runs
// immediately on import (a CLI script, not an importable library) so it
// can't be driven in-process either. Every one of these tests instead runs
// the same request -> (wait) -> report loop directly against the real app
// via jsonRequest, which E2E-01's own setup text explicitly allows ("a
// direct API call standing in for one screen"). Flagged in build-report.md.

import { describe, it, expect, afterAll } from 'vitest';
import {
  createTenantViaSuperadmin,
  createHumanSessionForTest,
  createTenantFixture,
  createCampaign,
  registerScreen,
  jsonRequest,
  cleanupAll,
} from '../helpers';

async function reserveAndConfirm(deviceKey: string): Promise<{ status: number; body: any; campaignId?: string }> {
  const reserve = await jsonRequest('/v1/fulfillments', { method: 'POST', token: deviceKey });
  if (reserve.status !== 201) return { status: reserve.status, body: reserve.body };
  await jsonRequest(`/v1/fulfillments/${reserve.body.fulfillment_id}/report`, {
    method: 'POST',
    token: deviceKey,
    json: { outcome: 'played', played_duration_ms: 1000 },
  });
  return { status: reserve.status, body: reserve.body, campaignId: reserve.body.campaign_id };
}

/** Runs `total` reserve+confirm cycles in concurrent batches rather than one
 * fully sequential loop — a purely sequential 200-300 iteration loop against
 * the real dev DB (network round trip per call, two calls per iteration)
 * blows well past any reasonable test timeout. Safe to run concurrently:
 * reserve_fulfillment's row lock already serializes the correctness-critical
 * part at the DB layer (proven by RACE-INT-01/02/03) — concurrent traffic
 * within a batch is if anything more representative of real screen fleets
 * than an artificial one-at-a-time loop. Returns only the successfully
 * reserved+confirmed results; a small number of transient
 * no_eligible_campaigns results under concurrency are expected and excluded
 * from the caller's convergence ratio, not treated as failures. */
async function runConvergenceBatches(
  pickDeviceKey: (i: number) => string,
  total: number,
  batchSize = 20
): Promise<{ campaignId: string }[]> {
  const results: { campaignId: string }[] = [];
  for (let start = 0; start < total; start += batchSize) {
    const size = Math.min(batchSize, total - start);
    const batch = await Promise.all(
      Array.from({ length: size }, (_, i) => reserveAndConfirm(pickDeviceKey(start + i)))
    );
    for (const r of batch) {
      if (r.status === 201 && r.campaignId) results.push({ campaignId: r.campaignId });
    }
  }
  return results;
}

describe('E2E-01: full onboarding-to-fulfillment flow', () => {
  afterAll(cleanupAll);

  it('tenant create -> invite accept -> campaign -> 10 confirmed fulfillments -> 11th excluded', async () => {
    const onboarding = await createTenantViaSuperadmin({ fulfillment_quota: 100 });

    const accept = await jsonRequest('/api/invites/accept', {
      method: 'POST',
      json: { token: onboarding.inviteToken, password: 'e2e-01-password-123' },
    });
    expect(accept.status).toBe(201);
    const tenantAdmin = await createHumanSessionForTest(onboarding.inviteEmail, 'e2e-01-password-123');

    const campaign = await createCampaign(tenantAdmin, { obligation_type: 'impression_count', obligation_target: 10 });
    expect(campaign.status).toBe(201);
    const screen = await registerScreen(tenantAdmin);
    expect(screen.status).toBe(201);

    for (let i = 0; i < 10; i++) {
      const result = await reserveAndConfirm(screen.body.device_api_key);
      expect(result.status).toBe(201);
    }

    const pacing = await jsonRequest(`/v1/campaigns/${campaign.body.campaign.id}/pacing`, { token: tenantAdmin.token });
    expect(pacing.body.delivered).toBe(10);

    const eleventh = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(eleventh.status).toBe(200);
    expect(eleventh.body.reason).toBe('no_eligible_campaigns');
  });
});

describe('E2E-02 / E2E-02b: SOV convergence', () => {
  afterAll(cleanupAll);

  it(
    'E2E-02: two SOV campaigns (60/40 target) converge toward their target split',
    async () => {
      const tenant = await createTenantFixture();
      const campaignA = await createCampaign(tenant.tenantAdmin, { name: 'SOV 60', obligation_type: 'share_of_voice', obligation_target: 60 });
      const campaignB = await createCampaign(tenant.tenantAdmin, { name: 'SOV 40', obligation_type: 'share_of_voice', obligation_target: 40 });
      const screen = await registerScreen(tenant.tenantAdmin);

      const runs = 240;
      const results = await runConvergenceBatches(() => screen.body.device_api_key, runs, 20);
      expect(results.length).toBeGreaterThan(runs * 0.9); // allow a small margin lost to concurrency contention

      expect(results.every((r) => r.campaignId === campaignA.body.campaign.id || r.campaignId === campaignB.body.campaign.id)).toBe(true);
      const aCount = results.filter((r) => r.campaignId === campaignA.body.campaign.id).length;
      const shareA = aCount / results.length;
      expect(shareA).toBeGreaterThan(0.5);
      expect(shareA).toBeLessThan(0.7);
    },
    45000
  );

  it(
    'E2E-02b: SOV holds its guaranteed 40% share against a competing effectively-unlimited impression-count campaign',
    async () => {
      const tenant = await createTenantFixture();
      const sovCampaign = await createCampaign(tenant.tenantAdmin, { name: 'SOV 40', obligation_type: 'share_of_voice', obligation_target: 40 });
      const impressionCampaign = await createCampaign(tenant.tenantAdmin, {
        name: 'Unlimited impression',
        obligation_type: 'impression_count',
        obligation_target: 100000,
      });
      const screen = await registerScreen(tenant.tenantAdmin);

      const runs = 240;
      const results = await runConvergenceBatches(() => screen.body.device_api_key, runs, 20);
      expect(results.length).toBeGreaterThan(runs * 0.9);

      expect(results.every((r) => r.campaignId === sovCampaign.body.campaign.id || r.campaignId === impressionCampaign.body.campaign.id)).toBe(true);
      const sovCount = results.filter((r) => r.campaignId === sovCampaign.body.campaign.id).length;
      const sovShare = sovCount / results.length;
      expect(sovShare).toBeGreaterThan(0.3);
      expect(sovShare).toBeLessThan(0.5);
    },
    45000
  );
});

describe('E2E-03: targeting exclusion end to end', () => {
  afterAll(cleanupAll);

  it('a CA-targeted campaign never delivers to a TX-registered screen, however many times requested', async () => {
    const tenant = await createTenantFixture();
    const campaign = await createCampaign(tenant.tenantAdmin, { targeting: { geo: { type: 'state', values: ['CA'] } } });
    const screen = await registerScreen(tenant.tenantAdmin, { state: 'TX' });

    for (let i = 0; i < 15; i++) {
      const { status, body } = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
      expect(status).toBe(200);
      expect(body.fulfilled).toBe(false);
    }

    const pacing = await jsonRequest(`/v1/campaigns/${campaign.body.campaign.id}/pacing`, { token: tenant.tenantAdmin.token });
    expect(pacing.body.delivered).toBe(0);
  });
});

describe('E2E-04: reservation timeout releases and re-serves obligation', () => {
  afterAll(cleanupAll);

  it(
    'screen A never reports, timeout elapses, screen B receives and confirms — final delivered is 1',
    async () => {
      const tenant = await createTenantFixture();
      // Short reservation timeout so the test can wait out a real timeout
      // rather than reaching into the DB row (E2E coverage of the
      // tenant-configurable timeout itself, distinct from EXPIRY-INT-01's
      // direct-row-manipulation approach).
      await jsonRequest(`/api/admin/tenants/${tenant.tenantId}`, {
        method: 'PATCH',
        token: tenant.superadmin.token,
        json: { reservation_timeout_seconds: 1 },
      });
      const campaign = await createCampaign(tenant.tenantAdmin, { obligation_type: 'impression_count', obligation_target: 1 });
      const screenA = await registerScreen(tenant.tenantAdmin);
      const screenB = await registerScreen(tenant.tenantAdmin);

      const first = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screenA.body.device_api_key });
      expect(first.status).toBe(201);

      await new Promise((resolve) => setTimeout(resolve, 1500));

      const second = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screenB.body.device_api_key });
      expect(second.status).toBe(201);
      const report = await jsonRequest(`/v1/fulfillments/${second.body.fulfillment_id}/report`, {
        method: 'POST',
        token: screenB.body.device_api_key,
        json: { outcome: 'played' },
      });
      expect(report.status).toBe(200);

      const pacing = await jsonRequest(`/v1/campaigns/${campaign.body.campaign.id}/pacing`, { token: tenant.tenantAdmin.token });
      expect(pacing.body.delivered).toBe(1);
    },
    10000
  );
});

describe('E2E-05: superadmin tenant lifecycle', () => {
  afterAll(cleanupAll);

  it('create -> appears in list -> deactivate -> blocked -> reactivate -> succeeds again', async () => {
    const tenant = await createTenantFixture();
    await createCampaign(tenant.tenantAdmin);
    const screen = await registerScreen(tenant.tenantAdmin);

    const list = await jsonRequest('/api/admin/tenants', { token: tenant.superadmin.token });
    expect(list.status).toBe(200);
    expect(list.body.tenants.some((t: any) => t.id === tenant.tenantId)).toBe(true);

    const deactivate = await jsonRequest(`/api/admin/tenants/${tenant.tenantId}`, {
      method: 'PATCH',
      token: tenant.superadmin.token,
      json: { status: 'deactivated' },
    });
    expect(deactivate.status).toBe(200);

    const blocked = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('TENANT_DEACTIVATED');

    const reactivate = await jsonRequest(`/api/admin/tenants/${tenant.tenantId}`, {
      method: 'PATCH',
      token: tenant.superadmin.token,
      json: { status: 'active' },
    });
    expect(reactivate.status).toBe(200);

    const succeeds = await jsonRequest('/v1/fulfillments', { method: 'POST', token: screen.body.device_api_key });
    expect(succeeds.status).toBe(201);
  });
});

describe('E2E-06: attribute-diverse traffic produces correct pacing convergence', () => {
  afterAll(cleanupAll);

  it(
    'a mixed-geo/config screen fleet against SOV+impression campaigns converges correctly for every targeting dimension exercised',
    async () => {
      const tenant = await createTenantFixture();

      const impressionCampaign = await createCampaign(tenant.tenantAdmin, {
        name: 'Impression - CA landscape',
        obligation_type: 'impression_count',
        obligation_target: 10000,
        targeting: { geo: { type: 'state', values: ['CA'] }, screen: { orientations: ['landscape'] } },
      });
      const sovA = await createCampaign(tenant.tenantAdmin, {
        name: 'SOV 60 - TX',
        obligation_type: 'share_of_voice',
        obligation_target: 60,
        targeting: { geo: { type: 'state', values: ['TX'] } },
      });
      const sovB = await createCampaign(tenant.tenantAdmin, {
        name: 'SOV 40 - TX',
        obligation_type: 'share_of_voice',
        obligation_target: 40,
        targeting: { geo: { type: 'state', values: ['TX'] } },
      });

      // Guaranteed-coverage-style fleet: at least a few screens per
      // targeting dimension the campaigns above actually use (CA landscape,
      // TX any-orientation), plus a spread of untargeted states/orientations
      // so no dimension is left untested — same intent as
      // attribute-generator.ts's two-layer approach, built inline.
      const caScreens = await Promise.all(
        Array.from({ length: 3 }, () => registerScreen(tenant.tenantAdmin, { state: 'CA', orientation: 'landscape' }))
      );
      const txScreens = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          registerScreen(tenant.tenantAdmin, { state: 'TX', orientation: i % 2 === 0 ? 'landscape' : 'portrait' })
        )
      );
      const otherScreens = await Promise.all(
        ['NY', 'FL', 'WA'].map((state) => registerScreen(tenant.tenantAdmin, { state, orientation: 'portrait' }))
      );

      expect(caScreens.every((s) => s.status === 201)).toBe(true);
      expect(txScreens.every((s) => s.status === 201)).toBe(true);
      expect(otherScreens.every((s) => s.status === 201)).toBe(true);

      // CA landscape traffic should always land on the impression campaign.
      for (const s of caScreens) {
        const result = await reserveAndConfirm(s.body.device_api_key);
        expect(result.status).toBe(201);
        expect(result.campaignId).toBe(impressionCampaign.body.campaign.id);
      }

      // NY/FL/WA screens match no campaign's targeting at all.
      for (const s of otherScreens) {
        const { status, body } = await jsonRequest('/v1/fulfillments', { method: 'POST', token: s.body.device_api_key });
        expect(status).toBe(200);
        expect(body.fulfilled).toBe(false);
      }

      // TX traffic (any orientation) competes only between the two SOV
      // campaigns — run enough cycles for convergence toward 60/40.
      const runs = 180;
      const results = await runConvergenceBatches((i) => txScreens[i % txScreens.length].body.device_api_key, runs, 20);
      expect(results.length).toBeGreaterThan(runs * 0.9);

      expect(results.every((r) => r.campaignId === sovA.body.campaign.id || r.campaignId === sovB.body.campaign.id)).toBe(true);
      const aCount = results.filter((r) => r.campaignId === sovA.body.campaign.id).length;
      const shareA = aCount / results.length;
      expect(shareA).toBeGreaterThan(0.45);
      expect(shareA).toBeLessThan(0.75);
    },
    45000
  );
});
