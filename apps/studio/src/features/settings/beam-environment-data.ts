import { useQuery } from "@tanstack/react-query";
import type { BeamEnvironmentTemplate } from "@beam-studio/shared";
import { apiGet } from "@/lib/api-client";

export type BeamEnvironmentSettings = {
  devSettingsEnabled: boolean;
  defaultTemplateKey: string;
  /** Installation-wide: the action comes from the Registry, not a Beam environment. */
  roomTransferAction?: {
    available: boolean;
    version: string;
    reason?: string;
  };
  templates: Array<
    BeamEnvironmentTemplate & {
      roomControlAvailable: boolean;
    }
  >;
};

export const beamEnvironmentSettingsQueryKey = [
  "/studio/beam-environment-settings",
] as const;

export function useBeamEnvironmentSettings() {
  return useQuery({
    queryKey: beamEnvironmentSettingsQueryKey,
    queryFn: () =>
      apiGet<BeamEnvironmentSettings>("/studio/beam-environment-settings"),
    staleTime: 30_000,
  });
}
