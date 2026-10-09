import {
  selectedRoomTemplate,
  selectedRoomTemplateKey,
  setSelectedRoomTemplateKey,
} from "@/lib/beam-environments";
import { useBeamEnvironmentSettings } from "@/features/settings/beam-environment-data";

export function RoomEnvironmentSelect() {
  const { data: settings, isPending } = useBeamEnvironmentSettings();
  if (!settings?.devSettingsEnabled) return null;
  const selected = selectedRoomTemplate(settings);
  const value = selected?.key || settings.defaultTemplateKey;

  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      Beam environment
      <select
        aria-label="Beam environment template"
        className="rounded-control border bg-background p-2 text-foreground"
        disabled={isPending}
        value={value}
        onChange={(event) => {
          setSelectedRoomTemplateKey(event.target.value);
          window.location.assign("/rooms");
        }}
      >
        {settings.templates.map((template) => (
          <option
            disabled={!template.roomControlAvailable}
            key={template.key}
            value={template.key}
          >
            {template.name}
          </option>
        ))}
      </select>
    </label>
  );
}
