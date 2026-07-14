import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiFetchBlob } from '@/lib/api';
import type { UsageByScreenResponse, PlayLogResponse, PlayLogExportWindow } from '@/lib/api-types';

export function useTenantApiKey() {
  return useQuery({
    queryKey: ['tenant-api-key'],
    queryFn: () => apiFetch<{ key_prefix: string; status: string }>('/v1/tenant/api-key'),
  });
}

export function useRotateTenantApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ api_key: string }>('/v1/tenant/api-key/rotate', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tenant-api-key'] }),
  });
}

export function useTenantUsage() {
  return useQuery({
    queryKey: ['tenant-usage'],
    queryFn: () => apiFetch<{ used: number; quota: number }>('/v1/tenant/usage'),
  });
}

// GET /v1/tenant/usage/by-screen (04i, follow-up scoping session).
export function useUsageByScreen() {
  return useQuery({
    queryKey: ['tenant-usage-by-screen'],
    queryFn: () => apiFetch<UsageByScreenResponse>('/v1/tenant/usage/by-screen'),
  });
}

export interface PlayLogFilters {
  cursor?: string;
  limit?: number;
}

// GET /v1/tenant/play-log.
export function usePlayLog(filters: PlayLogFilters) {
  const params = new URLSearchParams();
  if (filters.cursor) params.set('cursor', filters.cursor);
  if (filters.limit) params.set('limit', String(filters.limit));

  return useQuery({
    queryKey: ['tenant-play-log', filters],
    queryFn: () => apiFetch<PlayLogResponse>(`/v1/tenant/play-log?${params.toString()}`),
    placeholderData: (prev) => prev,
  });
}

// Triggers a browser download of GET /v1/tenant/play-log/export — not a
// react-query hook (there's nothing to cache/subscribe to, just a one-shot
// fetch-then-download action from a button click).
export async function downloadPlayLogCsv(window: PlayLogExportWindow): Promise<void> {
  const blob = await apiFetchBlob(`/v1/tenant/play-log/export?window=${window}`);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `play-log-${window}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
