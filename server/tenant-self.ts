// GET /v1/tenant/api-key, POST /v1/tenant/api-key/rotate, GET /v1/tenant/usage,
// GET /v1/tenant/usage/by-screen, GET /v1/tenant/play-log, GET
// /v1/tenant/play-log/export. Mounted at /v1/tenant behind
// tenantAccessMiddleware (JWT-or-tenant-key).

import { Hono } from 'hono';
import { ErrorCode } from '../types';
import { supabaseAdmin } from './supabase';
import { generateApiKey, hashApiKey } from './hash';
import { tenantAccessMiddleware } from './tenant-access';
import { getQuotaUsage } from './quota';
import { encodeCursor, decodeCursor } from './cursor';

const router = new Hono();
router.use('*', tenantAccessMiddleware);

router.get('/api-key', async (c) => {
  const auth = c.get('auth');
  const { data, error } = await supabaseAdmin
    .from('tenant_api_keys')
    .select('key_prefix, status')
    .eq('tenant_id', auth.tenant_id)
    .single();

  if (error || !data) {
    return c.json({ error: 'No API key found', code: ErrorCode.NOT_FOUND }, 404);
  }

  return c.json(data);
});

router.post('/api-key/rotate', async (c) => {
  const auth = c.get('auth');
  const { plaintextKey, keyPrefix } = generateApiKey('tenant');
  const keyHash = await hashApiKey(plaintextKey);

  // Single row per tenant (PK = tenant_id) — an in-place overwrite is enough,
  // no revoke-then-insert history needed like device_api_keys
  // (architecture.md: "old plaintext key stops working immediately, no grace
  // period in MVP").
  const { error } = await supabaseAdmin
    .from('tenant_api_keys')
    .update({ key_hash: keyHash, key_prefix: keyPrefix, status: 'active', rotated_at: new Date().toISOString() })
    .eq('tenant_id', auth.tenant_id);

  if (error) {
    return c.json({ error: 'Failed to rotate API key', code: ErrorCode.VALIDATION_ERROR }, 400);
  }

  return c.json({ api_key: plaintextKey });
});

router.get('/usage', async (c) => {
  const auth = c.get('auth');
  const usage = await getQuotaUsage(auth.tenant_id as string);
  return c.json(usage);
});

// GET /v1/tenant/usage/by-screen (04i, follow-up scoping session) —
// scope.md's "broken down per screen/device — not just the tenant-wide
// aggregate", tied to the device-key-compromise blast-radius concern. Reads
// straight from fulfillments (windowed, not all-time — that table is
// unbounded); no new table needed, `fulfillments_tenant_screen_requested_idx`
// (migration 0005) covers this grouped-and-windowed query.
router.get('/usage/by-screen', async (c) => {
  const auth = c.get('auth');
  const windowHoursParam = c.req.query('window_hours');

  let windowHours = 24;
  if (windowHoursParam !== undefined) {
    const parsed = Number(windowHoursParam);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return c.json({ error: 'window_hours must be a positive number', code: ErrorCode.VALIDATION_ERROR }, 400);
    }
    windowHours = parsed;
  }

  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  // supabase-js has no GROUP BY primitive — fetch the (bounded-by-window)
  // screen_id column and aggregate in JS, same pattern admin-tenants.ts's
  // GET '/' already uses for campaign/screen counts per tenant.
  const { data: rows, error } = await supabaseAdmin
    .from('fulfillments')
    .select('screen_id')
    .eq('tenant_id', auth.tenant_id)
    .gte('requested_at', windowStart);

  if (error) return c.json({ error: error.message, code: ErrorCode.VALIDATION_ERROR }, 400);

  const countsByScreen = new Map<string, number>();
  for (const row of rows ?? []) {
    countsByScreen.set(row.screen_id, (countsByScreen.get(row.screen_id) ?? 0) + 1);
  }

  const screenIds = [...countsByScreen.keys()];
  const labelsByScreen = new Map<string, string>();
  if (screenIds.length > 0) {
    const { data: screenRows } = await supabaseAdmin.from('screens').select('id, label').in('id', screenIds);
    for (const s of screenRows ?? []) labelsByScreen.set(s.id, s.label);
  }

  const screens = screenIds.map((screenId) => ({
    screen_id: screenId,
    label: labelsByScreen.get(screenId) ?? 'Unknown screen',
    count: countsByScreen.get(screenId) as number,
  }));

  return c.json({ window_hours: windowHours, screens });
});

// ─── Play log ────────────────────────────────────────────────────────────
// Tenant-facing view of the same `fulfillments` ledger admin-ledger.ts
// exposes cross-tenant to superadmins — scoped to auth.tenant_id, and joined
// with campaign name / screen label (via PostgREST embedding over the real
// FKs) so the dashboard never has to resolve raw ids itself. media_ref is
// shown as plain text, not a rendered thumbnail — creative_media_path is
// currently a free-text string (no upload flow or storage bucket backs it
// yet), per Jake's call when scoping this feature.

const PLAY_LOG_SELECT =
  'id, campaign_id, screen_id, media_ref, status, requested_at, report_outcome, played_duration_ms, campaigns(name), screens(label)';

interface PlayLogRow {
  id: string;
  campaign_id: string;
  screen_id: string;
  media_ref: string;
  status: string;
  requested_at: string;
  report_outcome: string | null;
  played_duration_ms: number | null;
  campaigns: { name: string } | null;
  screens: { label: string } | null;
}

function flattenPlayLogRow(row: PlayLogRow) {
  return {
    id: row.id,
    requested_at: row.requested_at,
    status: row.status,
    report_outcome: row.report_outcome,
    played_duration_ms: row.played_duration_ms,
    media_ref: row.media_ref,
    campaign_id: row.campaign_id,
    campaign_name: row.campaigns?.name ?? 'Unknown campaign',
    screen_id: row.screen_id,
    screen_label: row.screens?.label ?? 'Unknown screen',
  };
}

const PLAY_LOG_DEFAULT_LIMIT = 50;
const PLAY_LOG_MAX_LIMIT = 200;

// GET /v1/tenant/play-log — cursor-paginated, same keyset pattern as
// admin-ledger.ts (order by requested_at desc, id desc; opaque
// base64 cursor over the last row of the page).
router.get('/play-log', async (c) => {
  const auth = c.get('auth');
  const cursor = c.req.query('cursor');
  const limitParam = c.req.query('limit');

  let limit = PLAY_LOG_DEFAULT_LIMIT;
  if (limitParam) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return c.json({ error: 'limit must be a positive integer', code: ErrorCode.VALIDATION_ERROR }, 400);
    }
    limit = Math.min(parsed, PLAY_LOG_MAX_LIMIT);
  }

  let query = supabaseAdmin
    .from('fulfillments')
    .select(PLAY_LOG_SELECT)
    .eq('tenant_id', auth.tenant_id)
    .order('requested_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) {
      return c.json({ error: 'Invalid cursor', code: ErrorCode.VALIDATION_ERROR }, 400);
    }
    query = query.or(`requested_at.lt.${decoded.primary},and(requested_at.eq.${decoded.primary},id.lt.${decoded.id})`);
  }

  const { data, error } = await query;
  if (error) return c.json({ error: error.message, code: ErrorCode.VALIDATION_ERROR }, 400);

  const rows = (data ?? []) as unknown as PlayLogRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.requested_at, last.id) : null;

  return c.json({ entries: page.map(flattenPlayLogRow), next_cursor: nextCursor });
});

const EXPORT_WINDOW_DAYS: Record<string, number> = { day: 1, week: 7, month: 30 };
const EXPORT_PAGE_SIZE = 500;
// Hard safety cap on a single CSV export — this table is unbounded and a
// tenant could in principle ask for a month of a very high-volume network.
// 50k rows is generous for a personal-scale tenant and keeps a single Edge
// invocation's response time/memory bounded.
const EXPORT_MAX_ROWS = 50_000;

function csvEscape(value: string): string {
  if (/["\n,]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// GET /v1/tenant/play-log/export?window=day|week|month — CSV download for
// the tenant dashboard's play-log page. Loops keyset-paginated fetches
// server-side (ascending this time, oldest-first, for a naturally
// chronological CSV) rather than a single unpaginated `.select()` — see
// this workspace's standing "don't query a growing Supabase table without
// pagination" rule; PostgREST silently caps an unpaginated response at
// ~1000 rows.
router.get('/play-log/export', async (c) => {
  const auth = c.get('auth');
  const windowParam = c.req.query('window') ?? 'day';
  const days = EXPORT_WINDOW_DAYS[windowParam];
  if (!days) {
    return c.json(
      { error: `window must be one of ${Object.keys(EXPORT_WINDOW_DAYS).join(', ')}`, code: ErrorCode.VALIDATION_ERROR },
      400
    );
  }

  const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows: PlayLogRow[] = [];
  let after: { requestedAt: string; id: string } | null = null;

  while (rows.length < EXPORT_MAX_ROWS) {
    let query = supabaseAdmin
      .from('fulfillments')
      .select(PLAY_LOG_SELECT)
      .eq('tenant_id', auth.tenant_id)
      .gte('requested_at', windowStart)
      .order('requested_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(EXPORT_PAGE_SIZE);

    if (after) {
      query = query.or(`requested_at.gt.${after.requestedAt},and(requested_at.eq.${after.requestedAt},id.gt.${after.id})`);
    }

    const { data, error } = await query;
    if (error) return c.json({ error: error.message, code: ErrorCode.VALIDATION_ERROR }, 400);

    const page = (data ?? []) as unknown as PlayLogRow[];
    if (page.length === 0) break;

    rows.push(...page);
    const last = page[page.length - 1];
    after = { requestedAt: last.requested_at, id: last.id };

    if (page.length < EXPORT_PAGE_SIZE) break;
  }

  const header = ['requested_at', 'campaign', 'screen', 'status', 'report_outcome', 'played_duration_ms', 'media_ref'];
  const lines = [header.join(',')];
  for (const row of rows) {
    const flat = flattenPlayLogRow(row);
    lines.push(
      [
        flat.requested_at,
        csvEscape(flat.campaign_name),
        csvEscape(flat.screen_label),
        flat.status,
        flat.report_outcome ?? '',
        flat.played_duration_ms ?? '',
        csvEscape(flat.media_ref),
      ].join(',')
    );
  }

  const filename = `play-log-${windowParam}-${new Date().toISOString().slice(0, 10)}.csv`;
  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  return c.body(lines.join('\n'));
});

export default router;
