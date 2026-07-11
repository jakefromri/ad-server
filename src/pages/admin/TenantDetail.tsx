import * as React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useAdminTenants, usePatchTenant } from '@/hooks/useAdminTenants';
import { ApiError } from '@/lib/api';

// No GET /api/admin/tenants/:id endpoint exists (architecture.md's API
// Endpoints only specs GET list / POST / PATCH) — this reads the tenant from
// the already-fetched list query's cache rather than a dedicated fetch.
// Read-only campaigns/screens sub-views from architecture.md's Admin Panel
// route table aren't built for the same reason: no endpoint grants
// superadmin access to an arbitrary tenant's campaigns/screens (those routes
// are tenant_admin/tenant-key scoped only). See build-report.md's 04f
// "recommended follow-up scope."
export default function TenantDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data: tenants, isLoading } = useAdminTenants();
  const tenant = tenants?.find((t) => t.id === id);
  const patch = usePatchTenant(id ?? '');

  const [quota, setQuota] = React.useState('');
  const [timeout_, setTimeout_] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);

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

  if (isLoading || !hydrated) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (!tenant) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Tenant not found.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
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
            {tenant.used_count.toLocaleString()} / {tenant.fulfillment_quota.toLocaleString()} fulfillments ·{' '}
            {tenant.campaign_count} campaign(s) · {tenant.screen_count} screen(s)
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
    </div>
  );
}
