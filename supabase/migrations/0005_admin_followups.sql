-- ad-server — 04i admin follow-up scope
--
-- fulfillment_attempts: attempt-level log backing GET /api/admin/system-health.
-- fulfillments only gets a row on a successful reservation, so
-- request_rate_per_min/error_rate/no_eligible_campaign_rate can't be computed
-- from it alone — a `200 { fulfilled: false }` or a `429`/`401` leaves no
-- trace anywhere today. tenant_id/screen_id are nullable because an
-- auth_error (bad/revoked device key) never resolves either. Written async
-- via c.executionCtx.waitUntil(...) from POST /v1/fulfillments, off the
-- response's critical path — see architecture.md's Data Model section for
-- the full write-path rationale and its accepted at-least-once-ish (really
-- best-effort) delivery limitation. Internal ops signal only, never read by
-- reconciliation/quota/billing.
create table fulfillment_attempts (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid references tenants(id) on delete cascade,
  screen_id  uuid references screens(id) on delete cascade,
  outcome    text not null check (outcome in ('fulfilled', 'no_eligible_campaigns', 'quota_exceeded', 'auth_error', 'server_error')),
  created_at timestamptz not null default now()
);

alter table fulfillment_attempts enable row level security;

-- superadmin_all only — internal ops signal, not tenant-facing data (unlike
-- fulfillments/fulfillment_quota_usage, which tenants can read their own
-- rows of).
create policy superadmin_all on fulfillment_attempts
  using (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin')
  with check (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin');

-- system-health's windowed queries range-scan this on created_at only —
-- tenant_id/screen_id are never filtered on for that endpoint.
create index fulfillment_attempts_created_at_idx on fulfillment_attempts (created_at);

-- GET /v1/tenant/usage/by-screen: composite covers the grouped-and-windowed
-- query directly instead of falling back to a full tenant-scoped scan via
-- the existing single-column fulfillments_tenant_id_idx.
create index fulfillments_tenant_screen_requested_idx on fulfillments (tenant_id, screen_id, requested_at);
