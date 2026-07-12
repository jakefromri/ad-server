// OPENAPI-UNIT-01. test-plan.md § Unit Tests. Static check — no DB fixtures.

import { describe, it, expect } from 'vitest';
import { app } from '../../api/index';

// /api/cron/expire-reservations is CRON_SECRET-gated, internal-only
// (architecture.md § Expiry mechanics) — not part of the public API surface
// docs.ts documents, same as /api/health.
const NOT_DOCUMENTED = new Set(['/api/health', '/api/cron/expire-reservations', '/docs', '/v1/openapi.json']);
const API_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);

describe('OPENAPI-UNIT-01: generated spec covers every route', () => {
  it('every route registered on the Hono app appears in GET /v1/openapi.json', async () => {
    const res = await app.request('/v1/openapi.json');
    expect(res.status).toBe(200);
    const spec = await res.json();
    const specPaths = new Set(Object.keys(spec.paths));
    expect(specPaths.size).toBeGreaterThan(0);

    // app.routes includes duplicate entries (validation + handler) and
    // `ALL /*`/`ALL /prefix/*` wildcard entries from middleware `.use()`
    // registration — only real API_METHODS routes with a concrete path (no
    // trailing `/*`) are the ones a route file's `createRoute` should
    // actually document.
    const registeredApiPaths = new Set(
      app.routes
        .filter((r) => API_METHODS.has(r.method) && !r.path.endsWith('/*'))
        .map((r) => r.path)
        .filter((path) => !NOT_DOCUMENTED.has(path))
        .map((path) => path.replace(/:([^/]+)/g, '{$1}'))
    );

    const missing = [...registeredApiPaths].filter((path) => !specPaths.has(path));
    expect(missing).toEqual([]);
  });
});
