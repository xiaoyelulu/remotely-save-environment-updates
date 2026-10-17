import { nanoid } from "nanoid";
import type { Vault } from "obsidian";
import {
  getEnvironmentRelativePath,
  isDeviceLocalConfigPath,
  validateConfigDir,
} from "./environmentPaths";
import type { FakeFs } from "./fsAll";
import { mkdirpInVault } from "./misc";

export class EnvironmentRestoreError extends Error {
  constructor(
    readonly code: "empty" | "invalid" | "incomplete" | "write" | "rollback",
    readonly backupDir?: string
  ) {
    super(`Environment restore: ${code}`);
  }
}

/**
 * A deliberate cloud-to-device restore. A fresh installation's defaults must
 * never win just because their timestamps are newer than the user's settings.
 * Stage and validate everything, then back up all destinations before writing.
 */
export const restoreEnvironment = async (
  vault: Vault,
  remote: Pick<FakeFs, "walk" | "readFile">,
  sourceConfigDir: string,
  pluginId: string,
  onProgress?: (done: number, total: number) => void
) => {
  validateConfigDir(sourceConfigDir);
  validateConfigDir(vault.configDir);
  const entities = await remote.walk();
  const files = new Map<string, { key: string; mtime: number }>();
  for (const entity of entities) {
    const key = entity.key!;
    const relative = getEnvironmentRelativePath(key, sourceConfigDir);
    if (
      relative === undefined ||
      key.endsWith("/") ||
      isDeviceLocalConfigPath(key, sourceConfigDir, pluginId)
    )
      continue;
    if (files.has(relative)) throw new EnvironmentRestoreError("invalid");
    files.set(relative, {
      key,
      mtime: entity.mtimeCli || entity.mtimeSvr || Date.now(),
    });
  }
  if (files.size === 0) throw new EnvironmentRestoreError("empty");

  const backupDir = `${vault.configDir}/plugins/${pluginId}/environment-backups/${Date.now()}-${nanoid(8)}`;
  const adapter = vault.adapter;
  const write = async (
    path: string,
    content: ArrayBuffer,
    mtime?: number,
    ctime?: number
  ) => {
    await mkdirpInVault(path, vault);
    await adapter.writeBinary(path, content, { mtime, ctime });
  };
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value, null, 2))
      .buffer as ArrayBuffer;
  const jsonFiles = new Map<string, unknown>();
  let downloaded = 0;
  for (const [relative, file] of files) {
    const content = await remote.readFile(file.key);
    if (
      /^[^/]+\.json$/.test(relative) ||
      /^plugins\/[^/]+\/manifest\.json$/.test(relative)
    ) {
      try {
        const value: unknown = JSON.parse(new TextDecoder().decode(content));
        if (value === null || typeof value !== "object")
          throw Error("Invalid config object");
        jsonFiles.set(relative, value);
      } catch {
        throw new EnvironmentRestoreError("invalid", backupDir);
      }
    }
    await write(`${backupDir}/staged/${relative}`, content);
    onProgress?.(++downloaded, files.size);
  }

  const pluginFolders = new Set<string>();
  for (const relative of files.keys()) {
    const pluginFolder = /^plugins\/([^/]+)\//.exec(relative)?.[1];
    if (pluginFolder) pluginFolders.add(pluginFolder);
    if (/^plugins\/[^/]+\/manifest\.json$/.test(relative)) {
      const manifest = jsonFiles.get(relative) as { id?: unknown } | null;
      if (typeof manifest?.id !== "string")
        throw new EnvironmentRestoreError("invalid", backupDir);
      if (!files.has(relative.replace(/manifest\.json$/, "main.js"))) {
        throw new EnvironmentRestoreError("incomplete", backupDir);
      }
    }
  }
  for (const id of pluginFolders) {
    if (
      !files.has(`plugins/${id}/manifest.json`) ||
      !files.has(`plugins/${id}/main.js`)
    ) {
      throw new EnvironmentRestoreError("incomplete", backupDir);
    }
  }
  if (jsonFiles.has("community-plugins.json")) {
    const enabled = jsonFiles.get("community-plugins.json");
    if (
      !Array.isArray(enabled) ||
      !enabled.every((id) => typeof id === "string" && /^[^/\\.]+$/.test(id))
    ) {
      throw new EnvironmentRestoreError("invalid", backupDir);
    }
    for (const id of enabled) {
      if (
        id !== pluginId &&
        (!files.has(`plugins/${id}/manifest.json`) ||
          !files.has(`plugins/${id}/main.js`))
      )
        throw new EnvironmentRestoreError("incomplete", backupDir);
    }
    // Keep the user's bootstrap sync plugin enabled on the receiving device.
    await write(
      `${backupDir}/staged/community-plugins.json`,
      encode([...new Set([...enabled, pluginId])])
    );
  }

  const journal: {
    relative: string;
    existed: boolean;
    mtime?: number;
    ctime?: number;
  }[] = [];
  // Write the enabled list last, after every plugin's program and data are ready.
  const paths = [...files.keys()].sort(
    (a, b) =>
      Number(a === "community-plugins.json") -
        Number(b === "community-plugins.json") || a.localeCompare(b)
  );
  for (const relative of paths) {
    const path = `${vault.configDir}/${relative}`;
    const stat = await adapter.stat(path);
    if (stat?.type === "folder")
      throw new EnvironmentRestoreError("invalid", backupDir);
    journal.push({
      relative,
      existed: stat != null,
      mtime: stat?.mtime,
      ctime: stat?.ctime,
    });
    if (stat != null)
      await write(
        `${backupDir}/original/${relative}`,
        await adapter.readBinary(path)
      );
  }
  await write(
    `${backupDir}/journal.json`,
    encode({ configDir: vault.configDir, files: journal })
  );

  const attempted: typeof journal = [];
  try {
    for (const entry of journal) {
      attempted.push(entry); // Include the current file if an adapter partially writes then fails.
      await write(
        `${vault.configDir}/${entry.relative}`,
        await adapter.readBinary(`${backupDir}/staged/${entry.relative}`),
        files.get(entry.relative)!.mtime
      );
    }
  } catch (error) {
    console.error("Environment restore failed; restoring local backups", error);
    let rollbackFailed = false;
    for (const entry of attempted.reverse()) {
      try {
        const path = `${vault.configDir}/${entry.relative}`;
        if (entry.existed) {
          await write(
            path,
            await adapter.readBinary(`${backupDir}/original/${entry.relative}`),
            entry.mtime,
            entry.ctime
          );
        } else if (await adapter.exists(path)) {
          await adapter.remove(path);
        }
      } catch (rollbackError) {
        rollbackFailed = true;
        console.error("Environment restore rollback failed", rollbackError);
      }
    }
    throw new EnvironmentRestoreError(
      rollbackFailed ? "rollback" : "write",
      backupDir
    );
  }
  return { fileCount: files.size, backupDir };
};
