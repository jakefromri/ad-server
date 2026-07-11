// GET /api/cron/expire-reservations — the cron backstop from architecture.md
// § Expiry mechanics: "a Vercel Cron job runs every 1 minute, UPDATE
// fulfillments SET status = 'expired' WHERE status = 'reserved' AND
// reserved_expires_at < now()". This exists purely so the dashboard/ledger
// shows an accurate status for reservations nobody ever reports on — the
// lazy check in campaign_pacing/reserve_fulfillment already excludes expired
// reservations from reconciliation math regardless of whether this has run,
// so this has no effect on reconciliation correctness (EXPIRY-INT-02).
//
// Idempotent by construction (the WHERE clause only ever matches rows
// already past their own expiry timestamp), so a stray extra invocation is
// harmless. Gated by CRON_SECRET when set, matching Vercel's documented
// cron-authentication convention — not in architecture.md's Environment
// Variables table since it predates this phase; added to .env.example here.

import { Hono } from 'hono';
import { supabaseAdmin } from './supabase';

const router = new Hono();

router.get('/expire-reservations', async (c) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = c.req.header('Authorization');
    if (authHeader !== `Bearer ${secret}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  }

  const { data, error } = await supabaseAdmin
    .from('fulfillments')
    .update({ status: 'expired' })
    .eq('status', 'reserved')
    .lt('reserved_expires_at', new Date().toISOString())
    .select('id');

  if (error) return c.json({ error: error.message }, 500);

  return c.json({ swept: data?.length ?? 0 });
});

export default router;
