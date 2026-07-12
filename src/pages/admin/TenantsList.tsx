import * as React from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { useAdminTenants, usePatchTenant } from '@/hooks/useAdminTenants';
import { ApiError } from '@/lib/api';
import type { TenantSummary } from '@/lib/api-types';

function DeactivateDialog({ tenant, open, onOpenChange }: {
  tenant: TenantSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const patch = usePatchTenant(tenant.id);
  const [inFlight, setInFlight] = React.useState<number | null>(null);
  const [checked, setChecked] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // scope.md's Agent 03 flag: show the in-flight-reservation count before
  // committing to deactivation, not after. PATCH itself returns the count
  // (admin-tenants.ts), so the "check" and the "act" are the same call —
  // we ask for confirmation, then apply.
  async function handleConfirm() {
    setError(null);
    try {
      const result = await patch.mutateAsync({ status: 'deactivated' });
      setInFlight(result.in_flight_reservations ?? 0);
      setChecked(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to deactivate tenant');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => {
      onOpenChange(o);
      if (!o) {
        setChecked(false);
        setInFlight(null);
      }
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deactivate {tenant.name}?</DialogTitle>
          <DialogDescription>
            Fulfillment and report requests will be rejected with 403 while deactivated. Already-reserved
            fulfillments are not retroactively affected — they resolve via the normal expiry timeout.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {checked && (
          <Alert variant={inFlight && inFlight > 0 ? 'warning' : 'default'}>
            <AlertDescription>
              {inFlight && inFlight > 0
                ? `Deactivated. ${inFlight} reservation(s) were still in flight — their reports will be rejected until they expire.`
                : 'Deactivated. No in-flight reservations were affected.'}
            </AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          {!checked ? (
            <Button variant="destructive" disabled={patch.isPending} onClick={handleConfirm}>
              {patch.isPending ? 'Deactivating…' : 'Deactivate'}
            </Button>
          ) : (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TenantRow({ tenant }: { tenant: TenantSummary }) {
  const patch = usePatchTenant(tenant.id);
  const [deactivateOpen, setDeactivateOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function reactivate() {
    setError(null);
    try {
      await patch.mutateAsync({ status: 'active' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reactivate tenant');
    }
  }

  return (
    <TableRow>
      <TableCell className="font-medium">
        <Link to={`/admin/tenants/${tenant.id}`} className="hover:underline">
          {tenant.name}
        </Link>
      </TableCell>
      <TableCell>
        <Badge variant={tenant.status === 'active' ? 'success' : 'outline'}>{tenant.status}</Badge>
      </TableCell>
      <TableCell>
        {tenant.used_count.toLocaleString()} / {tenant.fulfillment_quota.toLocaleString()}
      </TableCell>
      <TableCell>{tenant.campaign_count}</TableCell>
      <TableCell>{tenant.screen_count}</TableCell>
      <TableCell className="text-right">
        {error && <div className="mb-1 text-xs text-destructive">{error}</div>}
        {tenant.status === 'active' ? (
          <Button size="sm" variant="destructive" onClick={() => setDeactivateOpen(true)}>
            Deactivate
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={patch.isPending} onClick={reactivate}>
            Reactivate
          </Button>
        )}
      </TableCell>
      <DeactivateDialog tenant={tenant} open={deactivateOpen} onOpenChange={setDeactivateOpen} />
    </TableRow>
  );
}

export default function TenantsList() {
  const { data: tenants, isLoading, error } = useAdminTenants();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Tenants</h1>
          <p className="text-sm text-muted-foreground">All tenants, quota usage, campaign/screen counts.</p>
        </div>
        <Button asChild>
          <Link to="/admin/tenants/new">New tenant</Link>
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error instanceof Error ? error.message : 'Failed to load tenants'}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : tenants && tenants.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Quota usage</TableHead>
              <TableHead>Campaigns</TableHead>
              <TableHead>Screens</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tenants.map((tenant) => (
              <TenantRow key={tenant.id} tenant={tenant} />
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">No tenants yet.</p>
      )}
    </div>
  );
}
