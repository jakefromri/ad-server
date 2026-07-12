// Shared plumbing for the 04i docs.ts conversion (architecture.md § API
// Endpoints, "docs.ts" / OpenAPI). Every route file's `Hono` router becomes
// an `OpenAPIHono` router built via `newRouter()` below, so a single
// `defaultHook` normalizes every route's validation-failure response to this
// codebase's existing shape (`{ error, code: ErrorCode.VALIDATION_ERROR }`,
// 400) instead of @hono/zod-openapi's own default hook format — this is a
// docs/validation-plumbing refactor, not a wire-format change, so every
// existing test (04h's suite) must keep seeing the same error bodies it
// already asserts on.

import { OpenAPIHono, createRoute, z, type Hook } from '@hono/zod-openapi';
import { ErrorCode } from '../types';

export { z, createRoute };

// Every route handler across server/*.ts is typed `(c: RouteContext) => ...`
// rather than relying on @hono/zod-openapi's per-route generic Context type —
// see the comment above each file's first `router.openapi()` call for why
// (the library's typed-response system doesn't hold up across handlers with
// several differently-shaped success/error branches). One disable comment
// here, instead of `@typescript-eslint/no-explicit-any` firing at every one
// of the ~20 handler signatures that would otherwise write the literal `any`
// keyword directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RouteContext = any;

const validationHook: Hook<unknown, RouteContext, RouteContext, RouteContext> = (result, c) => {
  if (!result.success) {
    const message = result.error.issues[0]?.message ?? 'Invalid request';
    return c.json({ error: message, code: ErrorCode.VALIDATION_ERROR }, 400);
  }
};

export function newRouter(): OpenAPIHono {
  return new OpenAPIHono({ defaultHook: validationHook });
}

// Generic error-response shape reused across every route's non-2xx
// `responses` entries — the actual body varies by error code, but the OpenAPI
// spec only needs the shared shape documented once.
export const errorResponseSchema = z
  .object({
    error: z.string(),
    code: z.string().optional(),
  })
  .openapi('ErrorResponse');

export function errorResponses(...statuses: number[]) {
  const descriptions: Record<number, string> = {
    400: 'Validation error',
    401: 'Missing or invalid credentials',
    403: 'Insufficient permissions',
    404: 'Not found',
    409: 'Conflict',
    429: 'Rate/quota limit exceeded',
  };
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      { description: descriptions[status] ?? 'Error', content: { 'application/json': { schema: errorResponseSchema } } },
    ])
  );
}
