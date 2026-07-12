// GET /v1/openapi.json, GET /docs (04i, follow-up scoping session).
// architecture.md § API Endpoints, "Docs" — both public, no auth. Unlike
// every other file in server/, this doesn't export a mountable router:
// `OpenAPIHono.doc()` reads `this.openAPIRegistry`, which only has every
// other route file's definitions merged into it *after* they're mounted onto
// the same top-level app instance (api/index.ts's `OpenAPIHono.route()` calls
// — see @hono/zod-openapi's own `route()` override, which merges a mounted
// sub-router's registry into the parent's). So this exports a function that
// mounts directly onto that already-assembled top-level app, not a sub-router
// of its own.

import { swaggerUI } from '@hono/swagger-ui';
import type { OpenAPIHono } from '@hono/zod-openapi';

export function mountDocs(app: OpenAPIHono): void {
  app.doc('/v1/openapi.json', {
    openapi: '3.0.0',
    info: { title: 'ad-server API', version: '1.0.0' },
  });

  app.get('/docs', swaggerUI({ url: '/v1/openapi.json' }));
}
