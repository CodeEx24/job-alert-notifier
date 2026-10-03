// background.js routes the popup's account-* messages to
// account-connection.js and registers its listeners, without disturbing the
// job-check alarm or the existing message handling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { installFakeWatchDesk, TEST_CODE, TEST_POLL_SECRET, TEST_TOKEN } from "./helpers/fake-watchdesk.js";
import { PAIRING_ALARM, TOKEN_KEY, WATCH_SYNC_KEY } from "../account-connection.js";

let env;
let api;

// Sends a message the way the popup does and waits for the answer.
function sendMessage(message) {
  return new Promise((resolve) => {
    for (const listener of env.chrome.runtime.onMessage.listeners) listener(message, {}, resolve);
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-10-02T09:00:00Z"));
  env = installChromeMock();
  api = installFakeWatchDesk();
  vi.resetModules();
  await import("../background.js");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("background.js wiring", () => {
  it("registers the account listeners at the top level", () => {
    expect(env.chrome.tabs.onRemoved.listeners).toHaveLength(1);
    // The job-check alarm listener plus the pairing backstop.
    expect(env.chrome.alarms.onAlarm.listeners).toHaveLength(2);
  });

  it("answers account-get-state and account-connect without the token or the poll secret", async () => {
    expect(await sendMessage({ type: "account-get-state" })).toEqual({ status: "not-connected", outcome: null });

    const pending = await sendMessage({ type: "account-connect" });
    expect(pending).toMatchObject({ status: "pending", code: TEST_CODE });
    expect(JSON.stringify(pending)).not.toContain(TEST_POLL_SECRET);

    api.queuePoll(api.approved);
    await vi.advanceTimersByTimeAsync(3000);
    const connected = await sendMessage({ type: "account-refresh" });
    expect(connected).toMatchObject({ status: "connected", email: "ada@example.com" });
    expect(JSON.stringify(connected)).not.toContain(TEST_TOKEN);
    expect(env.chrome.storage.local.dump()[TOKEN_KEY]).toBe(TEST_TOKEN);
  });

  it("answers account-cancel and account-show-tab", async () => {
    await sendMessage({ type: "account-connect" });
    expect(await sendMessage({ type: "account-show-tab" })).toMatchObject({ status: "pending" });
    expect(await sendMessage({ type: "account-cancel" })).toEqual({
      status: "not-connected",
      outcome: { reason: "cancelled" },
    });
  });

  it("does not run a job check when the pairing alarm fires", async () => {
    await env.chrome.alarms.onAlarm.dispatch({ name: PAIRING_ALARM, scheduledTime: Date.now() });
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("still answers unknown messages with the same error", async () => {
    expect(await sendMessage({ type: "no-such-message" })).toEqual({ ok: false, error: "Unknown message type" });
  });
});

describe("the job-check alarm also confirms the WatchDesk connection (WD-44)", () => {
  // One disabled watch, so a check cycle runs without fetching any job site
  // and its only visible effect is lastRunAt.
  beforeEach(async () => {
    await env.chrome.storage.sync.set({
      watches: [{ id: "w1", siteId: "linkedin", url: "https://www.linkedin.com/jobs/search/?keywords=x", enabled: false }],
    });
  });

  const checkAlarm = () => env.chrome.alarms.onAlarm.dispatch({ name: "check-jobs", scheduledTime: Date.now() });
  const currentCalls = () => api.requests.filter((r) => r.path === "/api/devices/current");

  it("asks /api/devices/current with the token on every check, and still runs the check", async () => {
    await env.chrome.storage.local.set({ [TOKEN_KEY]: TEST_TOKEN });
    await checkAlarm();
    expect(currentCalls()).toHaveLength(1);
    expect(currentCalls()[0].headers).toEqual({ Authorization: `Bearer ${TEST_TOKEN}` });
    expect(env.chrome.storage.local.dump().lastRunAt).toBe(Date.now());

    await checkAlarm();
    expect(currentCalls()).toHaveLength(2);
  });

  it("sends nothing to WatchDesk when no account is connected", async () => {
    await checkAlarm();
    expect(api.fetch).not.toHaveBeenCalled();
    expect(env.chrome.storage.local.dump().lastRunAt).toBe(Date.now());
  });

  it("does not hold up the job check while WatchDesk is slow", async () => {
    await env.chrome.storage.local.set({ [TOKEN_KEY]: TEST_TOKEN });
    // WatchDesk never answers; each attempt ends at the 15 s timeout.
    api.setCurrent(
      ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        ),
    );
    let done = false;
    const listener = checkAlarm().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(env.chrome.storage.local.dump().lastRunAt).toBeTypeOf("number");
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(120000);
    await listener;
    expect(done).toBe(true);
    // Gave up for this cycle, kept the token.
    expect(currentCalls()).toHaveLength(4);
    expect(env.chrome.storage.local.dump()[TOKEN_KEY]).toBe(TEST_TOKEN);
  });

  it("on a 401, discards the token and tells an open popup, and the check still runs", async () => {
    await env.chrome.storage.local.set({ [TOKEN_KEY]: TEST_TOKEN });
    api.setCurrent(() => api.json(401, { error: "Sign in to continue." }));
    env.chrome.runtime.sendMessage.mockResolvedValue(undefined);
    await checkAlarm();

    expect(env.chrome.storage.local.dump()[TOKEN_KEY]).toBeUndefined();
    expect(env.chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "account-state-changed",
      state: { status: "not-connected", outcome: { reason: "revoked" } },
    });
    expect(env.chrome.storage.local.dump().lastRunAt).toBe(Date.now());
    expect(await sendMessage({ type: "account-get-state" })).toEqual({
      status: "not-connected",
      outcome: { reason: "revoked" },
    });
  });
});

const UPWORK_URL = "https://www.upwork.com/nx/search/jobs/?q=react";
const OJ_ORIGIN = "https://www.onlinejobs.ph";
const checkJobsAlarm = () => env.chrome.alarms.onAlarm.dispatch({ name: "check-jobs", scheduledTime: Date.now() });
const storedWatches = () => env.chrome.storage.sync.dump().watches;
// What the extension keeps of a watch on WatchDesk.
const kept = ({ id, siteId, url, label, enabled }) => ({ id, siteId, url, label, enabled });

describe("the watch list with no account connected (WD-54: as before)", () => {
  it("reports local mode and still shows the default watch", async () => {
    const state = await sendMessage({ type: "get-state" });
    expect(state.watchSync).toEqual({ mode: "local" });
    expect(state.settings.watches).toMatchObject([{ id: "default", siteId: "onlinejobsph", enabled: true }]);
    expect(await sendMessage({ type: "sync-watches" })).toEqual({ mode: "local" });
  });

  it("adds, renames, pauses and removes in chrome.storage.sync, and sends nothing to WatchDesk", async () => {
    expect(await sendMessage({ type: "add-watch", url: UPWORK_URL, label: "Mine" })).toEqual({ ok: true, error: null });
    const added = storedWatches().find((w) => w.label === "Mine");
    expect(added).toMatchObject({ siteId: "upwork", url: UPWORK_URL, enabled: true });
    expect(added.id).toMatch(/^w_\d+_/);

    expect(await sendMessage({ type: "rename-watch", id: added.id, label: " Renamed " })).toEqual({ ok: true, label: "Renamed" });
    expect(await sendMessage({ type: "toggle-watch", id: added.id, enabled: false })).toEqual({ ok: true });
    expect(storedWatches().find((w) => w.id === added.id)).toMatchObject({ label: "Renamed", enabled: false });

    expect(await sendMessage({ type: "pause-all" })).toEqual({ ok: true });
    expect(storedWatches().map((w) => w.enabled)).toEqual([false, false]);
    expect(await sendMessage({ type: "set-site-enabled", siteId: "upwork", enabled: true })).toEqual({ ok: true });
    expect(storedWatches().map((w) => w.enabled)).toEqual([false, true]);
    expect(await sendMessage({ type: "resume-all" })).toEqual({ ok: true });

    expect(await sendMessage({ type: "remove-watch", id: added.id })).toEqual({ ok: true });
    expect(storedWatches().map((w) => w.id)).toEqual(["default"]);

    expect(api.fetch).not.toHaveBeenCalled();
    expect(env.chrome.storage.local.dump()[WATCH_SYNC_KEY]).toBeUndefined();
  });

  it("still saves a watch on an unsupported site and says so", async () => {
    const result = await sendMessage({ type: "add-watch", url: "https://example.com/jobs", label: "" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^Unsupported site/);
    expect(storedWatches().at(-1)).toMatchObject({ siteId: null, url: "https://example.com/jobs" });
  });

  it("Reset Extension puts the default watch back", async () => {
    await sendMessage({ type: "add-watch", url: UPWORK_URL, label: "Mine" });
    expect(await sendMessage({ type: "reset-extension" })).toEqual({ ok: true });
    expect(storedWatches().map((w) => w.id)).toEqual(["default"]);
  });

  it("checks on the alarm without asking WatchDesk for anything", async () => {
    await checkJobsAlarm();
    expect(api.requests.map((r) => r.origin)).toEqual([OJ_ORIGIN]);
    expect(env.chrome.storage.local.dump().lastRunAt).toBe(Date.now());
  });
});

describe("the watch list with an account connected (WD-54)", () => {
  const jobSiteFetches = () => api.requests.filter((r) => r.origin === OJ_ORIGIN).map((r) => r.url);

  beforeEach(async () => {
    await env.chrome.storage.local.set({ [TOKEN_KEY]: TEST_TOKEN });
  });

  it("uploads this browser's watch on the first sync, and brings in a watch added on the web on the next", async () => {
    expect(await sendMessage({ type: "sync-watches" })).toEqual({
      mode: "account",
      offline: false,
      lastSyncedAt: Date.now(),
      localOnly: 0,
    });
    expect(api.watches.map((w) => w.label)).toEqual(["All OnlineJobs.ph postings"]);

    api.addWatch({ url: UPWORK_URL, label: "From the web" });
    await sendMessage({ type: "sync-watches" });

    const state = await sendMessage({ type: "get-state" });
    expect(state.settings.watches).toEqual(api.watches.map(kept));
    expect(state.settings.watches.map((w) => w.label)).toEqual(["All OnlineJobs.ph postings", "From the web"]);
    expect(state.watchSync).toMatchObject({ mode: "account", offline: false });
    expect(JSON.stringify(state)).not.toContain(TEST_TOKEN);
  });

  it("syncs on the alarm before checking: a watch added on the web is checked on that very check", async () => {
    await checkJobsAlarm();
    expect(jobSiteFetches()).toHaveLength(1);

    const added = api.addWatch({ url: `${OJ_ORIGIN}/jobseekers/jobsearch?jobkeyword=added-on-web` });
    await checkJobsAlarm();

    expect(jobSiteFetches().slice(1)).toEqual([api.watches[0].url, added.url]);
    expect(Object.keys(env.chrome.storage.local.dump().lastChecked)).toContain(added.id);
  });

  it("a watch paused on the web is skipped on the next check, and one deleted there is gone", async () => {
    await checkJobsAlarm();
    expect(jobSiteFetches()).toHaveLength(1);

    api.watches[0].enabled = false;
    await checkJobsAlarm();
    expect(jobSiteFetches()).toHaveLength(1);
    expect(storedWatches()).toMatchObject([{ enabled: false }]);
    expect(env.chrome.storage.local.dump().lastRunAt).toBe(Date.now());

    api.watches.length = 0;
    await checkJobsAlarm();
    expect(storedWatches()).toEqual([]);
  });

  it("Check now syncs first too", async () => {
    await sendMessage({ type: "sync-watches" });
    api.watches[0].enabled = false;
    const state = await sendMessage({ type: "check-now" });
    expect(jobSiteFetches()).toHaveLength(0);
    expect(state.settings.watches).toMatchObject([{ enabled: false }]);
    expect(state.watchSync).toMatchObject({ mode: "account", offline: false });
  });

  it("shows an account with no watches as empty, not as the default watch", async () => {
    await sendMessage({ type: "sync-watches" });
    api.watches.length = 0;
    await sendMessage({ type: "sync-watches" });
    expect((await sendMessage({ type: "get-state" })).settings.watches).toEqual([]);
  });

  it("add, rename, pause and remove call WatchDesk's endpoints", async () => {
    await sendMessage({ type: "sync-watches" });

    expect(await sendMessage({ type: "add-watch", url: UPWORK_URL, label: "Mine" })).toEqual({ ok: true });
    const added = api.watches[1];
    expect(added).toMatchObject({ url: UPWORK_URL, label: "Mine", enabled: true });

    expect(await sendMessage({ type: "rename-watch", id: added.id, label: " Renamed " })).toEqual({ ok: true, label: "Renamed" });
    expect(await sendMessage({ type: "toggle-watch", id: added.id, enabled: false })).toEqual({ ok: true });
    expect(added).toMatchObject({ label: "Renamed", enabled: false });
    expect(storedWatches()).toEqual(api.watches.map(kept));

    expect(await sendMessage({ type: "pause-all" })).toEqual({ ok: true });
    expect(api.watches.map((w) => w.enabled)).toEqual([false, false]);
    expect(await sendMessage({ type: "set-site-enabled", siteId: "upwork", enabled: true })).toEqual({ ok: true });
    expect(await sendMessage({ type: "resume-all" })).toEqual({ ok: true });
    expect(api.watches.map((w) => w.enabled)).toEqual([true, true]);

    await env.chrome.storage.local.set({ seenIds: { [added.id]: ["a"] }, lastChecked: { [added.id]: 1 }, lastResult: {} });
    expect(await sendMessage({ type: "remove-watch", id: added.id })).toEqual({ ok: true });
    expect(api.watches).toHaveLength(1);
    expect(storedWatches()).toEqual(api.watches.map(kept));
    expect(env.chrome.storage.local.dump().seenIds).toEqual({});

    expect(
      api
        .watchCalls()
        .filter((r) => r.method !== "GET")
        .map((r) => r.method),
    ).toEqual([
      "POST", // the default watch, uploaded by the first sync
      "POST",
      "PATCH",
      "PATCH",
      "PATCH", // pause-all: only the watch still active
      "PATCH",
      "PATCH", // resume-all: only the watch still paused
      "DELETE",
    ]);
  });

  it("an empty title is refused before anything is sent", async () => {
    await sendMessage({ type: "sync-watches" });
    const calls = api.watchCalls().length;
    expect(await sendMessage({ type: "rename-watch", id: api.watches[0].id, label: "  " })).toEqual({
      ok: false,
      error: "Title can't be empty.",
    });
    expect(api.watchCalls()).toHaveLength(calls);
  });

  it("an unsupported URL is refused by WatchDesk and not saved", async () => {
    await sendMessage({ type: "sync-watches" });
    expect(await sendMessage({ type: "add-watch", url: "https://example.com/jobs", label: "" })).toEqual({
      ok: false,
      error: "Enter a search URL on OnlineJobs.ph, Glassdoor, LinkedIn or Upwork",
    });
    expect(storedWatches()).toHaveLength(1);
  });

  describe("while WatchDesk is unreachable", () => {
    beforeEach(async () => {
      await sendMessage({ type: "sync-watches" });
      api.addWatch({ url: UPWORK_URL, label: "From the web" });
      await sendMessage({ type: "sync-watches" });
      vi.setSystemTime(Date.now() + 240000);
      api.setWatchRoute(api.networkError);
    });

    it("the popup gets the last-synced list and an offline flag, never an empty list", async () => {
      expect(await sendMessage({ type: "sync-watches" })).toMatchObject({ mode: "account", offline: true });

      const state = await sendMessage({ type: "get-state" });
      expect(state.settings.watches.map((w) => w.label)).toEqual(["All OnlineJobs.ph postings", "From the web"]);
      expect(state.watchSync).toEqual({ mode: "account", offline: true, lastSyncedAt: Date.now() - 240000, localOnly: 0 });
    });

    it("the check still runs, on the last-synced list", async () => {
      await checkJobsAlarm();
      expect(jobSiteFetches()).toEqual([api.watches[0].url]);
      expect(env.chrome.storage.local.dump().lastRunAt).toBe(Date.now());
    });

    it("changes are refused with a clear message and nothing is removed", async () => {
      const refused = {
        ok: false,
        error: "Can't reach WatchDesk, so your watches can't be changed right now. The list shown is the last one synced.",
      };
      const id = api.watches[1].id;
      await env.chrome.storage.local.set({ seenIds: { [id]: ["a"] } });

      expect(await sendMessage({ type: "add-watch", url: UPWORK_URL, label: "x" })).toEqual(refused);
      expect(await sendMessage({ type: "toggle-watch", id, enabled: false })).toEqual(refused);
      expect(await sendMessage({ type: "rename-watch", id, label: "x" })).toEqual(refused);
      expect(await sendMessage({ type: "remove-watch", id })).toEqual(refused);
      expect(await sendMessage({ type: "pause-all" })).toEqual(refused);

      expect(storedWatches()).toEqual(api.watches.map(kept));
      expect(env.chrome.storage.local.dump().seenIds).toEqual({ [id]: ["a"] });
    });

    it("a WatchDesk that never answers holds the check up for 10 seconds, no longer", async () => {
      api.setWatchRoute(api.hang);
      let done = false;
      const listener = checkJobsAlarm().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(9999);
      expect(env.chrome.storage.local.dump().lastRunAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await listener;
      expect(done).toBe(true);
      expect(env.chrome.storage.local.dump().lastRunAt).toBe(Date.now());
      expect(api.watchCalls("GET")).toHaveLength(3);
    });
  });

  it("Reset Extension keeps the account's watches and deletes nothing on WatchDesk", async () => {
    await sendMessage({ type: "sync-watches" });
    await sendMessage({ type: "add-watch", url: UPWORK_URL, label: "Mine" });
    await env.chrome.storage.sync.set({ intervalMinutes: 30 });

    expect(await sendMessage({ type: "reset-extension" })).toEqual({ ok: true });

    expect(storedWatches()).toEqual(api.watches.map(kept));
    expect(api.watches).toHaveLength(2);
    expect(api.watchCalls("DELETE")).toHaveLength(0);
    expect(env.chrome.storage.sync.dump().intervalMinutes).toBe(5);
  });

  it("Import adds the file's watches to the account, without doubling one it already has", async () => {
    await sendMessage({ type: "sync-watches" });
    const existing = api.watches[0];

    const result = await sendMessage({
      type: "import-settings",
      data: {
        watches: [
          { id: "w_old", url: existing.url, label: "Same search", enabled: true },
          { id: "w_new", url: UPWORK_URL, label: "Imported", enabled: false },
        ],
      },
    });

    expect(result).toEqual({ ok: true, imported: 2, skipped: 0 });
    expect(api.watches.map((w) => [w.url, w.label, w.enabled])).toEqual([
      [existing.url, "All OnlineJobs.ph postings", true],
      [UPWORK_URL, "Imported", false],
    ]);
    expect(storedWatches()).toEqual(api.watches.map(kept));
  });

  it("once the token is refused, the list is this browser's again and changes stay here", async () => {
    await sendMessage({ type: "sync-watches" });
    api.setWatchRoute(() => api.json(401, { error: "Sign in to continue." }));

    expect(await sendMessage({ type: "sync-watches" })).toEqual({ mode: "local" });
    expect(env.chrome.storage.local.dump()[TOKEN_KEY]).toBeUndefined();
    const state = await sendMessage({ type: "get-state" });
    expect(state.watchSync).toEqual({ mode: "local" });
    expect(state.settings.watches).toHaveLength(1);

    const calls = api.watchCalls().length;
    expect(await sendMessage({ type: "add-watch", url: UPWORK_URL, label: "Local" })).toEqual({ ok: true, error: null });
    expect(storedWatches()).toHaveLength(2);
    expect(api.watchCalls()).toHaveLength(calls);
  });
});
