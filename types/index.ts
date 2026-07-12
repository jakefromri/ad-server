// Shared TypeScript types — single source of truth for src/ and api/.
// Mirrors architecture.md's Data Model + "Shared TypeScript Types" section exactly.
// No workspace/packages split in this repo (single Vite app topology) — both
// src/ and api/ import this file via relative path.

export interface Tenant {
  id: string;
  name: string;
  status: 'active' | 'deactivated';
  fulfillment_quota: number;
  reservation_timeout_seconds: number;
  created_at: string;
}

export interface Membership {
  id: string;
  tenant_id: string;
  user_id: string;
  role: 'tenant_admin';
  created_at: string;
}

export interface Invite {
  id: string;
  tenant_id: string;
  email: string;
  role: 'tenant_admin';
  token: string;
  expires_at: string;
  accepted_at: string | null;
  created_by: string;
  created_at: string;
}

export interface TenantApiKey {
  tenant_id: string;
  key_hash: string;
  key_prefix: string;
  status: 'active' | 'revoked';
  created_at: string;
  rotated_at: string | null;
}

export interface CampaignTargeting {
  daypart?: { start: string; end: string }[];
  days_of_week?: number[];
  geo: { type: 'all' | 'state' | 'zip'; values?: string[] };
  screen?: {
    aspect_ratios?: string[];
    resolutions?: string[];
    orientations?: ('landscape' | 'portrait')[];
  };
}

export interface Campaign {
  id: string;
  tenant_id: string;
  name: string;
  creative_media_path: string;
  obligation_type: 'impression_count' | 'share_of_voice';
  obligation_target: number;
  priority_weight: number;
  flight_start: string;
  flight_end: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  targeting: CampaignTargeting;
  created_at: string;
  updated_at: string;
}

export interface Screen {
  id: string;
  tenant_id: string;
  label: string;
  state: string | null;
  zip: string | null;
  aspect_ratio: string;
  resolution: string;
  orientation: 'landscape' | 'portrait';
  status: 'active' | 'inactive';
  is_simulated: boolean;
  created_at: string;
}

export interface DeviceApiKey {
  id: string;
  screen_id: string;
  tenant_id: string;
  key_hash: string;
  key_prefix: string;
  status: 'active' | 'revoked';
  created_at: string;
  revoked_at: string | null;
}

export interface Fulfillment {
  id: string;
  tenant_id: string;
  campaign_id: string;
  screen_id: string;
  media_ref: string;
  status: 'reserved' | 'confirmed' | 'expired' | 'failed';
  requested_at: string;
  reserved_expires_at: string;
  reported_at: string | null;
  report_outcome: 'played' | 'skipped' | 'failed' | null;
  played_duration_ms: number | null;
}

export interface FulfillmentQuotaUsage {
  tenant_id: string;
  used_count: number;
  updated_at: string;
}

export interface CampaignPacingRow {
  campaign_id: string;
  tenant_id: string;
  confirmed_count: number;
  pending_reserved_count: number;
}

// JWT app_metadata shape — IDs only, per ComposableAuth convention (CLAUDE.md).
export interface JwtClaims {
  role: 'superadmin' | 'tenant_admin';
  tenant_id: string | null;
}

export const ErrorCode = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  TENANT_DEACTIVATED: 'TENANT_DEACTIVATED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  SOV_OVERSOLD: 'SOV_OVERSOLD',
  ALREADY_REPORTED: 'ALREADY_REPORTED',
  LATE_REPORT: 'LATE_REPORT',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  TENANT_ALREADY_HAS_ADMIN: 'TENANT_ALREADY_HAS_ADMIN',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
