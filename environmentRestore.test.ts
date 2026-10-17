import { strict as assert } from "assert";
import type { Vault } from "obsidian";
import type { Entity } from "../src/baseTypes";
import { isDeviceLocalConfigPath } from "../src/environmentPaths";
import {
  EnvironmentRestoreError,
  restoreEnvironment,
} from "../src/environmentRestore";
import { listFilesInObsFolder } from "../src/obsFolderLister";

const bytes = (text: string) =>
  new TextEncoder().encode(text).buffer as ArrayBuffer;
const text = (content: ArrayBuffer) => new TextDecoder().decode(content);

class MemoryVault {
  configDir = ".obsidian";
  files = new Map<
    string,
    { content: ArrayBuffer; mtime: number; ctime: number }
  >();
  folders = new Set([".obsidian"]);
  failWrite?: string;
  failRead?: string;
  writes: string[] = [];
  put(path: string, value: string, mtime = 9000) {
    this.files.set(path, { content: bytes(value), mtime, ctime: 100 });
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++)
      this.folders.add(parts.slice(0, i).join("/"));
  }
  adapter = {
    exists: async (path: string) =>
      this.files.has(path) || this.folders.has(path),
    mkdir: async (path: string) => {
      this.folders.add(path);
    },
    stat: async (path: string) => {
      const file = this.files.get(path);
      if (file)
        return {
          type: "file",
          mtime: file.mtime,
          ctime: file.ctime,
          size: file.content.byteLength,
        };
      return this.folders.has(path)
        ? { type: "folder", mtime: 0, ctime: 0, size: 0 }
        : null;
    },
    list: async (path: string) => {
      const isChild = (p: string) =>
        p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/");
      return {
        files: [...this.files.keys()].filter(isChild),
        folders: [...this.folders].filter(isChild),
      };
    },
    readBinary: async (path: string) => {
      if (path === this.failRead) throw Error("simulated backup read failure");
      const file = this.files.get(path);
      if (!file) throw Error(`missing ${path}`);
      return file.content.slice(0);
    },
    writeBinary: async (
      path: string,
      content: ArrayBuffer,
      options?: { mtime?: number; ctime?: number }
    ) => {
      this.writes.push(path);
      this.files.set(path, {
        content: content.slice(0),
        mtime: options?.mtime ?? 10000,
        ctime: options?.ctime ?? 10000,
      });
      if (path === this.failWrite) {
        this.failWrite = undefined; // Simulate partial write, then allow rollback.
        throw Error("simulated disk failure");
      }
    },
    remove: async (path: string) => {
      this.files.delete(path);
    },
  };
  asVault() {
    return this as unknown as Vault;
  }
  get(path: string) {
    return text(this.files.get(path)!.content);
  }
}

const remote = (contents: Record<string, string>, failRead?: string) => ({
  walk: async (): Promise<Entity[]> =>
    Object.entries(contents).map(([key, value]) => ({
      key,
      keyRaw: key,
      sizeRaw: bytes(value).byteLength,
      size: bytes(value).byteLength,
      mtimeCli: 1000,
    })),
  readFile: async (key: string) => {
    if (key === failRead) throw Error("simulated network failure");
    return bytes(contents[key]);
  },
});

describe("Complete usage environment", () => {
  it("restores cloud preferences over newer defaults, themes, snippets, hotkeys, plugin programs and data", async () => {
    const local = new MemoryVault();
    local.put(".obsidian/appearance.json", '{"baseFontSize":16}');
    local.put(
      ".obsidian/plugins/remotely-save/data.json",
      "device credentials"
    );
    local.put(
      ".obsidian/plugins/remotely-save/main.js",
      "installed sync version"
    );
    const contents = {
      ".obsidian/app.json": '{"vimMode":true}',
      ".obsidian/appearance.json":
        '{"baseFontSize":22,"theme":"obsidian","cssTheme":"Minimal"}',
      ".obsidian/hotkeys.json":
        '{"app:go-back":[{"modifiers":["Mod"],"key":"B"}]}',
      ".obsidian/core-plugins.json": '["backlink","graph"]',
      ".obsidian/community-plugins.json": '["calendar"]',
      ".obsidian/themes/Minimal/theme.css": "body {color: red}",
      ".obsidian/themes/Minimal/manifest.json": '{"name":"Minimal"}',
      ".obsidian/snippets/my-style.css": "body {font-size:22px}",
      ".obsidian/plugins/calendar/manifest.json":
        '{"id":"calendar","isDesktopOnly":false}',
      ".obsidian/plugins/calendar/main.js": "calendar program",
      ".obsidian/plugins/calendar/data.json": '{"weekStart":1}',
      ".obsidian/plugins/calendar/assets/icon.svg": "<svg />",
      ".obsidian/plugins/remotely-save/data.json": "other device credentials",
      ".obsidian/plugins/remotely-save/main.js": "old sync version",
      ".obsidian/workspace.json": "other device window layout",
      ".obsidian/workspace-mobile.json": "other device mobile layout",
      "notes/hello.md": "note untouched by environment restore",
    };
    const result = await restoreEnvironment(
      local.asVault(),
      remote(contents),
      ".obsidian",
      "remotely-save"
    );
    assert.equal(
      local.get(".obsidian/appearance.json"),
      contents[".obsidian/appearance.json"]
    );
    assert.equal(local.files.get(".obsidian/appearance.json")!.mtime, 1000);
    assert.equal(
      local.get(".obsidian/plugins/calendar/data.json"),
      '{"weekStart":1}'
    );
    assert.equal(
      local.get(".obsidian/plugins/calendar/assets/icon.svg"),
      "<svg />"
    );
    assert.deepEqual(
      JSON.parse(local.get(".obsidian/community-plugins.json")),
      ["calendar", "remotely-save"]
    );
    assert.equal(
      local.get(".obsidian/plugins/remotely-save/data.json"),
      "device credentials"
    );
    assert.equal(
      local.get(".obsidian/plugins/remotely-save/main.js"),
      "installed sync version"
    );
    assert.equal(
      local.get(`${result.backupDir}/original/appearance.json`),
      '{"baseFontSize":16}'
    );
    assert.ok(!local.files.has(".obsidian/workspace.json"));
    assert.ok(!local.files.has("notes/hello.md"));
    assert.equal(result.fileCount, 12);
    assert.equal(
      local.writes.filter((p) => !p.startsWith(result.backupDir)).slice(-1)[0],
      ".obsidian/community-plugins.json"
    );
  });

  it("maps a source config folder to a different device config folder", async () => {
    const local = new MemoryVault();
    local.configDir = ".obsidian-mobile";
    await restoreEnvironment(
      local.asVault(),
      remote({ ".obsidian/hotkeys.json": "{}" }),
      ".obsidian",
      "remotely-save"
    );
    assert.equal(local.get(".obsidian-mobile/hotkeys.json"), "{}");
    assert.ok(!local.files.has(".obsidian/hotkeys.json"));
  });

  it("does not change settings when download or backup fails", async () => {
    for (const failure of ["network", "backup"]) {
      const local = new MemoryVault();
      local.put(".obsidian/app.json", '{"vimMode":false}');
      if (failure === "backup") local.failRead = ".obsidian/app.json";
      await assert.rejects(
        restoreEnvironment(
          local.asVault(),
          remote(
            {
              ".obsidian/app.json": '{"vimMode":true}',
              ".obsidian/appearance.json": "{}",
            },
            failure === "network" ? ".obsidian/appearance.json" : undefined
          ),
          ".obsidian",
          "remotely-save"
        )
      );
      assert.equal(local.get(".obsidian/app.json"), '{"vimMode":false}');
      assert.ok(!local.files.has(".obsidian/appearance.json"));
    }
  });

  it("rolls back partial writes and removes newly created files", async () => {
    const local = new MemoryVault();
    local.put(".obsidian/app.json", '{"vimMode":false}');
    local.failWrite = ".obsidian/hotkeys.json";
    await assert.rejects(
      restoreEnvironment(
        local.asVault(),
        remote({
          ".obsidian/app.json": '{"vimMode":true}',
          ".obsidian/appearance.json": "{}",
          ".obsidian/hotkeys.json": "{}",
        }),
        ".obsidian",
        "remotely-save"
      ),
      (e: unknown) => e instanceof EnvironmentRestoreError && e.code === "write"
    );
    assert.equal(local.get(".obsidian/app.json"), '{"vimMode":false}');
    assert.equal(local.files.get(".obsidian/app.json")!.mtime, 9000);
    assert.ok(!local.files.has(".obsidian/appearance.json"));
    assert.ok(!local.files.has(".obsidian/hotkeys.json"));
  });

  it("rejects invalid JSON, incomplete plugin programs, and missing enabled plugins before applying", async () => {
    for (const contents of [
      { ".obsidian/appearance.json": "{" },
      { ".obsidian/community-plugins.json": '["missing"]' },
      { ".obsidian/community-plugins.json": "{}" },
      { ".obsidian/plugins/calendar/manifest.json": '{"id":"calendar"}' },
    ] as Record<string, string>[]) {
      const local = new MemoryVault();
      local.put(".obsidian/appearance.json", "{}");
      await assert.rejects(
        restoreEnvironment(
          local.asVault(),
          remote(contents),
          ".obsidian",
          "remotely-save"
        ),
        EnvironmentRestoreError
      );
      assert.equal(local.get(".obsidian/appearance.json"), "{}");
      assert.ok(local.writes.every((p) => p.includes("/environment-backups/")));
    }
  });

  it("rejects traversal and empty cloud environments without modifying local files", async () => {
    for (const key of [
      ".obsidian/../note.md",
      ".obsidian/plugins/../../note.md",
      ".obsidian/a\\b",
      "notes/hello.md",
    ]) {
      const local = new MemoryVault();
      await assert.rejects(
        restoreEnvironment(
          local.asVault(),
          remote({ [key]: "bad" }),
          ".obsidian",
          "remotely-save"
        )
      );
      assert.equal(local.files.size, 0);
    }
    const local = new MemoryVault();
    await assert.rejects(
      restoreEnvironment(
        local.asVault(),
        remote({}),
        "../other",
        "remotely-save"
      )
    );
    assert.equal(local.files.size, 0);
  });

  it("lists the whole environment while excluding sync credentials, backups and device layouts", async () => {
    const local = new MemoryVault();
    for (const path of [
      ".obsidian/appearance.json",
      ".obsidian/hotkeys.json",
      ".obsidian/plugins/other/data.json",
      ".obsidian/plugins/other/main.js",
      ".obsidian/plugins/other/assets/icon.svg",
      ".obsidian/themes/Minimal/theme.css",
      ".obsidian/plugins/remotely-save/data.json",
      ".obsidian/plugins/remotely-save/environment-backups/old/original/app.json",
      ".obsidian/workspace.json",
      ".obsidian/workspace-mobile.json",
      ".obsidian/plugins/other/node_modules/a.js",
    ])
      local.put(path, "content");
    const keys = (
      await listFilesInObsFolder(
        ".obsidian",
        local.asVault(),
        "remotely-save",
        false
      )
    ).map((e) => e.key);
    assert.ok(keys.includes(".obsidian/plugins/other/assets/icon.svg"));
    assert.ok(keys.includes(".obsidian/themes/Minimal/theme.css"));
    assert.ok(!keys.some((k) => isDeviceLocalConfigPath(k!, ".obsidian")));
    const bookmarks = await listFilesInObsFolder(
      ".obsidian",
      local.asVault(),
      "remotely-save",
      true
    );
    assert.deepEqual(
      bookmarks.map((e) => e.key),
      [".obsidian/"]
    );
  });
});
