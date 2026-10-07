// The watch list of a connected browser (watch-sync.js), against a mocked
// chrome.* and a fake WatchDesk that keeps the account's watches: what a
// sync does to the stored list, what each change sends, and what happens
// while WatchDesk cannot be reached.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { installFakeWatchDesk, TEST_TOKEN } from "./helpers/fake-watchdesk.js";
import { TOKEN_KEY, WATCH_SYNC_KEY } from "../account-connection.js";

const OJ = "https://www.onlinejobs.ph/jobseekers/jobsearch?jobkeyword=va";
const LI = "https://www.linkedin.com/jobs/search/?keywords=engineer";
const UP = "https://www.upwork.com/nx/search/jobs/?q=react";
const OFFLINE =
  "Can't reach WatchDesk, so your watches can't be changed right now. The list shown is the last one synced.";

let env;
let api;
let sync;

const connect = () => env.chrome.storage.local.set({ [TOKEN_KEY]: TEST_TOKEN });
// What the check cycle and the popup read.
const storedWatches = () => env.chrome.storage.sync.dump().watches;
const storeWatches = (watches) => env.chrome.storage.sync.set({ watches });
const syncState = () => env.chrome.storage.local.dump()[WATCH_SYNC_KEY];
// A watch as the extension stores one it got from WatchDesk.
const stored = ({ id, siteId, url, label, enabled }) => ({ id, siteId, url, label, enabled });
const local = (id, url, extra = {}) => ({ id, siteId: "onlinejobsph", url, label: `Label ${id}`, enabled: true, ...extra });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-03T09:00:00Z"));
  env = installChromeMock();
  api = installFakeWatchDesk();
  vi.resetModules();
  sync = await import("../watch-sync.js");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("with no account connected", () => {
  it("sends nothing, changes nothing, and reports local mode", async () => {
    await storeWatches([local("w_1", OJ)]);
    env.chrome.storage.sync.set.mockClear();

    expect(await sync.syncWatches()).toEqual({ mode: "local" });
    expect(await sync.getWatchSyncStatus()).toEqual({ mode: "local" });
    expect(await sync.usesAccountWatches()).toBe(false);
    expect(await sync.hasSyncedAccountWatches()).toBe(false);
    expect(api.fetch).not.toHaveBeenCalled();
    expect(env.chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(syncState()).toBeUndefined();
  });
});

describe("getServerWatchIds (WD-59)", () => {
  it("is empty with no account connected, and before the first sync", async () => {
    await storeWatches([local("w_1", OJ)]);
    expect(await sync.getServerWatchIds()).toEqual([]);
    await connect();
    expect(await sync.getServerWatchIds()).toEqual([]);
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("lists the ids WatchDesk gave, and never a watch that is only in this browser", async () => {
    await connect();
    const onWeb = api.addWatch({ url: LI });
    await storeWatches([local("w_1", OJ), local("w_bad", "https://example.com/jobs")]);
    await sync.syncWatches();

    const uploaded = api.watches.find((w) => w.url === OJ);
    expect(await sync.getServerWatchIds()).toEqual([onWeb.id, uploaded.id]);
    expect(storedWatches().map((w) => w.id)).toContain("w_bad");
  });

  it("is empty again once the token is gone", async () => {
    await connect();
    api.addWatch({ url: LI });
    await sync.syncWatches();
    await env.chrome.storage.local.remove(TOKEN_KEY);
    expect(await sync.getServerWatchIds()).toEqual([]);
  });
});

describe("a sync", () => {
  beforeEach(connect);

  it("brings a watch added on the web into the stored list", async () => {
    await sync.syncWatches();
    expect(storedWatches() ?? []).toEqual([]);

    const added = api.addWatch({ url: LI, label: "Engineers" });
    const status = await sync.syncWatches();

    expect(storedWatches()).toEqual([
      { id: added.id, siteId: "linkedin", url: LI, label: "Engineers", enabled: true },
    ]);
    expect(status).toEqual({ mode: "account", offline: false, lastSyncedAt: Date.now(), localOnly: 0 });
  });

  it("asks GET /api/watches with the device token", async () => {
    await sync.syncWatches();
    const [call] = api.watchCalls();
    expect(call).toMatchObject({ method: "GET", path: "/api/watches", credentials: "omit" });
    expect(call.headers).toEqual({ Authorization: `Bearer ${TEST_TOKEN}` });
  });

  it("takes a rename and a pause made on the web", async () => {
    const watch = api.addWatch({ url: OJ, label: "Before" });
    await sync.syncWatches();

    Object.assign(watch, { label: "After", enabled: false });
    await sync.syncWatches();

    expect(storedWatches()).toEqual([stored(watch)]);
    expect(storedWatches()[0]).toMatchObject({ label: "After", enabled: false });
  });

  it("removes a watch deleted on the web, with its run state, and sends no write", async () => {
    const kept = api.addWatch({ url: OJ });
    const deleted = api.addWatch({ url: LI });
    await sync.syncWatches();
    await env.chrome.storage.local.set({
      seenIds: { [kept.id]: ["a"], [deleted.id]: ["b"] },
      lastResult: { [deleted.id]: { count: 1, newCount: 0, error: null } },
    });

    api.watches.splice(1, 1);
    await sync.syncWatches();

    expect(storedWatches()).toEqual([stored(kept)]);
    expect(env.chrome.storage.local.dump().seenIds).toEqual({ [kept.id]: ["a"] });
    expect(env.chrome.storage.local.dump().lastResult).toEqual({});
    expect(api.watchCalls().every((r) => r.method === "GET")).toBe(true);
  });

  it("keeps the account's order, oldest first", async () => {
    const first = api.addWatch({ url: UP });
    const second = api.addWatch({ url: OJ });
    await sync.syncWatches();
    expect(storedWatches().map((w) => w.id)).toEqual([first.id, second.id]);
  });

  it("does not write chrome.storage.sync when nothing changed", async () => {
    api.addWatch({ url: OJ });
    await sync.syncWatches();
    env.chrome.storage.sync.set.mockClear();

    vi.setSystemTime(Date.now() + 300000);
    const status = await sync.syncWatches();

    expect(env.chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(status.lastSyncedAt).toBe(Date.now());
  });

  it("shows an empty account as empty once it has synced", async () => {
    expect(await sync.hasSyncedAccountWatches()).toBe(false);
    await sync.syncWatches();
    expect(await sync.hasSyncedAccountWatches()).toBe(true);
  });

  it("runs one at a time, so two at once do not upload a watch twice", async () => {
    await storeWatches([local("w_1", OJ)]);
    await Promise.all([sync.syncWatches(), sync.syncWatches()]);
    expect(api.watchCalls("POST")).toHaveLength(1);
    expect(api.watches).toHaveLength(1);
  });
});

describe("the first sync after connecting, with watches already in this browser", () => {
  beforeEach(connect);

  it("uploads them as they are, paused ones paused, and adopts the server's ids", async () => {
    await storeWatches([local("default", OJ), local("w_2", LI, { siteId: "linkedin", enabled: false })]);

    const status = await sync.syncWatches();

    expect(api.watchCalls("POST").map((r) => r.body)).toEqual([
      { url: OJ, label: "Label default", enabled: true },
      { url: LI, label: "Label w_2", enabled: false },
    ]);
    expect(api.watches).toHaveLength(2);
    expect(storedWatches()).toEqual(api.watches.map(stored));
    expect(status).toMatchObject({ mode: "account", offline: false, localOnly: 0 });
  });

  it("does not upload a watch whose URL the account already has: it becomes that watch", async () => {
    const onWeb = api.addWatch({ url: OJ, label: "Named on the web", enabled: false });
    await storeWatches([local("w_1", OJ), local("w_2", UP, { siteId: "upwork" })]);

    await sync.syncWatches();

    expect(api.watchCalls("POST").map((r) => r.body.url)).toEqual([UP]);
    expect(api.watches).toHaveLength(2);
    // The account's version wins.
    expect(storedWatches()[0]).toEqual(stored(onWeb));
    expect(storedWatches().map((w) => w.url)).toEqual([OJ, UP]);
  });

  it("uploads two local watches with the same URL once", async () => {
    await storeWatches([local("w_1", OJ), local("w_2", OJ)]);
    await sync.syncWatches();
    expect(api.watchCalls("POST")).toHaveLength(1);
    expect(storedWatches()).toHaveLength(1);
  });

  it("keeps the run state of a watch under its new id, so it does not start over", async () => {
    await storeWatches([local("w_1", OJ)]);
    await env.chrome.storage.local.set({
      seenIds: { w_1: ["job-1", "job-2"] },
      lastChecked: { w_1: 1700000000000 },
      lastResult: { w_1: { count: 2, newCount: 0, error: null } },
      consecutiveErrors: { w_1: 0 },
      feed: [{ id: "w_1:job-1", watchId: "w_1", title: "A job" }],
    });

    await sync.syncWatches();

    const id = api.watches[0].id;
    const run = env.chrome.storage.local.dump();
    expect(run.seenIds).toEqual({ [id]: ["job-1", "job-2"] });
    expect(run.lastChecked).toEqual({ [id]: 1700000000000 });
    expect(run.lastResult).toEqual({ [id]: { count: 2, newCount: 0, error: null } });
    expect(run.consecutiveErrors).toEqual({ [id]: 0 });
    expect(run.feed).toEqual([{ id: "w_1:job-1", watchId: id, title: "A job" }]);
  });

  it("uploads the default watch of a browser that never stored a list", async () => {
    sync.configureWatchSync({ unsyncedFallback: () => [local("default", OJ, { label: "All OnlineJobs.ph postings" })] });

    await sync.syncWatches();

    expect(api.watchCalls("POST").map((r) => r.body)).toEqual([
      { url: OJ, label: "All OnlineJobs.ph postings", enabled: true },
    ]);
    expect(storedWatches()).toEqual(api.watches.map(stored));

    // Deleted on the web afterwards: it is not brought back.
    api.watches.length = 0;
    await sync.syncWatches();
    expect(storedWatches()).toEqual([]);
    expect(api.watchCalls("POST")).toHaveLength(1);
  });

  it("uploads nothing on the next sync", async () => {
    await storeWatches([local("w_1", OJ)]);
    await sync.syncWatches();
    await sync.syncWatches();
    expect(api.watchCalls("POST")).toHaveLength(1);
  });

  it("keeps a watch WatchDesk refuses in this browser, and does not offer it again", async () => {
    const odd = { id: "w_odd", siteId: null, url: "https://example.com/jobs", label: "Odd", enabled: true };
    await storeWatches([odd, local("w_1", OJ)]);

    const status = await sync.syncWatches();
    expect(storedWatches()).toEqual([stored(api.watches[0]), odd]);
    expect(status).toMatchObject({ offline: false, localOnly: 1 });

    await sync.syncWatches();
    expect(api.watchCalls("POST")).toHaveLength(2);
    expect(storedWatches()).toEqual([stored(api.watches[0]), odd]);
  });

  it("keeps what it could not upload and finishes on the next sync", async () => {
    await storeWatches([local("w_1", OJ), local("w_2", LI), local("w_3", UP)]);
    let posts = 0;
    api.setWatchRoute((request) => {
      if (request.method !== "POST") return undefined;
      posts += 1;
      return posts === 2 ? api.networkError() : undefined;
    });

    const status = await sync.syncWatches();
    // The second upload failed, so the third was not tried.
    expect(posts).toBe(2);
    expect(storedWatches().map((w) => w.id)).toEqual([api.watches[0].id, "w_2", "w_3"]);
    expect(status).toMatchObject({ localOnly: 2 });

    api.setWatchRoute(() => undefined);
    expect(await sync.syncWatches()).toMatchObject({ offline: false, localOnly: 0 });
    expect(storedWatches()).toEqual(api.watches.map(stored));
    expect(api.watches.map((w) => w.url)).toEqual([OJ, LI, UP]);
  });

  it("does not double a watch whose upload reached WatchDesk but whose answer was lost", async () => {
    await storeWatches([local("w_1", OJ)]);
    api.setWatchRoute((request) => {
      if (request.method !== "POST") return undefined;
      api.addWatch(request.body);
      return api.networkError();
    });
    await sync.syncWatches();
    expect(storedWatches().map((w) => w.id)).toEqual(["w_1"]);

    api.setWatchRoute(() => undefined);
    await sync.syncWatches();
    expect(api.watches).toHaveLength(1);
    expect(storedWatches()).toEqual(api.watches.map(stored));
  });

});

// WD-82: the rule that says which of the account's watches a watch of this
// browser is (watch-url.js) is the one every sync uses, not only the import
// of a browser's own data.
describe("the same search under another spelling (WD-82)", () => {
  beforeEach(connect);

  const OJ_SPELLED = "http://onlinejobs.ph/jobseekers/jobsearch/?utm_source=mail&jobkeyword=va#top";
  const UP_OTHER = "https://www.upwork.com/nx/search/jobs/?q=vue";

  it("the first sync does not upload it: it becomes the account's watch, which is not changed", async () => {
    const onWeb = api.addWatch({ url: OJ_SPELLED, label: "Named on the web", enabled: false });
    const before = structuredClone(onWeb);
    await storeWatches([local("w_1", OJ), local("w_2", UP, { siteId: "upwork" })]);

    await sync.syncWatches();

    expect(api.watchCalls("POST").map((r) => r.body.url)).toEqual([UP]);
    expect(api.watchCalls().filter((r) => r.method === "PATCH" || r.method === "DELETE")).toEqual([]);
    expect(api.watches[0]).toEqual(before);
    // The account's version wins, its spelling of the URL included.
    expect(storedWatches()[0]).toEqual(stored(onWeb));
    expect(storedWatches()).toHaveLength(2);
  });

  it("a search that differs in one value is another watch, and is uploaded", async () => {
    api.addWatch({ url: UP_OTHER });
    await storeWatches([local("w_1", UP, { siteId: "upwork" })]);

    await sync.syncWatches();

    expect(api.watchCalls("POST").map((r) => r.body.url)).toEqual([UP]);
    expect(api.watches.map((w) => w.url)).toEqual([UP_OTHER, UP]);
  });

  it("two local watches that are the same search are uploaded once", async () => {
    await storeWatches([local("w_1", OJ), local("w_2", OJ_SPELLED)]);
    await sync.syncWatches();
    expect(api.watchCalls("POST").map((r) => r.body.url)).toEqual([OJ]);
    expect(storedWatches()).toEqual(api.watches.map(stored));
  });

  it("takes the account's watch spelled the same when there is one, else the oldest, and the same one every time", async () => {
    const older = api.addWatch({ url: OJ_SPELLED, label: "Older" });
    const exact = api.addWatch({ url: OJ, label: "Exact" });
    api.addWatch({ url: `${UP}#a`, label: "Older Upwork" });
    api.addWatch({ url: `${UP}&utm_source=x`, label: "Newer Upwork" });
    await storeWatches([local("w_1", OJ), local("w_2", UP, { siteId: "upwork" })]);
    await env.chrome.storage.local.set({ seenIds: { w_1: ["a"], w_2: ["b"] } });

    await sync.syncWatches();

    expect(api.watchCalls("POST")).toEqual([]);
    expect(env.chrome.storage.local.dump().seenIds).toEqual({ [exact.id]: ["a"], [api.watches[2].id]: ["b"] });
    // Nothing of the account's is merged or removed: all four are still
    // there, and are this browser's list.
    expect(storedWatches()).toEqual(api.watches.map(stored));
    expect(api.watches).toHaveLength(4);
    expect(older.label).toBe("Older");

    await sync.syncWatches();
    expect(api.watchCalls().every((r) => r.method === "GET")).toBe(true);
    expect(storedWatches()).toEqual(api.watches.map(stored));
  });

  it("never merges two watches the account itself holds, however alike", async () => {
    api.addWatch({ url: OJ });
    api.addWatch({ url: OJ });
    api.addWatch({ url: OJ_SPELLED });

    await sync.syncWatches();
    await sync.syncWatches();

    expect(api.watches).toHaveLength(3);
    expect(storedWatches()).toEqual(api.watches.map(stored));
    expect(api.watchCalls().every((r) => r.method === "GET")).toBe(true);
  });

  it("a watch that becomes one this browser already checks adds what it had seen to it", async () => {
    const onWeb = api.addWatch({ url: OJ });
    await sync.syncWatches();
    await env.chrome.storage.local.set({
      seenIds: { [onWeb.id]: ["job-1", "job-2"], w_own: ["job-2", "job-3"] },
      lastChecked: { [onWeb.id]: 1700000000000, w_own: 1600000000000 },
      feed: [{ id: "w_own:job-3", watchId: "w_own", title: "A job" }],
    });

    // A backup file brings the same search back under a local id.
    expect(await sync.importAccountWatches([stored(onWeb), local("w_own", OJ_SPELLED)])).toEqual({ ok: true });

    expect(api.watchCalls("POST")).toEqual([]);
    const run = env.chrome.storage.local.dump();
    expect(run.seenIds).toEqual({ [onWeb.id]: ["job-1", "job-2", "job-3"] });
    // The rest of the run state is the watch's that was already checked.
    expect(run.lastChecked).toEqual({ [onWeb.id]: 1700000000000 });
    expect(run.feed).toEqual([{ id: "w_own:job-3", watchId: onWeb.id, title: "A job" }]);
  });

  it("a backup file's watch is matched the same way", async () => {
    const onWeb = api.addWatch({ url: OJ_SPELLED, label: "On the web" });
    await sync.syncWatches();

    expect(await sync.importAccountWatches([local("w_1", OJ), local("w_2", UP, { siteId: "upwork" })])).toEqual({ ok: true });

    expect(api.watchCalls("POST").map((r) => r.body.url)).toEqual([UP]);
    expect(storedWatches().map((w) => w.id)).toEqual([onWeb.id, api.watches[1].id]);
  });

  it("a watch added by hand while connected is not matched: adding is the user's own doing", async () => {
    api.addWatch({ url: OJ });
    await sync.syncWatches();

    expect(await sync.addAccountWatch({ url: OJ_SPELLED, label: "Again" })).toEqual({ ok: true });

    expect(api.watches).toHaveLength(2);
    expect(storedWatches()).toEqual(api.watches.map(stored));
  });
});

describe("importing a backup's watches into the account (WD-54, WD-111)", () => {
  beforeEach(connect);

  it("treats every imported watch as this browser's own: a server id deleted on the web is uploaded again", async () => {
    const onWeb = api.addWatch({ url: OJ });
    await sync.syncWatches();
    api.watches.length = 0;

    expect(await sync.importAccountWatches([local(onWeb.id, OJ), local("w_9", LI)])).toEqual({ ok: true });

    expect(api.watches.map((w) => w.url)).toEqual([OJ, LI]);
    expect(storedWatches()).toEqual(api.watches.map(stored));
  });

  it("uploads what the account lacks, matches the rest by URL, and keeps the account's other watches", async () => {
    const mine = api.addWatch({ url: OJ, label: "On WatchDesk" });
    const other = api.addWatch({ url: UP, label: "Also on WatchDesk" });
    await sync.syncWatches();

    expect(await sync.importAccountWatches([local("w_1", OJ), local("w_2", LI, { enabled: false })])).toEqual({ ok: true });

    expect(api.watchCalls("POST").map((r) => r.body)).toEqual([{ url: LI, label: "Label w_2", enabled: false }]);
    expect(storedWatches().map((w) => [w.id, w.url, w.label])).toEqual([
      [mine.id, OJ, "On WatchDesk"],
      [other.id, UP, "Also on WatchDesk"],
      [api.watches[2].id, LI, "Label w_2"],
    ]);
    expect(syncState()).toMatchObject({ serverIds: api.watches.map((w) => w.id), rejectedIds: [], offline: false });
  });

  it("drops a watch that was only in this browser and is not in the file, as an import always has", async () => {
    await storeWatches([local("w_1", "https://example.com/jobs")]);
    await sync.syncWatches();
    expect(storedWatches().map((w) => w.id)).toEqual(["w_1"]);

    await sync.importAccountWatches([local("w_2", LI)]);

    expect(storedWatches()).toEqual(api.watches.map(stored));
    expect(syncState().rejectedIds).toEqual([]);
  });

  it("imports nothing while WatchDesk cannot be reached: the copy and what is known of the account stay", async () => {
    api.addWatch({ url: OJ, label: "Synced earlier" });
    await sync.syncWatches();
    const before = { watches: storedWatches(), state: syncState() };
    api.setWatchRoute(api.networkError);
    env.chrome.storage.sync.set.mockClear();

    expect(await sync.importAccountWatches([local("w_9", LI)])).toEqual({ ok: false, error: `Nothing was imported. ${OFFLINE}` });

    expect(storedWatches()).toEqual(before.watches);
    expect(env.chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(syncState()).toEqual({ ...before.state, offline: true });
    expect(api.watchCalls("POST")).toHaveLength(0);
    expect(await sync.getWatchSyncStatus()).toMatchObject({ offline: true, localOnly: 0 });

    // And the next sync finds the account as it was: nothing to upload.
    api.setWatchRoute(() => undefined);
    await sync.syncWatches();
    expect(api.watches).toHaveLength(1);
    expect(storedWatches()).toEqual(before.watches);
  });

  it.each([
    [429, { error: "Too many requests." }, "Nothing was imported. WatchDesk is busy. Try again in a moment."],
    [500, { error: "Something went wrong." }, "Nothing was imported. WatchDesk couldn't do that just now. Try again."],
  ])("imports nothing when WatchDesk answers the list with %i", async (status, body, error) => {
    await storeWatches([local("w_1", OJ)]);
    await sync.syncWatches();
    const before = storedWatches();
    api.setWatchRoute(() => api.json(status, body));

    expect(await sync.importAccountWatches([local("w_9", LI)])).toEqual({ ok: false, error });
    expect(storedWatches()).toEqual(before);
  });

  it("on a 401, imports nothing and the token is gone", async () => {
    await storeWatches([local("w_1", OJ)]);
    await sync.syncWatches();
    const before = storedWatches();
    api.setWatchRoute(() => api.json(401, { error: "Sign in to continue." }));

    expect(await sync.importAccountWatches([local("w_9", LI)])).toEqual({
      ok: false,
      error: "Nothing was imported. This browser was disconnected from your WatchDesk account, so nothing was changed.",
    });
    expect(storedWatches()).toEqual(before);
    expect(env.chrome.storage.local.dump()[TOKEN_KEY]).toBeUndefined();
  });

  it("a watch WatchDesk refuses stays in this browser and is counted as only here", async () => {
    await sync.syncWatches();

    expect(await sync.importAccountWatches([local("w_1", "https://example.com/jobs"), local("w_2", LI)])).toEqual({ ok: true });

    expect(storedWatches().map((w) => w.id)).toEqual([api.watches[0].id, "w_1"]);
    expect(await sync.getWatchSyncStatus()).toMatchObject({ offline: false, localOnly: 1 });
  });

  it("waits its turn behind a sync that is running", async () => {
    api.addWatch({ url: OJ });
    const syncing = sync.syncWatches();
    const importing = sync.importAccountWatches([local("w_9", LI)]);
    await Promise.all([syncing, importing]);

    expect(api.watches.map((w) => w.url)).toEqual([OJ, LI]);
    expect(storedWatches()).toEqual(api.watches.map(stored));
  });

  it("with no account connected, sends nothing and changes nothing", async () => {
    await env.chrome.storage.local.remove(TOKEN_KEY);
    await storeWatches([local("w_1", OJ)]);

    expect((await sync.importAccountWatches([local("w_9", LI)])).ok).toBe(false);
    expect(api.fetch).not.toHaveBeenCalled();
    expect(storedWatches()).toEqual([local("w_1", OJ)]);
  });
});

describe("while WatchDesk cannot be reached", () => {
  beforeEach(async () => {
    await connect();
    api.addWatch({ url: OJ, label: "Synced earlier" });
    await sync.syncWatches();
    vi.setSystemTime(Date.now() + 600000);
  });

  it("keeps the last-synced list and says offline, with when it last synced", async () => {
    const lastSyncedAt = Date.now() - 600000;
    api.setWatchRoute(api.networkError);

    const status = await sync.syncWatches();

    expect(status).toEqual({ mode: "account", offline: true, lastSyncedAt, localOnly: 0 });
    expect(storedWatches()).toEqual(api.watches.map(stored));
    // One attempt: the next check or popup open is the retry.
    expect(api.watchCalls("GET")).toHaveLength(2);
  });

  it.each([500, 503, 429, 404])("treats a %i as not synced, and keeps the list", async (code) => {
    api.setWatchRoute(() => api.json(code, { error: "no" }, { "Retry-After": "1" }));
    expect(await sync.syncWatches()).toMatchObject({ offline: true });
    expect(storedWatches()).toHaveLength(1);
    expect(api.watchCalls("GET")).toHaveLength(2);
  });

  it("does not empty the list on an answer that is not a list of watches", async () => {
    api.setWatchRoute(() => api.json(200, { watches: [{ id: 7 }] }));
    expect(await sync.syncWatches()).toMatchObject({ offline: true });
    api.setWatchRoute(() => api.json(200, {}));
    expect(await sync.syncWatches()).toMatchObject({ offline: true });
    expect(storedWatches()).toHaveLength(1);
  });

  it("gives up on a WatchDesk that never answers after 10 seconds", async () => {
    api.setWatchRoute(api.hang);
    let status = null;
    const pending = sync.syncWatches().then((s) => {
      status = s;
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(status).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(status).toMatchObject({ offline: true });
  });

  it("is back in step, and no longer offline, on the next sync that gets through", async () => {
    api.setWatchRoute(api.networkError);
    await sync.syncWatches();
    api.setWatchRoute(() => undefined);
    api.addWatch({ url: LI });

    expect(await sync.syncWatches()).toMatchObject({ offline: false, lastSyncedAt: Date.now() });
    expect(storedWatches()).toHaveLength(2);
  });

  it.each([
    ["add", () => sync.addAccountWatch({ url: LI, label: "New" })],
    ["rename", () => sync.updateAccountWatch(api.watches[0].id, { label: "Renamed" })],
    ["pause", () => sync.updateAccountWatch(api.watches[0].id, { enabled: false })],
    ["remove", () => sync.removeAccountWatch(api.watches[0].id)],
    ["pause all", () => sync.setAccountWatchesEnabled(false)],
  ])("refuses to %s with a clear message, and changes nothing", async (_name, act) => {
    api.setWatchRoute(api.networkError);

    expect(await act()).toEqual({ ok: false, error: OFFLINE });
    expect(storedWatches()).toEqual(api.watches.map(stored));
    expect(api.watches).toHaveLength(1);
    expect(await sync.getWatchSyncStatus()).toMatchObject({ offline: true });
  });

  it("does not queue a refused change: nothing is sent when WatchDesk is back", async () => {
    api.setWatchRoute(api.networkError);
    await sync.addAccountWatch({ url: LI });
    api.setWatchRoute(() => undefined);
    await sync.syncWatches();
    expect(api.watches).toHaveLength(1);
    expect(storedWatches()).toHaveLength(1);
  });
});

describe("changes while connected", () => {
  let first;
  let second;
  let third;
  beforeEach(async () => {
    await connect();
    first = api.addWatch({ url: OJ, label: "One" });
    second = api.addWatch({ url: LI, label: "Two" });
    third = api.addWatch({ url: UP, label: "Three", enabled: false });
    await sync.syncWatches();
  });

  it("add: POST /api/watches with the token, then the watch is in the list", async () => {
    const url = "https://www.glassdoor.com/Job/manila-jobs.htm";
    expect(await sync.addAccountWatch({ url, label: "Manila" })).toEqual({ ok: true });

    const [post] = api.watchCalls("POST");
    expect(post).toMatchObject({ path: "/api/watches", body: { url, label: "Manila" } });
    expect(post.headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` });
    expect(storedWatches()).toEqual(api.watches.map(stored));
    expect(storedWatches()[3]).toMatchObject({ siteId: "glassdoor", label: "Manila", enabled: true });
  });

  it("add without a label leaves the label to WatchDesk", async () => {
    await sync.addAccountWatch({ url: "https://www.glassdoor.com/Job/x.htm", label: "" });
    expect(api.watchCalls("POST")[0].body).toEqual({ url: "https://www.glassdoor.com/Job/x.htm" });
    expect(storedWatches()[3].label).toBe("Glassdoor");
  });

  it("add: an unsupported URL is refused with WatchDesk's message and not saved", async () => {
    expect(await sync.addAccountWatch({ url: "https://example.com/jobs", label: "" })).toEqual({
      ok: false,
      error: "Enter a search URL on OnlineJobs.ph, Glassdoor, LinkedIn or Upwork",
    });
    expect(storedWatches()).toHaveLength(3);
    expect(await sync.getWatchSyncStatus()).toMatchObject({ offline: false });
  });

  it("add: an unverified email is refused", async () => {
    api.setWatchRoute((r) => (r.method === "POST" ? api.json(403, { error: "Verify your email address to do this." }) : undefined));
    expect(await sync.addAccountWatch({ url: OJ })).toEqual({
      ok: false,
      error: "Verify your email address on WatchDesk to add watches.",
    });
  });

  it.each([
    ["42", "WatchDesk is busy. Try again in 42 s."],
    ["90", "WatchDesk is busy. Try again in 2 min."],
    [null, "WatchDesk is busy. Try again in a moment."],
  ])("a rate limit (Retry-After %s) is reported, not retried", async (retryAfter, error) => {
    api.setWatchRoute((r) =>
      r.method === "POST" ? api.json(429, { error: "Too many." }, retryAfter ? { "Retry-After": retryAfter } : {}) : undefined,
    );
    expect(await sync.addAccountWatch({ url: OJ })).toEqual({ ok: false, error });
    expect(api.watchCalls("POST")).toHaveLength(1);
  });

  it("a 5xx is reported, not retried, and changes nothing", async () => {
    api.setWatchRoute((r) => (r.method === "DELETE" ? api.json(500, { error: "boom" }) : undefined));
    expect(await sync.removeAccountWatch(first.id)).toEqual({
      ok: false,
      error: "WatchDesk couldn't do that just now. Try again.",
    });
    expect(api.watchCalls("DELETE")).toHaveLength(1);
    expect(storedWatches()).toHaveLength(3);
  });

  it("rename: PATCH /api/watches/[id] with the label", async () => {
    expect(await sync.updateAccountWatch(second.id, { label: "Renamed" })).toEqual({ ok: true });
    const [patch] = api.watchCalls("PATCH");
    expect(patch).toMatchObject({ path: `/api/watches/${second.id}`, body: { label: "Renamed" } });
    expect(storedWatches()[1]).toMatchObject({ id: second.id, label: "Renamed", enabled: true });
  });

  it("pause and resume: PATCH with enabled", async () => {
    await sync.updateAccountWatch(first.id, { enabled: false });
    await sync.updateAccountWatch(third.id, { enabled: true });
    expect(api.watchCalls("PATCH").map((r) => r.body)).toEqual([{ enabled: false }, { enabled: true }]);
    expect(storedWatches().map((w) => w.enabled)).toEqual([false, true, true]);
    expect(api.watches.map((w) => w.enabled)).toEqual([false, true, true]);
  });

  it("a rejected rename is reported with WatchDesk's message", async () => {
    api.setWatchRoute((r) =>
      r.method === "PATCH" ? api.json(400, { error: "Check the fields.", fieldErrors: { label: ["Keep it under 100 characters"] } }) : undefined,
    );
    expect(await sync.updateAccountWatch(first.id, { label: "x".repeat(101) })).toEqual({
      ok: false,
      error: "Keep it under 100 characters",
    });
    expect(storedWatches()[0].label).toBe("One");
  });

  it("changing a watch deleted on the web says so and drops it from the list", async () => {
    api.watches.splice(0, 1);
    expect(await sync.updateAccountWatch(first.id, { enabled: false })).toEqual({
      ok: false,
      error: "That watch was already deleted on WatchDesk.",
    });
    expect(storedWatches().map((w) => w.id)).toEqual([second.id, third.id]);
  });

  it("an unknown id is not sent anywhere", async () => {
    expect(await sync.updateAccountWatch("nope", { enabled: false })).toEqual({ ok: false, error: "Watch not found." });
    expect(api.watchCalls("PATCH")).toHaveLength(0);
  });

  it("remove: DELETE /api/watches/[id], then it is gone from the list", async () => {
    expect(await sync.removeAccountWatch(second.id)).toEqual({ ok: true });
    expect(api.watchCalls("DELETE").map((r) => r.path)).toEqual([`/api/watches/${second.id}`]);
    expect(storedWatches().map((w) => w.id)).toEqual([first.id, third.id]);
    expect(api.watches.map((w) => w.id)).toEqual([first.id, third.id]);
  });

  it("removing a watch already deleted on the web just removes it here", async () => {
    api.watches.splice(1, 1);
    expect(await sync.removeAccountWatch(second.id)).toEqual({ ok: true });
    expect(storedWatches().map((w) => w.id)).toEqual([first.id, third.id]);
  });

  it("Pause All: one PATCH per watch that is not already paused", async () => {
    expect(await sync.setAccountWatchesEnabled(false)).toEqual({ ok: true });
    expect(api.watchCalls("PATCH").map((r) => r.path)).toEqual([`/api/watches/${first.id}`, `/api/watches/${second.id}`]);
    expect(storedWatches().map((w) => w.enabled)).toEqual([false, false, false]);
  });

  it("Resume for one site touches only that site's paused watches", async () => {
    expect(await sync.setAccountWatchesEnabled(true, "upwork")).toEqual({ ok: true });
    expect(api.watchCalls("PATCH").map((r) => r.path)).toEqual([`/api/watches/${third.id}`]);
    expect(storedWatches().map((w) => w.enabled)).toEqual([true, true, true]);
  });

  it("Pause All that is cut off keeps what went through and says how many did not", async () => {
    let patches = 0;
    api.setWatchRoute((request) => {
      if (request.method !== "PATCH") return undefined;
      patches += 1;
      return patches === 2 ? api.networkError() : undefined;
    });
    expect(await sync.setAccountWatchesEnabled(false)).toEqual({ ok: false, error: `1 not paused. ${OFFLINE}` });
    expect(storedWatches().map((w) => w.enabled)).toEqual([false, true, false]);
    expect(await sync.getWatchSyncStatus()).toMatchObject({ offline: true });
  });

  it("a watch that is only in this browser is changed and removed here, without a call", async () => {
    const odd = { id: "w_odd", siteId: null, url: "https://example.com/jobs", label: "Odd", enabled: true };
    await storeWatches([...storedWatches(), odd]);
    await sync.syncWatches();
    const calls = api.watchCalls().length;

    expect(await sync.updateAccountWatch("w_odd", { enabled: false })).toEqual({ ok: true });
    expect(storedWatches()[3]).toEqual({ ...odd, enabled: false });
    expect(await sync.removeAccountWatch("w_odd")).toEqual({ ok: true });
    expect(storedWatches()).toHaveLength(3);
    expect(api.watchCalls()).toHaveLength(calls);
  });
});

describe("a change before this connection has synced", () => {
  beforeEach(connect);

  it("syncs first, so local watches are uploaded before the change is made", async () => {
    await storeWatches([local("w_1", OJ)]);
    expect(await sync.addAccountWatch({ url: LI, label: "New" })).toEqual({ ok: true });
    expect(api.watches.map((w) => w.url)).toEqual([OJ, LI]);
    expect(storedWatches()).toEqual(api.watches.map(stored));
  });

  it("is refused when that sync cannot reach WatchDesk", async () => {
    await storeWatches([local("w_1", OJ)]);
    api.setWatchRoute(api.networkError);
    expect(await sync.removeAccountWatch("w_1")).toEqual({ ok: false, error: OFFLINE });
    expect(storedWatches()).toEqual([local("w_1", OJ)]);
    expect(await sync.getWatchSyncStatus()).toEqual({ mode: "account", offline: true, lastSyncedAt: null, localOnly: 0 });
  });
});

describe("losing the connection", () => {
  beforeEach(async () => {
    await connect();
    api.addWatch({ url: OJ });
    await sync.syncWatches();
  });

  it("a 401 on a sync discards the token; the list stays as this browser's own", async () => {
    api.setWatchRoute(() => api.json(401, { error: "Sign in to continue." }));

    expect(await sync.syncWatches()).toEqual({ mode: "local" });
    expect(env.chrome.storage.local.dump()[TOKEN_KEY]).toBeUndefined();
    expect(syncState()).toBeUndefined();
    expect(storedWatches()).toHaveLength(1);
  });

  it("a 401 on a change reports it and changes nothing", async () => {
    api.setWatchRoute(() => api.json(401, { error: "Sign in to continue." }));
    expect(await sync.addAccountWatch({ url: LI })).toEqual({
      ok: false,
      error: "This browser was disconnected from your WatchDesk account, so nothing was changed.",
    });
    expect(storedWatches()).toHaveLength(1);
    expect(syncState()).toBeUndefined();
  });
});

describe("secrets", () => {
  it("never logs, and never puts the token in a result, a status or chrome.storage.sync", async () => {
    const spies = ["log", "info", "warn", "error", "debug"].map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    await connect();
    await storeWatches([local("w_1", OJ)]);

    const seen = [await sync.syncWatches()];
    seen.push(await sync.addAccountWatch({ url: LI }));
    seen.push(await sync.updateAccountWatch(api.watches[0].id, { label: "x" }));
    api.setWatchRoute(api.networkError);
    seen.push(await sync.syncWatches(), await sync.removeAccountWatch(api.watches[0].id));
    api.setWatchRoute(() => api.json(401, { error: `no ${TEST_TOKEN}` }));
    seen.push(await sync.syncWatches(), await sync.getWatchSyncStatus());

    expect(JSON.stringify(seen)).not.toContain(TEST_TOKEN);
    expect(JSON.stringify(env.chrome.storage.sync.dump())).not.toContain(TEST_TOKEN);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
