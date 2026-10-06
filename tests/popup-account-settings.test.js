// WD-79: the popup's settings with a WatchDesk account connected, driven in
// the real popup against the real service worker (helpers/popup-harness.js):
// loading them when the popup and the settings panel open, saving a change
// in the account, what the popup does when the account refuses it, and the
// one line that says where the settings live. With no account connected the
// settings are as shipped; tests/popup-parity-settings.test.js holds that.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startExtension, REFERENCE_ROOT, WATCHES, UPWORK_URL } from "./helpers/popup-harness.js";
import { TEST_TOKEN } from "./helpers/fake-watchdesk.js";
import { describeSettingsSync, renderSettingsSync, renderSettingsChange } from "../popup-settings-sync.js";
import { TOKEN_KEY } from "../account-connection.js";

const LOCAL_ONLY =
  "No WatchDesk account is connected, so the check interval, alert sound, mute and keyword filter are saved in this browser only. Connect an account at the top of this popup to keep them in WatchDesk.";
const IN_ACCOUNT = "The check interval, alert sound, mute and keyword filter are saved in your WatchDesk account.";
const LOADING = "Loading your settings from WatchDesk…";
const OFFLINE_NOTE =
  "Can't reach WatchDesk. The check interval, alert sound, mute and keyword filter are shown as last loaded, and can't be changed until it's back.";
const OFFLINE_SAVE = "Can't reach WatchDesk, so that wasn't saved. Your settings are shown as last loaded.";
const DISCONNECTED_SAVE =
  "This browser was disconnected from your WatchDesk account, so that wasn't saved. Settings are saved in this browser only now.";

let ext;
afterEach(() => ext?.dispose());

const settingsCalls = (method) => ext.api.settingsCalls(method);
const chips = (popup) => [...popup.document.querySelectorAll(".keyword-chip > span")].map((el) => el.textContent);
const job = (n) => ({
  id: `13100${n}`,
  title: `PHP Developer ${n}`,
  url: `https://www.onlinejobs.ph/jobseekers/job/13100${n}`,
  postedRaw: "2026-10-05 09:15:00",
  postedAt: "2026-10-05T01:15:00.000Z",
  salaryRaw: null,
});

describe("the line that says where the settings are saved (popup-settings-sync.js)", () => {
  it.each([
    [undefined, {}, null],
    [{ mode: "local" }, {}, { tone: "local", text: LOCAL_ONLY }],
    [{ mode: "account", lastSyncedAt: null, problem: null }, {}, { tone: "neutral", text: LOADING }],
    [{ mode: "account", lastSyncedAt: null, problem: null }, { loading: true }, { tone: "neutral", text: LOADING }],
    [{ mode: "account", lastSyncedAt: 5, problem: null }, {}, { tone: "ok", text: IN_ACCOUNT }],
    [{ mode: "account", lastSyncedAt: 5, problem: null }, { loading: true }, { tone: "ok", text: `${IN_ACCOUNT} Checking it for changes…` }],
    [{ mode: "account", lastSyncedAt: 5, problem: "offline" }, { loading: true }, { tone: "offline", text: OFFLINE_NOTE }],
    [
      { mode: "account", lastSyncedAt: null, problem: "offline" },
      {},
      {
        tone: "offline",
        text: "Can't reach WatchDesk. The check interval, alert sound, mute and keyword filter are the ones saved in this browser, and can't be changed until it's back.",
      },
    ],
    [
      { mode: "account", lastSyncedAt: 5, problem: "unavailable" },
      {},
      {
        tone: "warning",
        text: "WatchDesk couldn't give your settings just now. The check interval, alert sound, mute and keyword filter are shown as last loaded.",
      },
    ],
  ])("describes %j %j", (status, options, view) => {
    expect(describeSettingsSync(status, options)).toEqual(view);
  });

  it("writes through textContent, and only when the words change", () => {
    const doc = new JSDOM(readFileSync("popup.html", "utf8")).window.document;
    const line = doc.getElementById("settings-sync-note");
    renderSettingsSync({ mode: "local" }, {}, doc);
    expect(line.textContent).toBe(LOCAL_ONLY);
    expect(line.dataset.tone).toBe("local");
    const node = line.firstChild;
    renderSettingsSync({ mode: "local" }, {}, doc);
    expect(line.firstChild).toBe(node);

    expect(renderSettingsChange({ ok: false, error: "<b>no</b>" }, doc)).toBe(false);
    expect(doc.getElementById("settings-change-error").textContent).toBe("<b>no</b>");
    expect(doc.getElementById("settings-change-error").children).toHaveLength(0);
    expect(renderSettingsChange({ ok: false }, doc)).toBe(false);
    expect(doc.getElementById("settings-change-error").textContent).toBe("Couldn't save that setting.");
    expect(renderSettingsChange({ ok: true }, doc)).toBe(true);
    expect(renderSettingsChange(undefined, doc)).toBe(true);
    expect(doc.getElementById("settings-change-error").textContent).toBe("");
  });
});

describe.skipIf(REFERENCE_ROOT)("with no account connected, the settings are local only and the panel says why", () => {
  it("says they are saved in this browser only, and how to change that", async () => {
    ext = await startExtension();
    const popup = await ext.openPopup();
    await popup.click(popup.$("settings-toggle"));

    expect(popup.text("settings-sync-note")).toBe(LOCAL_ONLY);
    expect(popup.$("settings-panel").contains(popup.$("settings-sync-note"))).toBe(true);
    expect(popup.text("settings-change-error")).toBe("");
  });

  it("asks WatchDesk for nothing: not on opening, not on opening the panel, not on a change", async () => {
    ext = await startExtension();
    const popup = await ext.openPopup();
    await popup.click(popup.$("settings-toggle"));
    await popup.choose(popup.$("interval"), "30");
    await popup.check(popup.$("mute-notifications"), true);

    expect(ext.watchdeskCalls()).toEqual([]);
    expect([...popup.opening, ...ext.take()].filter((m) => m.type === "sync-settings")).toEqual([]);
    expect(ext.sync()).toMatchObject({ intervalMinutes: 30, notificationsMuted: true });
    expect(ext.local().watchdeskSettingsBeforeConnect).toBeUndefined();
  });

  it("a worker asked anyway answers with this browser's settings and sends nothing", async () => {
    ext = await startExtension({ sync: { intervalMinutes: 30 } });
    const answer = await ext.send({ type: "sync-settings" });

    expect(answer.settingsSync).toEqual({ mode: "local" });
    expect(answer.settings.intervalMinutes).toBe(30);
    expect((await ext.send({ type: "get-state" })).settingsSync).toEqual({ mode: "local" });
    expect(ext.watchdeskCalls()).toEqual([]);
  });
});

describe.skipIf(REFERENCE_ROOT)("with an account connected", () => {
  const start = async (options = {}) => {
    ext = await startExtension({ connected: true, ...options });
    return ext.openPopup();
  };
  const onTheWeb = { intervalMinutes: 30, soundId: "soft", notificationsMuted: true, titleFilter: { enabled: false, keywords: ["rust", "go"] } };

  describe("opening the popup and the settings panel loads the current values from the API", () => {
    it("opening the popup asks for the account's settings and shows them", async () => {
      ext = await startExtension({ connected: true });
      ext.api.setSettings(onTheWeb);
      const before = settingsCalls("GET").length;

      const popup = await ext.openPopup();

      expect(popup.opening.filter((m) => m.type === "sync-settings")).toHaveLength(1);
      expect(settingsCalls("GET").length).toBeGreaterThan(before);
      expect(popup.$("interval").value).toBe("30");
      expect(popup.$("sound").value).toBe("soft");
      expect(popup.$("mute-notifications").checked).toBe(true);
      expect(popup.$("title-filter-enabled").checked).toBe(false);
      expect(chips(popup)).toEqual(["rust", "go"]);
      expect(popup.text("settings-sync-note")).toBe(IN_ACCOUNT);
    });

    it("opening the settings panel asks again: a change made on the web meanwhile is there", async () => {
      const popup = await start();
      expect(popup.$("interval").value).toBe("5");
      ext.api.setSettings(onTheWeb);
      ext.take();

      await popup.click(popup.$("settings-toggle"));

      expect(ext.take()).toEqual([{ type: "sync-settings" }]);
      expect(popup.$("mute-notifications").checked).toBe(true);
      expect(popup.$("title-filter-enabled").checked).toBe(false);
      expect(chips(popup)).toEqual(["rust", "go"]);
      expect(popup.$("interval").value).toBe("30");
      expect(popup.$("sound").value).toBe("soft");
      // The copy the check cycle reads has them too.
      expect(ext.sync()).toMatchObject(onTheWeb);
    });

    it("closing the panel asks for nothing", async () => {
      const popup = await start();
      await popup.click(popup.$("settings-toggle"));
      ext.take();
      await popup.click(popup.$("settings-toggle"));
      await popup.click(popup.$("settings-toggle"));
      await popup.click(popup.$("settings-close"));
      expect(ext.take()).toEqual([{ type: "sync-settings" }]);
    });

    it("shows the last known copy at once and says it is still loading, then why it could not", async () => {
      ext = await startExtension({ connected: true, synced: false, sync: { intervalMinutes: 15, soundId: "alert" } });
      ext.api.setSettingsRoute(ext.api.hang);

      const popup = await ext.openPopup();

      expect(popup.$("interval").value).toBe("15");
      expect(popup.$("sound").value).toBe("alert");
      expect(popup.text("settings-sync-note")).toBe(LOADING);

      // The request is given up after 10 seconds.
      await vi.advanceTimersByTimeAsync(25000);
      await popup.settle();
      expect(popup.text("settings-sync-note")).toBe(
        "Can't reach WatchDesk. The check interval, alert sound, mute and keyword filter are the ones saved in this browser, and can't be changed until it's back.",
      );
      expect(popup.$("settings-sync-note").dataset.tone).toBe("offline");
      expect(popup.$("interval").value).toBe("15");
    });

    it("does not touch a keyword the user has started typing when the answer arrives", async () => {
      const popup = await start();
      popup.type(popup.$("title-filter-new-keyword"), "larav");
      ext.api.setSettings(onTheWeb);

      await popup.click(popup.$("settings-toggle"));

      expect(chips(popup)).toEqual(["rust", "go"]);
      expect(popup.$("title-filter-new-keyword").value).toBe("larav");
    });

    it("a change still being saved is not flicked back by a load that was read before it", async () => {
      const popup = await start();
      // The load is asked for first, the change straight after it; the
      // load's answer holds the old interval.
      popup.$("settings-toggle").click();
      popup.$("interval").value = "30";
      popup.$("interval").dispatchEvent(new popup.window.Event("change", { bubbles: true }));
      const shown = [];
      const select = popup.$("interval");
      const original = Object.getOwnPropertyDescriptor(popup.window.HTMLSelectElement.prototype, "value");
      Object.defineProperty(select, "value", {
        configurable: true,
        get: () => original.get.call(select),
        set: (value) => {
          shown.push(value);
          original.set.call(select, value);
        },
      });
      await popup.settle();

      expect(shown.every((value) => value === "30")).toBe(true);
      expect(select.value).toBe("30");
      expect(ext.api.settings().intervalMinutes).toBe(30);
    });

    it("the token is nowhere in the page or in what the worker answers", async () => {
      const popup = await start();
      await popup.click(popup.$("settings-toggle"));
      const token = ext.local()[TOKEN_KEY];
      expect(popup.document.documentElement.outerHTML).not.toContain(token);
      expect(JSON.stringify(await ext.send({ type: "sync-settings" }))).not.toContain(token);
      expect(JSON.stringify(await ext.send({ type: "set-sound", soundId: "ping" }))).not.toContain(token);
      expect(JSON.stringify(ext.sync())).not.toContain(token);
    });
  });

  describe("changing a setting saves it with PUT /api/settings", () => {
    it.each([
      ["the check interval", (popup) => popup.choose(popup.$("interval"), "15"), { intervalMinutes: 15 }],
      ["the alert sound", (popup) => popup.choose(popup.$("sound"), "alert"), { soundId: "alert" }],
      ["mute", (popup) => popup.check(popup.$("mute-notifications"), true), { notificationsMuted: true }],
    ])("%s", async (_name, act, changed) => {
      const popup = await start();
      const before = ext.api.settings();
      const calls = settingsCalls().length;

      await act(popup);

      expect(
        settingsCalls()
          .slice(calls)
          .map((r) => r.method),
      ).toEqual(["GET", "PUT"]);
      expect(settingsCalls("PUT").at(-1).body).toEqual({ ...before, ...changed });
      expect(ext.api.settings()).toEqual({ ...before, ...changed });
      // The copy follows, and the popup shows the saved state with no error.
      expect(ext.sync()).toMatchObject(changed);
      expect(popup.text("settings-change-error")).toBe("");
      expect(popup.text("settings-sync-note")).toBe(IN_ACCOUNT);
      expect((await ext.openPopup()).text("settings-change-error")).toBe("");
    });

    it("the keyword filter: the chips are the keywords as WatchDesk kept them", async () => {
      const popup = await start({ sync: { titleFilter: { enabled: true, keywords: ["react"] } } });
      popup.$("title-filter-new-keyword").value = "  Laravel  ";
      await popup.click(popup.$("title-filter-add-btn"));
      await popup.check(popup.$("title-filter-enabled"), false);

      expect(ext.api.settings().titleFilter).toEqual({ enabled: false, keywords: ["react", "Laravel"] });
      expect(chips(popup)).toEqual(["react", "Laravel"]);
      expect(popup.$("title-filter-new-keyword").value).toBe("");
      expect(ext.sync().titleFilter).toEqual({ enabled: false, keywords: ["react", "Laravel"] });
    });

    it("a newly chosen interval re-arms the check alarm, as it does with no account connected", async () => {
      const popup = await start();
      await popup.choose(popup.$("interval"), "15");
      expect(ext.chrome.alarms.create).toHaveBeenLastCalledWith("check-jobs", { delayInMinutes: 0.1, periodInMinutes: 15 });
    });

    it("leaves the account's watcher state as WatchDesk holds it: a save neither pauses nor starts watching", async () => {
      const popup = await start();
      // Paused from another browser on the account; this one is running.
      ext.api.setSettings({ watcherState: "paused" });
      const alarmsCleared = ext.chrome.alarms.clear.mock.calls.length;

      await popup.check(popup.$("mute-notifications"), true);

      expect(settingsCalls("PUT").at(-1).body.watcherState).toBe("paused");
      expect(ext.api.settings()).toMatchObject({ notificationsMuted: true, watcherState: "paused" });
      expect(ext.local().watcherState).toBeUndefined();
      expect(popup.text("watcher-status")).toBe("Watching is running");
      expect(ext.chrome.alarms.clear.mock.calls.length).toBe(alarmsCleared);
    });

    it("two changes made at once are both saved", async () => {
      const popup = await start();
      popup.$("interval").value = "30";
      popup.$("interval").dispatchEvent(new popup.window.Event("change", { bubbles: true }));
      popup.$("sound").value = "soft";
      popup.$("sound").dispatchEvent(new popup.window.Event("change", { bubbles: true }));
      await popup.settle();

      expect(ext.api.settings()).toMatchObject({ intervalMinutes: 30, soundId: "soft" });
      expect(popup.$("interval").value).toBe("30");
      expect(popup.$("sound").value).toBe("soft");
      expect(ext.sync()).toMatchObject({ intervalMinutes: 30, soundId: "soft" });
    });
  });

  describe("a change WatchDesk does not take", () => {
    it("offline: the control goes back to the account's value and the popup says why", async () => {
      const popup = await start();
      ext.api.setSettingsRoute(ext.api.networkError);

      await popup.choose(popup.$("interval"), "30");

      expect(popup.$("interval").value).toBe("5");
      expect(popup.text("settings-change-error")).toBe(OFFLINE_SAVE);
      expect(popup.$("settings-change-error").getAttribute("role")).toBe("alert");
      expect(popup.text("settings-sync-note")).toBe(OFFLINE_NOTE);
      expect(ext.sync().intervalMinutes).toBe(5);
      expect(ext.chrome.alarms.create).not.toHaveBeenCalledWith("check-jobs", expect.objectContaining({ periodInMinutes: 30 }));
    });

    it("offline, nothing is queued: back online, the account still has what it had", async () => {
      const popup = await start();
      ext.api.setSettingsRoute(ext.api.networkError);
      await popup.check(popup.$("mute-notifications"), true);
      expect(popup.$("mute-notifications").checked).toBe(false);
      ext.api.setSettingsRoute(() => undefined);

      const reopened = await ext.openPopup();

      expect(settingsCalls("PUT")).toEqual([]);
      expect(ext.api.settings().notificationsMuted).toBe(false);
      expect(reopened.$("mute-notifications").checked).toBe(false);
      expect(reopened.text("settings-sync-note")).toBe(IN_ACCOUNT);
    });

    it("with Settings open, its status line says it too, and a change that works clears both", async () => {
      const popup = await start();
      await popup.click(popup.$("settings-toggle"));
      ext.api.setSettingsRoute(ext.api.networkError);

      await popup.check(popup.$("title-filter-enabled"), false);

      expect(popup.$("title-filter-enabled").checked).toBe(true);
      expect([popup.text("settings-status-msg"), popup.$("settings-status-msg").className]).toEqual([OFFLINE_SAVE, "settings-status error"]);

      ext.api.setSettingsRoute(() => undefined);
      await popup.check(popup.$("title-filter-enabled"), false);
      expect(popup.$("title-filter-enabled").checked).toBe(false);
      expect(popup.text("settings-change-error")).toBe("");
      expect(popup.text("settings-sync-note")).toBe(IN_ACCOUNT);
    });

    it("refused by WatchDesk: the field's own message, and the control back on what the account holds now", async () => {
      const popup = await start();
      ext.api.setSettings({ soundId: "soft" });
      ext.api.setSettingsRoute((request) =>
        request.method === "PUT"
          ? ext.api.json(400, { error: "Check the highlighted fields.", fieldErrors: { soundId: ["Choose one of the alert sounds"] } })
          : undefined,
      );

      await popup.choose(popup.$("sound"), "alert");

      expect(popup.text("settings-change-error")).toBe("Choose one of the alert sounds");
      expect(popup.$("sound").value).toBe("soft");
      expect(ext.sync().soundId).toBe("soft");
    });

    it("a keyword too long is caught here with WatchDesk's limit, with no request, and stays in the box to be fixed", async () => {
      const popup = await start();
      await popup.click(popup.$("settings-toggle"));
      const calls = ext.watchdeskCalls().length;
      const long = "x".repeat(101);
      popup.$("title-filter-new-keyword").value = long;

      await popup.click(popup.$("title-filter-add-btn"));

      expect(ext.watchdeskCalls()).toHaveLength(calls);
      expect(popup.text("settings-change-error")).toBe("A keyword must be at most 100 characters");
      expect(popup.text("settings-status-msg")).toBe("A keyword must be at most 100 characters");
      expect(popup.$("title-filter-new-keyword").value).toBe(long);
      expect(chips(popup)).not.toContain(long);

      popup.$("title-filter-new-keyword").value = "x".repeat(100);
      await popup.click(popup.$("title-filter-add-btn"));
      expect(chips(popup).at(-1)).toBe("x".repeat(100));
      expect(popup.text("settings-change-error")).toBe("");
    });

    it("the hundred-and-first keyword is caught here too", async () => {
      const keywords = Array.from({ length: 100 }, (_, i) => `keyword ${i}`);
      const popup = await start({ sync: { titleFilter: { enabled: true, keywords } } });
      const calls = ext.watchdeskCalls().length;
      popup.$("title-filter-new-keyword").value = "one more";

      await popup.click(popup.$("title-filter-add-btn"));

      expect(ext.watchdeskCalls()).toHaveLength(calls);
      expect(popup.text("settings-change-error")).toBe("Keep at most 100 keywords");
      expect(chips(popup)).toHaveLength(100);
      expect(ext.api.settings().titleFilter.keywords).toHaveLength(100);
    });

    it("a refused token: the popup falls back to local-only settings and says why", async () => {
      const popup = await start();
      ext.api.setSettingsRoute(() => ext.api.json(401, { error: "Sign in to continue." }));

      await popup.choose(popup.$("interval"), "30");

      expect(popup.text("settings-change-error")).toBe(DISCONNECTED_SAVE);
      expect(popup.text("settings-sync-note")).toBe(LOCAL_ONLY);
      expect(ext.local()[TOKEN_KEY]).toBeUndefined();
      // The last copy of the account's settings is this browser's own now.
      expect(popup.$("interval").value).toBe("5");
      expect(ext.sync().intervalMinutes).toBe(5);

      // And from here a change is saved in this browser, as shipped.
      const calls = ext.watchdeskCalls().length;
      await popup.choose(popup.$("interval"), "30");
      expect(ext.sync().intervalMinutes).toBe(30);
      expect(ext.watchdeskCalls()).toHaveLength(calls);
      expect(popup.text("settings-change-error")).toBe("");
    });

    it("a 403 is waited out like an outage: nothing is changed and the token is kept", async () => {
      const popup = await start();
      ext.api.setSettingsRoute(() => ext.api.json(403, { error: "Forbidden." }));

      await popup.choose(popup.$("sound"), "alert");

      expect(popup.text("settings-change-error")).toBe(
        "WatchDesk isn't accepting changes from this account right now, so that wasn't saved.",
      );
      expect(popup.$("sound").value).toBe("chime");
      expect(ext.local()[TOKEN_KEY]).toBeDefined();
      expect(popup.text("settings-sync-note")).toBe(
        "WatchDesk couldn't give your settings just now. The check interval, alert sound, mute and keyword filter are shown as last loaded.",
      );
    });
  });

  describe("the check cycle reads the copy", () => {
    it("with WatchDesk out of reach, a check still runs on the settings last loaded, with no settings request it waits for", async () => {
      const popup = await start({ watches: [WATCHES[0]], sync: { notificationsMuted: true } });
      ext.api.setSite(() => new Response("<html></html>", { status: 200 }));
      ext.api.setSettingsRoute(ext.api.networkError);
      ext.api.setWatchRoute(ext.api.networkError);

      ext.pages.onlinejobsph = [job(1)];
      await popup.click(popup.$("check-now"));
      ext.pages.onlinejobsph = [job(2), job(1)];
      await popup.click(popup.$("check-now"));

      // Muted, as the account had it: the feed and the badge, no notification.
      expect(ext.local().feed.map((entry) => entry.title)).toEqual(["PHP Developer 2"]);
      expect(ext.chrome.notifications.create).not.toHaveBeenCalled();
      expect(ext.sounds).toEqual([]);
    });

    it("a setting changed on the web applies to the very next check", async () => {
      const popup = await start({ watches: [WATCHES[0]] });
      ext.api.setSite(() => new Response("<html></html>", { status: 200 }));
      ext.pages.onlinejobsph = [job(1)];
      await popup.click(popup.$("check-now"));
      ext.api.setSettings({ soundId: "alert" });

      ext.pages.onlinejobsph = [job(2), job(1)];
      await ext.chrome.alarms.onAlarm.dispatch({ name: "check-jobs", scheduledTime: Date.now() });
      await popup.settle();

      expect(ext.sounds).toEqual(["alert"]);
    });

    it("an interval changed on the web re-arms the alarm on it, a whole interval away, so no second check starts", async () => {
      ext = await startExtension({ connected: true, watches: [WATCHES[0]] });
      ext.api.setSite(() => new Response("<html></html>", { status: 200 }));
      ext.api.setSettings({ intervalMinutes: 30 });

      await ext.chrome.alarms.onAlarm.dispatch({ name: "check-jobs", scheduledTime: Date.now() });
      await ext.settle();

      expect(ext.chrome.alarms.create).toHaveBeenLastCalledWith("check-jobs", { delayInMinutes: 30, periodInMinutes: 30 });
      expect(ext.sync().intervalMinutes).toBe(30);

      // The same interval again: the alarm is left alone.
      ext.chrome.alarms.create.mockClear();
      await ext.chrome.alarms.onAlarm.dispatch({ name: "check-jobs", scheduledTime: Date.now() });
      await ext.settle();
      expect(ext.chrome.alarms.create).not.toHaveBeenCalled();
    });

    it("paused, an interval changed on the web makes no alarm", async () => {
      ext = await startExtension({ connected: true, local: { watcherState: "paused" } });
      ext.chrome.alarms.create.mockClear();
      ext.api.setSettings({ intervalMinutes: 30 });

      await ext.send({ type: "sync-settings" });

      expect(ext.sync().intervalMinutes).toBe(30);
      expect(ext.chrome.alarms.create).not.toHaveBeenCalled();
      expect(await ext.chrome.alarms.get("check-jobs")).toBeUndefined();
    });
  });

  describe("connecting, and the settings chosen before it", () => {
    const own = { intervalMinutes: 1, soundId: "soft", notificationsMuted: true, titleFilter: { enabled: false, keywords: ["rust"] } };

    it("the account's settings are used from the first sync, and the browser's own are kept for the import (WD-81)", async () => {
      ext = await startExtension({ sync: own });
      const popup = await ext.openPopup();
      expect(popup.$("interval").value).toBe("1");
      // The account, with WatchDesk's defaults for a new one.
      ext.api.setSettings({ intervalMinutes: 5, soundId: "chime", notificationsMuted: false, titleFilter: { enabled: true, keywords: ["php"] } });
      await ext.chrome.storage.local.set({ [TOKEN_KEY]: TEST_TOKEN });

      const reopened = await ext.openPopup();

      expect(reopened.$("interval").value).toBe("5");
      expect(reopened.$("sound").value).toBe("chime");
      expect(reopened.$("mute-notifications").checked).toBe(false);
      expect(chips(reopened)).toEqual(["php"]);
      expect(reopened.text("settings-sync-note")).toBe(IN_ACCOUNT);
      expect(ext.local().watchdeskSettingsBeforeConnect).toEqual({ takenAt: Date.now(), settings: own });
      // Nothing of the browser's own was sent up: that is WD-81's to offer.
      expect(settingsCalls("PUT")).toEqual([]);
      expect(ext.chrome.alarms.create).toHaveBeenLastCalledWith("check-jobs", { delayInMinutes: 5, periodInMinutes: 5 });
    });
  });

  describe("Import, with an account connected", () => {
    const pickFile = async (popup, data) => {
      const input = popup.$("import-settings-file");
      Object.defineProperty(input, "files", { configurable: true, value: [{ text: async () => JSON.stringify(data) }] });
      input.dispatchEvent(new popup.window.Event("change"));
      await popup.settle();
    };
    const backup = {
      watches: [{ id: "w_1700000000000_abcde", siteId: "upwork", url: `${UPWORK_URL}&page=3`, label: "Imported", enabled: true }],
      intervalMinutes: 15,
      soundId: "ping",
      notificationsMuted: true,
      titleFilter: { enabled: false, keywords: ["react"] },
    };
    const status = (popup) => [popup.text("settings-status-msg"), popup.$("settings-status-msg").className];

    it("saves the file's settings in the account, in one write", async () => {
      const popup = await start();
      await popup.click(popup.$("settings-toggle"));
      const puts = settingsCalls("PUT").length;

      await pickFile(popup, backup);

      expect(status(popup)).toEqual(["Imported 1 watch.", "settings-status success"]);
      expect(settingsCalls("PUT")).toHaveLength(puts + 1);
      expect(ext.api.settings()).toEqual({
        intervalMinutes: 15,
        soundId: "ping",
        notificationsMuted: true,
        titleFilter: { enabled: false, keywords: ["react"] },
        watcherState: "running",
      });
      expect(popup.$("interval").value).toBe("15");
    });

    it("says so when the watches went in and the account would not take the settings", async () => {
      const popup = await start();
      await popup.click(popup.$("settings-toggle"));

      await pickFile(popup, { ...backup, soundId: "bell" });

      expect(status(popup)).toEqual([
        "Imported 1 watch. The file's settings were not applied: Choose one of the alert sounds",
        "settings-status error",
      ]);
      expect(popup.labels()).toContain("Imported");
      expect(ext.api.settings()).toMatchObject({ intervalMinutes: 5, soundId: "chime" });
      expect(popup.$("sound").value).toBe("chime");
    });
  });
});
