// The pairing flow in the service worker (account-connection.js), against
// a mocked chrome.* and a scripted WatchDesk API, with fake timers so the
// 3-second polling and the 10-minute expiry run instantly.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { installFakeWatchDesk, TEST_CODE, TEST_POLL_SECRET, TEST_TOKEN } from "./helpers/fake-watchdesk.js";
import { WATCHDESK_ORIGIN } from "../config.js";

let env;
let api;
let mod;

// Loads account-connection.js the way a fresh service worker does: a new
// module instance that registers its listeners at the top level.
async function startWorker() {
  vi.resetModules();
  mod = await import("../account-connection.js");
  mod.registerAccountConnection();
  return mod;
}

// Simulates Chrome stopping the worker: its pending timers die with it and
// its listeners are gone; storage stays.
function stopWorker() {
  // clearAllTimers() also resets the fake clock to real time; keep it.
  const now = Date.now();
  vi.clearAllTimers();
  vi.setSystemTime(now);
  env.dropListeners();
}

const advance = (ms) => vi.advanceTimersByTimeAsync(ms);

// Lets work started without a timer (a worker resuming at load) finish:
// a few real macrotask turns, which fake timers do not touch.
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

// Everything secret the extension handles in these tests.
function expectNoSecrets(value) {
  const text = JSON.stringify(value);
  expect(text).not.toContain(TEST_TOKEN);
  expect(text).not.toContain(TEST_POLL_SECRET);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-10-02T09:00:00Z"));
  env = installChromeMock();
  api = installFakeWatchDesk();
  await startWorker();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("Connect Account", () => {
  it("asks WatchDesk for a code and opens /connect-extension?code=… with nothing else in the URL", async () => {
    const state = await mod.startConnecting();

    const start = api.requests[0];
    expect(start).toMatchObject({ path: "/api/auth/device/start", method: "POST", credentials: "omit" });
    expect(start.origin).toBe(WATCHDESK_ORIGIN);

    expect(env.chrome.tabs.create).toHaveBeenCalledTimes(1);
    const { url } = env.chrome.tabs.create.mock.calls[0][0];
    expect(url).toBe(`${WATCHDESK_ORIGIN}/connect-extension?code=${TEST_CODE}`);
    expect(url).not.toContain(TEST_POLL_SECRET);

    expect(state).toEqual({ status: "pending", code: TEST_CODE, expiresAt: Date.now() + 10 * 60 * 1000 });
    expectNoSecrets(state);
  });

  it("starts polling in the background with the poll secret in a header, every pollIntervalSeconds", async () => {
    await mod.startConnecting();
    expect(api.polls()).toHaveLength(0);

    await advance(3000);
    expect(api.polls()).toHaveLength(1);
    const poll = api.polls()[0];
    expect(poll.query).toEqual({ code: TEST_CODE });
    expect(poll.headers).toEqual({ "X-Pairing-Secret": TEST_POLL_SECRET });
    expect(poll.credentials).toBe("omit");

    await advance(2999);
    expect(api.polls()).toHaveLength(1);
    await advance(1);
    expect(api.polls()).toHaveLength(2);
  });

  it("respects a longer pollIntervalSeconds from start", async () => {
    api.setStart(() =>
      api.json(200, {
        code: TEST_CODE,
        pollSecret: TEST_POLL_SECRET,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        pollIntervalSeconds: 5,
      }),
    );
    await mod.startConnecting();
    await advance(4999);
    expect(api.polls()).toHaveLength(0);
    await advance(1);
    expect(api.polls()).toHaveLength(1);
  });

  it("keeps the pairing in session storage only — never local, never sync", async () => {
    await mod.startConnecting();
    const pairing = env.chrome.storage.session.dump()[mod.PAIRING_KEY];
    expect(pairing).toMatchObject({ code: TEST_CODE, pollSecret: TEST_POLL_SECRET });
    expectNoSecrets(env.chrome.storage.local.dump());
    expect(env.chrome.storage.sync.set).not.toHaveBeenCalled();
  });

  it("does not start a second pairing while one is pending; it brings the tab back instead", async () => {
    await mod.startConnecting();
    const tabId = env.chrome.tabs.create.mock.results[0].value;
    await mod.startConnecting();
    expect(api.requests.filter((r) => r.path === "/api/auth/device/start")).toHaveLength(1);
    expect(env.chrome.tabs.create).toHaveBeenCalledTimes(1);
    expect(env.chrome.tabs.update).toHaveBeenCalledWith((await tabId).id, { active: true });
  });

  it("reports a start that WatchDesk rate-limits, with its Retry-After", async () => {
    api.setStart(() => api.json(429, { error: "Too many requests." }, { "Retry-After": "120" }));
    const state = await mod.startConnecting();
    expect(state).toEqual({ status: "not-connected", outcome: { reason: "rate-limited", retryAfterSeconds: 120 } });
    expect(env.chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("reports WatchDesk being unreachable without opening a tab", async () => {
    api.setStart(api.networkError);
    const state = await mod.startConnecting();
    expect(state).toEqual({ status: "not-connected", outcome: { reason: "unreachable" } });
    expect(env.chrome.tabs.create).not.toHaveBeenCalled();
  });

  it("treats a malformed start answer as an error", async () => {
    api.setStart(() => api.json(200, { code: TEST_CODE }));
    const state = await mod.startConnecting();
    expect(state.outcome).toEqual({ reason: "error" });
  });
});

describe("poll transitions", () => {
  it("pending → approved: stores the token in chrome.storage.local and shows the account's email", async () => {
    api.queuePoll(api.pending, api.pending, api.approved);
    await mod.startConnecting();
    await advance(9000);

    expect(env.chrome.storage.local.dump()[mod.TOKEN_KEY]).toBe(TEST_TOKEN);
    expect(env.chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(env.chrome.storage.session.dump()).toEqual({});
    expect(env.alarms.has(mod.PAIRING_ALARM)).toBe(false);

    const current = api.requests.find((r) => r.path === "/api/devices/current");
    expect(current.headers).toEqual({ Authorization: `Bearer ${TEST_TOKEN}` });
    expect(current.credentials).toBe("omit");

    const state = await mod.getConnectionState();
    expect(state).toEqual({
      status: "connected",
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      deviceLabel: "Chrome on my laptop",
    });
    expectNoSecrets(state);
  });

  it("stops polling once approved", async () => {
    api.queuePoll(api.approved);
    await mod.startConnecting();
    await advance(3000);
    const polls = api.polls().length;
    await advance(60000);
    expect(api.polls()).toHaveLength(polls);
  });

  it("denied → not connected, says so, and stops polling", async () => {
    api.queuePoll(api.pending, api.denied);
    await mod.startConnecting();
    await advance(6000);
    expect(await mod.getConnectionState()).toEqual({ status: "not-connected", outcome: { reason: "denied" } });
    await advance(60000);
    expect(api.polls()).toHaveLength(2);
    expect(env.chrome.storage.local.dump()[mod.TOKEN_KEY]).toBeUndefined();
    expect(env.alarms.has(mod.PAIRING_ALARM)).toBe(false);
  });

  it("expired → not connected, says so, and stops polling", async () => {
    api.queuePoll(api.expired);
    await mod.startConnecting();
    await advance(3000);
    expect(await mod.getConnectionState()).toEqual({ status: "not-connected", outcome: { reason: "expired" } });
    await advance(60000);
    expect(api.polls()).toHaveLength(1);
  });

  it("stops at expiresAt even if the server never says expired", async () => {
    await mod.startConnecting();
    await advance(10 * 60 * 1000);
    expect(await mod.getConnectionState()).toEqual({ status: "not-connected", outcome: { reason: "expired" } });
    const last = api.polls().at(-1);
    expect(last.at).toBeLessThan(Date.UTC(2026, 9, 2, 9, 10, 0));
    const count = api.polls().length;
    await advance(60000);
    expect(api.polls()).toHaveLength(count);
  });

  it("waits Retry-After on a 429 before polling again", async () => {
    api.queuePoll(() => api.json(429, { error: "Too many requests." }, { "Retry-After": "30" }));
    await mod.startConnecting();
    await advance(3000);
    expect(api.polls()).toHaveLength(1);
    await advance(29999);
    expect(api.polls()).toHaveLength(1);
    await advance(1);
    expect(api.polls()).toHaveLength(2);
    expect((await mod.getConnectionState()).status).toBe("pending");
  });

  it("keeps polling through a network error and still collects the token", async () => {
    api.queuePoll(api.networkError, api.networkError, api.approved);
    await mod.startConnecting();
    await advance(3000 + 5000 + 5000);
    expect(api.polls()).toHaveLength(3);
    expect((await mod.getConnectionState()).status).toBe("connected");
  });

  it("keeps polling through a 5xx", async () => {
    api.queuePoll(() => api.json(503, { error: "Unavailable" }), api.approved);
    await mod.startConnecting();
    await advance(3000 + 5000);
    expect((await mod.getConnectionState()).status).toBe("connected");
  });

  it("ends the pairing on a 400, which polling again cannot fix", async () => {
    api.queuePoll(() => api.json(400, { error: "Invalid code", fieldErrors: { code: ["Invalid"] } }));
    await mod.startConnecting();
    await advance(3000);
    expect(await mod.getConnectionState()).toEqual({ status: "not-connected", outcome: { reason: "error" } });
    await advance(60000);
    expect(api.polls()).toHaveLength(1);
  });

  it("connects even if /api/devices/current cannot be reached right after approval", async () => {
    api.setCurrent(api.networkError);
    api.queuePoll(api.approved);
    await mod.startConnecting();
    await advance(3000);
    expect(await mod.getConnectionState()).toEqual({
      status: "connected",
      email: null,
      displayName: null,
      deviceLabel: null,
    });
    expect(env.chrome.storage.local.dump()[mod.TOKEN_KEY]).toBe(TEST_TOKEN);
  });
});

describe("closing the tab before approving", () => {
  it("leaves the extension clearly not connected and stops polling", async () => {
    await mod.startConnecting();
    await advance(3000);
    const tab = [...env.openTabs.values()][0];

    await env.closeTab(tab.id);

    const state = await mod.getConnectionState();
    expect(state).toEqual({ status: "not-connected", outcome: { reason: "tab-closed" } });
    expect(env.chrome.storage.session.dump()[mod.PAIRING_KEY]).toBeUndefined();
    expect(env.chrome.storage.local.dump()[mod.TOKEN_KEY]).toBeUndefined();
    expect(env.alarms.has(mod.PAIRING_ALARM)).toBe(false);

    const polls = api.polls().length;
    await advance(60000);
    expect(api.polls()).toHaveLength(polls);
  });

  it("still collects the token when the tab is closed right after approving", async () => {
    await mod.startConnecting();
    const tab = [...env.openTabs.values()][0];
    api.queuePoll(api.approved);

    await env.closeTab(tab.id);

    expect((await mod.getConnectionState()).status).toBe("connected");
    expect(env.chrome.storage.local.dump()[mod.TOKEN_KEY]).toBe(TEST_TOKEN);
  });

  it("reports a denial made before the tab was closed as denied", async () => {
    await mod.startConnecting();
    api.queuePoll(api.denied);
    await env.closeTab([...env.openTabs.values()][0].id);
    expect((await mod.getConnectionState()).outcome).toEqual({ reason: "denied" });
  });

  it("ignores other tabs closing", async () => {
    await mod.startConnecting();
    const other = await env.chrome.tabs.create({ url: "https://www.linkedin.com/jobs/search/" });
    await env.closeTab(other.id);
    expect((await mod.getConnectionState()).status).toBe("pending");
  });

  it("lets the user start again with one click", async () => {
    await mod.startConnecting();
    await env.closeTab([...env.openTabs.values()][0].id);
    api.setStart(() =>
      api.json(200, {
        code: "BCDF-GHJK",
        pollSecret: "another-secret",
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        pollIntervalSeconds: 3,
      }),
    );
    const state = await mod.startConnecting();
    expect(state).toMatchObject({ status: "pending", code: "BCDF-GHJK" });
    expect(env.chrome.tabs.create).toHaveBeenLastCalledWith({ url: `${WATCHDESK_ORIGIN}/connect-extension?code=BCDF-GHJK` });
  });
});

describe("Cancel", () => {
  it("ends a pending pairing", async () => {
    await mod.startConnecting();
    const state = await mod.cancelConnecting();
    expect(state).toEqual({ status: "not-connected", outcome: { reason: "cancelled" } });
    await advance(60000);
    expect(api.polls()).toHaveLength(1); // the one last check made by Cancel
  });
});

describe("a service worker restart mid-pairing", () => {
  it("resumes polling from session storage and collects the token", async () => {
    await mod.startConnecting();
    await advance(6000);
    expect(api.polls()).toHaveLength(2);

    stopWorker();
    await advance(60000);
    expect(api.polls()).toHaveLength(2); // nothing polls while the worker is gone

    api.queuePoll(api.approved);
    await startWorker();
    await settle();

    expect(api.polls()).toHaveLength(3);
    expect(api.polls()[2].headers).toEqual({ "X-Pairing-Secret": TEST_POLL_SECRET });
    expect((await mod.getConnectionState()).status).toBe("connected");
  });

  it("keeps a backstop alarm while pending, which resumes polling when it wakes the worker", async () => {
    await mod.startConnecting();
    expect(env.alarms.get(mod.PAIRING_ALARM)).toMatchObject({ periodInMinutes: 0.5 });

    stopWorker();
    vi.resetModules();
    mod = await import("../account-connection.js");
    // Only the alarm listener this time, to show the alarm alone is enough.
    env.chrome.alarms.onAlarm.addListener((alarm) => (alarm.name === mod.PAIRING_ALARM ? mod.ensurePolling() : undefined));
    api.queuePoll(api.approved);
    await advance(30000);
    const done = env.chrome.alarms.onAlarm.dispatch({ name: mod.PAIRING_ALARM, scheduledTime: Date.now() });
    await settle();
    await done;

    expect((await mod.getConnectionState()).status).toBe("connected");
  });

  it("still ends the pairing at expiresAt after a restart", async () => {
    await mod.startConnecting();
    stopWorker();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    await startWorker();
    await settle();
    expect(await mod.getConnectionState()).toEqual({ status: "not-connected", outcome: { reason: "expired" } });
  });

  it("prefers a stored token over a pairing left behind by a worker stopped mid-write", async () => {
    await mod.startConnecting();
    stopWorker();
    await env.chrome.storage.local.set({ [mod.TOKEN_KEY]: TEST_TOKEN });
    await startWorker();
    await settle();
    expect((await mod.getConnectionState()).status).toBe("connected");
    expect(env.chrome.storage.session.dump()[mod.PAIRING_KEY]).toBeUndefined();
    expect(api.polls()).toHaveLength(0);
  });

  it("forgets a pending pairing on a browser restart (session storage is cleared)", async () => {
    await mod.startConnecting();
    stopWorker();
    env.chrome.storage.session.wipe();
    await startWorker();
    await advance(60000);
    expect(await mod.getConnectionState()).toEqual({ status: "not-connected", outcome: null });
    expect(api.polls()).toHaveLength(0);
  });
});

describe("the connected state", () => {
  beforeEach(async () => {
    await env.chrome.storage.local.set({ [mod.TOKEN_KEY]: TEST_TOKEN });
  });

  it("refreshes the account's email from /api/devices/current", async () => {
    const state = await mod.refreshAccount();
    expect(state).toEqual({
      status: "connected",
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      deviceLabel: "Chrome on my laptop",
    });
    expectNoSecrets(state);
  });

  it("treats a 401 as not connected and discards the token", async () => {
    api.setCurrent(() => api.json(401, { error: "Sign in to continue." }));
    const state = await mod.refreshAccount();
    expect(state).toEqual({ status: "not-connected", outcome: { reason: "revoked" } });
    expect(env.chrome.storage.local.dump()[mod.TOKEN_KEY]).toBeUndefined();
    expect(env.chrome.storage.local.dump()[mod.ACCOUNT_KEY]).toBeUndefined();
  });

  it("keeps the token and the last known account when WatchDesk cannot be reached, after retrying", async () => {
    await mod.refreshAccount();
    api.setCurrent(api.networkError);
    const pending = mod.refreshAccount();
    await advance(60000);
    const state = await pending;
    expect(state).toMatchObject({ status: "connected", email: "ada@example.com", accountCheckFailed: true });
    expect(env.chrome.storage.local.dump()[mod.TOKEN_KEY]).toBe(TEST_TOKEN);
    // One successful refresh, then the first try and three retries.
    expect(api.requests.filter((r) => r.path === "/api/devices/current")).toHaveLength(1 + 4);
  });

  it("keeps the token through a 5xx and connects again once WatchDesk answers", async () => {
    api.setCurrent(() => api.json(503, {}));
    const pending = mod.refreshAccount();
    await advance(60000);
    expect(await pending).toMatchObject({ status: "connected", accountCheckFailed: true });
    expect(env.chrome.storage.local.dump()[mod.TOKEN_KEY]).toBe(TEST_TOKEN);

    api.setCurrent(() =>
      api.json(200, { account: { email: "ada@example.com", displayName: "Ada" }, device: { id: "d", label: "L" } }),
    );
    expect(await mod.refreshAccount()).toMatchObject({ status: "connected", email: "ada@example.com" });
  });

  it("sends the token as a Bearer header", async () => {
    await mod.refreshAccount();
    const current = api.requests.find((r) => r.path === "/api/devices/current");
    expect(current.headers).toEqual({ Authorization: `Bearer ${TEST_TOKEN}` });
    expect(current.credentials).toBe("omit");
  });

  it("does not call WatchDesk when not connected", async () => {
    await env.chrome.storage.local.remove(mod.TOKEN_KEY);
    expect(await mod.refreshAccount()).toEqual({ status: "not-connected", outcome: null });
    expect(api.requests).toHaveLength(0);
  });

  it("isConnected says whether a token is stored, and nothing more (WD-54)", async () => {
    expect(await mod.isConnected()).toBe(true);
    await env.chrome.storage.local.remove(mod.TOKEN_KEY);
    expect(await mod.isConnected()).toBe(false);
  });

  it("drops what watch sync knew about the connection along with a refused token (WD-54)", async () => {
    await env.chrome.storage.local.set({ [mod.WATCH_SYNC_KEY]: { serverIds: ["a"], lastSyncedAt: 1 } });
    api.setCurrent(() => api.json(401, { error: "Sign in to continue." }));
    await mod.refreshAccount();
    expect(env.chrome.storage.local.dump()[mod.WATCH_SYNC_KEY]).toBeUndefined();
  });

  it("drops the record of when listings were last sent along with a refused token (WD-59)", async () => {
    await env.chrome.storage.local.set({ [mod.LISTING_SYNC_KEY]: { lastIngestedAt: 1, failed: false } });
    api.setCurrent(() => api.json(401, { error: "Sign in to continue." }));
    await mod.refreshAccount();
    expect(env.chrome.storage.local.dump()[mod.LISTING_SYNC_KEY]).toBeUndefined();
  });

  it("drops which watcher state the account was given along with a refused token (WD-71)", async () => {
    await env.chrome.storage.local.set({ [mod.WATCHER_SYNC_KEY]: { sent: "paused", failed: false } });
    api.setCurrent(() => api.json(401, { error: "Sign in to continue." }));
    await mod.refreshAccount();
    expect(env.chrome.storage.local.dump()[mod.WATCHER_SYNC_KEY]).toBeUndefined();
  });

  it("drops when the settings were last synced along with a refused token, and keeps the settings kept from before connecting (WD-79)", async () => {
    await env.chrome.storage.local.set({
      [mod.SETTINGS_SYNC_KEY]: { lastSyncedAt: 1, problem: null },
      watchdeskSettingsBeforeConnect: { takenAt: 1, settings: { intervalMinutes: 1 } },
    });
    api.setCurrent(() => api.json(401, { error: "Sign in to continue." }));
    await mod.refreshAccount();
    expect(env.chrome.storage.local.dump()[mod.SETTINGS_SYNC_KEY]).toBeUndefined();
    expect(env.chrome.storage.local.dump().watchdeskSettingsBeforeConnect).toEqual({ takenAt: 1, settings: { intervalMinutes: 1 } });
  });

  it("isCurrentConnection is true only while the token is still the one the connection was captured with (WD-71)", async () => {
    const connection = await mod.captureConnection();
    expect(await mod.isCurrentConnection(connection)).toBe(true);

    await env.chrome.storage.local.set({ [mod.TOKEN_KEY]: "wd_another.token" });
    expect(await mod.isCurrentConnection(connection)).toBe(false);
    expect(await mod.isCurrentConnection(await mod.captureConnection())).toBe(true);

    await env.chrome.storage.local.remove(mod.TOKEN_KEY);
    expect(await mod.isCurrentConnection(connection)).toBe(false);
  });

  describe("the queue of unsent listings (WD-60)", () => {
    const queueOf = (owner) => ({ owner, items: [{ watchId: "w", listing: { id: "1" } }], dropped: 0, droppedSeen: false });
    const stored = () => env.chrome.storage.local.dump()[mod.LISTING_QUEUE_KEY];
    const answerAs = (email) =>
      api.setCurrent(() => api.json(200, { account: { email, displayName: null }, device: { id: "d", label: "Chrome" } }));

    it("names the connected account by its email, trimmed and lower-cased", async () => {
      expect(await mod.getAccountOwner()).toBeNull();
      answerAs("  Ada@Example.COM ");
      await mod.refreshAccount();
      expect(await mod.getAccountOwner()).toBe("ada@example.com");

      await env.chrome.storage.local.remove(mod.TOKEN_KEY);
      expect(await mod.getAccountOwner()).toBeNull();
    });

    it("names nobody for an account without an email", async () => {
      answerAs(null);
      await mod.refreshAccount();
      expect(await mod.getAccountOwner()).toBeNull();
    });

    it("stays when the token is refused", async () => {
      await env.chrome.storage.local.set({ [mod.LISTING_QUEUE_KEY]: queueOf("ada@example.com") });
      api.setCurrent(() => api.json(401, { error: "Sign in to continue." }));
      await mod.refreshAccount();

      expect(env.chrome.storage.local.dump()[mod.TOKEN_KEY]).toBeUndefined();
      expect(stored()).toEqual(queueOf("ada@example.com"));
    });

    it("stays when the connected account is the one it belongs to", async () => {
      await env.chrome.storage.local.set({ [mod.LISTING_QUEUE_KEY]: queueOf("ada@example.com") });
      answerAs("Ada@example.com");
      await mod.refreshAccount();

      expect(stored()).toEqual(queueOf("ada@example.com"));
    });

    it("is removed as soon as the connected account is a different one, or has no email", async () => {
      await env.chrome.storage.local.set({ [mod.LISTING_QUEUE_KEY]: queueOf("grace@example.com") });
      await mod.refreshAccount();
      expect(stored()).toBeUndefined();

      await env.chrome.storage.local.set({ [mod.LISTING_QUEUE_KEY]: queueOf("ada@example.com") });
      answerAs(null);
      await mod.refreshAccount();
      expect(stored()).toBeUndefined();
    });

    it("stays while WatchDesk cannot say whose the token is", async () => {
      await env.chrome.storage.local.set({ [mod.LISTING_QUEUE_KEY]: queueOf("grace@example.com") });
      api.setCurrent(api.networkError);
      const pending = mod.refreshAccount();
      await advance(60000);
      await pending;

      expect(stored()).toEqual(queueOf("grace@example.com"));
    });

    it("a new pairing keeps the same account's queue and removes another's", async () => {
      await env.chrome.storage.local.remove(mod.TOKEN_KEY);
      await env.chrome.storage.local.set({ [mod.LISTING_QUEUE_KEY]: queueOf("ada@example.com") });
      await mod.startConnecting();
      api.queuePoll(api.approved);
      await advance(3000);
      expect(env.chrome.storage.local.dump()[mod.TOKEN_KEY]).toBe(TEST_TOKEN);
      expect(stored()).toEqual(queueOf("ada@example.com"));

      await env.chrome.storage.local.remove(mod.TOKEN_KEY);
      answerAs("grace@example.com");
      await mod.startConnecting();
      api.queuePoll(api.approved);
      await advance(3000);
      expect(env.chrome.storage.local.dump()[mod.TOKEN_KEY]).toBe(TEST_TOKEN);
      expect(stored()).toBeUndefined();
    });
  });

  it("does not start a pairing while connected", async () => {
    const state = await mod.startConnecting();
    expect(state.status).toBe("connected");
    expect(api.requests.filter((r) => r.path === "/api/auth/device/start")).toHaveLength(0);
    expect(env.chrome.tabs.create).not.toHaveBeenCalled();
  });
});

describe("losing the connection (a 401 on any authenticated call)", () => {
  beforeEach(async () => {
    await env.chrome.storage.local.set({
      [mod.TOKEN_KEY]: TEST_TOKEN,
      [mod.ACCOUNT_KEY]: { email: "ada@example.com", displayName: "Ada", deviceLabel: "L" },
    });
    api.setCurrent(() => api.json(401, { error: "Sign in to continue." }));
  });

  it("tells an open popup it is not connected any more, without the token", async () => {
    env.chrome.runtime.sendMessage.mockResolvedValue(undefined);
    await mod.refreshAccount();
    expect(env.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    const [message] = env.chrome.runtime.sendMessage.mock.calls[0];
    expect(message).toEqual({
      type: "account-state-changed",
      state: { status: "not-connected", outcome: { reason: "revoked" } },
    });
    expectNoSecrets(message);
  });

  it("does not fail when no popup is open, and the next open shows why", async () => {
    // The mock's default: no receiving end.
    await expect(mod.refreshAccount()).resolves.toMatchObject({ status: "not-connected" });
    expect(await mod.getConnectionState()).toEqual({ status: "not-connected", outcome: { reason: "revoked" } });
  });

  it("keeps a token that a new pairing stored while the refused request was out", async () => {
    api.setCurrent(async () => {
      await env.chrome.storage.local.set({ [mod.TOKEN_KEY]: "wd_newer.token" });
      return api.json(401, { error: "Sign in to continue." });
    });
    const state = await mod.refreshAccount();
    expect(state.status).toBe("connected");
    expect(env.chrome.storage.local.dump()[mod.TOKEN_KEY]).toBe("wd_newer.token");
    expect(env.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("is noticed by the next authenticated call even while retries are under way", async () => {
    // First answer a 5xx, then the device is revoked.
    const answers = [() => api.json(503, {}), () => api.json(401, {})];
    api.setCurrent(() => answers.shift()());
    const pending = mod.refreshAccount();
    await advance(5000);
    expect(await pending).toEqual({ status: "not-connected", outcome: { reason: "revoked" } });
    expect(api.requests.filter((r) => r.path === "/api/devices/current")).toHaveLength(2);
  });
});

describe("secrets", () => {
  it("never logs the token or the poll secret, and never touches chrome.storage.sync", async () => {
    const logged = [];
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      vi.spyOn(console, level).mockImplementation((...args) => logged.push(args));
    }
    api.queuePoll(api.networkError, () => api.json(503, {}), api.pending, api.approved);
    await mod.startConnecting();
    await advance(30000);
    api.setCurrent(() => api.json(503, {}));
    const retried = mod.refreshAccount();
    await advance(60000);
    await retried;
    api.setCurrent(() => api.json(401, { error: "Sign in to continue." }));
    await mod.refreshAccount();

    expectNoSecrets(logged.map((args) => args.map(String)));
    expectNoSecrets(env.chrome.runtime.sendMessage.mock.calls);
    expect(env.chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(env.chrome.storage.sync.get).not.toHaveBeenCalled();
  });
});

describe("whose the stored token is (WD-110)", () => {
  const OTHER_TOKEN = "wd_fedcba9876543210fedcba9876543210.othersecret-abcdefghijklmnopqrstuvwxyz012";
  const local = () => env.chrome.storage.local.dump();
  const currentCalls = () => api.requests.filter((r) => r.path === "/api/devices/current");
  const adaAnswer = () =>
    api.json(200, { account: { email: "ada@example.com", displayName: "Ada" }, device: { id: "d", label: "L" } });

  describe("a captured connection", () => {
    it("is nothing with no account connected", async () => {
      expect(await mod.captureConnection()).toBeNull();
    });

    it("names the account, and never holds the token", async () => {
      await env.chrome.storage.local.set({ [mod.TOKEN_KEY]: TEST_TOKEN });
      expect(await mod.captureConnection()).toEqual({ owner: null });

      await mod.refreshAccount();
      const connection = await mod.captureConnection();
      expect(connection).toEqual({ owner: "ada@example.com" });
      expect(Object.isFrozen(connection)).toBe(true);
      expectNoSecrets(connection);
      expectNoSecrets(Reflect.ownKeys(connection).map(String));
    });

    it("reads the token and the account's name in one storage call", async () => {
      await env.chrome.storage.local.set({ [mod.TOKEN_KEY]: TEST_TOKEN });
      env.chrome.storage.local.get.mockClear();
      await mod.captureConnection();

      expect(env.chrome.storage.local.get.mock.calls).toEqual([[[mod.TOKEN_KEY, mod.ACCOUNT_KEY]]]);
    });
  });

  describe("asking WatchDesk whose the token is", () => {
    beforeEach(async () => {
      await env.chrome.storage.local.set({ [mod.TOKEN_KEY]: TEST_TOKEN });
    });

    it("does not keep an answer for a token that a new pairing has replaced meanwhile", async () => {
      const queue = { owner: "grace@example.com", items: [], dropped: 2, droppedSeen: false };
      await env.chrome.storage.local.set({ [mod.LISTING_QUEUE_KEY]: queue });
      api.setCurrent(async () => {
        await env.chrome.storage.local.set({ [mod.TOKEN_KEY]: OTHER_TOKEN });
        return adaAnswer();
      });
      const state = await mod.refreshAccount();

      // Ada's name is not put beside the other account's token, and the
      // queue is not judged by it.
      expect(local()[mod.ACCOUNT_KEY]).toBeUndefined();
      expect(await mod.getAccountOwner()).toBeNull();
      expect(local()[mod.LISTING_QUEUE_KEY]).toEqual(queue);
      expect(state).toMatchObject({ status: "connected", email: null });
    });

    it("does not keep an answer for a token that has been discarded meanwhile", async () => {
      api.setCurrent(async () => {
        await env.chrome.storage.local.remove(mod.TOKEN_KEY);
        return adaAnswer();
      });
      await mod.refreshAccount();

      expect(local()[mod.ACCOUNT_KEY]).toBeUndefined();
    });

    it("does not retry with a token stored while it was waiting", async () => {
      api.setCurrent(async () => {
        await env.chrome.storage.local.set({ [mod.TOKEN_KEY]: OTHER_TOKEN });
        return api.json(503, {});
      });
      const pending = mod.refreshAccount();
      await advance(60000);
      const state = await pending;

      expect(currentCalls()).toHaveLength(1);
      expect(currentCalls()[0].headers).toEqual({ Authorization: `Bearer ${TEST_TOKEN}` });
      expect(state).toMatchObject({ status: "connected", accountCheckFailed: true });
      expect(local()[mod.ACCOUNT_KEY]).toBeUndefined();
    });

    it("still keeps the answer when nothing changed", async () => {
      await mod.refreshAccount();
      expect(local()[mod.ACCOUNT_KEY]).toEqual({
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        deviceLabel: "Chrome on my laptop",
      });
    });
  });

  it("a new pairing stores its token and empties the last account's name in one write", async () => {
    // A name left behind without its token.
    await env.chrome.storage.local.set({ [mod.ACCOUNT_KEY]: { email: "ada@example.com" } });
    api.setCurrent(api.networkError);
    await mod.startConnecting();
    api.queuePoll(api.approved);
    env.chrome.storage.local.set.mockClear();
    await advance(3000);

    // The write of the token carries the emptied account with it, so no
    // worker stopped after it can find the two side by side.
    const write = env.chrome.storage.local.set.mock.calls.find(([items]) => mod.TOKEN_KEY in items)[0];
    expect(write).toEqual({ [mod.TOKEN_KEY]: TEST_TOKEN, [mod.ACCOUNT_KEY]: null });
    expect(await mod.getAccountOwner()).toBeNull();
    expect(local()[mod.ACCOUNT_KEY]).toBeUndefined();
    await advance(60000);
  });
});
