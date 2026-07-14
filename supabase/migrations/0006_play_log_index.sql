-- ad-server — tenant play log (GET /v1/tenant/play-log and its CSV export
-- variant, /v1/tenant/play-log/export). Both order by (tenant_id,
-- requested_at desc) with a requested_at window filter on the export side;
-- the existing fulfillments_tenant_id_idx (tenant_id only) would require a
-- full tenant-scoped scan + sort for that. Mirrors the
-- fulfillments_tenant_screen_requested_idx pattern from migration 0005.
create index fulfillments_tenant_requested_idx on fulfillments (tenant_id, requested_at desc);
