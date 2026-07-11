import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { LedgerResponse } from '@/lib/api-types';

export interface LedgerFilters {
  tenant_id?: string;
  status?: string;
  cursor?: string;
  limit?: number;
}

export function useAdminLedger(filters: LedgerFilters) {
  const params = new URLSearchParams();
  if (filters.tenant_id) params.set('tenant_id', filters.tenant_id);
  if (filters.status) params.set('status', filters.status);
  if (filters.cursor) params.set('cursor', filters.cursor);
  if (filters.limit) params.set('limit', String(filters.limit));

  return useQuery({
    queryKey: ['admin-ledger', filters],
    queryFn: () => apiFetch<LedgerResponse>(`/api/admin/ledger?${params.toString()}`),
    placeholderData: (prev) => prev,
  });
}
