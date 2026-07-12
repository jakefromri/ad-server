import { Hono, type ExecutionContext } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import invites from '../server/invites';
import adminTenants from '../server/admin-tenants';
import adminLedger from '../server/admin-ledger';
import adminHealth from '../server/admin-health';
import tenantSelf from '../server/tenant-self';
import campaigns from '../server/campaigns';
import screens from '../server/screens';
import fulfillments from '../server/fulfillments';
import cron from '../server/cron';

export const config = { runtime: 'edge' };

const app = new Hono();

app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  })
);

app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Public — must stay outside any route glob a human-auth middleware guards.
app.route('/api/invites', invites);

// Superadmin — tenant lifecycle. Auth applied inside admin-tenants.ts.
app.route('/api/admin/tenants', adminTenants);

// Superadmin — cross-tenant ledger (04f). Auth applied inside admin-ledger.ts.
app.route('/api/admin/ledger', adminLedger);

// Superadmin — GET /api/admin/system-health (04i). Auth applied inside
// admin-health.ts. Backed by fulfillment_attempts (see migration 0005) +
// fulfillments — see architecture.md's Data Model / API Endpoints sections.
app.route('/api/admin/system-health', adminHealth);

// Tenant — JWT-or-tenant-key (architecture.md § Auth Model, mechanism 2).
// Auth applied inside each router via tenantAccessMiddleware.
app.route('/v1/campaigns', campaigns);
app.route('/v1/screens', screens);
app.route('/v1/tenant', tenantSelf);

// Device — fulfillment/report only. Auth applied inside fulfillments.ts via
// deviceAuthMiddleware (architecture.md § Auth Model, mechanism 3).
app.route('/v1/fulfillments', fulfillments);

// Vercel Cron backstop for reservation expiry (architecture.md § Expiry
// mechanics). Not device/tenant/superadmin scoped — see cron.ts for its own
// CRON_SECRET gate.
app.route('/api/cron', cron);

// docs.ts / GET /v1/openapi.json / GET /docs — attempted in 04i via
// @hono/zod-openapi, reverted in the same phase: that package internally
// imports hono's `mergePath` via the cross-package subpath `hono/utils/url`,
// which Vercel's Edge Function deploy-time validator rejects outright
// ("referencing unsupported modules"), confirmed with a real
// `vercel deploy --prebuilt`. Every version of @hono/zod-openapi has this
// same import (core to how `.route()` merges sub-router registries), so it
// isn't fixable by bumping versions, and switching this function to Node.js
// runtime to sidestep the Edge-only restriction surfaced a second blocking
// issue (this repo's `"type": "module"` + Vercel's unbundled Node Function
// packaging needs explicit `.js` extensions on every relative import — a
// much bigger, riskier change). Not attempted again without a clearer path
// around one of those two problems — see build-report.md's 04i section for
// the full investigation.
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    // Every auth middleware (human-auth/device-auth/tenant-access) throws
    // HTTPException with a JSON.stringify'd { error, code } body as
    // `message` — parse it back out rather than re-wrapping the JSON string
    // itself as the value of "error" (04d found this double-encoding it
    // silently ate every `code` field on 401/403 responses since 04b; falls
    // back to plain-string wrapping for any HTTPException thrown with an
    // actual plain-text message).
    try {
      return c.json(JSON.parse(err.message), err.status);
    } catch {
      return c.json({ error: err.message }, err.status);
    }
  }
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export { app };

// hono/vercel's handle(app) is `(app) => (req) => app.fetch(req)` — a
// one-argument call that discards Vercel's Edge ExecutionContext (confirmed
// by reading node_modules/hono/dist/adapter/vercel/handler.js). POST
// /v1/fulfillments needs that context to log fulfillment_attempts rows via
// c.executionCtx.waitUntil(...) without adding hot-path latency (architecture.md
// § Data Model, fulfillment_attempts), so the entrypoint forwards it directly
// instead of going through handle().
export default (req: Request, ctx: ExecutionContext) => app.fetch(req, undefined, ctx);
