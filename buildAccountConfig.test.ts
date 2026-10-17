import { strict as assert } from "assert";
import accountBuildConfig from "../buildAccountConfig.cjs";

const { resolveAccountBuildConfig } = accountBuildConfig;

describe("Account service build configuration", () => {
  it("uses an absolute official endpoint and a public client ID in credential-free builds", () => {
    const config = resolveAccountBuildConfig({});
    assert.equal(config.website, "https://remotelysave.com");
    assert.ok(config.clientId.startsWith("cli-"));
    assert.equal(
      new URL("api/v1/oauth2/token", `${config.website}/`).origin,
      "https://remotelysave.com"
    );
  });

  it("treats empty environment variables as missing, rather than fetching app:// paths", () => {
    for (const value of ["", "   "]) {
      const config = resolveAccountBuildConfig({
        REMOTELYSAVE_WEBSITE: value,
        REMOTELYSAVE_CLIENT_ID: value,
      });
      assert.equal(config.website, "https://remotelysave.com");
      assert.ok(config.clientId.length > 4);
    }
  });

  it("preserves explicit developer endpoints and public client IDs", () => {
    const config = resolveAccountBuildConfig({
      REMOTELYSAVE_WEBSITE: " http://127.0.0.1:46683/ ",
      REMOTELYSAVE_CLIENT_ID: " cli-test ",
    });
    assert.deepEqual(config, {
      website: "http://127.0.0.1:46683",
      clientId: "cli-test",
    });
  });

  it("fails the build for relative paths, non-HTTP schemes or URLs containing credentials", () => {
    for (const website of [
      "/",
      "remotelysave.com",
      "app://obsidian.md",
      "file:///api",
      "https://user:password@example.com",
    ]) {
      assert.throws(() =>
        resolveAccountBuildConfig({ REMOTELYSAVE_WEBSITE: website })
      );
    }
  });
});
