// Response shapes not already covered by ../../types (types/index.ts mirrors
// architecture.md's Data Model 1:1 — these are the extra fields specific
// API endpoints join on, per architecture.md § API Endpoints).
import type { Campaign, Screen, Tenant, Fulfillment } from '@shared/index';

export interface TenantSummary extends Tenant {
  used_count: number;
  campaign_count: number;
  screen_count: number;
}

export interface ScreenWithKey extends Screen {
  device_key_status: string;
  device_key_prefix: string | null;
}

export interface CampaignPacing {
  delivered: number;
  remaining: number | null;
  sov_actual: number | null;
  sov_target: number | null;
  no_eligible_screens: boolean;
}

export interface CreateTenantResponse {
  tenant: Tenant;
  invite: { invite_url: string; expires_at: string };
  api_key: string;
}

export interface PatchTenantResponse {
  tenant: Tenant;
  in_flight_reservations?: number;
}

export interface LedgerResponse {
  fulfillments: Fulfillment[];
  next_cursor: string | null;
}

// 04i, follow-up scoping session — GET /api/admin/tenants/:id.
export interface TenantDetailResponse {
  tenant: Tenant;
  campaigns: Campaign[];
  screens: Screen[];
}

// 04i — POST /api/admin/tenants/:id/reinvite.
export interface ReinviteResponse {
  invite: { invite_url: string; expires_at: string };
}

// 04i — GET /api/admin/system-health.
export interface SystemHealth {
  request_rate_per_min: number;
  error_rate: number;
  reservation_timeout_rate: number;
  no_eligible_campaign_rate: number;
}

// 04i — GET /v1/tenant/usage/by-screen.
export interface UsageByScreenResponse {
  window_hours: number;
  screens: { screen_id: string; label: string; count: number }[];
}

// GET /v1/tenant/play-log — same fulfillments ledger as LedgerResponse, but
// tenant-scoped and joined with campaign name / screen label server-side.
export interface PlayLogEntry {
  id: string;
  requested_at: string;
  status: Fulfillment['status'];
  report_outcome: Fulfillment['report_outcome'];
  played_duration_ms: number | null;
  media_ref: string;
  campaign_id: string;
  campaign_name: string;
  screen_id: string;
  screen_label: string;
}

export interface PlayLogResponse {
  entries: PlayLogEntry[];
  next_cursor: string | null;
}

export type PlayLogExportWindow = 'day' | 'week' | 'month';

export type { Campaign, Screen, Tenant, Fulfillment };
