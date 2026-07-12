import { useCampaignPacing } from '@/hooks/useCampaigns';
import { Badge } from '@/components/ui/badge';
import type { Campaign } from '@shared/index';

// Coarse tenant-wide approximation, not the request-time eligible-pool math
// the reconciliation engine actually uses (architecture.md's
// GET /v1/campaigns/:id/pacing doc comment, build-report.md 04c/04e) — a
// narrowly-targeted SOV campaign running alongside a broad impression-count
// campaign will show a sov_actual that looks stuck near zero even while
// genuinely converging within its real, isolated competitive pool. Surfaced
// via the title tooltip rather than hidden, per 04e's build-report flag.
const SOV_CAVEAT =
  'Approximate: measured against every active campaign tenant-wide, not just this campaign’s real competitive pool. Can look artificially low if you also run a broad, untargeted campaign.';

// no_eligible_screens (04i, follow-up scoping session) — a live structural
// check (targeting time-coverage + current active-screen fleet match), not a
// "zero requests seen" signal. See architecture.md's GET
// /v1/campaigns/:id/pacing doc comment for the accepted fidelity gap this
// implies (a campaign matching screens that exist but never send traffic
// still reads as eligible here).
const NO_ELIGIBLE_SCREENS_TOOLTIP =
  "This campaign's targeting doesn't currently match any active screen in your fleet (or its daypart/day-of-week window never has any coverage) — it can't deliver until that changes.";

function NoEligibleScreensBadge() {
  return (
    <Badge variant="warning" title={NO_ELIGIBLE_SCREENS_TOOLTIP} className="cursor-help">
      No eligible screens
    </Badge>
  );
}

export function CampaignPacingCell({ campaign }: { campaign: Campaign }) {
  const { data, isLoading } = useCampaignPacing(campaign.id);

  if (isLoading || !data) return <span className="text-muted-foreground">…</span>;

  if (campaign.obligation_type === 'impression_count') {
    return (
      <span className="flex items-center gap-2">
        <span>
          {data.delivered} / {campaign.obligation_target}{' '}
          <span className="text-muted-foreground">({data.remaining} left)</span>
        </span>
        {data.no_eligible_screens && <NoEligibleScreensBadge />}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2">
      <span title={SOV_CAVEAT} className="cursor-help underline decoration-dotted">
        {data.sov_actual?.toFixed(1)}% / {data.sov_target}% target
      </span>
      {data.no_eligible_screens && <NoEligibleScreensBadge />}
    </span>
  );
}
