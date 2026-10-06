// background.js routes the popup's account-* messages to
// account-connection.js and registers its listeners, without disturbing the
// job-check alarm or the existing message handling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { installFakeWatchDesk, TEST_CODE, TEST_POLL_SECRET, TEST_TOKEN } from "./helpers/fake-watchdesk.js";
import {
  LISTING_QUEUE_KEY,
  LISTING_SYNC_KEY,
  PAIRING_ALARM,
  TOKEN_KEY,
  WATCH_SYNC_KEY,
  WATCHER_SYNC_KEY,
} from "../account-connection.js";

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
      expect(state.watchSync).toEqual({
        mode: "account",
        offline: true,
        lastSyncedAt: Date.now() - 240000,
        localOnly: 0,
        listings: { lastIngestedAt: null, failed: false, queued: 0, dropped: 0 },
        watcherUnsent: null,
      });
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

  // WD-79: the settings are the account's too, so a reset leaves them, and
  // the copy of them, as they are.
  it("Reset Extension keeps the account's watches and settings, and changes nothing on WatchDesk", async () => {
    await sendMessage({ type: "sync-watches" });
    await sendMessage({ type: "add-watch", url: UPWORK_URL, label: "Mine" });
    api.setSettings({ intervalMinutes: 30 });
    await sendMessage({ type: "sync-settings" });
    const onWatchDesk = api.settings();

    expect(await sendMessage({ type: "reset-extension" })).toEqual({ ok: true });

    expect(storedWatches()).toEqual(api.watches.map(kept));
    expect(api.watches).toHaveLength(2);
    expect(api.watchCalls("DELETE")).toHaveLength(0);
    expect(env.chrome.storage.sync.dump().intervalMinutes).toBe(30);
    expect(api.settingsCalls("PUT")).toHaveLength(0);
    expect(api.settings()).toEqual(onWatchDesk);
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

describe("a check cycle posts what it read to WatchDesk (WD-59)", () => {
  // Postings as OnlineJobs.ph's adapter returns them. The titles pass the
  // default title filter, which covers that site.
  const job = (n, title = `PHP Developer ${n}`) => ({
    id: `13100${n}`,
    title,
    url: `${OJ_ORIGIN}/jobseekers/job/13100${n}`,
    postedRaw: "2026-10-02 09:15:00",
    postedAt: "2026-10-02T01:15:00.000Z",
    salaryRaw: null,
  });
  const listing = (n) => ({ ...job(n), postedApprox: false, easyApply: false, workplaceType: null });

  let page; // what the watched search page shows
  let popupMessages; // what an open popup would receive from the worker
  const ingestBodies = () => api.ingestCalls().map((r) => r.body);
  const local = () => env.chrome.storage.local.dump();

  beforeEach(() => {
    page = [job(1)];
    popupMessages = [];
    api.setSite(() => new Response("<html></html>", { status: 200 }));
    // The offscreen document is open and parses the page.
    env.chrome.runtime.getContexts = vi.fn(async () => [{}]);
    env.chrome.runtime.sendMessage.mockImplementation(async (message) => {
      if (message.type === "parse-html") return { ok: true, jobs: structuredClone(page) };
      if (message.type !== "play-sound") popupMessages.push(message);
      return undefined;
    });
  });

  describe("with no account connected", () => {
    it("checks exactly as before and sends nothing to WatchDesk", async () => {
      await checkJobsAlarm();
      page = [job(2), job(1)];
      await checkJobsAlarm();

      expect(local().feed.map((entry) => entry.sourceKey)).toEqual(["onlinejobsph:131002"]);
      expect(local().badgeCount).toBe(1);
      expect(env.chrome.notifications.create).toHaveBeenCalledTimes(1);
      expect(api.requests.every((r) => r.origin === OJ_ORIGIN)).toBe(true);
      expect(local()[LISTING_SYNC_KEY]).toBeUndefined();
      expect(popupMessages).toEqual([]);
      expect((await sendMessage({ type: "check-now" })).watchSync).toEqual({ mode: "local" });
      expect(api.requests.every((r) => r.origin === OJ_ORIGIN)).toBe(true);
    });
  });

  describe("with an account connected", () => {
    beforeEach(async () => {
      await env.chrome.storage.local.set({ [TOKEN_KEY]: TEST_TOKEN });
      // WD-79: a connected browser checks on the account's settings, and
      // this account has notifications on.
      api.setSettings({ notificationsMuted: false });
    });

    it("posts the listings the cycle read, under the watch's server id, baseline included", async () => {
      await checkJobsAlarm();

      // The first check of a watch is its baseline: nothing is new locally…
      expect(local().feed).toEqual([]);
      expect(env.chrome.notifications.create).not.toHaveBeenCalled();
      // …but what is on the page still goes to WatchDesk.
      expect(ingestBodies()).toEqual([{ watchId: api.watches[0].id, listings: [listing(1)] }]);
      expect(api.ingestCalls()[0].headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`);
      expect(api.listings.map((row) => row.sourceKey)).toEqual(["onlinejobsph:131001"]);
      expect(local()[LISTING_SYNC_KEY]).toEqual({ lastIngestedAt: Date.now(), failed: false });
    });

    it("sends every listing on the page each cycle, not only the new ones", async () => {
      await checkJobsAlarm();
      page = [job(2), job(1)];
      await checkJobsAlarm();

      expect(ingestBodies()[1].listings).toEqual([listing(2), listing(1)]);
      expect(api.listings).toHaveLength(2);
    });

    it("runs after the local detection: feed, notification and badge are done before the request is made", async () => {
      await checkJobsAlarm();
      page = [job(2), job(1)];
      let atRequest;
      api.setIngestRoute(() => {
        atRequest = {
          feed: local().feed.map((entry) => entry.sourceKey),
          lastRunAt: local().lastRunAt,
          seen: local().seenIds[api.watches[0].id],
          badgeCount: local().badgeCount,
          notifications: env.chrome.notifications.create.mock.calls.length,
          badgeText: env.chrome.action.setBadgeText.mock.calls.at(-1)?.[0],
        };
      });
      vi.setSystemTime(Date.now() + 300000);
      await checkJobsAlarm();

      expect(atRequest).toEqual({
        feed: ["onlinejobsph:131002"],
        lastRunAt: Date.now(),
        seen: ["131002", "131001"],
        badgeCount: 1,
        notifications: 1,
        badgeText: { text: "1" },
      });
    });

    it("sends what the title filter kept, as the local feed does", async () => {
      page = [job(1), job(2, "Food Safety Manager")];
      await checkJobsAlarm();

      expect(ingestBodies()[0].listings.map((sent) => sent.id)).toEqual(["131001"]);
    });

    it("sends nothing for a watch whose check failed", async () => {
      api.setSite(() => new Response("", { status: 503 }));
      await checkJobsAlarm();

      expect(local().lastResult[api.watches[0].id].error).toMatch(/^HTTP 503/);
      expect(api.ingestCalls()).toHaveLength(0);
    });

    it("skips a watch WatchDesk has not got yet, and sends it once a sync has uploaded it", async () => {
      api.setWatchRoute((request) => (request.method === "POST" ? api.json(500, {}) : undefined));
      await checkJobsAlarm();
      expect(local().lastRunAt).toBe(Date.now());
      expect(storedWatches().map((w) => w.id)).toEqual(["default"]);
      expect(api.ingestCalls()).toHaveLength(0);

      api.setWatchRoute(() => undefined);
      await checkJobsAlarm();
      expect(ingestBodies()).toEqual([{ watchId: api.watches[0].id, listings: [listing(1)] }]);
    });

    it("cannot delay or fail the check: with WatchDesk not answering, the cycle is saved at once and the failure is recorded later", async () => {
      await checkJobsAlarm();
      const firstAt = Date.now();
      page = [job(2), job(1)];
      api.setIngestRoute(api.hang);
      vi.setSystemTime(firstAt + 300000);
      const cycleAt = Date.now();
      let done = false;
      const listener = checkJobsAlarm().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(10);

      expect(local().lastRunAt).toBe(cycleAt);
      expect(local().feed.map((entry) => entry.sourceKey)).toEqual(["onlinejobsph:131002"]);
      expect(env.chrome.notifications.create).toHaveBeenCalledTimes(1);
      expect(done).toBe(false);

      await vi.advanceTimersByTimeAsync(120000);
      await listener;
      expect(local().lastResult[api.watches[0].id].error).toBeNull();
      expect(local()[LISTING_SYNC_KEY]).toEqual({ lastIngestedAt: firstAt, failed: true });
      // One request on the first cycle, then the retry policy's four
      // attempts on this one.
      expect(api.ingestCalls()).toHaveLength(5);
    });

    it("shows the result in the popup's state, without the token", async () => {
      await checkJobsAlarm();
      const state = await sendMessage({ type: "get-state" });

      expect(state.watchSync).toEqual({
        mode: "account",
        offline: false,
        lastSyncedAt: Date.now(),
        localOnly: 0,
        listings: { lastIngestedAt: Date.now(), failed: false, queued: 0, dropped: 0 },
        watcherUnsent: null,
      });
      expect(JSON.stringify(state)).not.toContain(TEST_TOKEN);
    });

    it("tells an open popup when the listings have been sent", async () => {
      await checkJobsAlarm();

      expect(popupMessages).toEqual([
        {
          type: "watch-sync-changed",
          watchSync: {
            mode: "account",
            offline: false,
            lastSyncedAt: Date.now(),
            localOnly: 0,
            listings: { lastIngestedAt: Date.now(), failed: false, queued: 0, dropped: 0 },
            watcherUnsent: null,
          },
        },
      ]);
      expect(JSON.stringify(popupMessages)).not.toContain(TEST_TOKEN);
    });

    it("Check now answers the popup before the listings are sent, then tells it how that went", async () => {
      api.setIngestRoute(api.hang);
      const state = await sendMessage({ type: "check-now" });

      // Answered with the check done, while the listings are not yet sent.
      expect(state.runState.lastRunAt).toBe(Date.now());
      expect(state.watchSync.listings).toEqual({ lastIngestedAt: null, failed: false, queued: 0, dropped: 0 });
      expect(popupMessages).toEqual([]);

      await vi.advanceTimersByTimeAsync(120000);
      expect(api.ingestCalls()).toHaveLength(4);
      expect(popupMessages).toHaveLength(1);
      expect(popupMessages[0]).toMatchObject({
        type: "watch-sync-changed",
        watchSync: { mode: "account", listings: { lastIngestedAt: null, failed: true } },
      });
    });

    it("Check now posts the listings too", async () => {
      await sendMessage({ type: "check-now" });
      await vi.advanceTimersByTimeAsync(0);

      expect(ingestBodies()).toEqual([{ watchId: api.watches[0].id, listings: [listing(1)] }]);
      expect(popupMessages).toHaveLength(1);
    });

    it("says nothing to the popup when there was nothing to send", async () => {
      page = [];
      await checkJobsAlarm();

      expect(api.ingestCalls()).toHaveLength(0);
      expect(popupMessages).toEqual([]);
    });

    it("a token refused while sending ends the connection; the check has already been saved", async () => {
      api.setIngestRoute(() => api.json(401, { error: "Sign in to continue." }));
      await checkJobsAlarm();

      expect(local()[TOKEN_KEY]).toBeUndefined();
      expect(local()[LISTING_SYNC_KEY]).toBeUndefined();
      expect(local().lastRunAt).toBe(Date.now());
      expect(popupMessages.map((message) => message.type)).toEqual(["account-state-changed"]);
    });
  });

  describe("when WatchDesk did not take a cycle's listings (WD-60)", () => {
    beforeEach(async () => {
      await env.chrome.storage.local.set({ [TOKEN_KEY]: TEST_TOKEN });
    });

    const outage = async () => {
      api.setIngestRoute(api.networkError);
      const listener = checkJobsAlarm();
      await vi.advanceTimersByTimeAsync(120000);
      await listener;
      api.setIngestRoute(() => undefined);
    };

    it("keeps them in chrome.storage.local and sends them on the next alarm tick, before that tick's own", async () => {
      await outage();
      expect(local()[LISTING_QUEUE_KEY]).toEqual({
        owner: "ada@example.com",
        items: [{ watchId: api.watches[0].id, listing: listing(1) }],
        dropped: 0,
        droppedSeen: false,
      });
      expect(api.listings).toHaveLength(0);
      // The check itself was not held up or failed by any of it.
      expect(local().lastResult[api.watches[0].id].error).toBeNull();

      page = [job(2)];
      const before = api.ingestCalls().length;
      await checkJobsAlarm();

      expect(ingestBodies().slice(before)).toEqual([
        { watchId: api.watches[0].id, listings: [listing(1)] },
        { watchId: api.watches[0].id, listings: [listing(2)] },
      ]);
      expect(api.listings.map((row) => row.sourceKey)).toEqual(["onlinejobsph:131001", "onlinejobsph:131002"]);
      expect(local()[LISTING_QUEUE_KEY]).toBeUndefined();
      expect(local()[LISTING_SYNC_KEY]).toEqual({ lastIngestedAt: Date.now(), failed: false });
    });

    it("Check now retries them too", async () => {
      await outage();
      page = [];
      await sendMessage({ type: "check-now" });
      await vi.advanceTimersByTimeAsync(0);

      expect(api.listings.map((row) => row.sourceKey)).toEqual(["onlinejobsph:131001"]);
      expect(local()[LISTING_QUEUE_KEY]).toBeUndefined();
    });

    it("tells the popup how many are waiting, and never what they are", async () => {
      await outage();
      const state = await sendMessage({ type: "get-state" });

      expect(state.watchSync.listings).toEqual({ lastIngestedAt: null, failed: true, queued: 1, dropped: 0 });
      expect(JSON.stringify(state.watchSync)).not.toContain("PHP Developer");
      expect(JSON.stringify(popupMessages)).not.toContain("PHP Developer");
    });

    it("the popup's 'seen' message clears a dropped count once everything has got through", async () => {
      await env.chrome.storage.local.set({
        watchdeskAccount: { email: "ada@example.com" },
        [LISTING_QUEUE_KEY]: { owner: "ada@example.com", items: [], dropped: 40, droppedSeen: false },
      });
      expect((await sendMessage({ type: "get-state" })).watchSync.listings.dropped).toBe(40);

      expect(await sendMessage({ type: "listing-drops-seen" })).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(0);

      expect(local()[LISTING_QUEUE_KEY]).toBeUndefined();
      expect((await sendMessage({ type: "get-state" })).watchSync.listings.dropped).toBe(0);
    });

    it("with no account connected there is no queue, whatever happens", async () => {
      await env.chrome.storage.local.remove(TOKEN_KEY);
      api.setIngestRoute(api.networkError);
      await checkJobsAlarm();
      await sendMessage({ type: "listing-drops-seen" });

      expect(local()[LISTING_QUEUE_KEY]).toBeUndefined();
      expect(api.requests.every((r) => r.origin === OJ_ORIGIN)).toBe(true);
    });
  });

  it("a new connection starts without the last one's record", async () => {
    await env.chrome.storage.local.set({ [LISTING_SYNC_KEY]: { lastIngestedAt: 1, failed: true } });
    await sendMessage({ type: "account-connect" });
    api.queuePoll(api.approved);
    await vi.advanceTimersByTimeAsync(3000);

    expect(local()[TOKEN_KEY]).toBe(TEST_TOKEN);
    expect(local()[LISTING_SYNC_KEY]).toBeUndefined();
  });
});

describe("Start Watching / Pause Watching (WD-71)", () => {
  const ALARM = "check-jobs";
  const hasAlarm = () => env.alarms.has(ALARM);
  const local = () => env.chrome.storage.local.dump();
  const pause = () => sendMessage({ type: "set-watcher-state", state: "paused" });
  const start = () => sendMessage({ type: "set-watcher-state", state: "running" });
  const jobSiteFetches = () => api.requests.filter((r) => r.origin === OJ_ORIGIN);
  // A new service worker: the same storage and alarms, its own listeners.
  const restartWorker = async () => {
    env.dropListeners();
    vi.resetModules();
    await import("../background.js");
  };

  describe("with no account connected", () => {
    it("is running to begin with, with the alarm on the user's interval", async () => {
      const state = await sendMessage({ type: "get-state" });

      expect(state.watcher).toEqual({ state: "running" });
      expect(env.alarms.get(ALARM)).toMatchObject({ periodInMinutes: 5 });
    });

    it("Pause clears the alarm at once, saves the state in this browser, and sends nothing", async () => {
      await sendMessage({ type: "get-state" });
      expect(hasAlarm()).toBe(true);

      const state = await pause();
      await vi.advanceTimersByTimeAsync(0);

      expect(hasAlarm()).toBe(false);
      expect(state.watcher).toEqual({ state: "paused" });
      expect(state.watchSync).toEqual({ mode: "local" });
      expect(local().watcherState).toBe("paused");
      expect(env.chrome.storage.sync.dump().watcherState).toBeUndefined();
      expect(local()[WATCHER_SYNC_KEY]).toBeUndefined();
      expect(api.fetch).not.toHaveBeenCalled();
    });

    it("changes no watch: it is not Pause All", async () => {
      await sendMessage({ type: "add-watch", url: UPWORK_URL, label: "Mine" });
      const before = storedWatches();

      const state = await pause();

      expect(storedWatches()).toEqual(before);
      expect(state.settings.watches.every((w) => w.enabled)).toBe(true);
    });

    it("stays paused through everything that used to re-arm the alarm", async () => {
      await pause();
      env.chrome.alarms.create.mockClear();

      await sendMessage({ type: "get-state" });
      await sendMessage({ type: "set-interval", minutes: 15 });
      await env.chrome.runtime.onInstalled.dispatch({ reason: "update", previousVersion: "1.0.0" });
      await env.chrome.runtime.onStartup.dispatch();
      await sendMessage({ type: "import-settings", data: { watches: [{ url: UPWORK_URL, label: "Imported" }] } });

      expect(hasAlarm()).toBe(false);
      expect(env.chrome.alarms.create).not.toHaveBeenCalledWith(ALARM, expect.anything());
      expect((await sendMessage({ type: "get-state" })).watcher).toEqual({ state: "paused" });
    });

    it("stays paused in a new service worker and after a browser restart", async () => {
      await pause();

      await restartWorker();
      await env.chrome.runtime.onStartup.dispatch();

      expect(hasAlarm()).toBe(false);
      expect((await sendMessage({ type: "get-state" })).watcher).toEqual({ state: "paused" });
      expect(hasAlarm()).toBe(false);
    });

    it("Check now still checks while paused, and does not bring the alarm back", async () => {
      await pause();

      const state = await sendMessage({ type: "check-now" });

      expect(jobSiteFetches()).toHaveLength(1);
      expect(state.runState.lastRunAt).toBe(Date.now());
      expect(state.watcher).toEqual({ state: "paused" });
      expect(hasAlarm()).toBe(false);
    });

    it("a tick that was already on its way when the user paused checks nothing", async () => {
      await pause();
      // Chrome had the alarm's event queued before it was cleared.
      env.alarms.set(ALARM, { name: ALARM, periodInMinutes: 5 });

      await checkJobsAlarm();

      expect(api.fetch).not.toHaveBeenCalled();
      expect(local().lastRunAt).toBeUndefined();
      expect(hasAlarm()).toBe(false);
    });

    it("an alarm left behind by a worker stopped mid-pause is cleared when the popup next opens", async () => {
      await env.chrome.storage.local.set({ watcherState: "paused" });
      await env.chrome.alarms.create(ALARM, { periodInMinutes: 5 });

      await sendMessage({ type: "get-state" });

      expect(hasAlarm()).toBe(false);
    });

    it("Start creates the alarm again on the user's interval, and the checks resume", async () => {
      await sendMessage({ type: "set-interval", minutes: 15 });
      await pause();

      const state = await start();

      expect(state.watcher).toEqual({ state: "running" });
      expect(local().watcherState).toBe("running");
      expect(env.alarms.get(ALARM)).toEqual({ name: ALARM, delayInMinutes: 0.1, periodInMinutes: 15 });

      await checkJobsAlarm();
      expect(jobSiteFetches()).toHaveLength(1);
      expect(local().lastRunAt).toBe(Date.now());
    });

    it("an interval chosen while paused is the one Start uses", async () => {
      await pause();
      await sendMessage({ type: "set-interval", minutes: 30 });

      await start();

      expect(env.alarms.get(ALARM)).toMatchObject({ periodInMinutes: 30 });
    });

    it("asking for the state it is already in does not restart the countdown", async () => {
      await sendMessage({ type: "get-state" });
      env.chrome.alarms.create.mockClear();
      env.chrome.alarms.clear.mockClear();

      expect((await start()).watcher).toEqual({ state: "running" });

      expect(env.chrome.alarms.create).not.toHaveBeenCalled();
      expect(env.chrome.alarms.clear).not.toHaveBeenCalled();
      expect(hasAlarm()).toBe(true);
    });

    it("refuses anything that is not running or paused, and changes nothing", async () => {
      await sendMessage({ type: "get-state" });
      const refused = { ok: false, error: "Unknown watcher state" };

      expect(await sendMessage({ type: "set-watcher-state", state: "stopped" })).toEqual(refused);
      expect(await sendMessage({ type: "set-watcher-state" })).toEqual(refused);

      expect(local().watcherState).toBeUndefined();
      expect(hasAlarm()).toBe(true);
    });

    it("Reset Extension starts watching again", async () => {
      await pause();

      expect(await sendMessage({ type: "reset-extension" })).toEqual({ ok: true });

      expect(local().watcherState).toBe("running");
      expect(hasAlarm()).toBe(true);
    });

    it("sends nothing to WatchDesk, whatever is clicked", async () => {
      await pause();
      await sendMessage({ type: "sync-watches" });
      await sendMessage({ type: "check-now" });
      await start();
      await checkJobsAlarm();
      await env.chrome.runtime.onStartup.dispatch();
      await sendMessage({ type: "reset-extension" });
      await vi.advanceTimersByTimeAsync(0);

      expect(api.requests.every((r) => r.origin === OJ_ORIGIN)).toBe(true);
      expect(local()[WATCHER_SYNC_KEY]).toBeUndefined();
    });
  });

  describe("with an account connected", () => {
    let popupMessages; // what an open popup would receive from the worker
    const flush = () => vi.advanceTimersByTimeAsync(0);
    const settingsMethods = () => api.settingsCalls().map((r) => r.method);

    beforeEach(async () => {
      await env.chrome.storage.local.set({ [TOKEN_KEY]: TEST_TOKEN });
      popupMessages = [];
      env.chrome.runtime.sendMessage.mockImplementation(async (message) => {
        popupMessages.push(message);
      });
    });

    it("Pause is reflected in the account's settings.watcherState, and Start sets it back", async () => {
      const before = api.settings();

      await pause();
      await flush();

      expect(hasAlarm()).toBe(false);
      expect(settingsMethods()).toEqual(["GET", "PUT"]);
      expect(api.settingsCalls().every((r) => r.headers.Authorization === `Bearer ${TEST_TOKEN}`)).toBe(true);
      // Only the watcher state changed.
      expect(api.settings()).toEqual({ ...before, watcherState: "paused" });

      await start();
      await flush();

      expect(hasAlarm()).toBe(true);
      expect(api.settings()).toEqual(before);
      // Nothing went wrong, so the sync line has nothing new to say.
      expect(popupMessages).toEqual([]);
    });

    it("the click is answered before WatchDesk is: one that never answers cannot hold up a pause", async () => {
      await sendMessage({ type: "get-state" });
      api.setSettingsRoute(api.hang);

      const state = await pause();

      // Answered and already paused, with the request still out.
      expect(state.watcher).toEqual({ state: "paused" });
      expect(state.watchSync.watcherUnsent).toBeNull();
      expect(hasAlarm()).toBe(false);
      expect(popupMessages).toEqual([]);

      await vi.advanceTimersByTimeAsync(10000);

      expect(settingsMethods()).toEqual(["GET"]);
      expect(popupMessages).toHaveLength(1);
      expect(popupMessages[0]).toMatchObject({
        type: "watch-sync-changed",
        watchSync: { mode: "account", watcherUnsent: "paused" },
      });
      expect(JSON.stringify(popupMessages)).not.toContain(TEST_TOKEN);
      // Still paused: the failure undoes nothing.
      expect(local().watcherState).toBe("paused");
      expect(hasAlarm()).toBe(false);
    });

    it("a pause WatchDesk did not get is sent again when the popup next opens, and the warning goes", async () => {
      api.setSettingsRoute(api.networkError);
      await pause();
      await flush();
      expect((await sendMessage({ type: "get-state" })).watchSync.watcherUnsent).toBe("paused");
      expect(api.settings().watcherState).toBe("running");

      api.setSettingsRoute(() => undefined);
      popupMessages.length = 0;
      await sendMessage({ type: "sync-watches" });
      await flush();

      expect(api.settings().watcherState).toBe("paused");
      expect(popupMessages.at(-1)).toMatchObject({ type: "watch-sync-changed", watchSync: { watcherUnsent: null } });
      expect(hasAlarm()).toBe(false);
    });

    it("…and at a browser start, since a paused browser has no alarm tick to send it on", async () => {
      api.setSettingsRoute(api.networkError);
      await pause();
      await flush();
      api.setSettingsRoute(() => undefined);

      await restartWorker();
      await env.chrome.runtime.onStartup.dispatch();

      expect(api.settings().watcherState).toBe("paused");
      expect(hasAlarm()).toBe(false);
    });

    it("…and by Check now", async () => {
      api.setSettingsRoute(api.networkError);
      await pause();
      await flush();
      api.setSettingsRoute(() => undefined);

      await sendMessage({ type: "check-now" });
      await flush();

      expect(api.settings().watcherState).toBe("paused");
    });

    it("a start WatchDesk did not get is sent again on the next alarm tick, after the check", async () => {
      await pause();
      await flush();
      api.setSettingsRoute(api.networkError);
      await start();
      await flush();
      expect(api.settings().watcherState).toBe("paused");
      expect(hasAlarm()).toBe(true);

      let lastRunAtRequest;
      api.setSettingsRoute(() => {
        lastRunAtRequest = local().lastRunAt;
        return undefined;
      });
      vi.setSystemTime(Date.now() + 300000);
      await checkJobsAlarm();

      expect(api.settings().watcherState).toBe("running");
      expect(lastRunAtRequest).toBe(Date.now());
    });

    it("Reset Extension starts watching again and tells WatchDesk", async () => {
      await pause();
      await flush();

      await sendMessage({ type: "reset-extension" });
      await flush();

      expect(hasAlarm()).toBe(true);
      expect(api.settings().watcherState).toBe("running");
    });

    it("never shows the popup the token", async () => {
      const paused = await pause();
      await flush();

      expect(JSON.stringify(paused)).not.toContain(TEST_TOKEN);
      expect(JSON.stringify(await sendMessage({ type: "get-state" }))).not.toContain(TEST_TOKEN);
    });
  });

  it("a new connection is told the state afresh: the last one's record goes", async () => {
    await pause();
    await env.chrome.storage.local.set({ [WATCHER_SYNC_KEY]: { sent: "paused", failed: false } });
    await sendMessage({ type: "account-connect" });
    api.queuePoll(api.approved);
    await vi.advanceTimersByTimeAsync(3000);
    expect(local()[TOKEN_KEY]).toBe(TEST_TOKEN);
    expect(local()[WATCHER_SYNC_KEY]).toBeUndefined();

    await sendMessage({ type: "sync-watches" });
    await vi.advanceTimersByTimeAsync(0);

    expect(api.settings().watcherState).toBe("paused");
    expect(local()[WATCHER_SYNC_KEY]).toEqual({ sent: "paused", failed: false });
    expect(local().watcherState).toBe("paused");
  });
});
