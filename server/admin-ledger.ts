// GET /api/admin/ledger. Mounted at /api/admin/ledger behind
// humanAuthMiddleware + requireRole('superadmin'). architecture.md § API
// Endpoints — paginated cross-tenant fulfillment ledger (this table is
// unbounded), filterable by tenant/status, for superadmin debugging/support
// per scope.md's "View the full ledger across all tenants" capability.
//
// Cursor is opaque: base64 of `${requested_at}|${id}` for the last row of the
// current page. Ordered by requested_at desc, id desc (tie-break for rows
// with an identical timestamp) so the cursor is stable under concurrent
// inserts between pages.

import { ErrorCode } from '../types';
import { supabaseAdmin } from './supabase';
import { humanAuthMiddleware, requireRole } from './human-auth';
import { newRouter, createRoute, z, errorResponses, type RouteContext } from './openapi';

const router = newRouter();
router.use('*', humanAuthMiddleware, requireRole('superadmin'));

const VALID_STATUSES = ['reserved', 'confirmed', 'expired', 'failed'] as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// btoa/atob (Web-standard, Edge-safe), not Buffer — api/index.ts runs on
// Vercel Edge runtime, which has no Node.js globals (same constraint as
// hash.ts's crypto.subtle-over-Node-crypto rule). requested_at/id are both
// plain ASCII, so no UTF-8 multibyte concern here.
function encodeCursor(requestedAt: string, id: string): string {
  return btoa(`${requestedAt}|${id}`);
}

function decodeCursor(cursor: string): { requestedAt: string; id: string } | null {
  try {
    const decoded = atob(cursor);
    const [requestedAt, id] = decoded.split('|');
    if (!requestedAt || !id) return null;
    return { requestedAt, id };
  } catch {
    return null;
  }
}

const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Admin — Ledger'],
  summary: 'Cross-tenant fulfillment ledger (paginated)',
  request: {
    query: z.object({
      tenant_id: z.string().optional(),
      status: z.enum(VALID_STATUSES).optional(),
      cursor: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Ledger page',
      content: {
        'application/json': { schema: z.object({ fulfillments: z.array(z.record(z.unknown())), next_cursor: z.string().nullable() }) },
      },
    },
    ...errorResponses(400, 401, 403),
  },
});

router.openapi(listRoute, async (c: RouteContext) => {
  const { tenant_id: tenantId, status, cursor, limit: limitParam } = c.req.valid('query');

  let limit = DEFAULT_LIMIT;
  if (limitParam) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return c.json({ error: 'limit must be a positive integer', code: ErrorCode.VALIDATION_ERROR }, 400);
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  let query = supabaseAdmin
    .from('fulfillments')
    .select('*')
    .order('requested_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);

  if (tenantId) query = query.eq('tenant_id', tenantId);
  if (status) query = query.eq('status', status);

  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) {
      return c.json({ error: 'Invalid cursor', code: ErrorCode.VALIDATION_ERROR }, 400);
    }
    // Keep rows strictly after the cursor position in the same (requested_at
    // desc, id desc) order: earlier requested_at, or equal requested_at with
    // a smaller id.
    query = query.or(
      `requested_at.lt.${decoded.requestedAt},and(requested_at.eq.${decoded.requestedAt},id.lt.${decoded.id})`
    );
  }

  const { data, error } = await query;
  if (error) return c.json({ error: error.message, code: ErrorCode.VALIDATION_ERROR }, 400);

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.requested_at, last.id) : null;

  return c.json({ fulfillments: page, next_cursor: nextCursor });
});

export default router;
