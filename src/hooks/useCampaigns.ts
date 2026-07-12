import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { Campaign, CampaignTargeting } from '@shared/index';
import type { CampaignPacing } from '@/lib/api-types';

export function useCampaigns() {
  return useQuery({
    queryKey: ['campaigns'],
    queryFn: () => apiFetch<{ campaigns: Campaign[] }>('/v1/campaigns'),
    select: (data) => data.campaigns,
  });
}

export function useCampaignPacing(campaignId: string | undefined) {
  return useQuery({
    queryKey: ['campaign-pacing', campaignId],
    queryFn: () => apiFetch<CampaignPacing>(`/v1/campaigns/${campaignId}/pacing`),
    enabled: !!campaignId,
  });
}

export interface CampaignInput {
  name: string;
  creative_media_path: string;
  obligation_type: 'impression_count' | 'share_of_voice';
  obligation_target: number;
  priority_weight?: number;
  flight_start: string;
  flight_end: string;
  targeting?: CampaignTargeting;
  status?: Campaign['status'];
}

export function useCreateCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CampaignInput) => apiFetch<{ campaign: Campaign }>('/v1/campaigns', { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['campaigns'] }),
  });
}

export function usePatchCampaign(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<CampaignInput>) =>
      apiFetch<{ campaign: Campaign }>(`/v1/campaigns/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['campaign-pacing', id] });
    },
  });
}
