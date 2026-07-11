import { useCampaignPacing } from '@/hooks/useCampaigns';
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

export function CampaignPacingCell({ campaign }: { campaign: Campaign }) {
  const { data, isLoading } = useCampaignPacing(campaign.id);

  if (isLoading || !data) return <span className="text-muted-foreground">…</span>;

  if (campaign.obligation_type === 'impression_count') {
    return (
      <span>
        {data.delivered} / {campaign.obligation_target}{' '}
        <span className="text-muted-foreground">({data.remaining} left)</span>
      </span>
    );
  }

  return (
    <span title={SOV_CAVEAT} className="cursor-help underline decoration-dotted">
      {data.sov_actual?.toFixed(1)}% / {data.sov_target}% target
    </span>
  );
}
