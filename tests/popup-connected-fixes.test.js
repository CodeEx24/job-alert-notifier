// WD-111: the five findings WD-72 left behind, each driven in the real popup
// against the real service worker (helpers/popup-harness.js). Every test
// here failed before its fix.
//   1. a connected account's watch URLs are WatchDesk's: the worker's URL
//      migration leaves them alone;
//   2. an import while WatchDesk cannot be reached imports nothing and says
//      so;
//   3. the hint under Reset Extension says what Reset does in each mode;
//   4. mute, interval and sound survive a re-render of the open popup;
//   5. installing or updating never writes the settings back.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startExtension,
  TESTED_MODES,
  REFERENCE_ROOT,
  NOW,
  WATCHES,
  OJ_URL,
  LINKEDIN_REACT_URL,
  UPWORK_URL,
} from "./helpers/popup-harness.js";

// A LinkedIn search as WatchDesk might store it: the extension's own rule
// would add sortBy=DD (sites.js, normalizeLinkedInUrl).
const LINKEDIN_AS_STORED = "https://www.linkedin.com/jobs/search/?keywords=react";
const RESET_HINT_SHIPPED =
  "Clears every watch, the feed, and all settings back to defaults. Can't be undone — export a backup first if you might want any of this again.";
const RESET_HINT_CONNECTED =
  "Clears the feed and all settings back to defaults. Your watches are kept: they belong to your WatchDesk account. Can't be undone.";
const IMPORT_REFUSED =
  "Nothing was imported. Can't reach WatchDesk, so your watches can't be changed right now. The list shown is the last one synced.";

let ext;
afterEach(() => {
  ext?.dispose();
  vi.restoreAllMocks();
});

const pickFile = async (popup, data) => {
  const input = popup.$("import-settings-file");
  Object.defineProperty(input, "files", { configurable: true, value: [{ text: async () => JSON.stringify(data) }] });
  input.dispatchEvent(new popup.window.Event("change"));
  await popup.settle();
};
const settingsStatus = (popup) => [popup.text("settings-status-msg"), popup.$("settings-status-msg").className];

describe("1. the URL migration and a connected account's watches", () => {
  it("with no account connected, still rewrites a stored LinkedIn URL and saves it, as shipped", async () => {
    ext = await startExtension({ watches: [{ ...WATCHES[2], url: LINKEDIN_AS_STORED }] });

    const state = await ext.send({ type: "get-state" });
    await ext.settle();

    expect(state.settings.watches[0].url).toBe(LINKEDIN_REACT_URL);
    expect(ext.watches()[0].url).toBe(LINKEDIN_REACT_URL);
  });

  it.skipIf(REFERENCE_ROOT)("connected, uses the URL WatchDesk stored and never writes the list itself", async () => {
    ext = await startExtension({ connected: true });
    ext.api.watches.find((w) => w.label === "LinkedIn React").url = LINKEDIN_AS_STORED;
    await ext.send({ type: "sync-watches" });
    expect(ext.watch("LinkedIn React").url).toBe(LINKEDIN_AS_STORED);
    ext.chrome.storage.sync.set.mockClear();

    const popup = await ext.openPopup();

    expect(popup.watchItem("LinkedIn React").querySelector(".label").title).toBe(LINKEDIN_AS_STORED);
    expect(ext.watch("LinkedIn React").url).toBe(LINKEDIN_AS_STORED);
    expect(ext.chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it.skipIf(REFERENCE_ROOT)("connected, a check reads the watch at WatchDesk's URL and leaves the list alone", async () => {
    ext = await startExtension({ connected: true });
    ext.api.watches.find((w) => w.label === "LinkedIn React").url = LINKEDIN_AS_STORED;
    await ext.send({ type: "sync-watches" });
    ext.chrome.storage.sync.set.mockClear();

    const state = await ext.send({ type: "check-now" });
    await ext.settle();

    expect(state.settings.watches.find((w) => w.label === "LinkedIn React").url).toBe(LINKEDIN_AS_STORED);
    expect(ext.chrome.tabs.query).toHaveBeenCalledWith({ url: LINKEDIN_AS_STORED });
    expect(ext.chrome.storage.sync.set).not.toHaveBeenCalled();
  });
});

describe.skipIf(REFERENCE_ROOT)("2. an import while WatchDesk cannot be reached", () => {
  const backup = {
    watches: [{ id: "w_1700000000000_abcde", siteId: "upwork", url: `${UPWORK_URL}&page=3`, label: "Imported", enabled: true }],
    intervalMinutes: 15,
    soundId: "ping",
    notificationsMuted: true,
    titleFilter: { enabled: false, keywords: ["react"] },
  };
  const start = async () => {
    ext = await startExtension({ connected: true, local: { seenIds: { kept: ["1"] }, lastRunAt: NOW - 60000 } });
    const popup = await ext.openPopup();
    await popup.click(popup.$("settings-toggle"));
    return popup;
  };

  it("imports nothing: the list, the settings and the run state stay as they were", async () => {
    const popup = await start();
    const before = { sync: ext.sync(), local: ext.local() };
    ext.api.setWatchRoute(ext.api.networkError);

    await pickFile(popup, backup);

    expect(popup.labels()).toEqual(WATCHES.map((w) => w.label));
    expect(ext.watches()).toEqual(before.sync.watches);
    expect(ext.sync()).toEqual(before.sync);
    expect(ext.local()).toMatchObject({ seenIds: { kept: ["1"] }, lastRunAt: NOW - 60000 });
    expect(popup.$("interval").value).toBe("5");
    expect(ext.api.watchCalls("POST")).toHaveLength(WATCHES.length);
  });

  it("says so in Settings, and the account card says WatchDesk is out of reach", async () => {
    const popup = await start();
    expect(popup.text("watch-sync-text")).toBe("Nothing waiting to be sent");
    ext.api.setWatchRoute(ext.api.networkError);

    await pickFile(popup, backup);

    expect(settingsStatus(popup)).toEqual([IMPORT_REFUSED, "settings-status error"]);
    expect(popup.$("watch-sync-status").dataset.tone).toBe("offline");
    expect(popup.text("watch-sync-text")).toBe(
      "Offline — couldn't reach WatchDesk. Your watches are shown as last synced. They can't be changed until it's back.",
    );
  });

  it("asks WatchDesk once and sends no watch to it", async () => {
    const popup = await start();
    ext.api.setWatchRoute(ext.api.networkError);
    const calls = ext.watchdeskCalls().length;

    await pickFile(popup, backup);

    expect(ext.watchdeskCalls().slice(calls).map((r) => [r.method, r.path])).toEqual([["GET", "/api/watches"]]);
  });

  it("the same file goes in once WatchDesk is back, beside the account's watches", async () => {
    const popup = await start();
    ext.api.setWatchRoute(ext.api.networkError);
    await pickFile(popup, backup);
    ext.api.setWatchRoute(() => undefined);

    await pickFile(popup, backup);

    expect(settingsStatus(popup)).toEqual(["Imported 1 watch.", "settings-status success"]);
    expect(ext.api.watches.map((w) => w.label)).toEqual([...WATCHES.map((w) => w.label), "Imported"]);
    expect(popup.labels()).toEqual(expect.arrayContaining([...WATCHES.map((w) => w.label), "Imported"]));
    expect(ext.watches()).toHaveLength(6);
    expect(ext.sync()).toMatchObject({ intervalMinutes: 15, soundId: "ping", notificationsMuted: true });
    expect(ext.local()).toMatchObject({ seenIds: {}, lastRunAt: null });
    expect(popup.text("watch-sync-text")).toBe("Nothing waiting to be sent");
  });

  it("an import WatchDesk answers 401 for changes nothing and says the browser was disconnected", async () => {
    const popup = await start();
    const watches = ext.watches();
    ext.api.setWatchRoute(() => ext.api.json(401, { error: "Sign in to continue." }));

    await pickFile(popup, backup);

    expect(settingsStatus(popup)).toEqual([
      "Nothing was imported. This browser was disconnected from your WatchDesk account, so nothing was changed.",
      "settings-status error",
    ]);
    expect(ext.watches()).toEqual(watches);
    expect(ext.sync().intervalMinutes).toBeUndefined();
  });
});

describe("3. the hint under Reset Extension", () => {
  // The paragraph under the button; WD-111 gives it an id.
  const hint = (popup) => popup.$("reset-extension").parentElement.querySelector(".hint");
  const words = (el) => el.textContent.replace(/\s+/g, " ").trim();

  it("with no account connected, is the shipped text, untouched", async () => {
    ext = await startExtension();
    const popup = await ext.openPopup();
    expect(words(hint(popup))).toBe(RESET_HINT_SHIPPED);
    // Not connected, the popup never rewrites it: popup.html's own spacing.
    expect(hint(popup).textContent).toMatch(/^\s+Clears every watch, the feed, and all settings back to defaults\.\s+Can't be undone/);
  });

  it.skipIf(REFERENCE_ROOT)("connected, says the watches are kept, as the confirm does", async () => {
    ext = await startExtension({ connected: true });
    const popup = await ext.openPopup();
    expect(hint(popup).id).toBe("reset-extension-hint");
    expect(words(hint(popup))).toBe(RESET_HINT_CONNECTED);

    await popup.click(popup.$("reset-extension"));
    expect(popup.confirm.mock.calls[0][0]).toContain("Your watches are kept: they belong to your WatchDesk account.");
    expect(ext.watches()).toHaveLength(WATCHES.length);
  });

  it.skipIf(REFERENCE_ROOT)("goes back to the shipped text when the account is disconnected", async () => {
    ext = await startExtension({ connected: true });
    const popup = await ext.openPopup();
    expect(words(hint(popup))).toBe(RESET_HINT_CONNECTED);
    ext.api.setWatchRoute(() => ext.api.json(401, { error: "Sign in to continue." }));

    await popup.click(popup.$("pause-all"));

    expect(popup.$("watch-sync-status").hidden).toBe(true);
    expect(words(hint(popup))).toBe(RESET_HINT_SHIPPED);
  });
});

describe.each(TESTED_MODES)("4. a setting changed in the open popup $mode", ({ connected }) => {
  const start = async () => {
    ext = await startExtension({ connected });
    return ext.openPopup();
  };
  // A re-render of what the popup already holds, with no new state from the
  // worker: opening a watch's rename box.
  const rerender = async (popup) => {
    ext.take();
    await popup.click(popup.button(popup.watchItem("Glassdoor React"), "Edit"));
    expect(ext.take()).toEqual([]);
  };

  it("mute stays ticked through a re-render", async () => {
    const popup = await start();
    await popup.check(popup.$("mute-notifications"), true);
    await rerender(popup);
    expect(popup.$("mute-notifications").checked).toBe(true);
    expect(ext.sync().notificationsMuted).toBe(true);

    await popup.check(popup.$("mute-notifications"), false);
    await rerender(popup);
    expect(popup.$("mute-notifications").checked).toBe(false);
  });

  it("the check interval stays chosen through a re-render", async () => {
    const popup = await start();
    await popup.choose(popup.$("interval"), "30");
    await rerender(popup);
    expect(popup.$("interval").value).toBe("30");
    expect(ext.sync().intervalMinutes).toBe(30);
  });

  it("the alert sound stays chosen through a re-render", async () => {
    const popup = await start();
    await popup.choose(popup.$("sound"), "soft");
    await rerender(popup);
    expect(popup.$("sound").value).toBe("soft");
    expect(ext.sync().soundId).toBe("soft");
  });

  it("Export, straight after, holds the values just chosen", async () => {
    const popup = await start();
    const blobs = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => blobs.push(blob) && "blob:backup");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    await popup.choose(popup.$("interval"), "15");
    await popup.choose(popup.$("sound"), "alert");
    await popup.check(popup.$("mute-notifications"), true);

    await popup.click(popup.$("export-settings"));

    expect(JSON.parse(await blobs[0].text())).toMatchObject({ intervalMinutes: 15, soundId: "alert", notificationsMuted: true });
  });

  it("sends the same one message per change as before", async () => {
    const popup = await start();
    ext.take();
    await popup.choose(popup.$("interval"), "15");
    await popup.choose(popup.$("sound"), "alert");
    await popup.check(popup.$("mute-notifications"), true);
    expect(ext.take()).toEqual([
      { type: "set-interval", minutes: 15 },
      { type: "set-sound", soundId: "alert" },
      { type: "set-notifications-muted", muted: true },
    ]);
  });
});

describe("5. installing or updating the extension", () => {
  const install = (details) => ext.chrome.runtime.onInstalled.dispatch(details);
  const mine = { id: "w_1759000000009_mine1", siteId: "upwork", url: UPWORK_URL, label: "Mine", enabled: true };

  it.each([{ reason: "install" }, { reason: "update", previousVersion: "1.0.0" }])(
    "on $reason, keeps what was written to chrome.storage.sync while it was starting",
    async (details) => {
      ext = await startExtension({ watches: null });

      // The handler has read the (empty) settings; these land before it is
      // done: the user's first clicks, or Chrome sync delivering the
      // settings of their other computer.
      const installed = install(details);
      await ext.chrome.storage.sync.set({ watches: [mine], intervalMinutes: 30, soundId: "ping", notificationsMuted: true });
      await installed;
      await ext.settle();

      expect(ext.sync()).toMatchObject({ watches: [mine], intervalMinutes: 30, soundId: "ping", notificationsMuted: true });
    },
  );

  it("on install, still arms the check alarm and the popup still shows the defaults", async () => {
    ext = await startExtension({ watches: null });
    await install({ reason: "install" });

    expect(ext.chrome.alarms.create).toHaveBeenLastCalledWith("check-jobs", { delayInMinutes: 0.1, periodInMinutes: 5 });
    const popup = await ext.openPopup();
    expect(popup.labels()).toEqual(["All OnlineJobs.ph postings"]);
    expect(popup.watchItem("All OnlineJobs.ph postings").querySelector(".label").title).toBe(OJ_URL);
    expect(popup.$("interval").value).toBe("5");
    expect(popup.$("sound").value).toBe("chime");
    expect(popup.$("mute-notifications").checked).toBe(false);
  });

  it("on update, arms the alarm on the stored interval and still records the update for the banner", async () => {
    ext = await startExtension({ sync: { intervalMinutes: 15 } });
    await install({ reason: "update", previousVersion: "1.0.0" });

    expect(ext.chrome.alarms.create).toHaveBeenLastCalledWith("check-jobs", { delayInMinutes: 0.1, periodInMinutes: 15 });
    expect(ext.local().justUpdated).toEqual({ toVersion: "1.1.0", fromVersion: "1.0.0" });
    expect(ext.watches()).toEqual(WATCHES);
  });

  it.skipIf(REFERENCE_ROOT)("connected, an update never writes the account's watch list", async () => {
    ext = await startExtension({ connected: true });
    ext.chrome.storage.sync.set.mockClear();

    await install({ reason: "update", previousVersion: "1.0.0" });
    await ext.settle();

    expect(ext.chrome.storage.sync.set).not.toHaveBeenCalled();
  });
});
