import * as React from 'react';
import type { Session } from '@supabase/supabase-js';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from './supabase';

type Role = 'superadmin' | 'tenant_admin';

interface AuthState {
  session: Session | null;
  role: Role | null;
  tenantId: string | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthState | undefined>(undefined);

function deriveClaims(session: Session | null): { role: Role | null; tenantId: string | null } {
  const meta = session?.user.app_metadata as Partial<{ role: Role; tenant_id: string | null }> | undefined;
  return { role: meta?.role ?? null, tenantId: meta?.tenant_id ?? null };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<Session | null>(null);
  const [loading, setLoading] = React.useState(true);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Supabase fires the same SIGNED_OUT event for a voluntary "Sign out" click
  // and for an involuntary refresh failure (revoked session, expired refresh
  // token) — there's no separate event for the latter. Track intent locally
  // so only the involuntary case gets the "your session ended" message.
  const voluntarySignOut = React.useRef(false);

  React.useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    // Supabase's client auto-refreshes the access token in the background
    // (default `autoRefreshToken: true`) — a logged-in operator isn't
    // silently logged out mid-session under normal use, per architecture.md's
    // explicit behavior. If a refresh genuinely fails, the client clears the
    // session and emits SIGNED_OUT — that's the involuntary case we redirect
    // to /login with a message rather than letting the dashboard surface raw
    // 401s. Also clear the query cache so no stale, now-unauthenticated query
    // refetches and logs a spurious 401 after the session is gone.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);
      if (event === 'SIGNED_OUT') {
        queryClient.clear();
        if (!voluntarySignOut.current) {
          navigate('/login', { state: { message: 'Your session ended. Please sign in again.' } });
        }
        voluntarySignOut.current = false;
      }
    });

    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { role, tenantId } = deriveClaims(session);

  const signOut = React.useCallback(async () => {
    voluntarySignOut.current = true;
    await supabase.auth.signOut();
    navigate('/login');
  }, [navigate]);

  const value = React.useMemo(
    () => ({ session, role, tenantId, loading, signOut }),
    [session, role, tenantId, loading, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
