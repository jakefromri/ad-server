import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { useAdminLedger } from '@/hooks/useAdminLedger';
import { useAdminTenants } from '@/hooks/useAdminTenants';
import type { Fulfillment } from '@shared/index';

const STATUS_VARIANT: Record<Fulfillment['status'], 'success' | 'secondary' | 'warning' | 'outline'> = {
  confirmed: 'success',
  reserved: 'secondary',
  expired: 'outline',
  failed: 'warning',
};

const PAGE_SIZE = 25;

export default function Ledger() {
  const { data: tenants } = useAdminTenants();
  const [tenantId, setTenantId] = React.useState<string>('all');
  const [status, setStatus] = React.useState<string>('all');
  const [cursorStack, setCursorStack] = React.useState<(string | undefined)[]>([undefined]);

  const currentCursor = cursorStack[cursorStack.length - 1];
  const { data, isLoading, error } = useAdminLedger({
    tenant_id: tenantId === 'all' ? undefined : tenantId,
    status: status === 'all' ? undefined : status,
    cursor: currentCursor,
    limit: PAGE_SIZE,
  });

  const tenantNameById = new Map((tenants ?? []).map((t) => [t.id, t.name]));

  function resetPaging() {
    setCursorStack([undefined]);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Ledger</h1>
        <p className="text-sm text-muted-foreground">Cross-tenant fulfillment history, for debugging/support.</p>
      </div>

      <div className="flex gap-3">
        <Select
          value={tenantId}
          onValueChange={(v) => {
            setTenantId(v);
            resetPaging();
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="All tenants" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tenants</SelectItem>
            {(tenants ?? []).map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            resetPaging();
          }}
        >
          <SelectTrigger className="w-48">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="reserved">Reserved</SelectItem>
            <SelectItem value="confirmed">Confirmed</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error instanceof Error ? error.message : 'Failed to load ledger'}</AlertDescription>
        </Alert>
      )}

      {isLoading && !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data && data.fulfillments.length > 0 ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tenant</TableHead>
                <TableHead>Requested at</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Media ref</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.fulfillments.map((f) => (
                <TableRow key={f.id}>
                  <TableCell>{tenantNameById.get(f.tenant_id) ?? f.tenant_id}</TableCell>
                  <TableCell>{new Date(f.requested_at).toLocaleString()}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[f.status]}>{f.status}</Badge>
                  </TableCell>
                  <TableCell>{f.report_outcome ?? '—'}</TableCell>
                  <TableCell className="max-w-xs truncate">{f.media_ref}</TableCell>
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
        <p className="text-sm text-muted-foreground">No fulfillments match these filters.</p>
      )}
    </div>
  );
}
