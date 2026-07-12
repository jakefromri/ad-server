-- Fix: 0002's OUT/RETURNS TABLE column `reserved_expires_at` collided with
-- the `fulfillments.reserved_expires_at` column name inside the function
-- body (PL/pgSQL error 42702, "ambiguous"). Renaming the RETURNS TABLE
-- columns with an `out_` prefix removes the collision; no other logic
-- changes from 0002.

-- create or replace can't change RETURNS TABLE column names, only their
-- types/order — drop first.
drop function if exists reserve_fulfillment(uuid, uuid, uuid, text, int, text, numeric);

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

  select
    count(*) filter (where fulfillments.status = 'confirmed'),
    count(*) filter (where fulfillments.status = 'reserved' and fulfillments.reserved_expires_at > now())
  into v_confirmed, v_pending
  from fulfillments
  where fulfillments.campaign_id = p_campaign_id;

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

revoke execute on function reserve_fulfillment from public;
grant execute on function reserve_fulfillment to service_role;
