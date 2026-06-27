import type { SettingsReader } from "./resolve-settings";
import { REMOTE_ONLY_SETTING } from "./settings-keys";

/**
 * Resolve the remote-only preference: an explicit per-run override wins; otherwise the saved
 * `remoteOnly` setting (`"true"` enables it, anything else / unset disables it).
 */
export function resolveRemoteOnly(settings: SettingsReader, override?: boolean): boolean {
  if (override !== undefined) return override;
  return settings.getSetting(REMOTE_ONLY_SETTING) === "true";
}
