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

export type { Campaign, Screen, Tenant, Fulfillment };
