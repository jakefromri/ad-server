// GET/POST /v1/campaigns, PATCH /v1/campaigns/:id, GET /v1/campaigns/:id/pacing.
// Mounted at /v1/campaigns behind tenantAccessMiddleware (JWT-or-tenant-key).

import { Hono } from 'hono';
import { z } from 'zod';
import { ErrorCode } from '../types';
import { supabaseAdmin } from './supabase';
import { tenantAccessMiddleware } from './tenant-access';
import { checkSovOverselling } from './sov';
import { hasNonZeroTimeCoverage, matchesGeo, matchesScreenConfig, type TargetingScreen } from './targeting';

const router = new Hono();
router.use('*', tenantAccessMiddleware);

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:MM');

const targetingSchema = z.object({
  daypart: z.array(z.object({ start: hhmm, end: hhmm })).optional(),
  days_of_week: z.array(z.number().int().min(1).max(7)).optional(),
  geo: z.object({
    type: z.enum(['all', 'state', 'zip']),
    values: z.array(z.string()).optional(),
  }),
  screen: z
    .object({
      aspect_ratios: z.array(z.string()).optional(),
      resolutions: z.array(z.string()).optional(),
      orientations: z.array(z.enum(['landscape', 'portrait'])).optional(),
    })
    .optional(),
});

const createCampaignSchema = z.object({
  name: z.string().min(1),
  creative_media_path: z.string().min(1),
  obligation_type: z.enum(['impression_count', 'share_of_voice']),
  obligation_target: z.number(),
  priority_weight: z.number().positive().optional(),
  flight_start: z.string().datetime({ offset: true }),
  flight_end: z.string().datetime({ offset: true }),
  targeting: targetingSchema.optional(),
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
});

const patchCampaignSchema = createCampaignSchema.partial();

interface ObligationFlightCheck {
  obligation_type: 'impression_count' | 'share_of_voice';
  obligation_target: number;
  flight_start: string;
  flight_end: string;
}

function validateObligationAndFlight(candidate: ObligationFlightCheck): string | null {
  if (new Date(candidate.flight_end) <= new Date(candidate.flight_start)) {
    return 'flight_end must be after flight_start';
  }
  if (candidate.obligation_type === 'impression_count') {
    if (!Number.isInteger(candidate.obligation_target) || candidate.obligation_target <= 0) {
      return 'obligation_target must be a positive integer for impression_count campaigns';
    }
  } else {
    if (candidate.obligation_target < 0 || candidate.obligation_target > 100) {
      return 'obligation_target must be between 0 and 100 for share_of_voice campaigns';
    }
  }
  return null;
}

router.get('/', async (c) => {
  const auth = c.get('auth');
  const { data, error } = await supabaseAdmin.from('campaigns').select('*').eq('tenant_id', auth.tenant_id);
  if (error) return c.json({ error: error.message, code: ErrorCode.VALIDATION_ERROR }, 400);
  return c.json({ campaigns: data ?? [] });
});

router.post('/', async (c) => {
  const auth = c.get('auth');
  const parsed = createCampaignSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request', code: ErrorCode.VALIDATION_ERROR }, 400);
  }
  const body = parsed.data;

  const validationError = validateObligationAndFlight(body);
  if (validationError) return c.json({ error: validationError, code: ErrorCode.VALIDATION_ERROR }, 400);

  const status = body.status ?? 'draft';

  if (body.obligation_type === 'share_of_voice' && status === 'active') {
    const { ok, currentCombinedTotal } = await checkSovOverselling({
      tenant_id: auth.tenant_id as string,
      obligation_target: body.obligation_target,
      flight_start: body.flight_start,
      flight_end: body.flight_end,
    });
    if (!ok) {
      return c.json(
        { error: 'Combined active SOV target would exceed 100%', code: ErrorCode.SOV_OVERSOLD, current_combined_total: currentCombinedTotal },
        409
      );
    }
  }

  const { data, error } = await supabaseAdmin
    .from('campaigns')
    .insert({
      tenant_id: auth.tenant_id,
      name: body.name,
      creative_media_path: body.creative_media_path,
      obligation_type: body.obligation_type,
      obligation_target: body.obligation_target,
      priority_weight: body.priority_weight ?? 1.0,
      flight_start: body.flight_start,
      flight_end: body.flight_end,
      status,
      targeting: body.targeting ?? { geo: { type: 'all' } },
    })
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: error?.message ?? 'Failed to create campaign', code: ErrorCode.VALIDATION_ERROR }, 400);
  }

  return c.json({ campaign: data }, 201);
});

router.patch('/:id', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');
  const parsed = patchCampaignSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request', code: ErrorCode.VALIDATION_ERROR }, 400);
  }
  const patch = parsed.data;

  const { data: existing, error: fetchError } = await supabaseAdmin
    .from('campaigns')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', auth.tenant_id)
    .single();

  if (fetchError || !existing) {
    return c.json({ error: 'Campaign not found', code: ErrorCode.NOT_FOUND }, 404);
  }

  const merged: ObligationFlightCheck = {
    obligation_type: patch.obligation_type ?? existing.obligation_type,
    obligation_target: patch.obligation_target ?? Number(existing.obligation_target),
    flight_start: patch.flight_start ?? existing.flight_start,
    flight_end: patch.flight_end ?? existing.flight_end,
  };
  const mergedStatus = patch.status ?? existing.status;

  const validationError = validateObligationAndFlight(merged);
  if (validationError) return c.json({ error: validationError, code: ErrorCode.VALIDATION_ERROR }, 400);

  if (merged.obligation_type === 'share_of_voice' && mergedStatus === 'active') {
    const { ok, currentCombinedTotal } = await checkSovOverselling({
      tenant_id: auth.tenant_id as string,
      obligation_target: merged.obligation_target,
      flight_start: merged.flight_start,
      flight_end: merged.flight_end,
      excludeCampaignId: id,
    });
    if (!ok) {
      return c.json(
        { error: 'Combined active SOV target would exceed 100%', code: ErrorCode.SOV_OVERSOLD, current_combined_total: currentCombinedTotal },
        409
      );
    }
  }

  const { data, error } = await supabaseAdmin
    .from('campaigns')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', auth.tenant_id)
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: error?.message ?? 'Failed to update campaign', code: ErrorCode.VALIDATION_ERROR }, 400);
  }

  return c.json({ campaign: data });
});

router.get('/:id/pacing', async (c) => {
  const auth = c.get('auth');
  const id = c.req.param('id');

  const { data: campaign, error } = await supabaseAdmin
    .from('campaigns')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', auth.tenant_id)
    .single();

  if (error || !campaign) {
    return c.json({ error: 'Campaign not found', code: ErrorCode.NOT_FOUND }, 404);
  }

  const { data: pacingRow } = await supabaseAdmin
    .from('campaign_pacing')
    .select('confirmed_count')
    .eq('campaign_id', id)
    .maybeSingle();

  const delivered = pacingRow?.confirmed_count ?? 0;

  let remaining: number | null = null;
  let sovActual: number | null = null;
  let sovTarget: number | null = null;

  if (campaign.obligation_type === 'impression_count') {
    remaining = Math.max(Number(campaign.obligation_target) - delivered, 0);
  } else {
    sovTarget = Number(campaign.obligation_target);

    // Dashboard-level approximation: tenant-wide delivered total across all
    // currently-active campaigns, not the request-time, targeting-scoped
    // eligible pool that 04d's reconciliation engine uses (RECON-UNIT-03).
    // There's no single "screen" context on this endpoint to scope
    // eligibility to, so this is the coarser number the pacing dashboard
    // shows — flagged in build-report.md for whoever builds 04f's dashboard.
    const { data: activeCampaigns } = await supabaseAdmin
      .from('campaigns')
      .select('id')
      .eq('tenant_id', auth.tenant_id)
      .eq('status', 'active');

    const activeIds = (activeCampaigns ?? []).map((row) => row.id);
    let poolDelivered = 0;
    if (activeIds.length > 0) {
      const { data: poolRows } = await supabaseAdmin.from('campaign_pacing').select('confirmed_count').in('campaign_id', activeIds);
      poolDelivered = (poolRows ?? []).reduce((sum, row) => sum + row.confirmed_count, 0);
    }
    sovActual = poolDelivered > 0 ? (delivered / poolDelivered) * 100 : 0;
  }

  // no_eligible_screens (04i, follow-up scoping session) — a live,
  // request-time structural check, not tracked on the fulfillment hot path
  // at all (architecture.md's resolved design: the original "zero real
  // fulfillment requests" framing would have needed a hot-path write per
  // eligible campaign per request; this is one extra query on an
  // already-low-traffic dashboard read endpoint instead). true if the
  // targeting's time window never has nonzero coverage, or no *active*
  // screen in the tenant's current fleet matches its geo/screen-config.
  const { data: activeScreens } = await supabaseAdmin
    .from('screens')
    .select('state, zip, aspect_ratio, resolution, orientation')
    .eq('tenant_id', auth.tenant_id)
    .eq('status', 'active');

  const hasTimeCoverage = hasNonZeroTimeCoverage(campaign.targeting);
  const hasMatchingScreen = (activeScreens ?? []).some((screen: TargetingScreen) =>
    matchesGeo(campaign.targeting.geo, screen) && matchesScreenConfig(campaign.targeting.screen, screen)
  );
  const noEligibleScreens = !(hasTimeCoverage && hasMatchingScreen);

  return c.json({ delivered, remaining, sov_actual: sovActual, sov_target: sovTarget, no_eligible_screens: noEligibleScreens });
});

export default router;
