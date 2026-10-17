// Run after `npm run build` or `npm run build2`. Exercise the production bundle against a
// temporary WebDAV server, with Obsidian's documented adapter/requestUrl boundary
// supplied by a small host stub. No personal vault or cloud account is accessed.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { v2: webdav } = require("webdav-server");
const { JSDOM } = require("jsdom");
const { randomBytes, pbkdf2Sync, createCipheriv } = require("node:crypto");

async function main() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "remotely-save-webdav-")
  );
  const cloud = path.join(root, "cloud");
  const device = path.join(root, "device");
  const messages = [];
  let requests = 0;
  let ios = false;
  const server = new webdav.WebDAVServer({
    port: 0,
    hostname: "127.0.0.1",
    requireAuthentification: false,
  });
  const put = async (base, relative, content) => {
    const fullPath = path.join(base, relative);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  };
  const source = {
    "appearance.json": '{"baseFontSize":23,"cssTheme":"Minimal"}',
    "hotkeys.json": '{"app:go-back":[{"modifiers":["Mod"],"key":"B"}]}',
    "community-plugins.json": '["calendar","remotely-save"]',
    "plugins/calendar/main.js": "// test plugin program",
    "plugins/calendar/manifest.json": '{"id":"calendar","isDesktopOnly":false}',
    "plugins/calendar/data.json": '{"weekStart":1}',
    "themes/Minimal/theme.css": "body {color: purple}",
    "plugins/remotely-save/data.json": "credentials from another device",
    "workspace-mobile.json": "other-device-layout",
  };
  const encrypt = (value) => {
    const salt = randomBytes(8);
    const keyAndIv = pbkdf2Sync("test-password", salt, 20000, 48, "sha256");
    const cipher = createCipheriv(
      "aes-256-cbc",
      keyAndIv.subarray(0, 32),
      keyAndIv.subarray(32)
    );
    return Buffer.concat([
      Buffer.from("Salted__"),
      salt,
      cipher.update(value),
      cipher.final(),
    ]);
  };
  const notices = class {
    constructor(message) {
      messages.push(message);
    }
    setMessage() {}
    hide() {}
  };
  const host = {
    Plugin: class {},
    Modal: class {},
    PluginSettingTab: class {},
    Events: class {},
    FileSystemAdapter: class {},
    Notice: notices,
    Platform: {
      get isIosApp() {
        return ios;
      },
      isAndroidApp: false,
    },
    requireApiVersion: () => true,
    requestUrl: async ({ url, method, body, headers }) => {
      requests++;
      const response = await fetch(url, { method, body, headers });
      const arrayBuffer = await response.arrayBuffer();
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        arrayBuffer,
        text: new TextDecoder().decode(arrayBuffer),
      };
    },
  };
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  try {
    for (const [relative, content] of Object.entries(source)) {
      await put(cloud, `vault/.obsidian/${relative}`, content);
      await put(
        cloud,
        `encrypted/${encrypt(`.obsidian/${relative}`).toString("base64url")}`,
        encrypt(content)
      );
    }
    await new Promise((resolve) =>
      server.setFileSystem("/", new webdav.PhysicalFileSystem(cloud), resolve)
    );
    await new Promise((resolve) => server.start(resolve));
    global.window = global;
    global.moment = (value) => ({
      format: () => new Date(value).toISOString(),
      toISOString: () => new Date(value).toISOString(),
    });
    global.document = new JSDOM(
      "<!doctype html><html><body></body></html>"
    ).window.document;
    global.DOMParser = document.defaultView.DOMParser;
    for (const name of [
      "Node",
      "Element",
      "HTMLElement",
      "DocumentFragment",
      "Text",
      "XMLSerializer",
    ]) {
      global[name] = document.defaultView[name];
    }
    Module._load = function (request, ...args) {
      if (request === "obsidian") return host;
      if (args[0]?.filename === path.resolve(__dirname, "../main.js")) {
        throw Error(
          `Production plugin requested a desktop-only module: ${request}`
        );
      }
      return originalLoad.call(this, request, ...args);
    };
    const Plugin = require("../main.js").default;
    const plugin = new Plugin();
    plugin.manifest = { id: "remotely-save", version: "0.5.27" };
    plugin.i18n = { t: (key, vars) => `${key} ${JSON.stringify(vars ?? {})}` };
    const toLocalPath = (relative) => {
      const fullPath = path.resolve(device, relative);
      assert.ok(fullPath.startsWith(`${device}/`));
      return fullPath;
    };
    plugin.app = {
      vault: {
        configDir: ".obsidian",
        getName: () => "vault",
        adapter: {
          exists: async (p) =>
            fs.access(toLocalPath(p)).then(
              () => true,
              () => false
            ),
          mkdir: async (p) => fs.mkdir(toLocalPath(p)),
          stat: async (p) => {
            try {
              const stat = await fs.stat(toLocalPath(p));
              return {
                type: stat.isDirectory() ? "folder" : "file",
                mtime: stat.mtimeMs,
                ctime: stat.ctimeMs,
                size: stat.size,
              };
            } catch (error) {
              if (error.code === "ENOENT") return null;
              throw error;
            }
          },
          readBinary: async (p) => {
            const buffer = await fs.readFile(toLocalPath(p));
            return buffer.buffer.slice(
              buffer.byteOffset,
              buffer.byteOffset + buffer.byteLength
            );
          },
          writeBinary: async (p, content, options) => {
            await fs.writeFile(toLocalPath(p), Buffer.from(content));
            if (options?.mtime)
              await fs.utimes(
                toLocalPath(p),
                new Date(),
                new Date(options.mtime)
              );
          },
          remove: async (p) => fs.unlink(toLocalPath(p)),
        },
      },
    };
    let saves = 0;
    plugin.saveSettings = async () => {
      saves++;
    };
    for (const platform of [
      "desktop",
      "ios",
      "desktop-encrypted",
      "ios-encrypted",
    ]) {
      ios = platform.startsWith("ios");
      const encrypted = platform.endsWith("encrypted");
      plugin.environmentRestartRequired = false;
      plugin.settings = {
        serviceType: "webdav",
        password: encrypted ? "test-password" : "",
        encryptionMethod: encrypted ? "openssl-base64" : "rclone-base64",
        webdav: {
          address: `http://127.0.0.1:${server.server.address().port}`,
          username: "",
          password: "",
          remoteBaseDir: encrypted ? "encrypted" : "vault",
          depth: "manual_1",
          manualRecursive: true,
        },
      };
      await put(device, ".obsidian/appearance.json", '{"baseFontSize":16}');
      await put(
        device,
        ".obsidian/plugins/remotely-save/data.json",
        "device credentials"
      );
      const countBefore = requests;
      await plugin.restoreUsageEnvironment(".obsidian");
      assert.ok(
        requests > countBefore,
        "Production WebDAV client must make real HTTP requests"
      );
      assert.equal(
        await fs.readFile(
          path.join(device, ".obsidian/appearance.json"),
          "utf8"
        ),
        source["appearance.json"]
      );
      assert.equal(
        await fs.readFile(path.join(device, ".obsidian/hotkeys.json"), "utf8"),
        source["hotkeys.json"]
      );
      assert.equal(
        await fs.readFile(
          path.join(device, ".obsidian/plugins/calendar/data.json"),
          "utf8"
        ),
        source["plugins/calendar/data.json"]
      );
      assert.equal(
        await fs.readFile(
          path.join(device, ".obsidian/plugins/remotely-save/data.json"),
          "utf8"
        ),
        "device credentials"
      );
      assert.equal(plugin.settings.syncConfigDir, true);
      assert.equal(plugin.environmentRestartRequired, true);
      assert.equal(plugin.isSyncing, false);
      assert.ok(messages.some((m) => m.startsWith("environment_restored")));
      const afterRestore = requests;
      await plugin.syncRun("manual");
      assert.equal(requests, afterRestore, "Sync must pause until restart");
      console.log(
        `Production WebDAV restore passed (${platform} host boundary)`
      );
    }
    assert.equal(saves, 4);

    // Normal sync must also refresh an existing account before WebDAV runs.
    // Fake only the account API; WebDAV still uses the real loopback server.
    const accountRequests = [];
    const newFeatures = [
      {
        featureName: "feature-smart_conflict",
        expireAtTimeMs: Date.now() + 86400000,
      },
    ];
    global.fetch = async (url, options) => {
      if (url === "https://remotelysave.com/api/v1/oauth2/token") {
        const body = new URLSearchParams(options.body);
        assert.equal(body.get("refresh_token"), "test-refresh-token");
        assert.ok(body.get("client_id").startsWith("cli-"));
        accountRequests.push("refresh");
        return new Response(
          JSON.stringify({
            access_token: "test-access-token",
            expires_in: 3600,
          })
        );
      }
      if (url === "https://remotelysave.com/api/v1/pro/list") {
        assert.equal(options.headers.Authorization, "Bearer test-access-token");
        accountRequests.push("features");
        return new Response(JSON.stringify({ proFeatures: newFeatures }));
      }
      assert.ok(
        typeof url === "string" &&
          url.startsWith(`http://127.0.0.1:${server.server.address().port}/`),
        `Unexpected network destination in smoke test: ${url}`
      );
      return originalFetch(url, options);
    };
    const values = new Map();
    const table = {
      setItem: async (key, value) => {
        values.set(key, value);
        return value;
      },
      getItems: async () => ({}),
    };
    plugin.db = {
      prevSyncRecordsTbl: table,
      syncPlansTbl: table,
      simpleKVForMiscTbl: table,
    };
    plugin.vaultRandomID = "test-vault";
    plugin.app.vault.getAllLoadedFiles = () => [];
    plugin.environmentRestartRequired = false;
    plugin.settings = {
      serviceType: "webdav",
      password: "",
      encryptionMethod: "rclone-base64",
      conflictAction: "smart_conflict",
      syncConfigDir: false,
      webdav: {
        address: `http://127.0.0.1:${server.server.address().port}`,
        username: "",
        password: "",
        remoteBaseDir: "vault",
        depth: "manual_1",
        manualRecursive: true,
      },
      pro: {
        accessToken: "",
        accessTokenExpiresAtTimeMs: 0,
        refreshToken: "test-refresh-token",
        enabledProFeatures: [
          { featureName: "feature-smart_conflict", expireAtTimeMs: 1 },
        ],
      },
    };
    await plugin.syncRun("dry");
    assert.deepEqual(accountRequests, ["refresh", "features"]);
    assert.equal(
      values.has("test-vault-lastFailedSyncMillis"),
      false,
      "Dry sync must finish without an account/network failure"
    );
    assert.equal(values.has("test-vault-lastSuccessSyncMillis"), true);
    assert.ok(
      [...values.keys()].some((key) => key.startsWith("test-vault\t")),
      "Dry sync must reach sync-plan generation"
    );
    assert.equal(plugin.isSyncing, false);
    console.log(
      "Production normal sync passed (expired account token, official endpoint, WebDAV dry run)"
    );
  } finally {
    global.fetch = originalFetch;
    Module._load = originalLoad;
    if (server.server?.listening)
      await new Promise((resolve) => server.stop(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
