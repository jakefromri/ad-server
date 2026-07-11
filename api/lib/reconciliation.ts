// Reconciliation engine — eligibility filter + two-tier scoring + weighted
// tiebreak. architecture.md § Reconciliation Engine (the core of the system,
// re-evaluated in full on every POST /v1/fulfillments call, no caching).
//
// Share-of-voice is a reservation off the top of TOTAL eligible traffic, not
// a sub-pool of sibling SOV campaigns. An SOV campaign behind its target
// share wins the slot over every impression-count campaign, unconditionally
// (Tier 1 short-circuits Tier 2 — no cross-tier score comparison). Tier 0'
// lets an already-satisfied SOV campaign serve rather than leave a slot
// empty when nothing else is eligible (floor, not ceiling — scope.md).
//
// This module is pure/deterministic given its inputs (an injectable `now`
// and `rng`) — it does no I/O. The caller (fulfillments.ts) is responsible
// for loading fresh campaign/pacing data before each attempt and for the
// row-lock re-validation that follows winner selection.

import type { CampaignTargeting } from '../../types';
import { matchesTargeting, type TargetingScreen } from './targeting';

export const TIEBREAK_EPSILON = 0.01;

export interface CampaignForEligibility {
  id: string;
  obligation_type: 'impression_count' | 'share_of_voice';
  obligation_target: number;
  priority_weight: number;
  flight_start: string;
  flight_end: string;
  status: string;
  targeting: CampaignTargeting;
  confirmed_count: number;
  pending_reserved_count: number;
}

export interface ScorableCampaign {
  id: string;
  obligation_type: 'impression_count' | 'share_of_voice';
  obligation_target: number;
  priority_weight: number;
  flight_start: string;
  flight_end: string;
  own_delivered: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/** Targeting match + in-flight + remaining-obligation filter (architecture.md's
 * "Targeting filter" / "Remaining-obligation filter" steps). SOV campaigns are
 * always kept — they have no fixed ceiling to run out of. */
export function filterEligibleCampaigns(campaigns: CampaignForEligibility[], screen: TargetingScreen, now: Date): ScorableCampaign[] {
  return campaigns
    .filter((c) => c.status === 'active')
    .filter((c) => new Date(c.flight_start) <= now && now <= new Date(c.flight_end))
    .filter((c) => matchesTargeting(c.targeting, screen, now))
    .filter((c) => {
      if (c.obligation_type === 'share_of_voice') return true;
      return c.confirmed_count + c.pending_reserved_count < Number(c.obligation_target);
    })
    .map((c) => ({
      id: c.id,
      obligation_type: c.obligation_type,
      obligation_target: Number(c.obligation_target),
      priority_weight: Number(c.priority_weight),
      flight_start: c.flight_start,
      flight_end: c.flight_end,
      own_delivered: c.confirmed_count + c.pending_reserved_count,
    }));
}

export function computeTotalPoolDelivered(campaigns: ScorableCampaign[]): number {
  return campaigns.reduce((sum, c) => sum + c.own_delivered, 0);
}

/** Tier 1 pacing pressure — measured against total pool (SOV + impression
 * combined), not sibling SOV campaigns alone (RECON-UNIT-03). */
export function scoreSovPressure(campaign: ScorableCampaign, totalPoolDelivered: number): number {
  const actualShare = campaign.own_delivered / Math.max(totalPoolDelivered, 1);
  return campaign.obligation_target / 100 - actualShare;
}

/** Tier 2 pacing pressure — expected-vs-actual delivery given flight elapsed. */
export function scoreImpressionPressure(campaign: ScorableCampaign, now: Date): number {
  const flightStart = new Date(campaign.flight_start).getTime();
  const flightEnd = new Date(campaign.flight_end).getTime();
  const elapsedFraction = clamp((now.getTime() - flightStart) / (flightEnd - flightStart), 0, 1);
  const expectedDelivered = campaign.obligation_target * elapsedFraction;
  return (expectedDelivered - campaign.own_delivered) / Math.max(campaign.obligation_target, 1);
}

export interface ScoredCandidate {
  campaign: ScorableCampaign;
  pacingPressure: number;
}

/** Weighted-random pick among near-tied candidates (score within EPSILON of
 * max), weighted by priority_weight — never a strict highest-score-wins, so
 * near-tied campaigns split traffic proportionally rather than one
 * monopolizing every tie (RECON-UNIT-09/10). priority_weight only ever
 * compares within the set passed in — callers must never mix tiers. */
export function selectWinner(candidates: ScoredCandidate[], rng: () => number = Math.random): ScoredCandidate | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const scores = candidates.map((c) => c.pacingPressure * c.campaign.priority_weight);
  const maxScore = Math.max(...scores);
  const winnerCandidates = candidates.filter((c, i) => scores[i] >= maxScore - TIEBREAK_EPSILON);
  if (winnerCandidates.length === 1) return winnerCandidates[0];

  const totalWeight = winnerCandidates.reduce((sum, c) => sum + c.campaign.priority_weight, 0);
  let draw = rng() * totalWeight;
  for (const candidate of winnerCandidates) {
    draw -= candidate.campaign.priority_weight;
    if (draw <= 0) return candidate;
  }
  return winnerCandidates[winnerCandidates.length - 1];
}

export type ReconciliationTier = 'sov_behind_pace' | 'impression_remnant' | 'sov_satisfied_fallback' | 'none';

export interface ReconciliationResult {
  winner: ScorableCampaign | null;
  tier: ReconciliationTier;
  // Every candidate considered in the winning tier, with its computed score —
  // enough to reconstruct after the fact why a given campaign won (scope.md's
  // near-tie logging flag). Empty when tier is 'none'.
  candidates: ScoredCandidate[];
}

/** The two-tier scoring engine itself. Pure function of the eligible pool —
 * does no I/O, no locking. architecture.md § Reconciliation Engine, "Scoring
 * — two tiers". */
export function scoreEligiblePool(eligible: ScorableCampaign[], now: Date, rng: () => number = Math.random): ReconciliationResult {
  const totalPoolDelivered = computeTotalPoolDelivered(eligible);

  const sovScored: ScoredCandidate[] = eligible
    .filter((c) => c.obligation_type === 'share_of_voice')
    .map((campaign) => ({ campaign, pacingPressure: scoreSovPressure(campaign, totalPoolDelivered) }));

  // Tier 1 — any SOV campaign behind its target share wins outright, ahead of
  // every impression-count campaign regardless of that campaign's own
  // pressure. Tier 2 is not evaluated at all when this tier has a candidate.
  const behindPaceSov = sovScored.filter((c) => c.pacingPressure > 0);
  if (behindPaceSov.length > 0) {
    return { winner: selectWinner(behindPaceSov, rng)!.campaign, tier: 'sov_behind_pace', candidates: behindPaceSov };
  }

  // Tier 2 — impression-count fills the remnant. Reached only once every
  // eligible SOV campaign is at or ahead of target. The max-score (even
  // negative) candidate still wins — a slot has to go to someone.
  const impressionScored: ScoredCandidate[] = eligible
    .filter((c) => c.obligation_type === 'impression_count')
    .map((campaign) => ({ campaign, pacingPressure: scoreImpressionPressure(campaign, now) }));

  if (impressionScored.length > 0) {
    return { winner: selectWinner(impressionScored, rng)!.campaign, tier: 'impression_remnant', candidates: impressionScored };
  }

  // Tier 0′ — satisfied SOV serves rather than leaving the slot empty, only
  // when nothing else wants it. Reuses the Tier 1 pressure values (all <= 0
  // here, since behindPaceSov was empty) — the least-negative one wins.
  if (sovScored.length > 0) {
    return { winner: selectWinner(sovScored, rng)!.campaign, tier: 'sov_satisfied_fallback', candidates: sovScored };
  }

  return { winner: null, tier: 'none', candidates: [] };
}
