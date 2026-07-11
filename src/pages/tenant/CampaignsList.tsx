import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useCampaigns, usePatchCampaign } from '@/hooks/useCampaigns';
import { CampaignPacingCell } from './CampaignPacingCell';
import type { Campaign } from '@shared/index';
import { ApiError } from '@/lib/api';
import * as React from 'react';

const STATUS_VARIANT: Record<Campaign['status'], 'success' | 'secondary' | 'warning' | 'outline'> = {
  active: 'success',
  draft: 'secondary',
  paused: 'warning',
  archived: 'outline',
};

function StatusActions({ campaign }: { campaign: Campaign }) {
  const [error, setError] = React.useState<string | null>(null);
  const patch = usePatchCampaign(campaign.id);

  async function setStatus(status: Campaign['status']) {
    setError(null);
    try {
      await patch.mutateAsync({ status });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update campaign');
    }
  }

  return (
    <div className="flex items-center justify-end gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <Button asChild size="sm" variant="outline">
        <Link to={`/t/campaigns/${campaign.id}/edit`}>Edit</Link>
      </Button>
      {campaign.status === 'active' ? (
        <Button size="sm" variant="outline" disabled={patch.isPending} onClick={() => setStatus('paused')}>
          Pause
        </Button>
      ) : campaign.status !== 'archived' ? (
        <Button size="sm" variant="outline" disabled={patch.isPending} onClick={() => setStatus('active')}>
          Activate
        </Button>
      ) : null}
      {campaign.status !== 'archived' && (
        <Button size="sm" variant="ghost" disabled={patch.isPending} onClick={() => setStatus('archived')}>
          Archive
        </Button>
      )}
    </div>
  );
}

export default function CampaignsList() {
  const { data: campaigns, isLoading, error } = useCampaigns();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Campaigns</h1>
          <p className="text-sm text-muted-foreground">Pacing, targeting, and flight status for every campaign.</p>
        </div>
        <Button asChild>
          <Link to="/t/campaigns/new">New campaign</Link>
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error instanceof Error ? error.message : 'Failed to load campaigns'}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : campaigns && campaigns.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Pacing</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.map((campaign) => (
              <TableRow key={campaign.id}>
                <TableCell className="font-medium">{campaign.name}</TableCell>
                <TableCell>{campaign.obligation_type === 'impression_count' ? 'Impressions' : 'Share of voice'}</TableCell>
                <TableCell>
                  <CampaignPacingCell campaign={campaign} />
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[campaign.status]}>{campaign.status}</Badge>
                </TableCell>
                <TableCell>{campaign.priority_weight}</TableCell>
                <TableCell>
                  <StatusActions campaign={campaign} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">No campaigns yet. Create one to get started.</p>
      )}
    </div>
  );
}
