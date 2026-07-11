import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useCreateTenant } from '@/hooks/useAdminTenants';
import { ApiError } from '@/lib/api';
import type { CreateTenantResponse } from '@/lib/api-types';

export default function TenantNew() {
  const navigate = useNavigate();
  const createTenant = useCreateTenant();

  const [name, setName] = React.useState('');
  const [quota, setQuota] = React.useState('1000');
  const [adminEmail, setAdminEmail] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<CreateTenantResponse | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const response = await createTenant.mutateAsync({
        name,
        fulfillment_quota: Number(quota),
        admin_email: adminEmail,
      });
      setResult(response);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create tenant');
    }
  }

  if (result) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>{result.tenant.name} created</CardTitle>
          <CardDescription>The invite URL and API key below are shown once — share the invite URL with the tenant admin now.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Invite URL (expires {new Date(result.invite.expires_at).toLocaleString()})</Label>
            <code className="block break-all rounded-md bg-muted p-3 text-sm">{result.invite.invite_url}</code>
          </div>
          <div className="space-y-1.5">
            <Label>Tenant API key</Label>
            <code className="block break-all rounded-md bg-muted p-3 text-sm">{result.api_key}</code>
          </div>
        </CardContent>
        <CardFooter>
          <Button onClick={() => navigate('/admin/tenants')}>Done</Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle>New tenant</CardTitle>
        <CardDescription>Creates the tenant, its API key, and the first tenant_admin invite in one call.</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="tenant-name">Name</Label>
            <Input id="tenant-name" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tenant-quota">Initial fulfillment quota</Label>
            <Input
              id="tenant-quota"
              type="number"
              required
              min={0}
              value={quota}
              onChange={(e) => setQuota(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-email">Tenant admin email</Label>
            <Input
              id="admin-email"
              type="email"
              required
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
            />
          </div>
        </CardContent>
        <CardFooter className="gap-2">
          <Button type="submit" disabled={createTenant.isPending}>
            {createTenant.isPending ? 'Creating…' : 'Create tenant'}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate('/admin/tenants')}>
            Cancel
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
