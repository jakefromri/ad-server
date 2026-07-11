import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import invites from './lib/invites';
import adminTenants from './lib/admin-tenants';
import tenantSelf from './lib/tenant-self';
import campaigns from './lib/campaigns';
import screens from './lib/screens';
import fulfillments from './lib/fulfillments';
import cron from './lib/cron';

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

// Remaining route modules (admin system-health/ledger, docs) are mounted in
// later phases — see architecture.md § File Structure and PROJECT_PLAN.md's
// 04d+ sessions.

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
export default handle(app);
