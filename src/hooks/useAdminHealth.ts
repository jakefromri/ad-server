import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { SystemHealth } from '@/lib/api-types';

// GET /api/admin/system-health (04i, follow-up scoping session). Windowed
// server-side (5min rate / 60min ratios, see admin-health.ts) — refetch on
// an interval so the dashboard stays reasonably current without the user
// manually reloading.
export function useSystemHealth() {
  return useQuery({
    queryKey: ['admin-system-health'],
    queryFn: () => apiFetch<SystemHealth>('/api/admin/system-health'),
    refetchInterval: 30_000,
  });
}
