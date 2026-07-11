import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { Screen } from '@shared/index';
import type { ScreenWithKey } from '@/lib/api-types';

export function useScreens() {
  return useQuery({
    queryKey: ['screens'],
    queryFn: () => apiFetch<{ screens: ScreenWithKey[] }>('/v1/screens'),
    select: (data) => data.screens,
  });
}

export interface ScreenInput {
  label: string;
  state?: string | null;
  zip?: string | null;
  aspect_ratio: string;
  resolution: string;
  orientation: 'landscape' | 'portrait';
}

export function useCreateScreen() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ScreenInput) =>
      apiFetch<{ screen: Screen; device_api_key: string }>('/v1/screens', { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['screens'] }),
  });
}

export function usePatchScreen(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<ScreenInput> & { status?: 'active' | 'inactive' }) =>
      apiFetch<{ screen: Screen }>(`/v1/screens/${id}`, { method: 'PATCH', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['screens'] }),
  });
}

export function useRotateScreenKey(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ device_api_key: string }>(`/v1/screens/${id}/rotate-key`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['screens'] }),
  });
}
