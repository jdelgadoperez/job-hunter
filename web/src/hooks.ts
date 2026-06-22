import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type SettingsUpdate, api } from "./api";

export function useMatches(minScore: number) {
  return useQuery({
    queryKey: ["matches", minScore],
    queryFn: () => api.getMatches(minScore),
  });
}

export function useCompanies() {
  return useQuery({ queryKey: ["companies"], queryFn: api.getCompanies });
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

/** Poll the background scan status; refetch quickly while a scan is running, idle otherwise. */
export function useScanStatus() {
  return useQuery({
    queryKey: ["scan-status"],
    queryFn: api.getScanStatus,
    refetchInterval: (query) => (query.state.data?.state === "running" ? 1000 : false),
  });
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
