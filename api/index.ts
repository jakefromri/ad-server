import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';

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

// Foundation-only stub. Route modules (campaigns, screens, fulfillments,
// tenants, admin, docs) are mounted here starting in 04b — see architecture.md
// § File Structure.
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default handle(app);
