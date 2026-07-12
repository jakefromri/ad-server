// Quota read/check helpers. Only the read path (getQuotaUsage) is exercised
// in 04c, powering GET /v1/tenant/usage — there's no fulfillment endpoint yet
// for isOverQuota to guard (PROJECT_PLAN.md § 04c: "Quota-check middleware
// wired in, not yet enforced against fulfillment — that's 04d"). 04d's
// reservation transaction still needs the authoritative locked re-check
// inside the same transaction as the reservation insert
// (architecture.md § "Quota enforcement point") — isOverQuota below is only
// the fast, unlocked pre-check, the first of that section's two checks.

import { supabaseAdmin } from './supabase';

export async function getQuotaUsage(tenantId: string): Promise<{ used: number; quota: number }> {
  const [{ data: tenant }, { data: usage }] = await Promise.all([
    supabaseAdmin.from('tenants').select('fulfillment_quota').eq('id', tenantId).single(),
    supabaseAdmin.from('fulfillment_quota_usage').select('used_count').eq('tenant_id', tenantId).maybeSingle(),
  ]);

  return { used: usage?.used_count ?? 0, quota: Number(tenant?.fulfillment_quota ?? 0) };
}

export async function isOverQuota(tenantId: string): Promise<boolean> {
  const { used, quota } = await getQuotaUsage(tenantId);
  return used >= quota;
}
