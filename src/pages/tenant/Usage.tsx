import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useTenantUsage } from '@/hooks/useTenantSelf';

export default function Usage() {
  const { data, isLoading, error } = useTenantUsage();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Usage</h1>
        <p className="text-sm text-muted-foreground">Fulfillment requests against your allotted quota.</p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error instanceof Error ? error.message : 'Failed to load usage'}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data ? (
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>
              {data.used.toLocaleString()} / {data.quota.toLocaleString()}
            </CardTitle>
            <CardDescription>Fulfillments used against lifetime quota</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${data.quota > 0 ? Math.min((data.used / data.quota) * 100, 100) : 0}%` }}
              />
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              This is the tenant-wide total. Per-device/screen usage breakdown isn't available yet — see
              build-report.md's 04f "recommended follow-up scope."
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
