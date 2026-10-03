// The WatchDesk origin lives in exactly one script (config.js) and in the
// manifest's host_permissions, and nowhere else the extension ships.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WATCHDESK_ORIGIN, WATCHDESK_ORIGINS, WATCHDESK_ENV } from "../config.js";

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const SHIPPED = readdirSync(".").filter((name) => /\.(js|html|css)$/.test(name) && !name.endsWith(".config.js"));

describe("config.js", () => {
  it("defaults to the production origin", () => {
    expect(WATCHDESK_ENV).toBe("production");
    expect(WATCHDESK_ORIGIN).toBe("https://watchdesk-rosy.vercel.app");
  });

  it("keeps a development origin for a local WatchDesk", () => {
    expect(WATCHDESK_ORIGINS.development).toBe("http://localhost:3000");
  });

  it("has a host permission in the manifest for every origin", () => {
    for (const origin of Object.values(WATCHDESK_ORIGINS)) {
      expect(manifest.host_permissions).toContain(`${origin}/*`);
    }
  });

  it("is the only shipped file that names an origin", () => {
    for (const origin of Object.values(WATCHDESK_ORIGINS)) {
      const host = new URL(origin).host;
      const files = SHIPPED.filter((name) => readFileSync(name, "utf8").includes(host));
      expect(files).toEqual(["config.js"]);
    }
  });

  it("keeps the existing permissions and hosts", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(["storage", "alarms", "notifications", "offscreen"]);
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining([
        "https://www.onlinejobs.ph/*",
        "https://www.glassdoor.com/*",
        "https://www.linkedin.com/*",
        "https://www.upwork.com/*",
      ]),
    );
  });
});
