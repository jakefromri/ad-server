-- ad-server — maintained confirmed-count counter (Agent 04g load-test fix)
--
-- 04g's load test found campaign_pacing's confirmed_count — and
-- reserve_fulfillment's internal re-validation of the same number under
-- lock — both computing `count(*) filter (where status = 'confirmed')
-- from fulfillments where campaign_id = ...` fresh on every single
-- fulfillment request. That's the exact anti-pattern
-- fulfillment_quota_usage's own header comment already warns against
-- ("Materialized counter, not COUNT(*) FROM fulfillments — checked on
-- every fulfillment request and must not scan a growing ledger table each
-- time") — campaign_pacing just never got the same treatment, and
-- architecture.md's Scale Plan assumed this view was dashboard-only
-- ("not on the fulfillment hot path"), which turned out to be wrong:
-- reserve_fulfillment queries the same aggregation directly, under lock,
-- on the hot path.
--
-- pending_reserved_count is deliberately NOT given the same treatment —
-- it's bounded by the reservation timeout window (only currently-open
-- reservations match), not by total ledger history, so it stays cheap via
-- the existing fulfillments_campaign_status_idx / fulfillments_status_expires_idx
-- indexes regardless of how large the table grows. confirmed_count is the
-- part that's genuinely unbounded (permanent, monotonically growing,
-- append-only-in-spirit history) — that's the only part maintained here.

create table campaign_confirmed_counts (
  campaign_id     uuid primary key references campaigns(id) on delete cascade,
  confirmed_count bigint not null default 0
);

alter table campaign_confirmed_counts enable row level security;

create policy superadmin_all on campaign_confirmed_counts
  using (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin')
  with check (auth.jwt() -> 'app_metadata' ->> 'role' = 'superadmin');

create policy tenant_members_read_own on campaign_confirmed_counts
  for select using (
    exists (
      select 1 from campaigns
      where campaigns.id = campaign_confirmed_counts.campaign_id
        and campaigns.tenant_id = (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::uuid
    )
    and auth.jwt() -> 'app_metadata' ->> 'role' = 'tenant_admin'
  );

-- Backfill from existing history so this doesn't reset delivered counts to
-- zero for campaigns that already have confirmed fulfillments.
insert into campaign_confirmed_counts (campaign_id, confirmed_count)
select campaign_id, count(*)
from fulfillments
where status = 'confirmed'
group by campaign_id
on conflict (campaign_id) do update set confirmed_count = excluded.confirmed_count;

-- Fires exactly once per fulfillment row (the report endpoint's own atomic
-- `update ... where status = 'reserved'` guard already ensures a
-- reserved -> confirmed transition happens at most once per row), so this
-- trigger can't double-count. Concurrent confirms of different rows against
-- the same campaign_id serialize safely at the counter row's own
-- UPDATE/lock, identical to fulfillment_quota_usage's existing
-- `used_count = used_count + 1` pattern.
create function bump_campaign_confirmed_count() returns trigger
language plpgsql as $$
begin
  insert into campaign_confirmed_counts (campaign_id, confirmed_count)
  values (new.campaign_id, 1)
  on conflict (campaign_id) do update
    set confirmed_count = campaign_confirmed_counts.confirmed_count + 1;
  return new;
end;
$$;

create trigger fulfillments_bump_confirmed_count
  after update of status on fulfillments
  for each row
  when (old.status = 'reserved' and new.status = 'confirmed')
  execute function bump_campaign_confirmed_count();

-- campaign_pacing: confirmed_count now reads the maintained counter
-- (left join + coalesce so a campaign with zero confirmed fulfillments
-- still returns a row); pending_reserved_count stays a live count — see
-- header comment for why that half is deliberately unchanged.
create or replace view campaign_pacing
  with (security_invoker = true) as
select
  f.campaign_id,
  f.tenant_id,
  coalesce(cc.confirmed_count, 0) as confirmed_count,
  count(*) filter (where f.status = 'reserved' and f.reserved_expires_at > now()) as pending_reserved_count
from fulfillments f
left join campaign_confirmed_counts cc on cc.campaign_id = f.campaign_id
group by f.campaign_id, f.tenant_id, cc.confirmed_count;

-- reserve_fulfillment: same substitution for its own internal
-- re-validation-under-lock query — this was the more urgent half of the
-- fix, since a slow count here directly extends how long the campaign
-- row's lock is held, compounding latency for every other concurrent
-- attempt against the same campaign.
create or replace function reserve_fulfillment(
  p_tenant_id uuid,
  p_campaign_id uuid,
  p_screen_id uuid,
  p_media_ref text,
  p_reservation_timeout_seconds int,
  p_obligation_type text,
  p_obligation_target numeric
)
returns table (
  out_result_status text,
  out_fulfillment_id uuid,
  out_requested_at timestamptz,
  out_reserved_expires_at timestamptz
)
language plpgsql
as $$
declare
  v_quota bigint;
  v_used bigint;
  v_confirmed bigint;
  v_pending bigint;
  v_fulfillment fulfillments%rowtype;
begin
  select fulfillment_quota into v_quota from tenants where id = p_tenant_id;

  insert into fulfillment_quota_usage (tenant_id, used_count)
  values (p_tenant_id, 0)
  on conflict (tenant_id) do nothing;

  select used_count into v_used
  from fulfillment_quota_usage
  where tenant_id = p_tenant_id
  for update;

  if v_used >= v_quota then
    return query select 'quota_exceeded'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  perform 1 from campaigns where id = p_campaign_id for update;

  select coalesce(confirmed_count, 0) into v_confirmed
  from campaign_confirmed_counts
  where campaign_id = p_campaign_id;

  select count(*) filter (where fulfillments.status = 'reserved' and fulfillments.reserved_expires_at > now())
  into v_pending
  from fulfillments
  where fulfillments.campaign_id = p_campaign_id;

  if p_obligation_type = 'impression_count' and (coalesce(v_confirmed, 0) + coalesce(v_pending, 0)) >= p_obligation_target then
    return query select 'campaign_no_longer_eligible'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  insert into fulfillments (tenant_id, campaign_id, screen_id, media_ref, status, reserved_expires_at)
  values (
    p_tenant_id,
    p_campaign_id,
    p_screen_id,
    p_media_ref,
    'reserved',
    now() + make_interval(secs => p_reservation_timeout_seconds)
  )
  returning * into v_fulfillment;

  update fulfillment_quota_usage
  set used_count = used_count + 1, updated_at = now()
  where tenant_id = p_tenant_id;

  return query select 'reserved'::text, v_fulfillment.id, v_fulfillment.requested_at, v_fulfillment.reserved_expires_at;
end;
$$;

revoke execute on function reserve_fulfillment from public;
grant execute on function reserve_fulfillment to service_role;
