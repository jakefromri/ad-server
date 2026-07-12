// Async, best-effort write to fulfillment_attempts — backs GET
// /api/admin/system-health (architecture.md § Data Model). Called from
// fulfillments.ts's POST '/' handler only, once per call, for every outcome
// (including auth failures before a device context exists). Never awaited on
// the response path — see api/index.ts's ExecutionContext-forwarding
// entrypoint, which this relies on to survive after the response is sent on
// real Edge deploys.

import type { Context } from 'hono';
import { supabaseAdmin } from './supabase';

export type FulfillmentAttemptOutcome = 'fulfilled' | 'no_eligible_campaigns' | 'quota_exceeded' | 'auth_error' | 'server_error';

export function logFulfillmentAttempt(
  c: Context,
  tenantId: string | null,
  screenId: string | null,
  outcome: FulfillmentAttemptOutcome
): void {
  const write = (async () => {
    await supabaseAdmin.from('fulfillment_attempts').insert({ tenant_id: tenantId, screen_id: screenId, outcome });
  })();

  try {
    // Real Edge deploy — keep the function instance alive until the write
    // finishes, without blocking the response that's already been sent.
    c.executionCtx.waitUntil(write);
  } catch {
    // No ExecutionContext (local dev via @hono/node-server, or vitest's
    // app.request()) — the insert is already in flight regardless; nothing
    // else to do here.
  }
}
