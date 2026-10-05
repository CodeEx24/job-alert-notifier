// Whether watching is running or paused (watcher-state.js, WD-71), against a
// mocked chrome.* and a fake WatchDesk that keeps the account's settings:
// where the state is kept, what telling WatchDesk sends, and what happens
// when WatchDesk cannot be told.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { installFakeWatchDesk, TEST_TOKEN } from "./helpers/fake-watchdesk.js";
import { ACCOUNT_KEY, TOKEN_KEY, WATCHER_SYNC_KEY } from "../account-connection.js";

const OTHER_TOKEN = "wd_ffffffffffffffffffffffffffffffff.othersecret-abcdefghijklmnopqrstuvwxyz0123";
// The account's settings before anything here changes them (the fake's).
const ON_WATCHDESK = {
  intervalMinutes: 15,
  soundId: "ping",
  notificationsMuted: true,
  titleFilter: { enabled: true, keywords: ["php"] },
  watcherState: "running",
};

let env;
let api;
let watcher;

const connect = () => env.chrome.storage.local.set({ [TOKEN_KEY]: TEST_TOKEN });
const local = () => env.chrome.storage.local.dump();
const record = () => local()[WATCHER_SYNC_KEY];
const methods = () => api.settingsCalls().map((r) => r.method);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-05T09:00:00Z"));
  env = installChromeMock();
  api = installFakeWatchDesk();
  vi.resetModules();
  watcher = await import("../watcher-state.js");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("this browser's state", () => {
  it("is running until the user pauses: an extension nobody has paused checks", async () => {
    expect(await watcher.getWatcherState()).toBe("running");
    expect(await watcher.isWatchingPaused()).toBe(false);
    expect(watcher.WATCHER_STATES).toEqual(["running", "paused"]);
  });

  it("is kept in chrome.storage.local, never in sync, and read back by a new worker", async () => {
    await watcher.saveWatcherState("paused");

    expect(local()[watcher.WATCHER_STATE_KEY]).toBe("paused");
    expect(env.chrome.storage.sync.dump()).toEqual({});
    expect(env.chrome.storage.session.dump()).toEqual({});

    // A service worker restart: a new module, the same storage.
    vi.resetModules();
    const restarted = await import("../watcher-state.js");
    expect(await restarted.getWatcherState()).toBe("paused");
    expect(await restarted.isWatchingPaused()).toBe(true);

    await restarted.saveWatcherState("running");
    expect(await restarted.getWatcherState()).toBe("running");
  });

  it.each([undefined, null, "", "stopped", 1, { state: "paused" }])("reads a stored %j as running", async (stored) => {
    await env.chrome.storage.local.set({ [watcher.WATCHER_STATE_KEY]: stored });
    expect(await watcher.getWatcherState()).toBe("running");
  });

  it("saves anything that is not paused as running", async () => {
    await watcher.saveWatcherState("stopped");
    expect(local()[watcher.WATCHER_STATE_KEY]).toBe("running");
  });

  it("knows the two states and nothing else", () => {
    expect(watcher.isWatcherState("running")).toBe(true);
    expect(watcher.isWatcherState("paused")).toBe(true);
    expect(watcher.isWatcherState("Paused")).toBe(false);
    expect(watcher.isWatcherState(undefined)).toBe(false);
  });
});

describe("with no account connected", () => {
  it("sends nothing and keeps no record, paused or running", async () => {
    await watcher.saveWatcherState("paused");
    expect(await watcher.reflectWatcherState()).toBe(false);
    await watcher.saveWatcherState("running");
    expect(await watcher.reflectWatcherState()).toBe(false);

    expect(api.fetch).not.toHaveBeenCalled();
    expect(record()).toBeUndefined();
    expect(await watcher.getWatcherSyncStatus()).toBeNull();
  });

  it("says nothing about WatchDesk even with a record left behind", async () => {
    await env.chrome.storage.local.set({ [WATCHER_SYNC_KEY]: { sent: "running", failed: true } });
    await watcher.saveWatcherState("paused");
    expect(await watcher.getWatcherSyncStatus()).toBeNull();
  });
});

describe("with an account connected", () => {
  beforeEach(connect);

  it("pausing reads the account's settings and sends them back with only the watcher state changed", async () => {
    await watcher.saveWatcherState("paused");
    await watcher.reflectWatcherState();

    expect(methods()).toEqual(["GET", "PUT"]);
    const [read, replaced] = api.settingsCalls();
    expect(read.headers).toEqual({ Authorization: `Bearer ${TEST_TOKEN}` });
    expect(replaced.headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` });
    // The whole object, as PUT needs it, and no `updatedAt`.
    expect(replaced.body).toEqual({ ...ON_WATCHDESK, watcherState: "paused" });
    expect(api.settings()).toEqual({ ...ON_WATCHDESK, watcherState: "paused" });
    expect(record()).toEqual({ sent: "paused", failed: false });
    expect(await watcher.getWatcherSyncStatus()).toBeNull();
  });

  it("starting again sends running the same way", async () => {
    await watcher.saveWatcherState("paused");
    await watcher.reflectWatcherState();
    await watcher.saveWatcherState("running");
    await watcher.reflectWatcherState();

    expect(methods()).toEqual(["GET", "PUT", "GET", "PUT"]);
    expect(api.settings()).toEqual(ON_WATCHDESK);
    expect(record()).toEqual({ sent: "running", failed: false });
  });

  it("sends the settings as they are on WatchDesk now, not as they were at the last call", async () => {
    await watcher.saveWatcherState("paused");
    await watcher.reflectWatcherState();
    // Changed on the web in the meantime.
    api.setSettings({ intervalMinutes: 30, titleFilter: { enabled: false, keywords: ["rust", "go"] } });

    await watcher.saveWatcherState("running");
    await watcher.reflectWatcherState();

    expect(api.settings()).toEqual({
      ...ON_WATCHDESK,
      intervalMinutes: 30,
      titleFilter: { enabled: false, keywords: ["rust", "go"] },
      watcherState: "running",
    });
  });

  it("never copies the account's settings into this browser", async () => {
    await watcher.saveWatcherState("paused");
    await watcher.reflectWatcherState();

    expect(env.chrome.storage.sync.dump()).toEqual({});
    expect(Object.keys(local()).sort()).toEqual([watcher.WATCHER_STATE_KEY, TOKEN_KEY, WATCHER_SYNC_KEY].sort());
  });

  it("does not write when WatchDesk already has the state, and asks only once", async () => {
    expect(await watcher.reflectWatcherState()).toBe(false);
    expect(methods()).toEqual(["GET"]);
    expect(record()).toEqual({ sent: "running", failed: false });

    await watcher.reflectWatcherState();
    await watcher.reflectWatcherState();
    expect(methods()).toEqual(["GET"]);
  });

  it("this browser's state wins over what the account holds; it is never read back", async () => {
    api.setSettings({ watcherState: "paused" });

    await watcher.reflectWatcherState();

    expect(await watcher.getWatcherState()).toBe("running");
    expect(api.settings().watcherState).toBe("running");
  });

  it("a pause and the start that follows it reach WatchDesk in that order", async () => {
    await watcher.saveWatcherState("paused");
    let second;
    api.setSettingsRoute((request) => {
      // The user starts watching again while the pause is still on its way.
      if (request.method === "GET" && !second) {
        env.chrome.storage.local.set({ [watcher.WATCHER_STATE_KEY]: "running" });
        second = watcher.reflectWatcherState();
      }
      return undefined;
    });

    // Nothing new for the popup: by the time the pause got through, running
    // was the state, and it had not failed.
    expect(await watcher.reflectWatcherState()).toBe(false);
    await second;

    expect(api.settingsCalls("PUT").map((r) => r.body.watcherState)).toEqual(["paused", "running"]);
    expect(api.settings().watcherState).toBe("running");
    expect(record()).toEqual({ sent: "running", failed: false });
    expect(await watcher.getWatcherSyncStatus()).toBeNull();
  });

  it("never puts the token in what it stores or reports", async () => {
    await watcher.saveWatcherState("paused");
    await watcher.reflectWatcherState();

    expect(JSON.stringify(record())).not.toContain(TEST_TOKEN);
    expect(JSON.stringify(await watcher.getWatcherSyncStatus())).not.toContain(TEST_TOKEN);
  });

  describe("when WatchDesk cannot be told", () => {
    it("unreachable: one attempt, the failure is reported, and the state in this browser stands", async () => {
      api.setSettingsRoute(api.networkError);
      await watcher.saveWatcherState("paused");

      expect(await watcher.reflectWatcherState()).toBe(true);

      expect(methods()).toEqual(["GET"]);
      expect(await watcher.getWatcherState()).toBe("paused");
      expect(record()).toEqual({ sent: null, failed: true });
      expect(await watcher.getWatcherSyncStatus()).toBe("paused");
    });

    it("tries again on every later call until it gets through, then clears the report", async () => {
      api.setSettingsRoute(api.networkError);
      await watcher.saveWatcherState("paused");
      await watcher.reflectWatcherState();

      // Still unreachable: asked again, nothing new to tell the popup.
      expect(await watcher.reflectWatcherState()).toBe(false);
      expect(methods()).toEqual(["GET", "GET"]);
      expect(await watcher.getWatcherSyncStatus()).toBe("paused");

      api.setSettingsRoute(() => undefined);
      expect(await watcher.reflectWatcherState()).toBe(true);
      expect(methods()).toEqual(["GET", "GET", "GET", "PUT"]);
      expect(api.settings().watcherState).toBe("paused");
      expect(record()).toEqual({ sent: "paused", failed: false });
      expect(await watcher.getWatcherSyncStatus()).toBeNull();
    });

    it("a WatchDesk that never answers is given 10 seconds, no longer", async () => {
      api.setSettingsRoute(api.hang);
      await watcher.saveWatcherState("paused");
      let done = false;
      const reflecting = watcher.reflectWatcherState().then(() => {
        done = true;
      });

      await vi.advanceTimersByTimeAsync(9999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await reflecting;

      expect(methods()).toEqual(["GET"]);
      expect(await watcher.getWatcherSyncStatus()).toBe("paused");
    });

    it.each([
      ["a 500 on the read", "GET", () => api.json(500, { error: "Something went wrong." })],
      ["a 429 on the read", "GET", () => api.json(429, {}, { "Retry-After": "30" })],
      ["a 404 (no settings row) on the read", "GET", () => api.json(404, { error: "Settings not found." })],
      ["a 500 on the write", "PUT", () => api.json(500, { error: "Something went wrong." })],
      ["a 400 on the write", "PUT", () => api.json(400, { error: "Check the highlighted fields.", fieldErrors: {} })],
      ["an unreachable write", "PUT", () => api.networkError()],
    ])("%s is a failure, sent once, and nothing is changed on WatchDesk", async (_label, method, answer) => {
      api.setSettingsRoute((request) => (request.method === method ? answer() : undefined));
      await watcher.saveWatcherState("paused");

      expect(await watcher.reflectWatcherState()).toBe(true);

      expect(api.settingsCalls(method)).toHaveLength(1);
      expect(api.settings()).toEqual(ON_WATCHDESK);
      expect(record()).toEqual({ sent: null, failed: true });
      expect(await watcher.getWatcherSyncStatus()).toBe("paused");
    });

    it("a WatchDesk that does not know the setting yet is a failure, not a success", async () => {
      // An older deployment: no watcherState on the way out, and an unknown
      // key on the way in is dropped with a 200.
      const older = { intervalMinutes: 5, soundId: "chime", notificationsMuted: false, titleFilter: { enabled: true, keywords: [] } };
      api.setSettingsRoute(() => api.json(200, { ...older, updatedAt: "2026-10-05T09:00:00.000Z" }));
      await watcher.saveWatcherState("paused");

      expect(await watcher.reflectWatcherState()).toBe(true);

      expect(methods()).toEqual(["GET", "PUT"]);
      expect(record()).toEqual({ sent: null, failed: true });
      expect(await watcher.getWatcherSyncStatus()).toBe("paused");
    });

    it("an answer that is not a settings object is a failure", async () => {
      api.setSettingsRoute(() => api.json(200, ["not", "settings"]));
      await watcher.saveWatcherState("paused");

      await watcher.reflectWatcherState();

      expect(methods()).toEqual(["GET"]);
      expect(await watcher.getWatcherSyncStatus()).toBe("paused");
    });

    it("going back to the state WatchDesk has needs no request and leaves nothing to report", async () => {
      await watcher.reflectWatcherState(); // WatchDesk has "running"
      api.setSettingsRoute(api.networkError);
      await watcher.saveWatcherState("paused");
      await watcher.reflectWatcherState();
      expect(await watcher.getWatcherSyncStatus()).toBe("paused");

      await watcher.saveWatcherState("running");
      const calls = api.settingsCalls().length;
      expect(await watcher.reflectWatcherState()).toBe(false);

      expect(api.settingsCalls()).toHaveLength(calls);
      expect(await watcher.getWatcherSyncStatus()).toBeNull();
    });

    it("never throws, whatever storage does", async () => {
      await watcher.saveWatcherState("paused");
      env.chrome.storage.local.set.mockRejectedValueOnce(new Error("QUOTA_BYTES quota exceeded"));

      await expect(watcher.reflectWatcherState()).resolves.toBe(false);
    });
  });

  describe("the connection it was read on", () => {
    it("a refused token ends the connection: nothing is recorded and nothing more is sent", async () => {
      await env.chrome.storage.local.set({ [WATCHER_SYNC_KEY]: { sent: "running", failed: false } });
      api.setSettingsRoute(() => api.json(401, { error: "Sign in to continue." }));
      await watcher.saveWatcherState("paused");

      expect(await watcher.reflectWatcherState()).toBe(false);

      expect(methods()).toEqual(["GET"]);
      expect(local()[TOKEN_KEY]).toBeUndefined();
      // Removed with the token, by account-connection.js.
      expect(record()).toBeUndefined();
      // The pause itself is this browser's, and stays.
      expect(await watcher.getWatcherState()).toBe("paused");
      expect(await watcher.getWatcherSyncStatus()).toBeNull();
    });

    it("settings read from one account are never written to the account that connected next", async () => {
      api.setSettingsRoute((request) => {
        // Another account's pairing completes while the read is out.
        if (request.method === "GET") {
          env.chrome.storage.local.set({ [TOKEN_KEY]: OTHER_TOKEN, [ACCOUNT_KEY]: null });
        }
        return undefined;
      });
      await watcher.saveWatcherState("paused");

      expect(await watcher.reflectWatcherState()).toBe(false);

      expect(methods()).toEqual(["GET"]);
      expect(api.settings()).toEqual(ON_WATCHDESK);
      expect(record()).toBeUndefined();
    });

    it("an answer for a connection that has since changed is not recorded for the new one", async () => {
      api.setSettingsRoute((request) => {
        // The write went out on the old token; the new pairing lands before
        // its answer is recorded.
        if (request.method === "PUT") {
          env.chrome.storage.local.set({ [TOKEN_KEY]: OTHER_TOKEN, [ACCOUNT_KEY]: null });
        }
        return undefined;
      });
      await watcher.saveWatcherState("paused");

      expect(await watcher.reflectWatcherState()).toBe(false);

      expect(methods()).toEqual(["GET", "PUT"]);
      expect(api.settingsCalls("PUT")[0].headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`);
      expect(record()).toBeUndefined();

      // The new connection is told afresh, with its own token.
      api.setSettingsRoute(() => undefined);
      api.setSettings({ watcherState: "running" });
      await watcher.reflectWatcherState();
      expect(api.settingsCalls().at(-1).headers.Authorization).toBe(`Bearer ${OTHER_TOKEN}`);
      expect(record()).toEqual({ sent: "paused", failed: false });
    });
  });
});
