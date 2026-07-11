-- ad-server — reservation transaction RPC (Agent 04d)
--
-- architecture.md's reservation-transaction pseudocode requires row-level
-- FOR UPDATE locks on fulfillment_quota_usage and the winning campaign row,
-- both re-validated inside the SAME transaction as the insert/increment.
-- supabase-js/PostgREST gives each request its own implicit transaction —
-- there is no way to hold a lock open across two separate HTTP calls from an
-- Edge function. A single Postgres function call *is* one transaction, so
-- the lock-and-validate step (only that step — eligibility filtering,
-- targeting matching, and the two-tier scoring stay in TypeScript, where
-- they're testable and shared with the rest of the app) is implemented here.
--
-- Eligibility filtering/scoring runs unlocked in api/lib/reconciliation.ts
-- before this function is called; this function re-validates the winning
-- campaign fresh, under lock, and is the sole place that can actually insert
-- a reservation or increment quota usage. A 'campaign_no_longer_eligible'
-- result means a concurrent request won the race for this specific campaign
-- since scoring ran — the caller retries the whole pipeline (fresh query,
-- fresh scoring, fresh lock), per architecture.md's race-safety requirement.
--
-- Lock order (quota row, then campaign row) matches architecture.md's stated
-- order — "fixed lock order, avoids deadlock with the campaign-row lock".

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
  result_status text,
  fulfillment_id uuid,
  requested_at timestamptz,
  reserved_expires_at timestamptz
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

  -- Ensure a usage row exists (tenant creation doesn't seed one — see
  -- admin-tenants.ts), then lock it. Authoritative check, re-validated here
  -- even though a fast unlocked pre-check already ran in the API layer
  -- (architecture.md § "Quota enforcement point": two checks, not one).
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

  -- Lock the winning campaign row to serialize concurrent attempts against it.
  perform 1 from campaigns where id = p_campaign_id for update;

  -- Recompute delivered counts fresh, inside the lock — the lazy-expiry rule
  -- (a 'reserved' row past reserved_expires_at is excluded regardless of
  -- whether the cron sweep has formally marked it 'expired' yet) applies
  -- here exactly as it does in the campaign_pacing view.
  select
    count(*) filter (where status = 'confirmed'),
    count(*) filter (where status = 'reserved' and reserved_expires_at > now())
  into v_confirmed, v_pending
  from fulfillments
  where campaign_id = p_campaign_id;

  -- impression_count: remaining must be > 0. share_of_voice: always
  -- re-checkable, no fixed ceiling to over-draw (architecture.md).
  if p_obligation_type = 'impression_count' and (v_confirmed + v_pending) >= p_obligation_target then
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

-- Writes: API service role only, matching every other table in this schema.
-- SECURITY INVOKER (the default) is sufficient — the service role already
-- bypasses RLS, and an anon/authenticated caller would fail at the INSERT
-- regardless (no insert policy exists on fulfillments/fulfillment_quota_usage
-- for those roles) — but revoke explicitly so the access rule isn't implicit.
revoke execute on function reserve_fulfillment from public;
grant execute on function reserve_fulfillment to service_role;
