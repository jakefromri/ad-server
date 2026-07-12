// POST /v1/fulfillments, POST /v1/fulfillments/:id/report. Mounted at
// /v1/fulfillments behind deviceAuthMiddleware only (architecture.md § API
// Endpoints, "Device — Fulfillment": 403 if a tenant_admin JWT or tenant API
// key is presented instead — deviceAuthMiddleware now distinguishes that
// from a plain 401, per this phase's fix to device-auth.ts).
//
// This is the reconciliation engine's request/response boundary. All of the
// scoring math lives in reconciliation.ts (pure, testable); this file is
// I/O — loading fresh data each attempt and calling the reserve_fulfillment
// RPC for the one step that needs a real row lock (see the migration's
// header comment for why that step can't be plain sequential supabase-js
// calls).

import { ErrorCode, type CampaignTargeting } from '../types';
import { supabaseAdmin } from './supabase';
import { deviceAuthMiddleware } from './device-auth';
import { filterEligibleCampaigns, scoreEligiblePool, type CampaignForEligibility } from './reconciliation';
import { logFulfillmentAttempt } from './fulfillment-attempts';
import type { TargetingScreen } from './targeting';
import { newRouter, createRoute, z, errorResponses, type RouteContext } from './openapi';

const router = newRouter();

// deviceAuthMiddleware is NOT mounted via a blanket `router.use('*', ...)`
// here (unlike every other router in server/) — POST '/' needs to catch its
// own auth failures to log a fulfillment_attempts row with outcome
// 'auth_error' (tenant_id/screen_id both null, since no device context ever
// gets set — architecture.md § Data Model). '/:id/report' has no such
// requirement (fulfillment_attempts is scoped to POST /v1/fulfillments only
// per architecture.md), so it keeps the plain middleware mount.
router.use('/:id/report', deviceAuthMiddleware);

const MAX_ATTEMPTS = 3;

interface EligiblePoolLoad {
  eligible: ReturnType<typeof filterEligibleCampaigns>;
  mediaByCampaign: Map<string, string>;
}

interface ActiveCampaignRow {
  id: string;
  obligation_type: 'impression_count' | 'share_of_voice';
  obligation_target: number;
  priority_weight: number;
  flight_start: string;
  flight_end: string;
  status: string;
  targeting: CampaignTargeting;
  creative_media_path: string;
}

// architecture.md § Scale Plan, row 1: "Cache each tenant's active campaign
// set (definition + targeting, not pacing state)... invalidated on campaign
// CRUD or a short TTL (e.g. 5s)". 04g's load test found this query
// dominating per-request latency under concurrency (six sequential DB round
// trips per fulfillment attempt, of which this was one) — this is the one
// targeted fix, not a general-purpose cache layer. Deliberately in-memory
// module scope, not Redis: Edge instances are ephemeral/per-region, so this
// doesn't guarantee global consistency, but a 5s-stale campaign definition
// (not pacing, which is always queried fresh below) is the tradeoff the doc
// already accepts. Never caches campaign_pacing — that must stay live every
// attempt (race-safety requirement, same doc).
const ACTIVE_CAMPAIGN_CACHE_TTL_MS = 5000;
const activeCampaignCache = new Map<string, { rows: ActiveCampaignRow[]; expiresAt: number }>();

async function loadActiveCampaigns(tenantId: string, nowIso: string): Promise<ActiveCampaignRow[]> {
  const cached = activeCampaignCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.rows;
  }

  const { data: campaigns } = await supabaseAdmin
    .from('campaigns')
    .select('id, obligation_type, obligation_target, priority_weight, flight_start, flight_end, status, targeting, creative_media_path')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .lte('flight_start', nowIso)
    .gte('flight_end', nowIso);

  const rows = campaigns ?? [];
  activeCampaignCache.set(tenantId, { rows, expiresAt: Date.now() + ACTIVE_CAMPAIGN_CACHE_TTL_MS });
  return rows;
}

/** Loads the tenant's currently-active, in-flight campaigns (cached — see
 * loadActiveCampaigns), joined against campaign_pacing (queried fresh every
 * time — it already implements the lazy-expiry rule: a 'reserved' row past
 * its timeout is excluded from pending_reserved_count regardless of whether
 * the cron sweep has formally marked it 'expired' yet), then runs the
 * targeting/remaining-obligation filter. Pacing is never reused from a
 * prior attempt (architecture.md's race-safety requirement) — only the
 * campaign definition/targeting half of this is cached. */
async function loadEligiblePool(tenantId: string, screen: TargetingScreen, now: Date): Promise<EligiblePoolLoad> {
  const nowIso = now.toISOString();

  const campaigns = await loadActiveCampaigns(tenantId, nowIso);

  if (!campaigns || campaigns.length === 0) {
    return { eligible: [], mediaByCampaign: new Map() };
  }

  const ids = campaigns.map((c) => c.id);
  const { data: pacingRows } = await supabaseAdmin
    .from('campaign_pacing')
    .select('campaign_id, confirmed_count, pending_reserved_count')
    .in('campaign_id', ids);

  const pacingByCampaign = new Map((pacingRows ?? []).map((r) => [r.campaign_id, r]));
  const mediaByCampaign = new Map(campaigns.map((c) => [c.id, c.creative_media_path]));

  const withPacing: CampaignForEligibility[] = campaigns.map((c) => {
    const pacing = pacingByCampaign.get(c.id);
    return {
      id: c.id,
      obligation_type: c.obligation_type,
      obligation_target: c.obligation_target,
      priority_weight: c.priority_weight,
      flight_start: c.flight_start,
      flight_end: c.flight_end,
      status: c.status,
      targeting: c.targeting,
      confirmed_count: pacing?.confirmed_count ?? 0,
      pending_reserved_count: pacing?.pending_reserved_count ?? 0,
    };
  });

  return { eligible: filterEligibleCampaigns(withPacing, screen, now), mediaByCampaign };
}

interface ReserveRpcRow {
  out_result_status: 'reserved' | 'quota_exceeded' | 'campaign_no_longer_eligible';
  out_fulfillment_id: string | null;
  out_requested_at: string | null;
  out_reserved_expires_at: string | null;
}

async function attemptReservation(params: {
  tenantId: string;
  campaignId: string;
  screenId: string;
  mediaRef: string;
  reservationTimeoutSeconds: number;
  obligationType: 'impression_count' | 'share_of_voice';
  obligationTarget: number;
}): Promise<ReserveRpcRow> {
  const { data, error } = await supabaseAdmin.rpc('reserve_fulfillment', {
    p_tenant_id: params.tenantId,
    p_campaign_id: params.campaignId,
    p_screen_id: params.screenId,
    p_media_ref: params.mediaRef,
    p_reservation_timeout_seconds: params.reservationTimeoutSeconds,
    p_obligation_type: params.obligationType,
    p_obligation_target: params.obligationTarget,
  });
  if (error) throw error;
  const row = (data as ReserveRpcRow[] | null)?.[0];
  if (!row) throw new Error('reserve_fulfillment returned no row');
  return row;
}

const requestFulfillmentRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Fulfillments'],
  summary: 'Request a fulfillment for the calling device\'s screen',
  responses: {
    201: {
      description: 'Reserved',
      content: {
        'application/json': {
          schema: z.object({
            fulfillment_id: z.string(),
            campaign_id: z.string(),
            media_ref: z.string(),
            reserved_expires_at: z.string(),
          }),
        },
      },
    },
    200: {
      description: 'No eligible campaign',
      content: { 'application/json': { schema: z.object({ fulfilled: z.literal(false), reason: z.literal('no_eligible_campaigns') }) } },
    },
    ...errorResponses(401, 403, 429),
  },
});

// Handler param is `c: RouteContext`, here and in every other 04i-converted route —
// @hono/zod-openapi's typed-response system requires every `c.json(...)`
// call in a handler to structurally match one declared `responses` status
// entry, verified via TS overload resolution across the whole function
// body. That breaks down across handlers with several differently-shaped
// success/error branches (a rough edge in the library's typing, not a
// runtime concern — request validation and the actual response body are
// unaffected either way).
router.openapi(requestFulfillmentRoute, async (c: RouteContext) => {
  // Manually invoked (not `router.use`) so a thrown auth failure can be
  // logged with a fulfillment_attempts row before propagating — see this
  // file's header comment on why '/' doesn't share '/:id/report''s plain
  // middleware mount.
  try {
    await deviceAuthMiddleware(c, async () => {});
  } catch (err) {
    logFulfillmentAttempt(c, null, null, 'auth_error');
    throw err;
  }

  const device = c.get('device');

  try {
    const { data: tenant } = await supabaseAdmin
      .from('tenants')
      .select('fulfillment_quota, reservation_timeout_seconds')
      .eq('id', device.tenant_id)
      .single();

    if (!tenant) return c.json({ error: 'Tenant not found', code: ErrorCode.NOT_FOUND }, 404);

    // Step 2 — fast unlocked quota pre-check (QUOTA-UNIT-01: must short-circuit
    // before the campaign query even runs, for the common already-over-quota
    // case). Not authoritative — reserve_fulfillment re-checks under lock.
    const { data: usage } = await supabaseAdmin
      .from('fulfillment_quota_usage')
      .select('used_count')
      .eq('tenant_id', device.tenant_id)
      .maybeSingle();

    if ((usage?.used_count ?? 0) >= Number(tenant.fulfillment_quota)) {
      logFulfillmentAttempt(c, device.tenant_id, device.screen_id, 'quota_exceeded');
      return c.json({ error: 'Fulfillment quota exceeded', code: ErrorCode.QUOTA_EXCEEDED }, 429);
    }

    const { data: screen } = await supabaseAdmin
      .from('screens')
      .select('state, zip, aspect_ratio, resolution, orientation')
      .eq('id', device.screen_id)
      .single();

    if (!screen) return c.json({ error: 'Screen not found', code: ErrorCode.NOT_FOUND }, 404);

    const now = new Date();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { eligible, mediaByCampaign } = await loadEligiblePool(device.tenant_id, screen, now);
      if (eligible.length === 0) {
        logFulfillmentAttempt(c, device.tenant_id, device.screen_id, 'no_eligible_campaigns');
        return c.json({ fulfilled: false, reason: 'no_eligible_campaigns' });
      }

      const { winner, tier, candidates } = scoreEligiblePool(eligible, now);
      if (!winner) {
        logFulfillmentAttempt(c, device.tenant_id, device.screen_id, 'no_eligible_campaigns');
        return c.json({ fulfilled: false, reason: 'no_eligible_campaigns' });
      }

      if (candidates.length > 1) {
        // Near-tie winner-selection detail — scope.md's "log enough detail to
        // reconstruct after the fact why a given campaign won" flag. No
        // dedicated ledger table for this in architecture.md's Data Model;
        // Vercel's function logs are the pragmatic MVP store.
        console.log('reconciliation_near_tie', {
          tenant_id: device.tenant_id,
          screen_id: device.screen_id,
          attempt,
          tier,
          winner_id: winner.id,
          candidates: candidates.map((cand) => ({ campaign_id: cand.campaign.id, pacing_pressure: cand.pacingPressure })),
        });
      }

      const mediaRef = mediaByCampaign.get(winner.id);
      if (!mediaRef) continue; // campaign vanished between load and here — retry fresh

      const result = await attemptReservation({
        tenantId: device.tenant_id,
        campaignId: winner.id,
        screenId: device.screen_id,
        mediaRef,
        reservationTimeoutSeconds: tenant.reservation_timeout_seconds,
        obligationType: winner.obligation_type,
        obligationTarget: winner.obligation_target,
      });

      if (result.out_result_status === 'quota_exceeded') {
        // Authoritative check failed — being over quota isn't fixed by trying a
        // different campaign, so no retry (architecture.md).
        logFulfillmentAttempt(c, device.tenant_id, device.screen_id, 'quota_exceeded');
        return c.json({ error: 'Fulfillment quota exceeded', code: ErrorCode.QUOTA_EXCEEDED }, 429);
      }

      if (result.out_result_status === 'reserved') {
        logFulfillmentAttempt(c, device.tenant_id, device.screen_id, 'fulfilled');
        return c.json(
          {
            fulfillment_id: result.out_fulfillment_id,
            campaign_id: winner.id,
            media_ref: mediaRef,
            reserved_expires_at: result.out_reserved_expires_at,
          },
          201
        );
      }

      // 'campaign_no_longer_eligible' — a concurrent request claimed the last
      // unit of this campaign's obligation since scoring ran. Loop continues:
      // next attempt re-queries and re-scores fresh, never reuses this
      // attempt's eligible set or winner (RACE-INT-02).
    }

    // All MAX_ATTEMPTS attempts lost the campaign-row race (RACE-INT-03).
    logFulfillmentAttempt(c, device.tenant_id, device.screen_id, 'no_eligible_campaigns');
    return c.json({ fulfilled: false, reason: 'no_eligible_campaigns' });
  } catch (err) {
    logFulfillmentAttempt(c, device.tenant_id, device.screen_id, 'server_error');
    throw err;
  }
});

const reportSchema = z.object({
  outcome: z.enum(['played', 'skipped', 'failed']),
  played_duration_ms: z.number().int().nonnegative().optional(),
});

const reportRoute = createRoute({
  method: 'post',
  path: '/{id}/report',
  tags: ['Fulfillments'],
  summary: 'Report the outcome of a reserved fulfillment',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: reportSchema } } },
  },
  responses: {
    200: { description: 'Reported', content: { 'application/json': { schema: z.object({ status: z.enum(['confirmed', 'released']) }) } } },
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

router.openapi(reportRoute, async (c: RouteContext) => {
  const device = c.get('device');
  const { id } = c.req.valid('param');
  const { outcome, played_duration_ms } = c.req.valid('json');

  const { data: fulfillment, error: fetchError } = await supabaseAdmin
    .from('fulfillments')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !fulfillment) {
    return c.json({ error: 'Fulfillment not found', code: ErrorCode.NOT_FOUND }, 404);
  }

  if (fulfillment.screen_id !== device.screen_id) {
    return c.json({ error: 'Fulfillment belongs to a different screen', code: ErrorCode.FORBIDDEN }, 403);
  }

  if (fulfillment.status === 'confirmed' || fulfillment.status === 'failed') {
    return c.json({ error: 'Fulfillment already reported', code: ErrorCode.ALREADY_REPORTED }, 409);
  }

  // Lazy-expiry rule applies here too: a 'reserved' row past its timeout is
  // treated as expired even if the cron sweep hasn't formally flipped its
  // status yet (architecture.md § Expiry mechanics).
  if (fulfillment.status === 'expired' || new Date(fulfillment.reserved_expires_at) < new Date()) {
    return c.json({ error: 'Reservation already expired', code: ErrorCode.LATE_REPORT }, 409);
  }

  const newStatus = outcome === 'played' ? 'confirmed' : 'failed';

  // Guard the transition on status='reserved' so two simultaneous report
  // calls for the same fulfillment can't both succeed — the update is a
  // single atomic statement, no RPC needed for this narrower race.
  const { data: updated, error: updateError } = await supabaseAdmin
    .from('fulfillments')
    .update({
      status: newStatus,
      reported_at: new Date().toISOString(),
      report_outcome: outcome,
      played_duration_ms: played_duration_ms ?? null,
    })
    .eq('id', id)
    .eq('status', 'reserved')
    .select()
    .single();

  if (updateError || !updated) {
    return c.json({ error: 'Fulfillment already reported', code: ErrorCode.ALREADY_REPORTED }, 409);
  }

  return c.json({ status: outcome === 'played' ? 'confirmed' : 'released' });
});

export default router;
