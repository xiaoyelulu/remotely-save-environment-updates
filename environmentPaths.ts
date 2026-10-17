import { isSpecialFolderNameToSkip } from "./misc";

export const SYNC_PLUGIN_ID = "remotely-save";

export const validateConfigDir = (configDir: string) => {
  if (
    !/^\.[^/\\]+$/.test(configDir) ||
    configDir === "." ||
    configDir === ".."
  ) {
    throw Error("Invalid Obsidian configuration folder");
  }
};

/** These files belong to the running device, even when config sync is enabled. */
export const isDeviceLocalConfigPath = (
  key: string,
  configDir: string,
  pluginId = SYNC_PLUGIN_ID
) => {
  if (!key.startsWith(`${configDir}/`)) return false;
  const relative = key.slice(configDir.length + 1).replace(/\/$/, "");
  const parts = relative.split("/");
  return (
    relative === `plugins/${pluginId}` ||
    relative.startsWith(`plugins/${pluginId}/`) ||
    /^(workspace|workspace-mobile)(\.json)?$/.test(parts[0]) ||
    parts.some((part) => isSpecialFolderNameToSkip(part, []))
  );
};

/** Validate before using a remote path with the local adapter. */
export const getEnvironmentRelativePath = (key: string, configDir: string) => {
  if (!key.startsWith(`${configDir}/`)) return undefined;
  const relative = key.slice(configDir.length + 1).replace(/\/$/, "");
  if (relative === "") return undefined;
  if (
    relative.includes("\\") ||
    relative.includes("\0") ||
    relative
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw Error(`Invalid environment path: ${key}`);
  }
  return relative;
};
