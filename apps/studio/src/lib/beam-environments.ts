import type { BeamEnvironmentTemplate } from "@beam-studio/shared";

type BeamEnvironmentTemplateStatus = BeamEnvironmentTemplate & {
  roomControlAvailable?: boolean;
};

export const roomTemplateStorageKey = "beam.room-environment-template";

export function selectedRoomTemplateKey() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(roomTemplateStorageKey)?.trim() ?? "";
}

export function setSelectedRoomTemplateKey(templateKey: string) {
  if (typeof window === "undefined") return;
  const value = templateKey.trim();
  if (value) {
    window.localStorage.setItem(roomTemplateStorageKey, value);
  } else {
    window.localStorage.removeItem(roomTemplateStorageKey);
  }
}

export function roomScopeKey() {
  return selectedRoomTemplateKey() || "default-template";
}

export function selectedRoomTemplate(
  settings:
    | {
        defaultTemplateKey?: string;
        templates?: BeamEnvironmentTemplateStatus[];
      }
    | null
    | undefined,
) {
  const templates = settings?.templates ?? [];
  const selectedKey = selectedRoomTemplateKey();
  return (
    templates.find((template) => template.key === selectedKey) ??
    templates.find(
      (template) => template.key === settings?.defaultTemplateKey,
    ) ??
    templates.find((template) => template.key === "prod") ??
    null
  );
}

export function configTemplate(
  settings:
    | {
        defaultTemplateKey?: string;
        templates?: BeamEnvironmentTemplateStatus[];
      }
    | null
    | undefined,
  config: Record<string, unknown>,
) {
  const templates = settings?.templates ?? [];
  const key =
    typeof config.environmentTemplateKey === "string"
      ? config.environmentTemplateKey
      : "";
  return (
    templates.find((template) => template.key === key) ??
    templates.find(
      (template) => template.key === settings?.defaultTemplateKey,
    ) ??
    templates.find((template) => template.key === "prod") ??
    null
  );
}

export function roomTemplateHeaders() {
  const templateKey = selectedRoomTemplateKey();
  return templateKey ? { "x-beam-environment-template": templateKey } : {};
}

/**
 * The CLI ships one binary per channel, each compiled against its own
 * coordinator, so a command naming the wrong one resolves the wrong
 * coordinator and cannot find the room. Templates no longer carry an
 * environment field — migration 0016 removed it — so the channel comes from
 * the template key, which is what identifies the environment now.
 */
export function beamCliBinary(templateKey = selectedRoomTemplateKey()) {
  return templateKey.trim() === "dev" ? "beam-dev" : "beam";
}

export function isDevRoomTemplate(templateKey = selectedRoomTemplateKey()) {
  return templateKey.trim() === "dev";
}
