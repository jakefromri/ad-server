import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { usePlayLog, downloadPlayLogCsv } from '@/hooks/useTenantSelf';
import type { Fulfillment } from '@shared/index';
import type { PlayLogExportWindow } from '@/lib/api-types';

const STATUS_VARIANT: Record<Fulfillment['status'], 'success' | 'secondary' | 'warning' | 'outline'> = {
  confirmed: 'success',
  reserved: 'secondary',
  expired: 'outline',
  failed: 'warning',
};

const PAGE_SIZE = 25;

const EXPORT_OPTIONS: { window: PlayLogExportWindow; label: string }[] = [
  { window: 'day', label: 'Past day' },
  { window: 'week', label: 'Past week' },
  { window: 'month', label: 'Past month' },
];

export default function PlayLog() {
  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([undefined]);
  const [downloading, setDownloading] = React.useState<PlayLogExportWindow | null>(null);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);

  const currentCursor = cursorStack[cursorStack.length - 1];
  const { data, isLoading, error } = usePlayLog({ cursor: currentCursor, limit: PAGE_SIZE });

  async function handleDownload(window: PlayLogExportWindow) {
    setDownloadError(null);
    setDownloading(window);
    try {
      await downloadPlayLogCsv(window);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Failed to download CSV');
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Play log</h1>
          <p className="text-sm text-muted-foreground">
            Every media play across your screens, with campaign and screen details.
          </p>
        </div>
        <div className="flex gap-2">
          {EXPORT_OPTIONS.map((opt) => (
            <Button
              key={opt.window}
              variant="outline"
              size="sm"
              disabled={downloading !== null}
              onClick={() => handleDownload(opt.window)}
            >
              {downloading === opt.window ? 'Preparing…' : `Download CSV (${opt.label})`}
            </Button>
          ))}
        </div>
      </div>

      {downloadError && (
        <Alert variant="destructive">
          <AlertDescription>{downloadError}</AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error instanceof Error ? error.message : 'Failed to load play log'}</AlertDescription>
        </Alert>
      )}

      {isLoading && !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data && data.entries.length > 0 ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Requested at</TableHead>
                <TableHead>Campaign</TableHead>
                <TableHead>Screen</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Media</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{new Date(entry.requested_at).toLocaleString()}</TableCell>
                  <TableCell>{entry.campaign_name}</TableCell>
                  <TableCell>{entry.screen_label}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[entry.status]}>{entry.status}</Badge>
                  </TableCell>
                  <TableCell>{entry.report_outcome ?? '—'}</TableCell>
                  <TableCell className="max-w-xs truncate">{entry.media_ref}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              disabled={cursorStack.length <= 1}
              onClick={() => setCursorStack((prev) => prev.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!data.next_cursor}
              onClick={() => setCursorStack((prev) => [...prev, data.next_cursor ?? undefined])}
            >
              Next
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No plays recorded yet.</p>
      )}
    </div>
  );
}
