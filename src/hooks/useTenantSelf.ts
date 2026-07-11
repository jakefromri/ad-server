import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

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
