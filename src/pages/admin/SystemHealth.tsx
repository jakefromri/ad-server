import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useSystemHealth } from '@/hooks/useAdminHealth';

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export default function SystemHealth() {
  const { data, isLoading, error } = useSystemHealth();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">System health</h1>
        <p className="text-sm text-muted-foreground">
          Cross-tenant request rate (5 min) and error/timeout/no-eligible-campaign rates (60 min).
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error instanceof Error ? error.message : 'Failed to load system health'}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Card>
            <CardHeader>
              <CardTitle>{data.request_rate_per_min.toFixed(1)}</CardTitle>
              <CardDescription>Requests / min</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{formatPercent(data.error_rate)}</CardTitle>
              <CardDescription>Error rate</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{formatPercent(data.reservation_timeout_rate)}</CardTitle>
              <CardDescription>Reservation timeout rate</CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{formatPercent(data.no_eligible_campaign_rate)}</CardTitle>
              <CardDescription>No-eligible-campaign rate</CardDescription>
            </CardHeader>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
