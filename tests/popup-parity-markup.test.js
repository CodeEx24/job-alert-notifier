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
  // WD-81: "Import your existing data": the question a freshly connected
  // browser asks about its own watches, feed and settings, its progress and
  // how it ended.
  ["local-import", "section"],
  ["local-import-title", "h2"],
  ["local-import-text", "p"],
  // WD-83: the report of an import that ended, by site.
  ["local-import-report", "div"],
  ["local-import-details", "ul"],
  ["local-import-accept", "button"],
  ["local-import-decline", "button"],
  ["local-import-retry", "button"],
  ["local-import-dismiss", "button"],
  // WD-83: importing again, and the two steps that remove the copies this
  // browser kept from before the import.
  ["local-import-redo", "button"],
  ["local-import-confirm", "button"],
  ["local-import-keep", "button"],
  ["local-import-remove", "button"],
  // WD-79: the line at the top of the settings panel that says where the
  // settings are saved (this browser only, or the connected account).
  ["settings-sync-note", "p"],
  // WD-81: the way back to the import question after "Not now".
  ["local-import-again-group", "div"],
  ["local-import-again", "button"],
  ["local-import-again-hint", "p"],
  // WD-83: the way back to the report after "Close".
  ["local-import-review-group", "div"],
  ["local-import-review", "button"],
  ["local-import-review-hint", "p"],
  // WD-111: the hint under Reset Extension. The shipped popup has the same
  // paragraph with the same words and no id; the id lets popup.js say what
  // Reset does with an account connected.
  ["reset-extension-hint", "p"],
  // WD-71: Start Watching / Pause Watching.
  ["watcher-control", "section"],
  ["watcher-status", "span"],
  ["watcher-detail", "span"],
  ["watcher-toggle", "button"],
  // WD-79: why a change to a connected account's settings was refused.
  ["settings-change-error", "div"],
];

describe.skipIf(REFERENCE_ROOT)("popup.html's controls added since the shipped popup", () => {
  it.each(ADDED_SINCE_SHIPPED)("#%s is a %s, once", (id, expected) => {
    const el = doc.getElementById(id);
    expect(el, `#${id} is gone`).not.toBeNull();
    expect(kind(el)).toBe(expected);
    expect(doc.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
  });

  it("the import card (WD-81) follows the account card, hidden and empty until popup.js fills it in, and its way back is in the settings panel", () => {
    const card = doc.getElementById("local-import");
    expect(card.closest("#settings-panel")).toBeNull();
    expect(doc.getElementById("account-card").compareDocumentPosition(card) & 4).toBe(4);
    expect(card.compareDocumentPosition(doc.getElementById("settings-panel")) & 4).toBe(4);
    expect(card.hidden).toBe(true);
    expect(card.getAttribute("aria-labelledby")).toBe("local-import-title");
    expect(doc.getElementById("local-import-text").getAttribute("aria-live")).toBe("polite");
    expect(doc.getElementById("local-import-title").textContent).toBe("");
    expect(doc.getElementById("local-import-text").textContent).toBe("");
    // Real buttons, in the order they are read: reachable and pressable from
    // the keyboard with nothing added.
    const buttons = [...card.querySelectorAll("button")];
    expect(buttons.map((b) => [b.id, b.type, b.hidden, b.getAttribute("tabindex")])).toEqual([
      ["local-import-accept", "button", true, null],
      ["local-import-decline", "button", true, null],
      ["local-import-retry", "button", true, null],
      ["local-import-dismiss", "button", true, null],
      // WD-83: after "Close", so the focus is never handed to a button that
      // removes something; "Keep them" before "Remove the copies".
      ["local-import-redo", "button", true, null],
      ["local-import-confirm", "button", true, null],
      ["local-import-keep", "button", true, null],
      ["local-import-remove", "button", true, null],
    ]);
    // WD-83: the report is empty and hidden until there is one, and the
    // way back to it is in the settings panel, after the way back to the
    // question.
    const report = doc.getElementById("local-import-report");
    expect(card.contains(report)).toBe(true);
    expect([report.hidden, report.children.length]).toEqual([true, 0]);
    const review = doc.getElementById("local-import-review-group");
    expect(doc.getElementById("settings-panel").contains(review)).toBe(true);
    expect(review.hidden).toBe(true);
    expect(doc.getElementById("local-import-again-group").compareDocumentPosition(review) & 4).toBe(4);
    expect(review.compareDocumentPosition(doc.getElementById("reset-extension")) & 4).toBe(4);
    // Still one role="status" in the popup: the sync line (WD-73).
    expect([...doc.querySelectorAll('[role="status"]')].map((el) => el.id)).toEqual(["watch-sync-text"]);

    const again = doc.getElementById("local-import-again-group");
    expect(doc.getElementById("settings-panel").contains(again)).toBe(true);
    expect(again.hidden).toBe(true);
    expect(doc.getElementById("import-settings-btn").compareDocumentPosition(again) & 4).toBe(4);
    expect(again.compareDocumentPosition(doc.getElementById("reset-extension")) & 4).toBe(4);
  });

  it("Start / Pause Watching (WD-71) is on the main page, between the settings panel and the check controls", () => {
    const control = doc.getElementById("watcher-control");
    expect(control.closest("#settings-panel")).toBeNull();
    expect(doc.getElementById("settings-panel").compareDocumentPosition(control) & 4).toBe(4);
    expect(control.compareDocumentPosition(doc.getElementById("interval")) & 4).toBe(4);
  });

  it("the settings note (WD-79) opens the settings panel, and the refusal line follows the interval and the sound it is about", () => {
    const panel = doc.getElementById("settings-panel");
    const note = doc.getElementById("settings-sync-note");
    expect(panel.contains(note)).toBe(true);
    expect(note.compareDocumentPosition(doc.getElementById("pause-all")) & 4).toBe(4);
    expect(note.getAttribute("aria-live")).toBe("polite");

    const refusal = doc.getElementById("settings-change-error");
    expect(refusal.closest("#settings-panel")).toBeNull();
    expect(refusal.getAttribute("role")).toBe("alert");
    expect(doc.getElementById("sound").compareDocumentPosition(refusal) & 4).toBe(4);
    expect(refusal.compareDocumentPosition(doc.getElementById("open-required-tabs")) & 4).toBe(4);
    // Both are empty until popup.js fills them in.
    expect(note.textContent).toBe("");
    expect(refusal.textContent).toBe("");
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
