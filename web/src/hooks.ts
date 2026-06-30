import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type MatchFilters,
  type ScoredPosting,
  type SettingsUpdate,
  type UserAction,
} from "./api";

export function useMatches(minScore: number, filters: MatchFilters = {}) {
  return useQuery({
    queryKey: [
      "matches",
      minScore,
      filters.includeExpired ?? false,
      filters.includeDismissed ?? false,
      filters.remoteOnly ?? false,
      filters.country ?? "",
      filters.includeApplied ?? false,
      filters.onlyApplied ?? false,
    ],
    queryFn: () => api.getMatches(minScore, filters),
  });
}

type MatchActionVars = { id: string; action: UserAction | null };

export function useMatchAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: MatchActionVars) => {
      if (vars.action) await api.setMatchAction(vars.id, vars.action);
      else await api.clearMatchAction(vars.id);
    },
    // Optimistically patch the posting's action across every cached matches query so the button
    // state flips instantly. Snapshot the prior cache for rollback on error.
    onMutate: async (vars: MatchActionVars) => {
      await qc.cancelQueries({ queryKey: ["matches"] });
      const snapshot = qc.getQueriesData<ScoredPosting[]>({ queryKey: ["matches"] });
      for (const [key, data] of snapshot) {
        if (!data) continue;
        qc.setQueryData(
          key,
          data.map((m) => (m.posting.id === vars.id ? { ...m, action: vars.action } : m)),
        );
      }
      return { snapshot };
    },
    onError: (_error, _vars, context) => {
      for (const [key, data] of context?.snapshot ?? []) qc.setQueryData(key, data);
    },
    // Re-sync with the server regardless of outcome (a successful write can change expiry/ordering
    // that the optimistic patch doesn't model).
    onSettled: () => qc.invalidateQueries({ queryKey: ["matches"] }),
  });
}

export function useCompanies() {
  return useQuery({ queryKey: ["companies"], queryFn: api.getCompanies });
}

export function useManualReviewCompanies() {
  return useQuery({
    queryKey: ["companies", "manual-review"],
    queryFn: api.getManualReviewCompanies,
  });
}

export function useAddCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ careersUrl, name }: { careersUrl: string; name?: string }) =>
      api.addCompany(careersUrl, name),
    onSuccess: (companies) => qc.setQueryData(["companies"], companies),
  });
}

export function useRemoveCompany() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (careersUrl: string) => api.removeCompany(careersUrl),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["companies"] }),
  });
}

export function useProfile() {
  return useQuery({ queryKey: ["profile"], queryFn: api.getProfile });
}

export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (update: SettingsUpdate) => api.putSettings(update),
    onSuccess: (data) => qc.setQueryData(["settings"], data),
  });
}

export function useUploadResume() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.uploadResume(file),
    onSuccess: (data) => qc.setQueryData(["profile"], data),
  });
}

export function useUpdateProfileSkills() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skills: string[]) => api.updateProfileSkills(skills),
    onSuccess: (profile) => qc.setQueryData(["profile"], profile),
  });
}

export function useSkills() {
  return useQuery({ queryKey: ["skills"], queryFn: api.getSkills });
}

export function useAddSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, category }: { name: string; category?: string }) =>
      api.addSkill(name, category),
    onSuccess: (skills) => qc.setQueryData(["skills"], skills),
  });
}

export function useRemoveSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.removeSkill(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}

/** Poll the background scan status; refetch quickly while a scan is running, idle otherwise. */
export function useScanStatus() {
  return useQuery({
    queryKey: ["scan-status"],
    queryFn: api.getScanStatus,
    refetchInterval: (query) => (query.state.data?.state === "running" ? 1000 : false),
  });
}

export function useLatestScan() {
  return useQuery({ queryKey: ["latest-scan"], queryFn: api.getLatestScan });
}

export function useVersion() {
  return useQuery({ queryKey: ["version"], queryFn: api.getVersion, staleTime: 60 * 60 * 1000 });
}

export function useStartScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.startScan,
    onSuccess: (status) => {
      qc.setQueryData(["scan-status"], status);
      // A finished scan means new matches — refresh them.
      if (status.state === "done") qc.invalidateQueries({ queryKey: ["matches"] });
    },
  });
}
