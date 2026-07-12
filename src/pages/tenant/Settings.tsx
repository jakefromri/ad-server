import * as React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useTenantApiKey, useRotateTenantApiKey } from '@/hooks/useTenantSelf';
import { ApiError, API_BASE_URL } from '@/lib/api';

export default function Settings() {
  const { data, isLoading, error } = useTenantApiKey();
  const rotate = useRotateTenantApiKey();
  const [rotatedKey, setRotatedKey] = React.useState<string | null>(null);
  const [rotateError, setRotateError] = React.useState<string | null>(null);

  async function handleRotate() {
    setRotateError(null);
    setRotatedKey(null);
    try {
      const { api_key } = await rotate.mutateAsync();
      setRotatedKey(api_key);
    } catch (err) {
      setRotateError(err instanceof ApiError ? err.message : 'Failed to rotate API key');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">API key and documentation.</p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error instanceof Error ? error.message : 'Failed to load API key'}</AlertDescription>
        </Alert>
      )}

      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>API key</CardTitle>
          <CardDescription>Used by external scripts to call the campaign/screen management endpoints.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : data ? (
            <div className="flex items-center gap-2">
              <code className="rounded-md bg-muted px-2 py-1 text-sm">{data.key_prefix}…</code>
              <Badge variant={data.status === 'active' ? 'success' : 'outline'}>{data.status}</Badge>
            </div>
          ) : null}

          {rotateError && (
            <Alert variant="destructive">
              <AlertDescription>{rotateError}</AlertDescription>
            </Alert>
          )}
          {rotatedKey && (
            <Alert variant="warning">
              <AlertDescription>
                New key (shown once — copy it now): <code className="break-all">{rotatedKey}</code>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
        <CardFooter>
          <Button variant="outline" disabled={rotate.isPending} onClick={handleRotate}>
            {rotate.isPending ? 'Rotating…' : 'Rotate key'}
          </Button>
        </CardFooter>
      </Card>

      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>API documentation</CardTitle>
          <CardDescription>Full endpoint reference for the campaign/screen management API.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button variant="outline" asChild>
            <a href={`${API_BASE_URL}/docs`} target="_blank" rel="noopener noreferrer">
              View API docs
            </a>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
