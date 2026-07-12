import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { CreateTenantResponse, PatchTenantResponse, ReinviteResponse, TenantDetailResponse, TenantSummary } from '@/lib/api-types';

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-tenants'] });
      queryClient.invalidateQueries({ queryKey: ['admin-tenant-detail', id] });
    },
  });
}

// GET /api/admin/tenants/:id (04i, follow-up scoping session) — replaces the
// 04f list-cache workaround (TenantDetail.tsx used to derive the tenant from
// useAdminTenants()'s cache and had no campaigns/screens sub-views at all,
// since no endpoint granted a superadmin JWT access to an arbitrary tenant's
// campaigns/screens).
export function useAdminTenantDetail(id: string | undefined) {
  return useQuery({
    queryKey: ['admin-tenant-detail', id],
    queryFn: () => apiFetch<TenantDetailResponse>(`/api/admin/tenants/${id}`),
    enabled: !!id,
  });
}

export function useReinviteTenant(id: string) {
  return useMutation({
    mutationFn: () => apiFetch<ReinviteResponse>(`/api/admin/tenants/${id}/reinvite`, { method: 'POST' }),
  });
}
