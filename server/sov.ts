// SOV overselling check — architecture.md § Reconciliation Engine, "SOV
// overselling — validated at campaign creation, not at fulfillment time".
// Flight-window overlap is used as a conservative proxy for "could compete
// for the same slot"; targeting-scope intersection is intentionally not
// computed in MVP.

import { supabaseAdmin } from './supabase';

export interface SovCandidate {
  tenant_id: string;
  obligation_target: number;
  flight_start: string;
  flight_end: string;
  excludeCampaignId?: string;
}

async function sumOverlappingActiveSov(candidate: SovCandidate): Promise<number> {
  let query = supabaseAdmin
    .from('campaigns')
    .select('obligation_target')
    .eq('tenant_id', candidate.tenant_id)
    .eq('obligation_type', 'share_of_voice')
    .eq('status', 'active')
    .lt('flight_start', candidate.flight_end)
    .gt('flight_end', candidate.flight_start);

  if (candidate.excludeCampaignId) {
    query = query.neq('id', candidate.excludeCampaignId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).reduce((sum, row) => sum + Number(row.obligation_target), 0);
}

export interface SovCheckResult {
  ok: boolean;
  // The combined total of *other* overlapping active SOV campaigns, not
  // including the candidate — matches the CAMPAIGN-INT-05 test's expected
  // error body (a pre-existing 70% campaign blocking a new 40% one reports
  // current_combined_total: 70, not 110).
  currentCombinedTotal: number;
}

export async function checkSovOverselling(candidate: SovCandidate): Promise<SovCheckResult> {
  const currentCombinedTotal = await sumOverlappingActiveSov(candidate);
  const wouldBeCombined = currentCombinedTotal + candidate.obligation_target;
  return { ok: wouldBeCombined <= 100, currentCombinedTotal };
}
