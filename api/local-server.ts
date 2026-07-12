// Local-only HTTP server wrapping the same `app` export api/index.ts hands to
// Vercel Edge. Nothing here is Vercel-specific (04b's build-report already
// established the auth/route code is runtime-agnostic) — this just gives k6
// (and anything else that needs real HTTP, not `app.request()` in-process) a
// live target without requiring `vercel dev` / Vercel CLI login, which isn't
// available in this environment. Never used in production — Vercel serves
// `app` directly via `hono/vercel`'s `handle()`.
//
// Usage: npm run dev:api:local  (defaults to :3000, override with PORT=)

import { serve } from '@hono/node-server';
import { app } from './index';

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Local API server listening on http://localhost:${info.port}`);
});
