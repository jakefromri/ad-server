import * as React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useTenantApiKey, useRotateTenantApiKey } from '@/hooks/useTenantSelf';
import { ApiError } from '@/lib/api';

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
          {/* GET /v1/openapi.json / GET /docs (04i) attempted and reverted in
              the same phase — @hono/zod-openapi isn't deployable on this
              project's Vercel Edge Function (see api/index.ts's header
              comment). No docs page to link to yet. */}
          <CardDescription>Coming soon — the OpenAPI spec/docs page hit a Vercel deployment blocker and was reverted.</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
