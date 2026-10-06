// The settings of a connected browser (account-settings.js, WD-79), against
// a mocked chrome.* and a fake WatchDesk that keeps the account's settings:
// the copy the check cycle reads, the one read-modify-write that every write
// to the account's settings is, what is kept from before connecting, and
// what happens when WatchDesk cannot be asked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { installFakeWatchDesk, TEST_TOKEN } from "./helpers/fake-watchdesk.js";
import { ACCOUNT_KEY, SETTINGS_SYNC_KEY, TOKEN_KEY, WATCHER_SYNC_KEY, WATCH_SYNC_KEY } from "../account-connection.js";

const OTHER_TOKEN = "wd_ffffffffffffffffffffffffffffffff.othersecret-abcdefghijklmnopqrstuvwxyz0123";
// The account's settings before anything here changes them (the fake's).
const SYNCED = {
  intervalMinutes: 15,
  soundId: "ping",
  notificationsMuted: true,
  titleFilter: { enabled: true, keywords: ["php"] },
};
const ON_WATCHDESK = { ...SYNCED, watcherState: "running" };
// What a user had chosen in this browser before connecting. Mute was never
// touched, so it was never stored.
const OWN = { intervalMinutes: 1, soundId: "soft", titleFilter: { enabled: false, keywords: ["rust"] } };

const OFFLINE = "Can't reach WatchDesk, so that wasn't saved. Your settings are shown as last loaded.";

let env;
let api;
let settings;
let watcher;
let copyChanged;

const connect = (token = TEST_TOKEN) => env.chrome.storage.local.set({ [TOKEN_KEY]: token });
// What account-connection.js does when a token is refused or replaced.
const disconnect = () => env.chrome.storage.local.remove([TOKEN_KEY, ACCOUNT_KEY, WATCH_SYNC_KEY, WATCHER_SYNC_KEY, SETTINGS_SYNC_KEY]);
const local = () => env.chrome.storage.local.dump();
const copy = () => env.chrome.storage.sync.dump();
const state = () => local()[SETTINGS_SYNC_KEY];
const snapshot = () => local()[settings.SETTINGS_SNAPSHOT_KEY];
const calls = () => api.settingsCalls().map((r) => r.method);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-05T09:00:00Z"));
  env = installChromeMock();
  api = installFakeWatchDesk();
  vi.resetModules();
  settings = await import("../account-settings.js");
  watcher = await import("../watcher-state.js");
  copyChanged = vi.fn(async () => {});
  settings.configureAccountSettings({ onCopyChanged: copyChanged });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("with no account connected", () => {
  it("does nothing: no request, no storage touched, and the settings are this browser's", async () => {
    await env.chrome.storage.sync.set(OWN);
    env.chrome.storage.sync.set.mockClear();

    expect(await settings.usesAccountSettings()).toBe(false);
    expect(await settings.syncAccountSettings()).toEqual({ mode: "local" });
    expect(await settings.getSettingsSyncStatus()).toEqual({ mode: "local" });

    expect(api.fetch).not.toHaveBeenCalled();
    expect(copy()).toEqual(OWN);
    expect(env.chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(local()).toEqual({});
  });

  it("refuses a save rather than send it anywhere", async () => {
    const result = await settings.saveAccountSettings({ intervalMinutes: 30 });
    expect(result.ok).toBe(false);
    expect(api.fetch).not.toHaveBeenCalled();
    expect(copy()).toEqual({});
  });
});

describe("loading the account's settings", () => {
  beforeEach(() => connect());

  it("copies them into the keys the check cycle reads, with one GET and no watcher state", async () => {
    expect(await settings.syncAccountSettings()).toEqual({ mode: "account", lastSyncedAt: Date.now(), problem: null });

    expect(calls()).toEqual(["GET"]);
    expect(api.settingsCalls()[0].headers).toEqual({ Authorization: `Bearer ${TEST_TOKEN}` });
    expect(copy()).toEqual(SYNCED);
    expect(copyChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps the token and everything about the connection out of chrome.storage.sync", async () => {
    await settings.syncAccountSettings();
    expect(Object.keys(copy()).sort()).toEqual([...settings.SYNCED_SETTINGS].sort());
    expect(JSON.stringify(copy())).not.toContain(TEST_TOKEN);
    expect(JSON.stringify(env.chrome.storage.session.dump())).not.toContain(TEST_TOKEN);
  });

  it("writes nothing to chrome.storage.sync when nothing changed, however often it is asked", async () => {
    await settings.syncAccountSettings();
    env.chrome.storage.sync.set.mockClear();
    copyChanged.mockClear();

    await settings.syncAccountSettings();
    await settings.syncAccountSettings();

    expect(env.chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(copyChanged).not.toHaveBeenCalled();
  });

  it("a change made on the web arrives on the next sync, and only that key is written", async () => {
    await settings.syncAccountSettings();
    env.chrome.storage.sync.set.mockClear();
    copyChanged.mockClear();
    api.setSettings({ intervalMinutes: 30 });
    vi.setSystemTime(Date.now() + 60000);

    expect((await settings.syncAccountSettings()).lastSyncedAt).toBe(Date.now());

    expect(env.chrome.storage.sync.set.mock.calls).toEqual([[{ intervalMinutes: 30 }]]);
    expect(copy()).toEqual({ ...SYNCED, intervalMinutes: 30 });
    expect(copyChanged).toHaveBeenCalledTimes(1);
  });

  it("never reads the watcher state back: paused on the account, this browser goes on running", async () => {
    api.setSettings({ watcherState: "paused" });
    await settings.syncAccountSettings();

    expect(await watcher.getWatcherState()).toBe("running");
    expect(local()[watcher.WATCHER_STATE_KEY]).toBeUndefined();
    expect(copy().watcherState).toBeUndefined();
    expect(api.settings().watcherState).toBe("paused");
  });

  it("survives a new service worker: the copy and its record are in storage, not in the module", async () => {
    await settings.syncAccountSettings();
    const at = Date.now();
    vi.resetModules();
    const restarted = await import("../account-settings.js");

    expect(await restarted.getSettingsSyncStatus()).toEqual({ mode: "account", lastSyncedAt: at, problem: null });
    expect(copy()).toEqual(SYNCED);
  });

  describe("when WatchDesk cannot give them", () => {
    beforeEach(async () => {
      await settings.syncAccountSettings();
      copyChanged.mockClear();
    });
    const at = () => state().lastSyncedAt;

    it("offline: the copy stays, and the status says so until WatchDesk is back", async () => {
      const synced = at();
      api.setSettingsRoute(api.networkError);
      vi.setSystemTime(Date.now() + 60000);

      expect(await settings.syncAccountSettings()).toEqual({ mode: "account", lastSyncedAt: synced, problem: "offline" });
      expect(copy()).toEqual(SYNCED);

      api.setSettingsRoute(() => undefined);
      expect(await settings.syncAccountSettings()).toEqual({ mode: "account", lastSyncedAt: Date.now(), problem: null });
    });

    it.each([
      ["a 500", () => api.json(500, { error: "boom" })],
      ["a 429", () => api.json(429, {}, { "Retry-After": "30" })],
      ["a 403, waited out like an outage", () => api.json(403, { error: "Forbidden." })],
      ["a 404: the account has no settings row", () => api.json(404, { error: "Settings not found." })],
    ])("%s: the copy stays, nothing is retried, and the status says WatchDesk could not give them", async (_name, answer) => {
      api.setSettingsRoute(answer);
      const before = calls().length;

      expect((await settings.syncAccountSettings()).problem).toBe("unavailable");

      expect(calls().length).toBe(before + 1);
      expect(copy()).toEqual(SYNCED);
      expect(local()[TOKEN_KEY]).toBe(TEST_TOKEN);
      expect(copyChanged).not.toHaveBeenCalled();
    });

    it.each([
      ["no interval", { ...ON_WATCHDESK, intervalMinutes: undefined }],
      ["an interval of zero", { ...ON_WATCHDESK, intervalMinutes: 0 }],
      ["an interval that is not a number", { ...ON_WATCHDESK, intervalMinutes: "5" }],
      ["no sound", { ...ON_WATCHDESK, soundId: "" }],
      ["a mute that is not true or false", { ...ON_WATCHDESK, notificationsMuted: "no" }],
      ["no title filter", { ...ON_WATCHDESK, titleFilter: null }],
      ["keywords that are not a list", { ...ON_WATCHDESK, titleFilter: { enabled: true, keywords: "php" } }],
      ["a keyword that is not text", { ...ON_WATCHDESK, titleFilter: { enabled: true, keywords: ["php", 7] } }],
      ["an empty object", {}],
    ])("an answer with %s is not settings: the check goes on reading the copy it had", async (_name, body) => {
      api.setSettingsRoute(() => api.json(200, body));

      expect((await settings.syncAccountSettings()).problem).toBe("unavailable");
      expect(copy()).toEqual(SYNCED);
    });

    it("gives up after 10 seconds", async () => {
      api.setSettingsRoute(api.hang);
      const syncing = settings.syncAccountSettings();
      await vi.advanceTimersByTimeAsync(9999);
      expect(state().problem).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect((await syncing).problem).toBe("offline");
    });

    it("never throws, even when chrome.storage.sync refuses the write", async () => {
      api.setSettings({ soundId: "alert" });
      env.chrome.storage.sync.set.mockRejectedValueOnce(new Error("QUOTA_BYTES_PER_ITEM quota exceeded"));

      expect((await settings.syncAccountSettings()).problem).toBe("unavailable");
      expect(copy()).toEqual(SYNCED);
    });
  });

  describe("the connection it was read on", () => {
    it("a refused token ends the connection: the last copy becomes this browser's own settings", async () => {
      await settings.syncAccountSettings();
      api.setSettingsRoute(() => api.json(401, { error: "Sign in to continue." }));
      // account-connection.js is loaded with the module, so the shared 401
      // handler is the real one.
      expect(await settings.syncAccountSettings()).toEqual({ mode: "local" });

      expect(local()[TOKEN_KEY]).toBeUndefined();
      expect(state()).toBeUndefined();
      expect(copy()).toEqual(SYNCED);
      expect(await settings.usesAccountSettings()).toBe(false);
    });

    it("another account connecting while the request is out: its answer is dropped, not copied for the new one", async () => {
      await env.chrome.storage.sync.set(OWN);
      api.setSettingsRoute(() => {
        env.chrome.storage.local.set({ [TOKEN_KEY]: OTHER_TOKEN });
        return undefined;
      });

      await settings.syncAccountSettings();

      expect(copy()).toEqual(OWN);
      expect(state()).toBeUndefined();
      expect(snapshot()).toBeUndefined();
      expect(copyChanged).not.toHaveBeenCalled();
    });
  });
});

describe("the settings a user had before connecting", () => {
  it("are kept at the first sync, as stored, before the account's replace them", async () => {
    await env.chrome.storage.sync.set({ ...OWN, watches: [{ id: "default" }] });
    await connect();

    await settings.syncAccountSettings();

    expect(snapshot()).toEqual({ takenAt: Date.now(), settings: OWN });
    expect(copy()).toEqual({ ...SYNCED, watches: [{ id: "default" }] });
    // In this browser only.
    expect(JSON.stringify(copy())).not.toContain("rust");
  });

  it("a browser that never stored a setting is kept as that: every one was the default", async () => {
    await connect();
    await settings.syncAccountSettings();
    expect(snapshot()).toEqual({ takenAt: Date.now(), settings: {} });
  });

  it("are not taken again by later syncs or saves, whatever changes on the account", async () => {
    await env.chrome.storage.sync.set(OWN);
    await connect();
    await settings.syncAccountSettings();
    const kept = snapshot();
    vi.setSystemTime(Date.now() + 60000);

    api.setSettings({ soundId: "alert" });
    await settings.syncAccountSettings();
    await settings.saveAccountSettings({ intervalMinutes: 5 });

    expect(snapshot()).toEqual(kept);
  });

  it("are taken when the first thing a connection does is a save, not a sync", async () => {
    await env.chrome.storage.sync.set(OWN);
    await connect();

    expect(await settings.saveAccountSettings({ notificationsMuted: false })).toEqual({ ok: true });

    expect(snapshot().settings).toEqual(OWN);
    expect(copy()).toEqual({ ...SYNCED, notificationsMuted: false });
  });

  it("a first sync that fails takes nothing and leaves them in place", async () => {
    await env.chrome.storage.sync.set(OWN);
    await connect();
    api.setSettingsRoute(api.networkError);

    expect(await settings.syncAccountSettings()).toEqual({ mode: "account", lastSyncedAt: null, problem: "offline" });

    expect(copy()).toEqual(OWN);
    expect(snapshot()).toBeUndefined();
  });

  it("survive a disconnect and a reconnect in which nothing was changed here", async () => {
    await env.chrome.storage.sync.set(OWN);
    await connect();
    await settings.syncAccountSettings();
    const kept = snapshot();

    await disconnect();
    vi.setSystemTime(Date.now() + 3600000);
    await connect(OTHER_TOKEN);
    await settings.syncAccountSettings();

    expect(snapshot()).toEqual(kept);
  });

  it("are taken again when the user changed a setting while disconnected", async () => {
    await env.chrome.storage.sync.set(OWN);
    await connect();
    await settings.syncAccountSettings();
    await disconnect();
    // Not connected, a change is this browser's own (background.js).
    await env.chrome.storage.sync.set({ soundId: "alert" });
    vi.setSystemTime(Date.now() + 3600000);

    await connect();
    await settings.syncAccountSettings();

    expect(snapshot()).toEqual({ takenAt: Date.now(), settings: { ...SYNCED, soundId: "alert" } });
    expect(copy()).toEqual(SYNCED);
  });
});

describe("saving a setting in the account", () => {
  beforeEach(async () => {
    await connect();
    await settings.syncAccountSettings();
    copyChanged.mockClear();
  });
  const sinceSync = () => api.settingsCalls().slice(1);

  it("reads the account's settings and sends them all back with only that one changed", async () => {
    expect(await settings.saveAccountSettings({ intervalMinutes: 30 })).toEqual({ ok: true });

    expect(sinceSync().map((r) => r.method)).toEqual(["GET", "PUT"]);
    const put = sinceSync()[1];
    expect(put.headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` });
    expect(put.body).toEqual({ ...ON_WATCHDESK, intervalMinutes: 30 });
    expect(api.settings()).toEqual({ ...ON_WATCHDESK, intervalMinutes: 30 });
    expect(copy()).toEqual({ ...SYNCED, intervalMinutes: 30 });
    expect(copyChanged).toHaveBeenCalledTimes(1);
    expect(await settings.getSettingsSyncStatus()).toEqual({ mode: "account", lastSyncedAt: Date.now(), problem: null });
  });

  it("sends back the watcher state WatchDesk holds, so a save can neither pause nor start watching", async () => {
    // Paused from another browser on the account; this one is running.
    api.setSettings({ watcherState: "paused" });

    await settings.saveAccountSettings({ soundId: "alert" });

    expect(sinceSync()[1].body.watcherState).toBe("paused");
    expect(api.settings()).toEqual({ ...ON_WATCHDESK, soundId: "alert", watcherState: "paused" });
    expect(await watcher.getWatcherState()).toBe("running");
  });

  it("sends back what was changed on the web since the last sync, not this browser's copy of it", async () => {
    api.setSettings({ soundId: "soft", titleFilter: { enabled: false, keywords: ["go"] } });

    await settings.saveAccountSettings({ notificationsMuted: false });

    const expected = { ...SYNCED, soundId: "soft", titleFilter: { enabled: false, keywords: ["go"] }, notificationsMuted: false };
    expect(api.settings()).toEqual({ ...expected, watcherState: "running" });
    // And the copy now has the web's changes too.
    expect(copy()).toEqual(expected);
  });

  it("sends back a setting this version does not know", async () => {
    api.setSettingsRoute((request) => (request.method === "GET" ? api.json(200, { ...ON_WATCHDESK, somethingNew: 7 }) : undefined));

    await settings.saveAccountSettings({ intervalMinutes: 1 });

    expect(sinceSync()[1].body).toEqual({ ...ON_WATCHDESK, somethingNew: 7, intervalMinutes: 1 });
  });

  it("several settings at once are one write (an imported backup)", async () => {
    const file = { intervalMinutes: 5, soundId: "chime", notificationsMuted: false, titleFilter: { enabled: false, keywords: ["react"] } };

    expect(await settings.saveAccountSettings(file)).toEqual({ ok: true });

    expect(sinceSync().map((r) => r.method)).toEqual(["GET", "PUT"]);
    expect(api.settings()).toEqual({ ...file, watcherState: "running" });
    expect(copy()).toEqual(file);
  });

  it("stores the keywords as WatchDesk kept them: trimmed, without repeats", async () => {
    await settings.saveAccountSettings({ titleFilter: { enabled: true, keywords: ["php", "  React ", "PHP", "react", ""] } });

    expect(api.settings().titleFilter).toEqual({ enabled: true, keywords: ["php", "React"] });
    expect(copy().titleFilter).toEqual({ enabled: true, keywords: ["php", "React"] });
  });

  it("writes nothing when the account already has the value, and still takes in what it read", async () => {
    api.setSettings({ soundId: "soft" });

    expect(await settings.saveAccountSettings({ intervalMinutes: 15 })).toEqual({ ok: true });

    expect(sinceSync().map((r) => r.method)).toEqual(["GET"]);
    expect(copy().soundId).toBe("soft");
  });

  describe("a value WatchDesk would refuse", () => {
    it.each([
      [{ intervalMinutes: 10 }, "Check interval must be 1, 5, 15 or 30 minutes"],
      [{ soundId: "bell" }, "Choose one of the alert sounds"],
      [{ titleFilter: { enabled: true, keywords: ["x".repeat(101)] } }, "A keyword must be at most 100 characters"],
      [{ titleFilter: { enabled: true, keywords: Array.from({ length: 101 }, (_, i) => `k${i}`) } }, "Keep at most 100 keywords"],
    ])("%j is refused with WatchDesk's own words, and no request", async (patch, error) => {
      expect(await settings.saveAccountSettings(patch)).toEqual({ ok: false, error });
      expect(sinceSync()).toEqual([]);
      expect(copy()).toEqual(SYNCED);
    });

    it("at the limit it goes through: 100 keywords, one of 100 characters", async () => {
      const keywords = [...Array.from({ length: 99 }, (_, i) => `k${i}`), "x".repeat(100)];
      expect(await settings.saveAccountSettings({ titleFilter: { enabled: true, keywords } })).toEqual({ ok: true });
      expect(api.settings().titleFilter.keywords).toHaveLength(100);
    });

    it("a refusal that only WatchDesk makes is shown in its words, and the copy goes to what the account holds", async () => {
      api.setSettings({ soundId: "soft" });
      api.setSettingsRoute((request) =>
        request.method === "PUT"
          ? api.json(400, { error: "Check the highlighted fields.", fieldErrors: { intervalMinutes: ["Check interval must be 5, 15 or 30 minutes"] } })
          : undefined,
      );

      expect(await settings.saveAccountSettings({ intervalMinutes: 1 })).toEqual({
        ok: false,
        error: "Check interval must be 5, 15 or 30 minutes",
      });

      expect(api.settings().intervalMinutes).toBe(15);
      expect(copy()).toEqual({ ...SYNCED, soundId: "soft" });
      // WatchDesk answered; it is not out of reach.
      expect(state().problem).toBeNull();
    });
  });

  describe("when WatchDesk cannot take it", () => {
    it("offline: the change is refused, not queued, and nothing here changes", async () => {
      api.setSettingsRoute(api.networkError);

      expect(await settings.saveAccountSettings({ intervalMinutes: 30 })).toEqual({ ok: false, error: OFFLINE });

      expect(sinceSync().map((r) => r.method)).toEqual(["GET"]);
      expect(copy()).toEqual(SYNCED);
      expect(state().problem).toBe("offline");
      expect(copyChanged).not.toHaveBeenCalled();

      // Back online, nothing is replayed: the account is as it was.
      api.setSettingsRoute(() => undefined);
      await settings.syncAccountSettings();
      expect(api.settingsCalls("PUT")).toHaveLength(0);
      expect(api.settings()).toEqual(ON_WATCHDESK);
    });

    it("the write lost after the read got through: refused, and the copy is what the account was just read to hold", async () => {
      api.setSettings({ soundId: "soft" });
      api.setSettingsRoute((request) => (request.method === "PUT" ? api.networkError() : undefined));

      expect(await settings.saveAccountSettings({ intervalMinutes: 30 })).toEqual({ ok: false, error: OFFLINE });

      expect(sinceSync().map((r) => r.method)).toEqual(["GET", "PUT"]);
      expect(api.settings().intervalMinutes).toBe(15);
      expect(copy()).toEqual({ ...SYNCED, soundId: "soft" });
      expect(state().problem).toBe("offline");
    });

    it.each([
      [() => api.json(429, {}, { "Retry-After": "30" }), "WatchDesk is busy, so that wasn't saved. Try again in 30 s."],
      [() => api.json(429, {}, { "Retry-After": "90" }), "WatchDesk is busy, so that wasn't saved. Try again in 2 min."],
      [() => api.json(429, {}), "WatchDesk is busy, so that wasn't saved. Try again in a moment."],
      [() => api.json(403, { error: "Forbidden." }), "WatchDesk isn't accepting changes from this account right now, so that wasn't saved."],
      [
        () => api.json(404, { error: "Settings not found." }),
        "WatchDesk has no settings for this account yet, so that wasn't saved. Sign in to WatchDesk once, then try again.",
      ],
      [() => api.json(500, { error: `boom ${TEST_TOKEN}` }), "WatchDesk couldn't save that just now. Try again."],
    ])("says why, sends it once, and keeps the token and the copy", async (answer, error) => {
      api.setSettingsRoute(answer);

      const result = await settings.saveAccountSettings({ intervalMinutes: 30 });

      expect(result).toEqual({ ok: false, error });
      expect(JSON.stringify(result)).not.toContain(TEST_TOKEN);
      expect(sinceSync()).toHaveLength(1);
      expect(copy()).toEqual(SYNCED);
      expect(local()[TOKEN_KEY]).toBe(TEST_TOKEN);
    });

    it("a refused token: nothing is saved, and the settings are this browser's own again", async () => {
      api.setSettingsRoute(() => api.json(401, { error: "Sign in to continue." }));

      expect(await settings.saveAccountSettings({ intervalMinutes: 30 })).toEqual({
        ok: false,
        error:
          "This browser was disconnected from your WatchDesk account, so that wasn't saved. Settings are saved in this browser only now.",
      });

      expect(local()[TOKEN_KEY]).toBeUndefined();
      expect(state()).toBeUndefined();
      expect(copy()).toEqual(SYNCED);
      expect(await settings.getSettingsSyncStatus()).toEqual({ mode: "local" });
    });

    it("never throws: storage failing is a refusal like any other", async () => {
      env.chrome.storage.sync.set.mockRejectedValueOnce(new Error("MAX_WRITE_OPERATIONS_PER_MINUTE"));
      expect(await settings.saveAccountSettings({ intervalMinutes: 30 })).toEqual({
        ok: false,
        error: "WatchDesk couldn't save that just now. Try again.",
      });
    });
  });

  describe("the connection it was read on", () => {
    const CHANGED = { ok: false, error: "The connected WatchDesk account changed, so that wasn't saved." };

    it("another account connecting between the read and the write: the write is never sent", async () => {
      api.setSettingsRoute((request) => {
        if (request.method === "GET") env.chrome.storage.local.set({ [TOKEN_KEY]: OTHER_TOKEN });
        return undefined;
      });

      expect(await settings.saveAccountSettings({ intervalMinutes: 30 })).toEqual(CHANGED);

      expect(sinceSync().map((r) => r.method)).toEqual(["GET"]);
      expect(api.settings()).toEqual(ON_WATCHDESK);
      expect(copy()).toEqual(SYNCED);
    });

    it("another account connecting while the write is out: its answer is not copied for the new one", async () => {
      api.setSettingsRoute((request) => {
        if (request.method === "PUT") {
          // account-connection.js drops this connection's records with it.
          env.chrome.storage.local.remove(SETTINGS_SYNC_KEY);
          env.chrome.storage.local.set({ [TOKEN_KEY]: OTHER_TOKEN });
        }
        return undefined;
      });

      expect(await settings.saveAccountSettings({ intervalMinutes: 30 })).toEqual(CHANGED);

      expect(sinceSync()[1].headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`);
      expect(copy()).toEqual(SYNCED);
      expect(state()).toBeUndefined();
      expect(copyChanged).not.toHaveBeenCalled();
    });
  });
});

describe("one write at a time", () => {
  beforeEach(async () => {
    await connect();
    await settings.syncAccountSettings();
  });
  const sinceSync = () => api.settingsCalls().slice(1);

  it("two quick changes cannot interleave: the second is built on the first, and both are saved", async () => {
    const [first, second] = await Promise.all([
      settings.saveAccountSettings({ intervalMinutes: 30 }),
      settings.saveAccountSettings({ notificationsMuted: false }),
    ]);

    expect([first, second]).toEqual([{ ok: true }, { ok: true }]);
    expect(sinceSync().map((r) => r.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
    expect(sinceSync()[3].body).toEqual({ ...ON_WATCHDESK, intervalMinutes: 30, notificationsMuted: false });
    expect(api.settings()).toEqual({ ...ON_WATCHDESK, intervalMinutes: 30, notificationsMuted: false });
    expect(copy()).toEqual({ ...SYNCED, intervalMinutes: 30, notificationsMuted: false });
  });

  it("of two changes to the same setting, the last one wins", async () => {
    await Promise.all([settings.saveAccountSettings({ soundId: "alert" }), settings.saveAccountSettings({ soundId: "soft" })]);

    expect(api.settings().soundId).toBe("soft");
    expect(copy().soundId).toBe("soft");
  });

  it("a change waits behind a sync that is on its way, and is not undone by it", async () => {
    const [, saved] = await Promise.all([settings.syncAccountSettings(), settings.saveAccountSettings({ soundId: "alert" })]);

    expect(saved).toEqual({ ok: true });
    expect(copy().soundId).toBe("alert");
  });

  it("a refused change does not hold up the one behind it", async () => {
    const [bad, good] = await Promise.all([
      settings.saveAccountSettings({ intervalMinutes: 99 }),
      settings.saveAccountSettings({ intervalMinutes: 1 }),
    ]);
    expect(bad.ok).toBe(false);
    expect(good).toEqual({ ok: true });
    expect(api.settings().intervalMinutes).toBe(1);
  });

  // The two writers of the account's settings in this extension (WD-71's
  // report and the popup's settings), in both orders.
  it("a pause reported while a setting is being saved: the account ends up paused, with the new setting", async () => {
    await watcher.saveWatcherState("paused");
    let reported;
    api.setSettingsRoute((request) => {
      // The report starts while the save's read is still out.
      if (request.method === "GET" && !reported) reported = watcher.reflectWatcherState();
      return undefined;
    });

    expect(await settings.saveAccountSettings({ intervalMinutes: 30 })).toEqual({ ok: true });
    await reported;

    expect(sinceSync().map((r) => r.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
    expect(sinceSync()[1].body).toEqual({ ...ON_WATCHDESK, intervalMinutes: 30 });
    expect(sinceSync()[3].body).toEqual({ ...ON_WATCHDESK, intervalMinutes: 30, watcherState: "paused" });
    expect(api.settings()).toEqual({ ...ON_WATCHDESK, intervalMinutes: 30, watcherState: "paused" });
    expect(local()[WATCHER_SYNC_KEY]).toEqual({ sent: "paused", failed: false });
  });

  it("a setting saved while a pause is being reported: the same, the other way round", async () => {
    await watcher.saveWatcherState("paused");
    let saved;
    api.setSettingsRoute((request) => {
      if (request.method === "GET" && !saved) saved = settings.saveAccountSettings({ intervalMinutes: 30 });
      return undefined;
    });

    await watcher.reflectWatcherState();
    expect(await saved).toEqual({ ok: true });

    expect(sinceSync().map((r) => r.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
    expect(sinceSync()[1].body).toEqual({ ...ON_WATCHDESK, watcherState: "paused" });
    expect(sinceSync()[3].body).toEqual({ ...ON_WATCHDESK, watcherState: "paused", intervalMinutes: 30 });
    expect(api.settings()).toEqual({ ...ON_WATCHDESK, intervalMinutes: 30, watcherState: "paused" });
    expect(copy().intervalMinutes).toBe(30);
  });

  it("Start and Pause never reset a setting: the report sends back what the account holds, not this browser's copy", async () => {
    // Changed on the web; this browser's copy still has the old values.
    api.setSettings({ intervalMinutes: 1, titleFilter: { enabled: false, keywords: ["go"] } });
    await watcher.saveWatcherState("paused");
    await watcher.reflectWatcherState();
    await watcher.saveWatcherState("running");
    await watcher.reflectWatcherState();

    expect(api.settings()).toEqual({ ...ON_WATCHDESK, intervalMinutes: 1, titleFilter: { enabled: false, keywords: ["go"] } });
    // The report is not a sync: the copy is left for the next one.
    expect(copy()).toEqual(SYNCED);
  });

  it("changeAccountSettings is the one place a PUT body is built: the fields given, over what was just read", async () => {
    const connection = await (await import("../account-connection.js")).captureConnection();
    api.setSettings({ soundId: "soft" });

    const result = await settings.changeAccountSettings({ watcherState: "paused" }, connection);

    expect(result).toEqual({ kind: "ok", settings: { ...ON_WATCHDESK, soundId: "soft", watcherState: "paused" } });
    expect(sinceSync()[1].body).toEqual({ ...ON_WATCHDESK, soundId: "soft", watcherState: "paused" });
  });
});
