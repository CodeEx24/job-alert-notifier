// WD-72: the popup's page still has every control the shipped popup had. The
// account work (WD-42, WD-54) and the tickets running beside this one add to
// popup.html; this fails when one of them takes something away.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";
import { REFERENCE_ROOT } from "./helpers/popup-harness.js";

const ROOT = resolve(REFERENCE_ROOT || ".");

// Every element with an id in the shipped popup.html, in document order, as
// [id, tag or tag:type].
const SHIPPED = [
  ["settings-toggle", "button"],
  ["update-banner", "div"],
  ["update-banner-text", "span"],
  ["settings-panel", "section"],
  ["settings-close", "button"],
  ["pause-all", "button"],
  ["resume-all", "button"],
  ["settings-per-site-section", "div"],
  ["settings-per-site-toggle", "button"],
  ["settings-per-site-count", "span"],
  ["settings-per-site", "div"],
  ["mute-notifications", "input:checkbox"],
  ["settings-title-filter-section", "div"],
  ["title-filter-enabled", "input:checkbox"],
  ["title-filter-keywords", "div"],
  ["title-filter-new-keyword", "input:text"],
  ["title-filter-add-btn", "button"],
  ["export-settings", "button"],
  ["import-settings-btn", "button"],
  ["import-settings-file", "input:file"],
  ["reset-extension", "button"],
  ["settings-status-msg", "div"],
  ["about-version", "p"],
  ["interval", "select"],
  ["check-now", "button"],
  ["sound", "select"],
  ["test-sound", "button"],
  ["open-required-tabs", "button"],
  ["check-status", "div"],
  ["check-status-gap", "div"],
  ["watch-list-banner", "div"],
  ["watch-list", "section"],
  ["new-url", "input:url"],
  ["new-label", "input:text"],
  ["add-watch", "button"],
  ["add-error", "div"],
  ["feed-applied-count", "span"],
  ["mark-all-visited", "button"],
  ["clear-feed", "button"],
  ["feed-search", "input:search"],
  ["feed-platform-filter", "select"],
  ["feed-workplace-filter", "select"],
  ["feed-status-filter", "select"],
  ["feed-sort", "select"],
  ["feed-summary", "div"],
  ["feed-list", "div"],
  ["feed-pagination", "div"],
  ["status", "span"],
];

// The settings the ticket names, and where the shipped popup has them.
const IN_SETTINGS_PANEL = ["mute-notifications", "title-filter-enabled", "title-filter-keywords", "title-filter-new-keyword", "title-filter-add-btn"];
const ON_THE_MAIN_PAGE = ["interval", "check-now", "sound", "test-sound", "open-required-tabs"];

let doc;
beforeAll(() => {
  doc = new JSDOM(readFileSync(resolve(ROOT, "popup.html"), "utf8")).window.document;
});

const kind = (el) => el.tagName.toLowerCase() + (el.tagName === "INPUT" ? `:${el.type}` : "");

describe("popup.html keeps every control of the shipped popup", () => {
  it.each(SHIPPED)("#%s is still a %s", (id, expected) => {
    const el = doc.getElementById(id);
    expect(el, `#${id} is gone`).not.toBeNull();
    expect(kind(el)).toBe(expected);
    expect(doc.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
  });

  it("keeps them in the shipped order", () => {
    const shippedIds = new Set(SHIPPED.map(([id]) => id));
    const now = [...doc.querySelectorAll("[id]")].map((el) => el.id).filter((id) => shippedIds.has(id));
    expect(now).toEqual(SHIPPED.map(([id]) => id));
  });

  it("keeps mute and the keyword filter in the settings panel, which the gear opens", () => {
    const panel = doc.getElementById("settings-panel");
    for (const id of IN_SETTINGS_PANEL) expect(panel.contains(doc.getElementById(id)), id).toBe(true);
    expect(panel.contains(doc.getElementById("settings-toggle"))).toBe(false);

    const css = readFileSync(resolve(ROOT, "popup.css"), "utf8");
    expect(css).toMatch(/\.settings-panel\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.settings-panel\.open\s*\{[^}]*display:\s*block/);
  });

  it("keeps the interval, the sound and Open All Tabs on the main page, outside any panel that can be closed", () => {
    for (const id of ON_THE_MAIN_PAGE) {
      const el = doc.getElementById(id);
      expect(el.closest("#settings-panel"), id).toBeNull();
      expect(el.closest("[hidden]"), id).toBeNull();
      expect(el.disabled, id).toBe(false);
    }
  });

  it("keeps the choices of each fixed list", () => {
    const options = (id) => [...doc.getElementById(id).options].map((o) => o.value);
    expect(options("interval")).toEqual(["1", "5", "15", "30"]);
    expect(options("feed-workplace-filter")).toEqual(["all", "Remote", "Hybrid", "On-site"]);
    expect(options("feed-status-filter")).toEqual(["all", "not-applied", "applied"]);
    expect(options("feed-sort")).toEqual(["found-desc", "found-asc", "posted-desc", "posted-asc"]);
  });

  it("still loads popup.js as its one script", () => {
    const scripts = [...doc.querySelectorAll("script")];
    expect(scripts.map((s) => [s.getAttribute("src"), s.type])).toEqual([["popup.js", "module"]]);
  });
});

// Controls added since the shipped popup, each by the ticket named, in
// document order. The shipped copy has none of them, so this is skipped
// against it.
const ADDED_SINCE_SHIPPED = [
  // WD-71: Start Watching / Pause Watching.
  ["watcher-control", "section"],
  ["watcher-status", "span"],
  ["watcher-detail", "span"],
  ["watcher-toggle", "button"],
];

describe.skipIf(REFERENCE_ROOT)("popup.html's controls added since the shipped popup", () => {
  it.each(ADDED_SINCE_SHIPPED)("#%s is a %s, once", (id, expected) => {
    const el = doc.getElementById(id);
    expect(el, `#${id} is gone`).not.toBeNull();
    expect(kind(el)).toBe(expected);
    expect(doc.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
  });

  it("Start / Pause Watching (WD-71) is on the main page, between the settings panel and the check controls", () => {
    const control = doc.getElementById("watcher-control");
    expect(control.closest("#settings-panel")).toBeNull();
    expect(doc.getElementById("settings-panel").compareDocumentPosition(control) & 4).toBe(4);
    expect(control.compareDocumentPosition(doc.getElementById("interval")) & 4).toBe(4);
  });
});

describe("manifest.json still lets the popup do it", () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "manifest.json"), "utf8"));

  it("opens popup.html from the toolbar", () => {
    expect(manifest.action.default_popup).toBe("popup.html");
  });

  // The extension has no "tabs" permission: Open All Tabs finds a watch's
  // open tab through these hosts (baseline §9.11).
  it.each(["https://www.onlinejobs.ph/*", "https://www.glassdoor.com/*", "https://www.linkedin.com/*", "https://www.upwork.com/*"])(
    "has host access to %s",
    (host) => {
      expect(manifest.host_permissions).toContain(host);
    },
  );

  it("keeps the permissions the shipped popup's controls rely on", () => {
    for (const permission of ["storage", "alarms", "notifications", "offscreen"]) {
      expect(manifest.permissions).toContain(permission);
    }
  });
});
