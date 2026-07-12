// Shared fixtures for integration/e2e specs. Hits the real dev Supabase DB
// (CLAUDE.md: "integration tests must hit a real database, not mocks") via
// the same `app` export api/index.ts hands to Vercel — `app.request()` is
// Hono's own in-process test entrypoint, no live HTTP server needed (see
// api/local-server.ts's header comment: the app is runtime-agnostic).
//
// Every fixture-creating helper returns cleanup handles; call
// `cleanupAll()` in the spec's `afterAll`/`afterEach`. Deleting a `tenants`
// row cascades to every child table (campaigns, screens, device_api_keys,
// fulfillments, tenant_api_keys, invites, memberships — all
// `on delete cascade` per 0001_initial_schema.sql), so tenant cleanup alone
// is enough for DB rows; Supabase Auth users are a separate schema and need
// an explicit `auth.admin.deleteUser` call.

import { randomUUID } from 'node:crypto';
import { app } from '../api/index';
import { supabaseAdmin, supabaseAuth } from '../server/supabase';

export { app, supabaseAdmin };

export async function apiRequest(path: string, init?: RequestInit & { token?: string }): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.token) headers.set('Authorization', `Bearer ${init.token}`);
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return app.request(path, { ...init, headers });
}

export async function jsonRequest(path: string, init?: RequestInit & { token?: string; json?: unknown }): Promise<{ status: number; body: any }> {
  const { json, ...rest } = init ?? {};
  const res = await apiRequest(path, { ...rest, body: json !== undefined ? JSON.stringify(json) : rest.body });
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const cleanupTenantIds = new Set<string>();
const cleanupUserIds = new Set<string>();

export function trackTenant(tenantId: string) {
  cleanupTenantIds.add(tenantId);
}

export function trackUser(userId: string) {
  cleanupUserIds.add(userId);
}

export async function cleanupAll(): Promise<void> {
  for (const tenantId of cleanupTenantIds) {
    await supabaseAdmin.from('tenants').delete().eq('id', tenantId);
  }
  cleanupTenantIds.clear();
  for (const userId of cleanupUserIds) {
    await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => {});
  }
  cleanupUserIds.clear();
}

interface HumanSession {
  userId: string;
  token: string;
}

/** Creates a real Supabase Auth user (app_metadata set directly, same shape
 * invites.ts's accept handler produces) and signs in for a usable JWT —
 * skips the invite-email round trip for tests that only need a working
 * session, not invite-flow coverage itself (that's AUTH-INT-04/05/06,
 * which drive POST /api/invites/accept directly). */
async function createHumanSession(role: 'superadmin' | 'tenant_admin', tenantId: string | null): Promise<HumanSession> {
  const email = `test-${role}-${randomUUID()}@example.com`;
  const password = `Test-${randomUUID()}-Pw!`;

  const created = await withRateLimitRetry(() =>
    supabaseAdmin.auth.admin.createUser({ email, password, app_metadata: { role, tenant_id: tenantId }, email_confirm: true })
  );
  if (created.error || !created.data.user) throw new Error(`Failed to create ${role} test user: ${created.error?.message}`);
  trackUser(created.data.user.id);

  const session = await withRateLimitRetry(() => supabaseAuth.auth.signInWithPassword({ email, password }));
  if (session.error || !session.data.session) throw new Error(`Failed to sign in ${role} test user: ${session.error?.message}`);

  return { userId: created.data.user.id, token: session.data.session.access_token };
}

/** Supabase's GoTrue rate limit on auth endpoints (createUser, sign-in) is
 * per-IP — a test suite that mints a fresh human session per tenant fixture
 * can burst past it even with sequential file execution. Retries with
 * exponential backoff on a rate-limit response rather than failing the
 * whole spec; any other error passes through immediately. */
async function withRateLimitRetry<T extends { error: { message: string } | null }>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  let lastResult: T;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = await fn();
    const message = lastResult.error?.message ?? '';
    if (!lastResult.error || !/rate limit/i.test(message)) return lastResult;
    if (attempt < maxAttempts) await sleep(attempt * 1500);
  }
  return lastResult!;
}

export async function createSuperadminSession(): Promise<HumanSession> {
  return createHumanSession('superadmin', null);
}

/** Signs in an already-existing Supabase Auth user (e.g. one just created
 * via POST /api/invites/accept) rather than creating a new one — for specs
 * that need a session for a user the invite flow itself produced. */
export async function createHumanSessionForTest(email: string, password: string): Promise<HumanSession> {
  const { data: session, error } = await withRateLimitRetry(() => supabaseAuth.auth.signInWithPassword({ email, password }));
  if (error || !session.session) throw new Error(`Failed to sign in ${email}: ${error?.message}`);
  trackUser(session.session.user.id);
  return { userId: session.session.user.id, token: session.session.access_token };
}

interface TenantOnboarding {
  tenantId: string;
  tenantApiKey: string;
  inviteToken: string;
  inviteExpiresAt: string;
  inviteEmail: string;
  superadmin: HumanSession;
  raw: any;
}

/** Creates a tenant via the real superadmin endpoint (POST
 * /api/admin/tenants — exercises the same atomic tenant+key+invite path
 * production uses) and returns the raw onboarding artifacts, including the
 * invite token (parsed out of invite_url), for specs that drive the invite
 * flow itself (AUTH-INT-04/05/06, ONBOARD-INT-01/02). */
export async function createTenantViaSuperadmin(overrides?: {
  fulfillment_quota?: number;
  name?: string;
  admin_email?: string;
}): Promise<TenantOnboarding> {
  const superadmin = await createSuperadminSession();
  const adminEmail = overrides?.admin_email ?? `admin-${randomUUID()}@example.com`;
  const { status, body } = await jsonRequest('/api/admin/tenants', {
    method: 'POST',
    token: superadmin.token,
    json: {
      name: overrides?.name ?? `Test Tenant ${randomUUID()}`,
      fulfillment_quota: overrides?.fulfillment_quota ?? 1000,
      admin_email: adminEmail,
    },
  });
  if (status !== 201) throw new Error(`Failed to create test tenant: ${status} ${JSON.stringify(body)}`);

  const tenantId: string = body.tenant.id;
  trackTenant(tenantId);

  const inviteToken = new URL(body.invite.invite_url).searchParams.get('token');
  if (!inviteToken) throw new Error(`Could not parse invite token from ${body.invite.invite_url}`);

  return {
    tenantId,
    tenantApiKey: body.api_key,
    inviteToken,
    inviteExpiresAt: body.invite.expires_at,
    inviteEmail: adminEmail,
    superadmin,
    raw: body,
  };
}

interface TenantFixture {
  tenantId: string;
  tenantAdmin: HumanSession;
  tenantApiKey: string;
  superadmin: HumanSession;
}

/** Full tenant fixture: onboards via createTenantViaSuperadmin, then
 * attaches a working tenant_admin session directly (bypassing
 * invite-accept, see createHumanSession's note) for specs that just need a
 * usable tenant_admin session, not invite-flow coverage itself. */
export async function createTenantFixture(overrides?: { fulfillment_quota?: number; name?: string }): Promise<TenantFixture> {
  const onboarding = await createTenantViaSuperadmin(overrides);

  const tenantAdmin = await createHumanSession('tenant_admin', onboarding.tenantId);
  await supabaseAdmin.from('memberships').insert({ tenant_id: onboarding.tenantId, user_id: tenantAdmin.userId, role: 'tenant_admin' });

  return { tenantId: onboarding.tenantId, tenantAdmin, tenantApiKey: onboarding.tenantApiKey, superadmin: onboarding.superadmin };
}

interface CampaignOverrides {
  name?: string;
  creative_media_path?: string;
  obligation_type?: 'impression_count' | 'share_of_voice';
  obligation_target?: number;
  priority_weight?: number;
  flight_start?: string;
  flight_end?: string;
  status?: 'draft' | 'active' | 'paused' | 'archived';
  targeting?: Record<string, unknown>;
}

export function isoOffset(minutes: number, from = new Date()): string {
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}

export async function createCampaign(auth: { token: string }, overrides: CampaignOverrides = {}): Promise<{ status: number; body: any }> {
  return jsonRequest('/v1/campaigns', {
    method: 'POST',
    token: auth.token,
    json: {
      name: overrides.name ?? `Test Campaign ${randomUUID()}`,
      creative_media_path: overrides.creative_media_path ?? 'https://example.com/creative.mp4',
      obligation_type: overrides.obligation_type ?? 'impression_count',
      obligation_target: overrides.obligation_target ?? 100,
      priority_weight: overrides.priority_weight,
      flight_start: overrides.flight_start ?? isoOffset(-60),
      flight_end: overrides.flight_end ?? isoOffset(60 * 24),
      status: overrides.status ?? 'active',
      targeting: overrides.targeting ?? { geo: { type: 'all' } },
    },
  });
}

interface ScreenOverrides {
  label?: string;
  state?: string | null;
  zip?: string | null;
  aspect_ratio?: string;
  resolution?: string;
  orientation?: 'landscape' | 'portrait';
  is_simulated?: boolean;
}

export async function registerScreen(auth: { token: string }, overrides: ScreenOverrides = {}): Promise<{ status: number; body: any }> {
  return jsonRequest('/v1/screens', {
    method: 'POST',
    token: auth.token,
    json: {
      label: overrides.label ?? `Test Screen ${randomUUID()}`,
      state: overrides.state,
      zip: overrides.zip,
      aspect_ratio: overrides.aspect_ratio ?? '16:9',
      resolution: overrides.resolution ?? '1920x1080',
      orientation: overrides.orientation ?? 'landscape',
      is_simulated: overrides.is_simulated,
    },
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` until it returns truthy or `timeoutMs` elapses — used for
 * assertions against state written asynchronously (e.g. the 5s campaign
 * cache TTL) rather than a fixed sleep that's either flaky or wastefully
 * long. */
export async function waitUntil<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 8000, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await sleep(intervalMs);
  }
}
