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

import { Hono } from 'hono';
import { ErrorCode } from '../types';
import { supabaseAdmin } from './supabase';
import { humanAuthMiddleware, requireRole } from './human-auth';
import { encodeCursor, decodeCursor } from './cursor';

const router = new Hono();
router.use('*', humanAuthMiddleware, requireRole('superadmin'));

const VALID_STATUSES = ['reserved', 'confirmed', 'expired', 'failed'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

router.get('/', async (c) => {
  const tenantId = c.req.query('tenant_id');
  const status = c.req.query('status');
  const cursor = c.req.query('cursor');
  const limitParam = c.req.query('limit');

  if (status && !VALID_STATUSES.includes(status)) {
    return c.json({ error: `status must be one of ${VALID_STATUSES.join(', ')}`, code: ErrorCode.VALIDATION_ERROR }, 400);
  }

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
    query = query.or(`requested_at.lt.${decoded.primary},and(requested_at.eq.${decoded.primary},id.lt.${decoded.id})`);
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
