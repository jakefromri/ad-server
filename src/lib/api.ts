import { supabase } from './supabase';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string;

export class ApiError extends Error {
  status: number;
  code?: string;
  // Full JSON error body — some endpoints attach extra fields beyond
  // {error, code} (e.g. 409 SOV_OVERSOLD's `current_combined_total`,
  // architecture.md § API Endpoints).
  body?: Record<string, unknown>;

  constructor(status: number, message: string, code?: string, body?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}

// Every dashboard call authenticates with the signed-in user's Supabase JWT —
// the same tenantAccessMiddleware/humanAuthMiddleware chain the API already
// exposes to tenant API keys and curl (architecture.md § Auth Model). The
// dashboard never holds/sends a tenant or device API key itself.
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const body = (payload as Record<string, unknown> | null) ?? undefined;
    const message = (body?.error as string | undefined) ?? res.statusText;
    const code = body?.code as string | undefined;
    throw new ApiError(res.status, message, code, body);
  }

  return payload as T;
}
