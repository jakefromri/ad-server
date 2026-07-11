import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import invites from './lib/invites';
import testRoutes from './lib/test-routes';

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

// 04b-only auth-primitive proof routes. See api/lib/test-routes.ts header.
app.route('/api/_test', testRoutes);

// Remaining route modules (campaigns, screens, fulfillments, tenants, admin,
// docs) are mounted here starting in 04c — see architecture.md § File
// Structure.

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export { app };
export default handle(app);
