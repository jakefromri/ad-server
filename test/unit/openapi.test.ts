// OPENAPI-UNIT-01 — test-plan.md § Unit Tests. 04j (re-scope of 04i's
// reverted docs.ts — see build-report.md's 04i section).

import { describe, it, expect } from 'vitest';
import { app } from '../../api/index';
import spec from '../../server/openapi.generated.json';

describe('OPENAPI-UNIT-01: generated spec covers every route', () => {
  it('every route Hono actually registers has a corresponding path+method in the generated spec', () => {
    const registered = app.routes
      .filter((r) => r.method !== 'ALL' && !r.path.includes('*'))
      .map((r) => ({ method: r.method.toLowerCase(), path: r.path.replace(/:([a-zA-Z_]+)/g, '{$1}') }));

    expect(registered.length).toBeGreaterThan(0);

    const missing = registered.filter(({ method, path }) => {
      const pathItem = (spec.paths as Record<string, Record<string, unknown>>)[path];
      return !pathItem || !(method in pathItem);
    });

    expect(missing).toEqual([]);
  });
});
