-- 0001_initial_schema.sql
-- ad-server — foundation schema (Agent 04a)
-- Data model per architecture.md "Data Model" section.

create extension if not exists "pgcrypto";

-- ─── Tenants ─────────────────────────────────────────────────────────────────

create table tenants (
  id                            uuid primary key default gen_random_uuid(),
  name                          text not null,
  status                        text not null default 'active' check (status in ('active', 'deactivated')),
  fulfillment_quota             bigint not null default 0,
  reservation_timeout_seconds   int not null default 300,
  created_at                    timestamptz not null default now()
);

alter table tenants enable row level security;

create policy superadmin_all on tenants
  using (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin')
  with check (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin');

-- Read only — no client writes, mutations go through the API service role.
create policy tenant_members_read_own on tenants
  for select using (
    id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
    and auth.jwt() -> 'app_metadata' ->> 'role' = 'tenant_admin'
  );

-- ─── Memberships ─────────────────────────────────────────────────────────────

create table memberships (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null check (role = 'tenant_admin'),
  created_at  timestamptz not null default now(),
  unique (tenant_id, user_id)
);

alter table memberships enable row level security;

create policy user_read_own on memberships
  for select using (user_id = auth.uid());

create policy superadmin_all on memberships
  using (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin')
  with check (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin');

-- ─── Invites ─────────────────────────────────────────────────────────────────

create table invites (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  email        text not null,
  role         text not null default 'tenant_admin' check (role = 'tenant_admin'),
  token        text not null unique,
  expires_at   timestamptz not null default (now() + interval '72 hours'),
  accepted_at  timestamptz,
  created_by   uuid not null references auth.users(id),
  created_at   timestamptz not null default now()
);

alter table invites enable row level security;

-- No client reads — all access via API service role (unauthenticated lookup by token only).
create policy superadmin_all on invites
  using (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin')
  with check (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin');

-- ─── Tenant API keys ───────────────────────────────────────────────────────────
-- Authenticates programmatic management access (held by tenant_admin). Distinct
-- from device_api_keys, which authenticate screens.

create table tenant_api_keys (
  tenant_id   uuid primary key references tenants(id) on delete cascade,
  key_hash    text not null,
  key_prefix  text not null,
  status      text not null default 'active' check (status in ('active', 'revoked')),
  created_at  timestamptz not null default now(),
  rotated_at  timestamptz
);

alter table tenant_api_keys enable row level security;

-- Superadmin only — no tenant-scoped client read. Dashboard's "your API key" view
-- is served by an API endpoint returning key_prefix + status, never key_hash.
create policy superadmin_all on tenant_api_keys
  using (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin')
  with check (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin');

create index tenant_api_keys_key_hash_idx on tenant_api_keys (key_hash);

-- ─── Campaigns ─────────────────────────────────────────────────────────────────

create table campaigns (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  name                  text not null,
  creative_media_path   text not null,
  obligation_type       text not null check (obligation_type in ('impression_count', 'share_of_voice')),
  obligation_target     numeric not null,
  priority_weight       numeric not null default 1.0,
  flight_start          timestamptz not null,
  flight_end            timestamptz not null,
  status                text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  targeting             jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (flight_end > flight_start)
);

alter table campaigns enable row level security;

create policy superadmin_all on campaigns
  using (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin')
  with check (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin');

-- Read only — obligation_type/obligation_target pairing validation lives in the
-- API, not the DB. Writes: API service role only.
create policy tenant_members_read_own on campaigns
  for select using (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
    and auth.jwt() -> 'app_metadata' ->> 'role' = 'tenant_admin'
  );

create index campaigns_tenant_id_idx on campaigns (tenant_id);
create index campaigns_tenant_status_idx on campaigns (tenant_id, status);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger campaigns_set_updated_at
  before update on campaigns
  for each row execute function set_updated_at();

-- ─── Screens ───────────────────────────────────────────────────────────────────

create table screens (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  label          text not null,
  state          text,
  zip            text,
  aspect_ratio   text not null,
  resolution     text not null,
  orientation    text not null check (orientation in ('landscape', 'portrait')),
  status         text not null default 'active' check (status in ('active', 'inactive')),
  is_simulated   boolean not null default false,
  created_at     timestamptz not null default now()
);

alter table screens enable row level security;

create policy superadmin_all on screens
  using (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin')
  with check (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin');

create policy tenant_members_read_own on screens
  for select using (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
    and auth.jwt() -> 'app_metadata' ->> 'role' = 'tenant_admin'
  );

create index screens_tenant_id_idx on screens (tenant_id);

-- ─── Device API keys ───────────────────────────────────────────────────────────
-- Screen auth. Multiple rows per screen over time (rotation history); only one
-- 'active' row per screen enforced at the application layer.

create table device_api_keys (
  id           uuid primary key default gen_random_uuid(),
  screen_id    uuid not null references screens(id) on delete cascade,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  key_hash     text not null,
  key_prefix   text not null,
  status       text not null default 'active' check (status in ('active', 'revoked')),
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz
);

alter table device_api_keys enable row level security;

-- Superadmin only — same reasoning as tenant_api_keys. Dashboard's screen list
-- shows key status + key_prefix via an API endpoint, never a direct table read.
create policy superadmin_all on device_api_keys
  using (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin')
  with check (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin');

create index device_api_keys_key_hash_idx on device_api_keys (key_hash);
create index device_api_keys_screen_id_idx on device_api_keys (screen_id);

-- ─── Fulfillments (the ledger) ─────────────────────────────────────────────────
-- Append-only in spirit: inserted at reservation, updated exactly once (report
-- call or expiry sweep). No row is ever deleted.

create table fulfillments (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references tenants(id) on delete cascade,
  campaign_id            uuid not null references campaigns(id) on delete cascade,
  screen_id              uuid not null references screens(id) on delete cascade,
  media_ref              text not null,
  status                 text not null default 'reserved' check (status in ('reserved', 'confirmed', 'expired', 'failed')),
  requested_at           timestamptz not null default now(),
  reserved_expires_at    timestamptz not null,
  reported_at            timestamptz,
  report_outcome         text check (report_outcome in ('played', 'skipped', 'failed')),
  played_duration_ms     int
);

alter table fulfillments enable row level security;

create policy superadmin_all on fulfillments
  using (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin')
  with check (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin');

-- SELECT only — defense-in-depth. The dashboard pacing view is served through
-- the API (paginated, aggregated), not a raw client scan of this table.
create policy tenant_members_read_own on fulfillments
  for select using (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
    and auth.jwt() -> 'app_metadata' ->> 'role' = 'tenant_admin'
  );

-- Reconciliation reads by (campaign_id, status); expiry-sweep cron reads by
-- (status, reserved_expires_at); report ownership checks read by screen_id.
create index fulfillments_campaign_status_idx on fulfillments (campaign_id, status);
create index fulfillments_tenant_id_idx on fulfillments (tenant_id);
create index fulfillments_screen_id_idx on fulfillments (screen_id);
create index fulfillments_status_expires_idx on fulfillments (status, reserved_expires_at);

-- ─── Fulfillment quota usage ───────────────────────────────────────────────────
-- Materialized counter, not COUNT(*) FROM fulfillments — checked on every
-- fulfillment request and must not scan a growing ledger table each time.

create table fulfillment_quota_usage (
  tenant_id    uuid primary key references tenants(id) on delete cascade,
  used_count   bigint not null default 0,
  updated_at   timestamptz not null default now()
);

alter table fulfillment_quota_usage enable row level security;

create policy superadmin_all on fulfillment_quota_usage
  using (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin')
  with check (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin');

create policy tenant_members_read_own on fulfillment_quota_usage
  for select using (
    tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
    and auth.jwt() -> 'app_metadata' ->> 'role' = 'tenant_admin'
  );

-- ─── Campaign pacing (view) ─────────────────────────────────────────────────────
-- Delivered/remaining and SOV actual-vs-target math is computed in the API layer
-- (joins this view against campaigns) — SOV requires aggregating across a
-- competitive pool a single-table view can't express cleanly.
-- security_invoker ensures the view is evaluated under the querying role's RLS,
-- not the view owner's — required for fulfillments' RLS to actually apply here.

create view campaign_pacing
  with (security_invoker = true) as
select
  campaign_id,
  tenant_id,
  count(*) filter (where status = 'confirmed') as confirmed_count,
  count(*) filter (where status = 'reserved' and reserved_expires_at > now()) as pending_reserved_count
from fulfillments
group by campaign_id, tenant_id;
