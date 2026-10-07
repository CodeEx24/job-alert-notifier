// WD-81: what the import of a browser's own data needed from the modules
// around it, each on its own against a mocked chrome.* and the fake
// WatchDesk: the hold on a freshly paired browser (account-connection.js and
// every module that picks its mode by it), the one way the import record is
// changed, the watch upload and the "set aside" of a declined import
// (watch-sync.js), the settings save bound to a connection
// (account-settings.js), and the two API calls that are new or newly bound
// (watchdesk-api.js).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { installFakeWatchDesk, TEST_TOKEN } from "./helpers/fake-watchdesk.js";

const OJ = "https://www.onlinejobs.ph/jobseekers/jobsearch?jobkeyword=va";
const UP = "https://www.upwork.com/nx/search/jobs/?q=react";
const GD = "https://www.glassdoor.com/Job/remote-react-jobs-SRCH_IL.0,6_IS11047_KO7,12.htm";
const OTHER_TOKEN = "wd_another.token-of-another-account";

let env;
let api;
let connection;
let watchSync;
let settings;
let ingest;
let watcher;
let wd;

const local = () => env.chrome.storage.local.dump();
const storedWatches = () => env.chrome.storage.sync.dump().watches;
const own = (id, url, extra = {}) => ({ id, siteId: "onlinejobsph", url, label: `Label ${id}`, enabled: true, ...extra });
const connect = (record) =>
  env.chrome.storage.local.set({
    [connection.TOKEN_KEY]: TEST_TOKEN,
    [connection.ACCOUNT_KEY]: { email: "ada@example.com" },
    ...(record ? { [connection.IMPORT_KEY]: record } : {}),
  });
const advance = (ms) => vi.advanceTimersByTimeAsync(ms);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-05T09:00:00Z"));
  env = installChromeMock();
  api = installFakeWatchDesk();
  vi.resetModules();
  connection = await import("../account-connection.js");
  wd = await import("../watchdesk-api.js");
  watchSync = await import("../watch-sync.js");
  settings = await import("../account-settings.js");
  ingest = await import("../listing-ingest.js");
  watcher = await import("../watcher-state.js");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the hold on a freshly paired browser (isAccountActive)", () => {
  it.each([
    ["no token", null, null, false],
    ["a token and no record (connected before WD-81, or nothing to ask)", TEST_TOKEN, null, true],
    ["just paired", TEST_TOKEN, { phase: "connecting" }, false],
    ["the question is open", TEST_TOKEN, { phase: "offered", owner: "ada@example.com" }, false],
    ["the user said yes", TEST_TOKEN, { phase: "importing", owner: "ada@example.com" }, true],
    ["the import ended", TEST_TOKEN, { phase: "done", owner: "ada@example.com" }, true],
    ["the user said no", TEST_TOKEN, { phase: "declined", owner: "ada@example.com" }, true],
    ["asked again from Settings", TEST_TOKEN, { phase: "offered-again", owner: "ada@example.com" }, true],
    ["a record left by a token that is gone", null, { phase: "importing", owner: "ada@example.com" }, false],
  ])("%s", async (_name, token, record, active) => {
    await env.chrome.storage.local.set({
      ...(token ? { [connection.TOKEN_KEY]: token } : {}),
      ...(record ? { [connection.IMPORT_KEY]: record } : {}),
    });
    expect(await connection.isAccountActive()).toBe(active);
  });

  it("only a No keeps this browser's own watches out of the account", async () => {
    for (const [phase, kept] of [
      [null, false],
      ["connecting", false],
      ["offered", false],
      ["importing", false],
      ["done", false],
      ["declined", true],
      ["offered-again", true],
    ]) {
      if (phase) await env.chrome.storage.local.set({ [connection.IMPORT_KEY]: { phase } });
      expect(await connection.keepsOwnWatchesLocal(), String(phase)).toBe(kept);
    }
  });

  it("while it holds, every module is in its unconnected mode and sends nothing", async () => {
    await connect({ phase: "offered", owner: "ada@example.com" });
    await env.chrome.storage.sync.set({ watches: [own("w_1", OJ)], intervalMinutes: 30 });
    await env.chrome.storage.local.set({ watcherState: "paused" });

    expect(await watchSync.usesAccountWatches()).toBe(false);
    expect(await watchSync.hasSyncedAccountWatches()).toBe(false);
    expect(await watchSync.syncWatches()).toEqual({ mode: "local" });
    expect(await watchSync.getServerWatchIds()).toEqual([]);
    expect(await settings.usesAccountSettings()).toBe(false);
    expect(await settings.syncAccountSettings()).toEqual({ mode: "local" });
    expect(
      await ingest.ingestCheckedListings([{ watchId: "w_1", jobs: [{ id: "1", title: "A", url: "https://a.example/1" }] }]),
    ).toEqual({ status: "not-connected", sent: 0, unsent: 0 });
    expect(await watcher.reflectWatcherState()).toBe(false);

    expect(api.fetch).not.toHaveBeenCalled();
    expect(storedWatches()).toEqual([own("w_1", OJ)]);
    expect(env.chrome.storage.sync.dump().intervalMinutes).toBe(30);
    expect(local().watchdeskListingQueue).toBeUndefined();
    expect(local()[connection.WATCH_SYNC_KEY]).toBeUndefined();
  });
});

describe("a pairing that completes", () => {
  const pair = async () => {
    await connection.startConnecting();
    api.queuePoll(api.approved);
    await advance(3000);
  };

  it("puts the browser on hold in the write that stores the token", async () => {
    await pair();
    expect(local()[connection.TOKEN_KEY]).toBe(TEST_TOKEN);
    expect(local()[connection.IMPORT_KEY]).toEqual({ phase: "connecting" });
    expect(await connection.isAccountActive()).toBe(false);
  });

  it("carries an import that was under way along, to be taken up only by the same account", async () => {
    const importing = { phase: "importing", owner: "ada@example.com", startedAt: 1, step: "listings", sent: ["a"] };
    await env.chrome.storage.local.set({ [connection.IMPORT_KEY]: importing });
    await pair();
    expect(local()[connection.IMPORT_KEY]).toEqual({ phase: "connecting", interrupted: importing });

    // A second pairing before the first was settled keeps it too.
    await env.chrome.storage.local.remove(connection.TOKEN_KEY);
    await pair();
    expect(local()[connection.IMPORT_KEY]).toEqual({ phase: "connecting", interrupted: importing });
  });

  it("replaces an answer given for the last connection: the next account is settled afresh", async () => {
    await env.chrome.storage.local.set({ [connection.IMPORT_KEY]: { phase: "declined", owner: "ada@example.com" } });
    await pair();
    expect(local()[connection.IMPORT_KEY]).toEqual({ phase: "connecting" });
  });
});

describe("changeImportRecord", () => {
  it("stores what the change returns, removes on null, and leaves it on undefined", async () => {
    expect(await connection.changeImportRecord(() => ({ phase: "offered", owner: "a" }))).toEqual({ phase: "offered", owner: "a" });
    expect(local()[connection.IMPORT_KEY]).toEqual({ phase: "offered", owner: "a" });

    env.chrome.storage.local.set.mockClear();
    expect(await connection.changeImportRecord(() => undefined)).toEqual({ phase: "offered", owner: "a" });
    expect(env.chrome.storage.local.set).not.toHaveBeenCalled();

    expect(await connection.changeImportRecord((record) => (record.phase === "offered" ? null : undefined))).toBeNull();
    expect(local()[connection.IMPORT_KEY]).toBeUndefined();
    expect(await connection.changeImportRecord((record) => record ?? undefined)).toBeNull();
  });

  it("runs one change at a time, each on the result of the one before", async () => {
    await connection.changeImportRecord(() => ({ phase: "importing", n: 0 }));
    await Promise.all(
      Array.from({ length: 5 }, () => connection.changeImportRecord(async (record) => ({ ...record, n: record.n + 1 }))),
    );
    expect(local()[connection.IMPORT_KEY]).toEqual({ phase: "importing", n: 5 });
  });
});

describe("uploadOwnWatches (the import's first step)", () => {
  it("uploads this browser's watches on the given connection and says what it did", async () => {
    await connect({ phase: "importing", owner: "ada@example.com" });
    const twin = api.addWatch({ url: OJ, label: "Theirs" });
    await env.chrome.storage.sync.set({
      watches: [own("w_1", OJ), own("w_2", UP), own("w_3", "https://jobs.example.org/x")],
    });
    const bound = await connection.captureConnection();

    expect(await watchSync.uploadOwnWatches([], bound)).toEqual({
      ok: true,
      created: 1,
      matched: 1,
      rejected: 1,
      waiting: 0,
      stoppedBy: null,
    });
    expect(storedWatches().map((w) => w.id)).toEqual([twin.id, api.watches[1].id, "w_3"]);

    // Again: nothing is made twice, and nothing is counted twice.
    expect(await watchSync.uploadOwnWatches([], bound)).toMatchObject({ ok: true, created: 0, matched: 0, rejected: 1 });
    expect(api.watchCalls("POST").filter((r) => r.body.url === UP)).toHaveLength(1);
  });

  it("adds the watches that were set aside to the list, without doubling one already there", async () => {
    await connect({ phase: "importing", owner: "ada@example.com" });
    const theirs = api.addWatch({ url: GD, label: "On the web" });
    await env.chrome.storage.sync.set({ watches: [{ id: theirs.id, siteId: "glassdoor", url: GD, label: "On the web", enabled: true }] });
    await env.chrome.storage.local.set({ [connection.WATCH_SYNC_KEY]: { serverIds: [theirs.id], rejectedIds: [], lastSyncedAt: 1, offline: false } });
    const bound = await connection.captureConnection();

    const result = await watchSync.uploadOwnWatches([own("w_1", OJ), own("w_2", GD)], bound);

    expect(result).toMatchObject({ ok: true, created: 1, matched: 1 });
    expect(storedWatches().map((w) => w.url)).toEqual([GD, OJ]);
    expect(api.watches.map((w) => w.url)).toEqual([GD, OJ]);
  });

  it("says how many are still waiting, and what stopped it, when WatchDesk stops taking them", async () => {
    await connect({ phase: "importing", owner: "ada@example.com" });
    await env.chrome.storage.sync.set({ watches: [own("w_1", OJ), own("w_2", UP), own("w_3", GD)] });
    let posts = 0;
    api.setWatchRoute((request) => {
      if (request.method !== "POST") return undefined;
      posts += 1;
      return posts === 2 ? api.json(429, { error: "Slow down." }, { "Retry-After": "30" }) : undefined;
    });

    const result = await watchSync.uploadOwnWatches([], await connection.captureConnection());

    expect(result).toEqual({
      ok: true,
      created: 1,
      matched: 0,
      rejected: 0,
      waiting: 2,
      stoppedBy: { kind: "rate-limited", retryAfterSeconds: 30 },
    });
    // The two that did not go are still in this browser's list.
    expect(storedWatches().map((w) => w.id)).toEqual([api.watches[0].id, "w_2", "w_3"]);
  });

  it("does nothing, and says so, when WatchDesk does not give the account's list", async () => {
    await connect({ phase: "importing", owner: "ada@example.com" });
    await env.chrome.storage.sync.set({ watches: [own("w_1", OJ)] });
    api.setWatchRoute(api.networkError);

    expect(await watchSync.uploadOwnWatches([], await connection.captureConnection())).toMatchObject({
      ok: false,
      kind: "unreachable",
    });
    expect(storedWatches()).toEqual([own("w_1", OJ)]);
  });

  it("sends and writes nothing once the token is another account's", async () => {
    await connect({ phase: "importing", owner: "ada@example.com" });
    await env.chrome.storage.sync.set({ watches: [own("w_1", OJ), own("w_2", UP)] });
    const bound = await connection.captureConnection();
    // Another pairing completes while the first upload is out.
    // (The mock stores at the call; the route still answers with the watch.)
    api.setWatchRoute((request) => {
      if (request.method === "POST") env.chrome.storage.local.set({ [connection.TOKEN_KEY]: OTHER_TOKEN });
      return undefined;
    });

    const result = await watchSync.uploadOwnWatches([], bound);

    expect(result).toMatchObject({ ok: false, kind: "connection-changed" });
    // The first went out, and was taken; the second was never sent.
    expect(api.watches).toHaveLength(1);
    expect(api.watchCalls("POST")).toHaveLength(1);
    expect(api.requests.some((r) => r.headers.Authorization === `Bearer ${OTHER_TOKEN}`)).toBe(false);
    // The stored list is not replaced by the old account's.
    expect(storedWatches()).toEqual([own("w_1", OJ), own("w_2", UP)]);
    expect(local()[connection.WATCH_SYNC_KEY]).toBeUndefined();
  });
});

describe("after a No (watch-sync.js)", () => {
  it("keepOwnWatches sets the list aside as it is, once per URL, and a browser that stored none keeps its default", async () => {
    watchSync.configureWatchSync({ unsyncedFallback: () => [own("default", OJ)] });
    await watchSync.keepOwnWatches();
    expect(local()[watchSync.WATCHES_SNAPSHOT_KEY]).toEqual({ takenAt: Date.now(), watches: [own("default", OJ)] });

    await env.chrome.storage.sync.set({ watches: [own("w_1", OJ), own("w_2", UP)] });
    await watchSync.keepOwnWatches();
    expect(await watchSync.getSetAsideWatches()).toEqual([own("default", OJ), own("w_2", UP)]);
  });

  it("a sync uploads nothing: an own watch becomes the account's by URL or is set aside, and its run state is left", async () => {
    await connect({ phase: "declined", owner: "ada@example.com" });
    const theirs = api.addWatch({ url: OJ, label: "Theirs" });
    await env.chrome.storage.sync.set({ watches: [own("w_1", OJ), own("w_2", UP)] });
    await env.chrome.storage.local.set({ seenIds: { w_1: ["a"], w_2: ["b"] } });

    expect(await watchSync.syncWatches()).toMatchObject({ mode: "account", offline: false, localOnly: 0 });

    expect(api.watchCalls("POST")).toEqual([]);
    expect(storedWatches().map((w) => w.id)).toEqual([theirs.id]);
    expect(await watchSync.getSetAsideWatches()).toEqual([own("w_2", UP)]);
    // Never deleted: what the set-aside watch had seen is still there.
    expect(local().seenIds).toEqual({ [theirs.id]: ["a"], w_2: ["b"] });
  });

  it("the watch is set aside before the list loses it", async () => {
    await connect({ phase: "declined", owner: "ada@example.com" });
    await env.chrome.storage.sync.set({ watches: [own("w_1", OJ)] });
    const order = [];
    const localSet = env.chrome.storage.local.set.getMockImplementation();
    env.chrome.storage.local.set.mockImplementation(async (items) => {
      if (watchSync.WATCHES_SNAPSHOT_KEY in items) order.push("set aside");
      return localSet(items);
    });
    const syncSet = env.chrome.storage.sync.set.getMockImplementation();
    env.chrome.storage.sync.set.mockImplementation(async (items) => {
      order.push("list");
      return syncSet(items);
    });

    await watchSync.syncWatches();

    expect(order).toEqual(["set aside", "list"]);
  });

  it("Import of a backup file is unaffected: its watches are the user's to add (WD-111)", async () => {
    await connect({ phase: "declined", owner: "ada@example.com" });
    expect(await watchSync.importAccountWatches([own("w_1", OJ)])).toEqual({ ok: true });
    expect(api.watchCalls("POST")).toHaveLength(1);
  });
});

describe("importAccountSettings (the import's last step)", () => {
  it("saves on the given connection through the one read-modify-write, the account's watcher state untouched", async () => {
    await connect({ phase: "importing", owner: "ada@example.com" });
    api.setSettings({ watcherState: "paused" });
    const before = api.settings();

    expect(await settings.importAccountSettings({ soundId: "soft" }, await connection.captureConnection())).toEqual({ kind: "ok" });

    expect(api.settingsCalls().map((r) => r.method)).toEqual(["GET", "PUT"]);
    expect(api.settingsCalls("PUT")[0].body).toEqual({ ...before, soundId: "soft" });
    expect(env.chrome.storage.sync.dump().soundId).toBe("soft");
  });

  it("tells a refusal from an outage", async () => {
    await connect({ phase: "importing", owner: "ada@example.com" });
    const bound = await connection.captureConnection();

    expect(await settings.importAccountSettings({ intervalMinutes: 7 }, bound)).toEqual({
      kind: "refused",
      message: "Check interval must be 1, 5, 15 or 30 minutes",
    });
    expect(api.fetch).not.toHaveBeenCalled();

    api.setSettingsRoute(api.networkError);
    expect(await settings.importAccountSettings({ soundId: "soft" }, bound)).toMatchObject({ kind: "unreachable" });
  });

  it("sends nothing once the token is another account's", async () => {
    await connect({ phase: "importing", owner: "ada@example.com" });
    const bound = await connection.captureConnection();
    await env.chrome.storage.local.set({ [connection.TOKEN_KEY]: OTHER_TOKEN });

    expect(await settings.importAccountSettings({ soundId: "soft" }, bound)).toMatchObject({ kind: "connection-changed" });
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("saveAccountSettings answers as it always did", async () => {
    await connect();
    expect(await settings.saveAccountSettings({ soundId: "soft" })).toEqual({ ok: true });
    expect(await settings.saveAccountSettings({ intervalMinutes: 7 })).toEqual({
      ok: false,
      error: "Check interval must be 1, 5, 15 or 30 minutes",
    });
  });
});

describe("the calls the import added (watchdesk-api.js)", () => {
  it("setListingStatus PATCHes the listing with the token and answers ok", async () => {
    await connect();
    const watch = api.addWatch({ url: OJ });
    await wd.ingestListings(watch.id, [{ id: "1", title: "A", url: "https://a.example/1" }]);
    const [{ listingId }] = api.listings;

    expect(await wd.setListingStatus(listingId, "applied", await connection.captureConnection())).toEqual({ kind: "ok" });

    const [call] = api.statusCalls();
    expect(call).toMatchObject({
      method: "PATCH",
      path: `/api/listings/${listingId}`,
      body: { status: "applied" },
      credentials: "omit",
    });
    expect(call.headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(api.listings[0].status).toBe("applied");
  });

  it("names its failures like every other call, and repeats a request WatchDesk did not answer", async () => {
    await connect();
    const bound = await connection.captureConnection();
    expect(await wd.setListingStatus("listing-none", "applied", bound)).toEqual({ kind: "not-found" });
    expect(await wd.setListingStatus("listing-none", "sideways", bound)).toMatchObject({ kind: "invalid" });

    // Giving a listing the status it has changes nothing, so it is retried.
    let fails = 2;
    api.setListingRoute(() => (fails-- > 0 ? api.json(503, { error: "Unavailable" }) : api.json(200, {})));
    const before = api.statusCalls().length;
    const answer = wd.setListingStatus("listing-1", "applied", bound);
    await advance(10000);
    expect(await answer).toEqual({ kind: "ok" });
    expect(api.statusCalls()).toHaveLength(before + 3);
  });

  it("a call bound to a connection that is no longer the stored one sends nothing", async () => {
    await connect();
    const bound = await connection.captureConnection();
    await env.chrome.storage.local.set({ [connection.TOKEN_KEY]: OTHER_TOKEN });

    expect(await wd.setListingStatus("listing-1", "applied", bound)).toEqual({ kind: "connection-changed" });
    expect(await wd.listWatches(bound)).toEqual({ kind: "connection-changed" });
    expect(await wd.createWatch({ url: OJ }, bound)).toEqual({ kind: "connection-changed" });
    expect(api.fetch).not.toHaveBeenCalled();
    // Unbound, they go out as they always did.
    expect(await wd.listWatches()).toEqual({ kind: "ok", watches: [] });
  });
});
