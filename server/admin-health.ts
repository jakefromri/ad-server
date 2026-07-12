// GET /api/admin/system-health (04i, follow-up scoping session). Mounted at
// /api/admin/system-health behind humanAuthMiddleware + requireRole('superadmin').
// architecture.md § API Endpoints — backed by fulfillment_attempts (migration
// 0005) for request_rate_per_min/error_rate/no_eligible_campaign_rate, and
// fulfillments directly for reservation_timeout_rate (doesn't need
// fulfillment_attempts — computable from the existing ledger).
//
// "windowed, last 5/60 min" (architecture.md) is two separate windows, not
// one: a short 5-minute window for the rate (a recent-activity signal that a
// 60-minute average would smooth out too much), and a longer 60-minute window
// for the three ratios (a stable-enough denominator that a 5-minute one
// wouldn't reliably have).

import { Hono } from 'hono';
import { supabaseAdmin } from './supabase';
import { humanAuthMiddleware, requireRole } from './human-auth';

const router = new Hono();
router.use('*', humanAuthMiddleware, requireRole('superadmin'));

const RATE_WINDOW_MINUTES = 5;
const RATIO_WINDOW_MINUTES = 60;

router.get('/', async (c) => {
  const now = Date.now();
  const rateWindowStart = new Date(now - RATE_WINDOW_MINUTES * 60_000).toISOString();
  const ratioWindowStart = new Date(now - RATIO_WINDOW_MINUTES * 60_000).toISOString();

  const { count: rateWindowCount } = await supabaseAdmin
    .from('fulfillment_attempts')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', rateWindowStart);

  const { data: ratioAttempts } = await supabaseAdmin
    .from('fulfillment_attempts')
    .select('outcome')
    .gte('created_at', ratioWindowStart);

  const attempts = ratioAttempts ?? [];
  const totalAttempts = attempts.length;
  const errorCount = attempts.filter((a) => a.outcome === 'auth_error' || a.outcome === 'server_error').length;
  const noEligibleCount = attempts.filter((a) => a.outcome === 'no_eligible_campaigns').length;

  const { count: totalFulfillments } = await supabaseAdmin
    .from('fulfillments')
    .select('id', { count: 'exact', head: true })
    .gte('requested_at', ratioWindowStart);

  const { count: expiredFulfillments } = await supabaseAdmin
    .from('fulfillments')
    .select('id', { count: 'exact', head: true })
    .gte('requested_at', ratioWindowStart)
    .eq('status', 'expired');

  return c.json({
    request_rate_per_min: (rateWindowCount ?? 0) / RATE_WINDOW_MINUTES,
    error_rate: totalAttempts > 0 ? errorCount / totalAttempts : 0,
    reservation_timeout_rate: (totalFulfillments ?? 0) > 0 ? (expiredFulfillments ?? 0) / (totalFulfillments as number) : 0,
    no_eligible_campaign_rate: totalAttempts > 0 ? noEligibleCount / totalAttempts : 0,
  });
});

export default router;
