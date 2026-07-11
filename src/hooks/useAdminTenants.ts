import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { CreateTenantResponse, PatchTenantResponse, TenantSummary } from '@/lib/api-types';

export function useAdminTenants() {
  return useQuery({
    queryKey: ['admin-tenants'],
    queryFn: () => apiFetch<{ tenants: TenantSummary[] }>('/api/admin/tenants'),
    select: (data) => data.tenants,
  });
}

export interface CreateTenantInput {
  name: string;
  fulfillment_quota: number;
  admin_email: string;
}

export function useCreateTenant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTenantInput) => apiFetch<CreateTenantResponse>('/api/admin/tenants', { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-tenants'] }),
  });
}

export interface PatchTenantInput {
  status?: 'active' | 'deactivated';
  fulfillment_quota?: number;
  reservation_timeout_seconds?: number;
}

export function usePatchTenant(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchTenantInput) =>
      apiFetch<PatchTenantResponse>(`/api/admin/tenants/${id}`, { method: 'PATCH', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-tenants'] }),
  });
}
