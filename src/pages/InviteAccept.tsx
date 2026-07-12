import * as React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { apiFetch, ApiError } from '@/lib/api';
import { supabase } from '@/lib/supabase';

// Public route the invite_url returned by POST /api/admin/tenants points at
// (admin-tenants.ts: `${APP_URL}/invite?token=...`). Sets the tenant_admin's
// password via POST /api/invites/accept, then signs them straight in — the
// accept endpoint only creates the Supabase Auth user, it doesn't return a
// session itself.
export default function InviteAccept() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setSubmitting(true);
    try {
      const { user } = await apiFetch<{ user: { id: string; email: string } }>('/api/invites/accept', {
        method: 'POST',
        body: { token, password },
      });

      const { error: signInError } = await supabase.auth.signInWithPassword({ email: user.email, password });
      if (signInError) {
        // Account was created but the follow-up sign-in failed — send them to
        // the normal login form rather than stranding them on this page.
        navigate('/login', { state: { message: 'Account created — please sign in.' } });
        return;
      }

      navigate('/t/campaigns', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <Alert variant="destructive" className="max-w-sm">
          <AlertDescription>Missing invite token. Check the link you were sent.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Set your password</CardTitle>
          <CardDescription>Finish setting up your ad-server account</CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={10}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-password">Confirm password</Label>
              <Input
                id="confirm-password"
                type="password"
                required
                minLength={10}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? 'Setting password…' : 'Set password & sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
