import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { useTenantUsage, useUsageByScreen } from '@/hooks/useTenantSelf';

export default function Usage() {
  const { data, isLoading, error } = useTenantUsage();
  const { data: byScreen, isLoading: byScreenLoading, error: byScreenError } = useUsageByScreen();

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
          </CardContent>
        </Card>
      ) : null}

      {/* GET /v1/tenant/usage/by-screen (04i, follow-up scoping session) —
          tied to the device-key-compromise blast-radius concern: a
          compromised/misbehaving screen shows up here as a count spike well
          before it would exhaust the tenant-wide quota. */}
      <div>
        <h2 className="text-lg font-semibold">Per-screen breakdown</h2>
        <p className="text-sm text-muted-foreground">Fulfillments by screen over the last {byScreen?.window_hours ?? 24}h.</p>
      </div>

      {byScreenError && (
        <Alert variant="destructive">
          <AlertDescription>
            {byScreenError instanceof Error ? byScreenError.message : 'Failed to load per-screen usage'}
          </AlertDescription>
        </Alert>
      )}

      {byScreenLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : byScreen && byScreen.screens.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Screen</TableHead>
              <TableHead className="text-right">Fulfillments</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {byScreen.screens
              .slice()
              .sort((a, b) => b.count - a.count)
              .map((s) => (
                <TableRow key={s.screen_id}>
                  <TableCell className="font-medium">{s.label}</TableCell>
                  <TableCell className="text-right">{s.count.toLocaleString()}</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">No fulfillments in this window.</p>
      )}
    </div>
  );
}
