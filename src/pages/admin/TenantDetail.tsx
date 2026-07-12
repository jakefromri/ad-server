import * as React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { useAdminTenantDetail, usePatchTenant, useReinviteTenant } from '@/hooks/useAdminTenants';
import { ApiError } from '@/lib/api';

// GET /api/admin/tenants/:id (04i, follow-up scoping session) replaces the
// 04f list-cache workaround this page used to rely on — see build-report.md's
// 04f "recommended follow-up scope" and architecture.md's resolved design
// (one combined tenant+campaigns+screens fetch, since a superadmin JWT gets
// 403 on GET /v1/campaigns / GET /v1/screens directly).
export default function TenantDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error: loadError } = useAdminTenantDetail(id);
  const tenant = data?.tenant;
  const patch = usePatchTenant(id ?? '');
  const reinvite = useReinviteTenant(id ?? '');

  const [quota, setQuota] = React.useState('');
  const [timeout_, setTimeout_] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);
  const [reinviteResult, setReinviteResult] = React.useState<string | null>(null);
  const [reinviteError, setReinviteError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (tenant && !hydrated) {
      setQuota(String(tenant.fulfillment_quota));
      setTimeout_(String(tenant.reservation_timeout_seconds));
      setHydrated(true);
    }
  }, [tenant, hydrated]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    try {
      await patch.mutateAsync({
        fulfillment_quota: Number(quota),
        reservation_timeout_seconds: Number(timeout_),
      });
      setSuccess(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update tenant');
    }
  }

  async function handleReinvite() {
    setReinviteError(null);
    setReinviteResult(null);
    try {
      const { invite } = await reinvite.mutateAsync();
      setReinviteResult(invite.invite_url);
    } catch (err) {
      setReinviteError(err instanceof ApiError ? err.message : 'Failed to send invite');
    }
  }

  if (isLoading || !hydrated) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (loadError || !tenant) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Tenant not found.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Button variant="ghost" size="sm" onClick={() => navigate('/admin/tenants')}>
        ← Back to tenants
      </Button>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>{tenant.name}</CardTitle>
            <Badge variant={tenant.status === 'active' ? 'success' : 'outline'}>{tenant.status}</Badge>
          </div>
          <CardDescription>
            {data.campaigns.length} campaign(s) · {data.screens.length} screen(s)
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {success && (
              <Alert>
                <AlertDescription>Saved.</AlertDescription>
              </Alert>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="quota">Fulfillment quota</Label>
              <Input id="quota" type="number" min={0} value={quota} onChange={(e) => setQuota(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timeout">Reservation timeout (seconds)</Label>
              <Input
                id="timeout"
                type="number"
                min={1}
                value={timeout_}
                onChange={(e) => setTimeout_(e.target.value)}
              />
            </div>
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={patch.isPending}>
              {patch.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </CardFooter>
        </form>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Admin invite</CardTitle>
          <CardDescription>
            Re-send a tenant_admin invite. Only valid if this tenant has no accepted admin yet — if one already
            exists, this will show an error rather than displacing it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {reinviteError && (
            <Alert variant="destructive">
              <AlertDescription>{reinviteError}</AlertDescription>
            </Alert>
          )}
          {reinviteResult && (
            <Alert>
              <AlertDescription>
                New invite link: <code className="break-all">{reinviteResult}</code>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
        <CardFooter>
          <Button variant="outline" disabled={reinvite.isPending} onClick={handleReinvite}>
            {reinvite.isPending ? 'Sending…' : 'Resend invite'}
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Campaigns</CardTitle>
          <CardDescription>Read-only.</CardDescription>
        </CardHeader>
        <CardContent>
          {data.campaigns.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.campaigns.map((campaign) => (
                  <TableRow key={campaign.id}>
                    <TableCell className="font-medium">{campaign.name}</TableCell>
                    <TableCell>{campaign.obligation_type === 'impression_count' ? 'Impressions' : 'Share of voice'}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{campaign.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No campaigns yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Screens</CardTitle>
          <CardDescription>Read-only.</CardDescription>
        </CardHeader>
        <CardContent>
          {data.screens.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.screens.map((screen) => (
                  <TableRow key={screen.id}>
                    <TableCell className="font-medium">{screen.label}</TableCell>
                    <TableCell>{screen.state ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={screen.status === 'active' ? 'success' : 'outline'}>{screen.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No screens yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
