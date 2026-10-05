// Sending a check cycle's listings to WatchDesk (listing-ingest.js), against
// a mocked chrome.* and a fake WatchDesk that keeps the account's watches and
// listings. The requests go through the real authorizedRequest(), over a
// mocked fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { installFakeWatchDesk, TEST_TOKEN } from "./helpers/fake-watchdesk.js";
import { ACCOUNT_KEY, LISTING_QUEUE_KEY, LISTING_SYNC_KEY, TOKEN_KEY } from "../account-connection.js";

const LI = "https://www.linkedin.com/jobs/search/?keywords=engineer";
const UP = "https://www.upwork.com/nx/search/jobs/?q=react";
const OJ = "https://www.onlinejobs.ph/jobseekers/jobsearch?jobkeyword=va";

// A posting as LinkedIn's adapter returns it (every field set).
const linkedInJob = (n) => ({
  id: `40${n}`,
  title: `Engineer ${n}`,
  url: `https://www.linkedin.com/jobs/view/40${n}/`,
  postedRaw: "3 days ago",
  postedAt: "2026-09-30T09:00:00.000Z",
  postedApprox: true,
  salaryRaw: "$90K/yr - $120K/yr",
  easyApply: true,
  workplaceType: "Remote",
});
// And as OnlineJobs.ph's does (no approx flag, Easy Apply or workplace).
const onlineJobsJob = (n) => ({
  id: `13${n}`,
  title: `Assistant ${n}`,
  url: `https://www.onlinejobs.ph/jobseekers/job/13${n}`,
  postedRaw: "2026-10-02 09:15:00",
  postedAt: "2026-10-02T01:15:00.000Z",
  salaryRaw: null,
});

let env;
let api;
let sync;
let ingest;

const connect = () => env.chrome.storage.local.set({ [TOKEN_KEY]: TEST_TOKEN });
const listingState = () => env.chrome.storage.local.dump()[LISTING_SYNC_KEY];
const bodies = () => api.ingestCalls().map((r) => r.body);
// Lets a call that has to wait out its retries finish.
async function settle(promise) {
  await vi.advanceTimersByTimeAsync(120000);
  return promise;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-05T09:00:00Z"));
  env = installChromeMock();
  api = installFakeWatchDesk();
  vi.resetModules();
  sync = await import("../watch-sync.js");
  ingest = await import("../listing-ingest.js");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("with no account connected", () => {
  it("sends nothing and stores nothing", async () => {
    const outcome = await ingest.ingestCheckedListings([{ watchId: "default", jobs: [onlineJobsJob(1)] }]);

    expect(outcome).toEqual({ status: "not-connected", sent: 0, unsent: 0 });
    expect(api.fetch).not.toHaveBeenCalled();
    expect(listingState()).toBeUndefined();
    expect(env.chrome.storage.local.set).not.toHaveBeenCalled();
  });
});

describe("with an account connected", () => {
  let watch;

  beforeEach(async () => {
    await connect();
    watch = api.addWatch({ url: LI, label: "Engineers" });
    await sync.syncWatches();
  });

  it("posts every listing a watch's check read, under the watch's server id, with the device token", async () => {
    const jobs = [linkedInJob(1), linkedInJob(2)];
    const outcome = await ingest.ingestCheckedListings([{ watchId: watch.id, jobs }]);

    expect(outcome).toEqual({ status: "ok", sent: 1, unsent: 0 });
    const [request] = api.ingestCalls();
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${TEST_TOKEN}` });
    expect(request.credentials).toBe("omit");
    expect(request.body).toEqual({ watchId: watch.id, listings: jobs });
    expect(api.listings.map((row) => row.sourceKey)).toEqual(["linkedin:401", "linkedin:402"]);
  });

  it("names each field as WD-57's schema does, and sends nothing else", async () => {
    await ingest.ingestCheckedListings([
      { watchId: watch.id, jobs: [{ ...onlineJobsJob(1), siteId: "x", watchLabel: "y", detectedAt: 1, visited: true }] },
    ]);

    expect(bodies()[0].listings).toEqual([
      {
        id: "131",
        title: "Assistant 1",
        url: "https://www.onlinejobs.ph/jobseekers/job/131",
        postedRaw: "2026-10-02 09:15:00",
        postedAt: "2026-10-02T01:15:00.000Z",
        postedApprox: false,
        salaryRaw: null,
        easyApply: false,
        workplaceType: null,
      },
    ]);
    expect(Object.keys(bodies()[0])).toEqual(["watchId", "listings"]);
  });

  it("records when the listings last reached WatchDesk", async () => {
    expect(await ingest.getListingSyncStatus()).toEqual({ lastIngestedAt: null, failed: false, queued: 0, dropped: 0 });

    await ingest.ingestCheckedListings([{ watchId: watch.id, jobs: [linkedInJob(1)] }]);

    expect(listingState()).toEqual({ lastIngestedAt: Date.now(), failed: false });
    expect(await ingest.getListingSyncStatus()).toEqual({ lastIngestedAt: Date.now(), failed: false, queued: 0, dropped: 0 });
  });

  it("sends the whole page again on the next cycle; WatchDesk stores each posting once", async () => {
    await ingest.ingestCheckedListings([{ watchId: watch.id, jobs: [linkedInJob(1)] }]);
    vi.setSystemTime(Date.now() + 300000);
    const outcome = await ingest.ingestCheckedListings([{ watchId: watch.id, jobs: [linkedInJob(1), linkedInJob(2)] }]);

    expect(outcome.status).toBe("ok");
    expect(bodies()[1].listings).toHaveLength(2);
    expect(api.listings).toHaveLength(2);
    expect(listingState().lastIngestedAt).toBe(Date.now());
  });

  it("splits a watch's listings into requests of at most 200", async () => {
    const jobs = Array.from({ length: 450 }, (_unused, n) => linkedInJob(n));
    const outcome = await ingest.ingestCheckedListings([{ watchId: watch.id, jobs }]);

    expect(outcome).toEqual({ status: "ok", sent: 3, unsent: 0 });
    expect(bodies().map((body) => body.listings.length)).toEqual([200, 200, 50]);
    expect(bodies().every((body) => body.watchId === watch.id)).toBe(true);
    expect(api.listings).toHaveLength(450);
  });

  it("sends one watch per request, in the order they were checked", async () => {
    const second = api.addWatch({ url: UP });
    await sync.syncWatches();
    await ingest.ingestCheckedListings([
      { watchId: second.id, jobs: [linkedInJob(1)] },
      { watchId: watch.id, jobs: [linkedInJob(2)] },
    ]);

    expect(bodies().map((body) => body.watchId)).toEqual([second.id, watch.id]);
  });

  it("sends nothing for a watch that read no listings, and leaves the record as it was", async () => {
    const outcome = await ingest.ingestCheckedListings([{ watchId: watch.id, jobs: [] }]);

    expect(outcome).toEqual({ status: "nothing-to-send", sent: 0, unsent: 0 });
    expect(api.ingestCalls()).toHaveLength(0);
    expect(listingState()).toBeUndefined();
    expect((await ingest.ingestCheckedListings(undefined)).status).toBe("nothing-to-send");
  });

  describe("a watch that has no server id yet", () => {
    it("is never sent with its local id, and the others still go", async () => {
      const outcome = await ingest.ingestCheckedListings([
        { watchId: "w_1759654800000_abcde", jobs: [onlineJobsJob(1)] },
        { watchId: "default", jobs: [onlineJobsJob(2)] },
        { watchId: watch.id, jobs: [linkedInJob(1)] },
      ]);

      expect(outcome).toEqual({ status: "ok", sent: 1, unsent: 0 });
      expect(bodies().map((body) => body.watchId)).toEqual([watch.id]);
    });

    it("is picked up once a sync has uploaded it", async () => {
      const localWatch = { id: "w_1", siteId: "onlinejobsph", url: OJ, label: "Mine", enabled: true };
      await env.chrome.storage.sync.set({ watches: [...env.chrome.storage.sync.dump().watches, localWatch] });
      // WatchDesk cannot be reached, so the watch stays local for now.
      api.setWatchRoute(api.networkError);
      await sync.syncWatches();
      expect((await ingest.ingestCheckedListings([{ watchId: "w_1", jobs: [onlineJobsJob(1)] }])).status).toBe(
        "nothing-to-send",
      );
      expect(api.ingestCalls()).toHaveLength(0);

      api.setWatchRoute(() => undefined);
      await sync.syncWatches();
      const uploaded = api.watches.find((w) => w.url === OJ);
      await ingest.ingestCheckedListings([{ watchId: uploaded.id, jobs: [onlineJobsJob(1)] }]);

      expect(bodies().map((body) => body.watchId)).toEqual([uploaded.id]);
    });

    it("covers a watch WatchDesk refused", async () => {
      const refused = { id: "w_2", siteId: null, url: "https://example.com/jobs", label: "Elsewhere", enabled: true };
      await env.chrome.storage.sync.set({ watches: [...env.chrome.storage.sync.dump().watches, refused] });
      await sync.syncWatches();

      await ingest.ingestCheckedListings([{ watchId: "w_2", jobs: [onlineJobsJob(1)] }]);
      expect(api.ingestCalls()).toHaveLength(0);
    });
  });

  it("sends nothing before this connection has had WatchDesk's list", async () => {
    await env.chrome.storage.local.remove("watchdeskWatchSync");
    const outcome = await ingest.ingestCheckedListings([{ watchId: watch.id, jobs: [linkedInJob(1)] }]);

    expect(outcome.status).toBe("nothing-to-send");
    expect(api.ingestCalls()).toHaveLength(0);
  });

  describe("a listing WatchDesk could not store", () => {
    it.each([
      ["no id", { id: "" }],
      ["an id that is not text", { id: null }],
      ["no title", { title: "   " }],
      ["a title over 500 characters", { title: "x".repeat(501) }],
      ["an id over 200 characters", { id: "9".repeat(201) }],
      ["no URL", { url: undefined }],
      ["a URL over 2048 characters", { url: `https://www.linkedin.com/jobs/view/${"1".repeat(2048)}` }],
      ["a URL that is not a web address", { url: "javascript:alert(1)" }],
      ["a relative URL", { url: "/jobs/view/1" }],
    ])("is left out rather than losing the batch: %s", async (_name, change) => {
      await ingest.ingestCheckedListings([{ watchId: watch.id, jobs: [{ ...linkedInJob(1), ...change }, linkedInJob(2)] }]);

      expect(bodies()[0].listings.map((listing) => listing.id)).toEqual(["402"]);
    });

    it("is not a listing at all", () => {
      expect(ingest.toListing(null)).toBeNull();
      expect(ingest.toListing("job")).toBeNull();
    });

    it("keeps a listing whose optional fields cannot be sent, without those fields", async () => {
      const job = {
        ...linkedInJob(1),
        id: 4011,
        title: "  Engineer  ",
        postedRaw: "p".repeat(101),
        postedAt: "three days ago",
        postedApprox: "yes",
        salaryRaw: "s".repeat(201),
        easyApply: 1,
        workplaceType: "Anywhere",
      };
      await ingest.ingestCheckedListings([{ watchId: watch.id, jobs: [job] }]);

      expect(bodies()[0].listings).toEqual([
        {
          id: "4011",
          title: "Engineer",
          url: "https://www.linkedin.com/jobs/view/401/",
          postedRaw: null,
          postedAt: null,
          postedApprox: false,
          salaryRaw: null,
          easyApply: false,
          workplaceType: null,
        },
      ]);
    });

    it("rewrites a date that is not in toISOString()'s form", () => {
      expect(ingest.toListing({ ...linkedInJob(1), postedAt: "2026-09-30T17:00:00+08:00" }).postedAt).toBe(
        "2026-09-30T09:00:00.000Z",
      );
    });

    it("sends nothing when no listing of the page is left", async () => {
      const outcome = await ingest.ingestCheckedListings([{ watchId: watch.id, jobs: [{ title: "No id" }] }]);
      expect(outcome.status).toBe("nothing-to-send");
      expect(api.ingestCalls()).toHaveLength(0);
    });
  });

  describe("when WatchDesk does not take the listings", () => {
    let second;

    beforeEach(async () => {
      second = api.addWatch({ url: UP });
      await sync.syncWatches();
    });

    const cycle = () => [
      { watchId: watch.id, jobs: [linkedInJob(1)] },
      { watchId: second.id, jobs: [linkedInJob(2)] },
    ];

    it("unreachable: retries per the retry policy, then drops the cycle's listings and records the failure", async () => {
      api.setIngestRoute(api.networkError);
      const outcome = await settle(ingest.ingestCheckedListings(cycle()));

      expect(outcome).toEqual({ status: "failed", sent: 0, unsent: 2 });
      // Four attempts for the first watch; the second is not attempted.
      expect(bodies().map((body) => body.watchId)).toEqual([watch.id, watch.id, watch.id, watch.id]);
      expect(listingState()).toEqual({ lastIngestedAt: null, failed: true });
    });

    it("a 5xx is the same, and the batches already sent are not counted as unsent", async () => {
      let calls = 0;
      api.setIngestRoute(() => (++calls > 1 ? api.json(500, { error: "Something went wrong." }) : undefined));
      const outcome = await settle(ingest.ingestCheckedListings(cycle()));

      expect(outcome).toEqual({ status: "failed", sent: 1, unsent: 1 });
      expect(api.listings.map((row) => row.sourceKey)).toEqual(["linkedin:401"]);
      expect(listingState()).toEqual({ lastIngestedAt: null, failed: true });
    });

    it("a request that failed once and then got through is a success", async () => {
      let calls = 0;
      api.setIngestRoute(() => (++calls === 1 ? api.json(503, {}) : undefined));
      const outcome = await settle(ingest.ingestCheckedListings(cycle()));

      expect(outcome).toEqual({ status: "ok", sent: 2, unsent: 0 });
      expect(api.listings).toHaveLength(2);
      expect(listingState().failed).toBe(false);
    });

    it("rate limited with a short Retry-After: waits it out and sends", async () => {
      let calls = 0;
      api.setIngestRoute(() => (++calls === 1 ? api.json(429, { error: "Slow down." }, { "Retry-After": "2" }) : undefined));
      const pending = ingest.ingestCheckedListings(cycle());
      await vi.advanceTimersByTimeAsync(1999);
      expect(api.ingestCalls()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toEqual({ status: "ok", sent: 2, unsent: 0 });
    });

    it("rate limited for longer than a worker should wait: gives up at once", async () => {
      api.setIngestRoute(() => api.json(429, { error: "Slow down." }, { "Retry-After": "60" }));
      const outcome = await ingest.ingestCheckedListings(cycle());

      expect(outcome).toEqual({ status: "failed", sent: 0, unsent: 2 });
      expect(api.ingestCalls()).toHaveLength(1);
    });

    it("keeps the time of the last cycle that got through", async () => {
      await ingest.ingestCheckedListings(cycle());
      const firstAt = Date.now();
      vi.setSystemTime(firstAt + 300000);
      api.setIngestRoute(api.networkError);
      await settle(ingest.ingestCheckedListings(cycle()));

      expect(listingState()).toEqual({ lastIngestedAt: firstAt, failed: true });

      api.setIngestRoute(() => undefined);
      await ingest.ingestCheckedListings(cycle());
      expect(listingState()).toEqual({ lastIngestedAt: Date.now(), failed: false });
    });

    it("a watch deleted on WatchDesk since the last sync: its listings are dropped, the rest go, and it is not a failure", async () => {
      api.watches.splice(0, 1);
      const jobs = Array.from({ length: 250 }, (_unused, n) => linkedInJob(n));
      const outcome = await ingest.ingestCheckedListings([{ watchId: watch.id, jobs }, cycle()[1]]);

      expect(outcome).toEqual({ status: "ok", sent: 1, unsent: 0 });
      // One request for the deleted watch (its second 200 is not sent), sent once.
      expect(bodies().map((body) => body.watchId)).toEqual([watch.id, second.id]);
      expect(listingState()).toEqual({ lastIngestedAt: Date.now(), failed: false });
    });

    it("a batch WatchDesk refuses (400) is dropped and recorded, sent once, and the other watches still go", async () => {
      api.setIngestRoute((request) =>
        request.body.watchId === watch.id
          ? api.json(400, { error: "Check the highlighted fields.", fieldErrors: { "listings.0.title": ["Title is required"] } })
          : undefined,
      );
      const outcome = await ingest.ingestCheckedListings(cycle());

      expect(outcome).toEqual({ status: "failed", sent: 1, unsent: 0 });
      expect(bodies().map((body) => body.watchId)).toEqual([watch.id, second.id]);
      expect(listingState()).toEqual({ lastIngestedAt: null, failed: true });
    });

    it("a refused token (401): the connection is dropped, nothing more is sent, and no record is left", async () => {
      await ingest.ingestCheckedListings(cycle());
      expect(listingState()).toBeDefined();
      api.setIngestRoute(() => api.json(401, { error: "Sign in to continue." }));
      const before = api.ingestCalls().length;
      const outcome = await ingest.ingestCheckedListings(cycle());

      expect(outcome).toEqual({ status: "not-connected", sent: 0, unsent: 0 });
      expect(api.ingestCalls()).toHaveLength(before + 1);
      expect(env.chrome.storage.local.dump()[TOKEN_KEY]).toBeUndefined();
      expect(listingState()).toBeUndefined();
    });
  });

  it("leaves no record behind when the connection ended while the listings were being sent", async () => {
    // Another call got a 401 meanwhile: the token and this record are gone.
    api.setIngestRoute(() => {
      env.chrome.storage.local.remove([TOKEN_KEY, LISTING_SYNC_KEY]);
    });
    await ingest.ingestCheckedListings([{ watchId: watch.id, jobs: [linkedInJob(1)] }]);

    expect(api.ingestCalls()).toHaveLength(1);
    expect(listingState()).toBeUndefined();
  });

  it("never throws, whatever goes wrong inside", async () => {
    env.chrome.storage.local.get.mockRejectedValue(new Error("storage is gone"));
    await expect(ingest.ingestCheckedListings([{ watchId: watch.id, jobs: [linkedInJob(1)] }])).resolves.toEqual({
      status: "failed",
      sent: 0,
      unsent: 0,
    });
  });

  it("keeps nothing between cycles but the record in chrome.storage.local (a restarted worker carries on)", async () => {
    await ingest.ingestCheckedListings([{ watchId: watch.id, jobs: [linkedInJob(1)] }]);
    const at = Date.now();

    vi.resetModules();
    const restarted = await import("../listing-ingest.js");
    expect(await restarted.getListingSyncStatus()).toEqual({ lastIngestedAt: at, failed: false, queued: 0, dropped: 0 });
    expect((await restarted.ingestCheckedListings([{ watchId: watch.id, jobs: [linkedInJob(2)] }])).status).toBe("ok");
    expect(env.chrome.storage.sync.dump()[LISTING_SYNC_KEY]).toBeUndefined();
    expect(env.chrome.storage.session.dump()[LISTING_SYNC_KEY]).toBeUndefined();
  });

  it("never logs, and never puts the token or a listing in what it returns or stores", async () => {
    const logs = ["log", "info", "warn", "error", "debug"].map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const ok = await ingest.ingestCheckedListings([{ watchId: watch.id, jobs: [linkedInJob(1)] }]);
    api.setIngestRoute(api.networkError);
    const failed = await settle(ingest.ingestCheckedListings([{ watchId: watch.id, jobs: [linkedInJob(2)] }]));

    for (const log of logs) expect(log).not.toHaveBeenCalled();
    const visible = JSON.stringify([ok, failed, await ingest.getListingSyncStatus(), listingState()]);
    expect(visible).not.toContain(TEST_TOKEN);
    expect(visible).not.toContain("Engineer");
    expect(visible).not.toContain("linkedin.com");
  });

  it("queues nothing while WatchDesk has not yet said whose the token is", async () => {
    api.setIngestRoute(api.networkError);
    const outcome = await settle(ingest.ingestCheckedListings([{ watchId: watch.id, jobs: [linkedInJob(1)] }]));

    expect(outcome).toEqual({ status: "failed", sent: 0, unsent: 1 });
    expect(env.chrome.storage.local.dump()[LISTING_QUEUE_KEY]).toBeUndefined();
  });
});

describe("the retry queue (WD-60)", () => {
  const ADA = "ada@example.com";
  let account;
  let watch;
  let second;

  const queue = () => env.chrome.storage.local.dump()[LISTING_QUEUE_KEY];
  const queuedIds = () => (queue()?.items ?? []).map((item) => `${item.watchId === watch.id ? "a" : "b"}:${item.listing.id}`);
  const sentIds = () => bodies().map((body) => body.listings.map((listing) => listing.id));
  const cycle = (first = [linkedInJob(1)], other = [linkedInJob(2)]) => [
    { watchId: watch.id, jobs: first },
    { watchId: second.id, jobs: other },
  ];
  const outage = () => api.setIngestRoute(api.networkError);
  const recover = () => api.setIngestRoute(() => undefined);
  const failCycle = async (checked = cycle()) => {
    outage();
    const outcome = await settle(ingest.ingestCheckedListings(checked));
    recover();
    return outcome;
  };

  beforeEach(async () => {
    account = await import("../account-connection.js");
    await connect();
    // WatchDesk says whose the token is: ada@example.com.
    await account.refreshAccount();
    watch = api.addWatch({ url: LI, label: "Engineers" });
    second = api.addWatch({ url: UP });
    await sync.syncWatches();
  });

  describe("a cycle WatchDesk did not take", () => {
    it("is kept in chrome.storage.local, under the account it was read for", async () => {
      const outcome = await failCycle();

      expect(outcome).toEqual({ status: "failed", sent: 0, unsent: 2 });
      expect(queue()).toEqual({
        owner: ADA,
        items: [
          { watchId: watch.id, listing: linkedInJob(1) },
          { watchId: second.id, listing: linkedInJob(2) },
        ],
        dropped: 0,
        droppedSeen: false,
      });
      expect(env.chrome.storage.sync.dump()[LISTING_QUEUE_KEY]).toBeUndefined();
      expect(env.chrome.storage.session.dump()[LISTING_QUEUE_KEY]).toBeUndefined();
      expect(await ingest.getListingSyncStatus()).toEqual({ lastIngestedAt: null, failed: true, queued: 2, dropped: 0 });
    });

    it("is retried on the next cycle, before that cycle's own listings, and then leaves the queue", async () => {
      await failCycle();
      const before = api.ingestCalls().length;
      vi.setSystemTime(Date.now() + 300000);
      const outcome = await ingest.ingestCheckedListings(cycle([linkedInJob(3)], [linkedInJob(4)]));

      expect(outcome).toEqual({ status: "ok", sent: 4, unsent: 0 });
      expect(sentIds().slice(before)).toEqual([["401"], ["402"], ["403"], ["404"]]);
      expect(api.listings.map((row) => row.listing.id).sort()).toEqual(["401", "402", "403", "404"]);
      expect(queue()).toBeUndefined();
      expect(listingState()).toEqual({ lastIngestedAt: Date.now(), failed: false });
    });

    it("is retried even when the next cycle read nothing", async () => {
      await failCycle();
      const outcome = await ingest.ingestCheckedListings([]);

      expect(outcome).toEqual({ status: "ok", sent: 2, unsent: 0 });
      expect(api.listings).toHaveLength(2);
      expect(queue()).toBeUndefined();
    });

    it.each([
      ["a 5xx", () => api.json(503, { error: "Something went wrong." })],
      ["a 429 that asks for a long wait", () => api.json(429, { error: "Slow down." }, { "Retry-After": "60" })],
      ["a request that never answers", (request) => api.hang(request)],
    ])("is queued after %s too", async (_name, answer) => {
      api.setIngestRoute(answer);
      await settle(ingest.ingestCheckedListings(cycle()));

      expect(queuedIds()).toEqual(["a:401", "b:402"]);
    });

    it("queues only what was not sent", async () => {
      let calls = 0;
      api.setIngestRoute(() => (++calls > 1 ? api.json(500, {}) : undefined));
      const outcome = await settle(ingest.ingestCheckedListings(cycle()));

      expect(outcome).toEqual({ status: "failed", sent: 1, unsent: 1 });
      expect(queuedIds()).toEqual(["b:402"]);
    });

    it("stays queued through a second failure, and the cycle's own listings join it", async () => {
      await failCycle();
      const outcome = await failCycle(cycle([linkedInJob(3)], []));

      // The queued request for the first watch failed; nothing after it was tried.
      expect(outcome).toEqual({ status: "failed", sent: 0, unsent: 3 });
      expect(queuedIds()).toEqual(["a:401", "b:402", "a:403"]);
    });
  });

  describe("coalescing", () => {
    it("holds each listing once per watch: a later reading replaces the older copy", async () => {
      await failCycle(cycle([linkedInJob(1), linkedInJob(2)], [linkedInJob(1)]));
      const newer = { ...linkedInJob(2), title: "Engineer 2 (updated)" };
      await failCycle(cycle([newer, linkedInJob(3)], []));

      expect(queuedIds()).toEqual(["a:401", "b:401", "a:402", "a:403"]);
      expect(queue().items[2].listing.title).toBe("Engineer 2 (updated)");
    });

    it("sends a watch's queued listings together, the watch with the oldest listing first", async () => {
      await failCycle(cycle([linkedInJob(1)], [linkedInJob(2)]));
      await failCycle(cycle([linkedInJob(3)], []));
      const before = api.ingestCalls().length;
      await ingest.ingestCheckedListings([]);

      expect(bodies().slice(before)).toEqual([
        { watchId: watch.id, listings: [linkedInJob(1), linkedInJob(3)] },
        { watchId: second.id, listings: [linkedInJob(2)] },
      ]);
    });

    it("takes a queued copy out when the cycle's own reading of it got through", async () => {
      // Twelve watches queued: two are beyond what one cycle retries.
      const more = Array.from({ length: 10 }, (_unused, n) => api.addWatch({ url: `${LI}&n=${n}` }));
      await sync.syncWatches();
      const all = [watch, second, ...more];
      await failCycle(all.map((w) => ({ watchId: w.id, jobs: [linkedInJob(1)] })));
      const last = all.at(-1);
      await ingest.ingestCheckedListings([{ watchId: last.id, jobs: [linkedInJob(1)] }]);

      expect(queue().items.map((item) => item.watchId)).toEqual([all.at(-2).id]);
    });
  });

  describe("how much a cycle retries", () => {
    it("sends at most 10 queued requests a cycle and the rest on the next", async () => {
      const more = Array.from({ length: 10 }, (_unused, n) => api.addWatch({ url: `${LI}&n=${n}` }));
      await sync.syncWatches();
      await failCycle([watch, second, ...more].map((w) => ({ watchId: w.id, jobs: [linkedInJob(1)] })));
      expect(queue().items).toHaveLength(12);
      const before = api.ingestCalls().length;

      const first = await ingest.ingestCheckedListings([]);
      expect(ingest.QUEUE_MAX_REQUESTS_PER_CYCLE).toBe(10);
      expect(first).toEqual({ status: "ok", sent: 10, unsent: 0 });
      expect(api.ingestCalls()).toHaveLength(before + 10);
      expect(queue().items).toHaveLength(2);
      // Nothing failed, but not everything is there yet.
      expect(await ingest.getListingSyncStatus()).toEqual({ lastIngestedAt: null, failed: false, queued: 2, dropped: 0 });

      const next = await ingest.ingestCheckedListings([]);
      expect(next).toEqual({ status: "ok", sent: 2, unsent: 0 });
      expect(queue()).toBeUndefined();
      expect(listingState()).toEqual({ lastIngestedAt: Date.now(), failed: false });
    });

    it("splits a watch's queued listings into requests of at most 200", async () => {
      await failCycle([{ watchId: watch.id, jobs: Array.from({ length: 450 }, (_unused, n) => linkedInJob(n)) }]);
      const before = api.ingestCalls().length;
      await ingest.ingestCheckedListings([]);

      expect(
        bodies()
          .slice(before)
          .map((body) => body.listings.length),
      ).toEqual([200, 200, 50]);
      expect(api.listings).toHaveLength(450);
    });

    it("stops at the first queued request that fails, and does not send the cycle's own after it", async () => {
      await failCycle();
      const before = api.ingestCalls().length;
      await failCycle(cycle([linkedInJob(5)], [linkedInJob(6)]));

      // The four attempts of one request, all for the oldest queued batch.
      expect(sentIds().slice(before)).toEqual([["401"], ["401"], ["401"], ["401"]]);
    });

    it("two cycles at once send the queue once", async () => {
      await failCycle([{ watchId: watch.id, jobs: [linkedInJob(1)] }]);
      const before = api.ingestCalls().length;
      api.setIngestRoute(
        () => new Promise((resolve) => setTimeout(() => resolve(api.json(200, { received: 1, inserted: [] })), 1000)),
      );
      const alarm = ingest.ingestCheckedListings([]);
      const checkNow = ingest.ingestCheckedListings([]);
      await vi.advanceTimersByTimeAsync(5000);

      expect(await alarm).toEqual({ status: "ok", sent: 1, unsent: 0 });
      expect(await checkNow).toEqual({ status: "nothing-to-send", sent: 0, unsent: 0 });
      expect(api.ingestCalls()).toHaveLength(before + 1);
    });
  });

  describe("delivery", () => {
    it("removes a listing only after WatchDesk took it: a worker stopped in between sends it again, harmlessly", async () => {
      await failCycle([{ watchId: watch.id, jobs: [linkedInJob(1)] }]);
      // WatchDesk answers 200, and the worker dies before the queue is rewritten.
      env.chrome.storage.local.remove.mockRejectedValueOnce(new Error("worker stopped"));
      await ingest.ingestCheckedListings([]);
      expect(api.listings).toHaveLength(1);
      expect(queuedIds()).toEqual(["a:401"]);

      vi.resetModules();
      const restarted = await import("../listing-ingest.js");
      expect(await restarted.ingestCheckedListings([])).toEqual({ status: "ok", sent: 1, unsent: 0 });
      expect(api.listings).toHaveLength(1);
      expect(queue()).toBeUndefined();
    });

    it("a queued batch WatchDesk refuses (400) is dropped and recorded, never sent again", async () => {
      await failCycle();
      api.setIngestRoute((request) => (request.body.watchId === watch.id ? api.json(400, { error: "No." }) : undefined));
      const outcome = await ingest.ingestCheckedListings([]);

      expect(outcome).toEqual({ status: "failed", sent: 1, unsent: 0 });
      expect(queue()).toBeUndefined();
      expect(listingState()).toEqual({ lastIngestedAt: null, failed: true });

      const before = api.ingestCalls().length;
      expect((await ingest.ingestCheckedListings([])).status).toBe("nothing-to-send");
      expect(api.ingestCalls()).toHaveLength(before);
    });

    it("a refused batch of the cycle itself is not queued", async () => {
      api.setIngestRoute(() => api.json(400, { error: "No." }));
      await ingest.ingestCheckedListings(cycle());

      expect(queue()).toBeUndefined();
    });

    it("a watch that is gone (404) loses its queued listings, all of them; the others still go", async () => {
      await failCycle(cycle(Array.from({ length: 250 }, (_unused, n) => linkedInJob(n)), [linkedInJob(1)]));
      api.watches.splice(0, 1);
      const before = api.ingestCalls().length;
      const outcome = await ingest.ingestCheckedListings([]);

      expect(outcome).toEqual({ status: "ok", sent: 1, unsent: 0 });
      // One request for the deleted watch (its other 50 are not sent), one for the other.
      expect(
        bodies()
          .slice(before)
          .map((body) => body.watchId),
      ).toEqual([watch.id, second.id]);
      expect(queue()).toBeUndefined();
      expect(listingState()).toEqual({ lastIngestedAt: Date.now(), failed: false });
    });
  });

  describe("whose listings they are", () => {
    const refuseToken = async (checked = cycle()) => {
      api.setIngestRoute(() => api.json(401, { error: "Sign in to continue." }));
      const outcome = await ingest.ingestCheckedListings(checked);
      recover();
      return outcome;
    };
    const reconnectAs = async (email) => {
      api.setCurrent(() => api.json(200, { account: { email, displayName: null }, device: { id: "d2", label: "Chrome" } }));
      await connect();
      await account.refreshAccount();
      await sync.syncWatches();
    };

    it("a refused token (401) keeps the queue and adds what the cycle could not send", async () => {
      await failCycle([{ watchId: watch.id, jobs: [linkedInJob(1)] }]);
      const outcome = await refuseToken(cycle([linkedInJob(3)], [linkedInJob(4)]));

      expect(outcome).toEqual({ status: "not-connected", sent: 0, unsent: 0 });
      expect(env.chrome.storage.local.dump()[TOKEN_KEY]).toBeUndefined();
      expect(queue().owner).toBe(ADA);
      expect(queuedIds()).toEqual(["a:401", "a:403", "b:404"]);
    });

    it("sends nothing and changes nothing while not connected", async () => {
      await refuseToken();
      const before = api.ingestCalls().length;
      const held = queue();

      expect(await ingest.ingestCheckedListings(cycle())).toEqual({ status: "not-connected", sent: 0, unsent: 0 });
      expect(api.ingestCalls()).toHaveLength(before);
      expect(queue()).toEqual(held);
    });

    it("is sent after reconnecting to the same account, however the address is written", async () => {
      await refuseToken();
      await reconnectAs("  Ada@Example.com ");
      const outcome = await ingest.ingestCheckedListings([]);

      expect(outcome).toEqual({ status: "ok", sent: 2, unsent: 0 });
      expect(api.listings.map((row) => row.listing.id)).toEqual(["401", "402"]);
      expect(queue()).toBeUndefined();
    });

    it("is cleared, unsent, when a different account connects", async () => {
      await refuseToken();
      const before = api.ingestCalls().length;
      await reconnectAs("grace@example.com");

      expect(queue()).toBeUndefined();
      expect((await ingest.ingestCheckedListings([])).status).toBe("nothing-to-send");
      expect(api.ingestCalls()).toHaveLength(before);
      expect(api.listings).toHaveLength(0);
    });

    it("is not sent to another account even if it is still in storage", async () => {
      await refuseToken();
      const held = queue();
      const before = api.ingestCalls().length;
      await connect();
      await env.chrome.storage.local.set({ [ACCOUNT_KEY]: { email: "grace@example.com" } });
      await sync.syncWatches();

      expect(await ingest.getListingSyncStatus()).toMatchObject({ queued: 0, dropped: 0 });
      expect((await ingest.ingestCheckedListings([])).status).toBe("nothing-to-send");
      expect(api.ingestCalls()).toHaveLength(before);
      expect(queue()).toEqual(held);
    });

    it("waits, unsent, until WatchDesk has said whose the new token is", async () => {
      await refuseToken();
      const before = api.ingestCalls().length;
      await connect();
      await sync.syncWatches();

      expect((await ingest.ingestCheckedListings([])).status).toBe("nothing-to-send");
      expect(api.ingestCalls()).toHaveLength(before);
      expect(queuedIds()).toEqual(["a:401", "b:402"]);
    });

    it("stops a cycle when another account is connected while it is sending, and leaves that account no queue", async () => {
      api.setIngestRoute(() => {
        env.chrome.storage.local.set({ [ACCOUNT_KEY]: { email: "grace@example.com" } });
      });
      const outcome = await ingest.ingestCheckedListings(cycle());

      expect(outcome).toEqual({ status: "not-connected", sent: 1, unsent: 0 });
      expect(api.ingestCalls()).toHaveLength(1);
      expect(queue()).toBeUndefined();
    });

    it("a cycle that fails after another account connected leaves that account's queue alone", async () => {
      const theirs = { owner: "grace@example.com", items: [{ watchId: "w", listing: { id: "1" } }], dropped: 0, droppedSeen: false };
      api.setIngestRoute(() => {
        env.chrome.storage.local.set({ [ACCOUNT_KEY]: { email: "grace@example.com" }, [LISTING_QUEUE_KEY]: theirs });
        return api.json(500, {});
      });
      await settle(ingest.ingestCheckedListings(cycle()));

      expect(queue()).toEqual(theirs);
    });
  });

  describe("the cap", () => {
    const many = (count, from = 0) => Array.from({ length: count }, (_unused, n) => linkedInJob(from + n));

    it("drops the oldest listings over 2,000 and counts them", async () => {
      await failCycle([{ watchId: watch.id, jobs: many(1500) }]);
      expect(await ingest.getListingSyncStatus()).toMatchObject({ queued: 1500, dropped: 0 });
      await failCycle([{ watchId: watch.id, jobs: many(600, 1500) }]);

      expect(ingest.QUEUE_MAX_LISTINGS).toBe(2000);
      expect(queue().items).toHaveLength(2000);
      expect(queue().items[0].listing.id).toBe(linkedInJob(100).id);
      expect(queue().items.at(-1).listing.id).toBe(linkedInJob(2099).id);
      expect(queue().dropped).toBe(100);
      expect(await ingest.getListingSyncStatus()).toEqual({ lastIngestedAt: null, failed: true, queued: 2000, dropped: 100 });
    });

    it("keeps the queue under 2 MB when the listings are unusually long", async () => {
      const long = (n) => ({
        ...linkedInJob(n),
        title: "t".repeat(500),
        url: `https://www.linkedin.com/jobs/view/${n}/?${"q".repeat(1990)}`,
        salaryRaw: "s".repeat(200),
        postedRaw: "p".repeat(100),
      });
      await failCycle([{ watchId: watch.id, jobs: Array.from({ length: 900 }, (_unused, n) => long(n)) }]);

      const bytes = new TextEncoder().encode(JSON.stringify(queue().items)).length;
      expect(bytes).toBeLessThanOrEqual(ingest.QUEUE_MAX_BYTES);
      expect(bytes).toBeGreaterThan(ingest.QUEUE_MAX_BYTES * 0.99);
      expect(queue().items.length).toBeLessThan(900);
      expect(queue().dropped).toBe(900 - queue().items.length);
      expect(queue().items.at(-1).listing.id).toBe(long(899).id);
    });

    it("drains a full queue in one cycle once WatchDesk is back", async () => {
      await failCycle([{ watchId: watch.id, jobs: many(2100) }]);
      const outcome = await ingest.ingestCheckedListings([]);

      expect(outcome).toEqual({ status: "ok", sent: 10, unsent: 0 });
      expect(api.listings).toHaveLength(2000);
      expect(listingState()).toEqual({ lastIngestedAt: Date.now(), failed: false });
    });

    describe("the dropped count", () => {
      beforeEach(async () => {
        await failCycle([{ watchId: watch.id, jobs: many(2100) }]);
      });
      const dropped = async () => (await ingest.getListingSyncStatus()).dropped;

      it("outlives the recovery until the user has seen it", async () => {
        await ingest.ingestCheckedListings([]);
        await ingest.ingestCheckedListings(cycle());
        expect(await dropped()).toBe(100);
        expect(queue()).toEqual({ owner: ADA, items: [], dropped: 100, droppedSeen: false });

        await ingest.acknowledgeDroppedListings();
        expect(await dropped()).toBe(0);
        expect(queue()).toBeUndefined();
      });

      it("seen during the outage, stays until everything has got through", async () => {
        await ingest.acknowledgeDroppedListings();
        expect(await dropped()).toBe(100);
        await failCycle([]);
        expect(await dropped()).toBe(100);

        await ingest.ingestCheckedListings([]);
        expect(await dropped()).toBe(0);
        expect(queue()).toBeUndefined();
      });

      it("seen once, is shown again when more are dropped", async () => {
        await ingest.acknowledgeDroppedListings();
        await failCycle([{ watchId: watch.id, jobs: many(50, 5000) }]);
        expect(queue()).toMatchObject({ dropped: 150, droppedSeen: false });

        await ingest.ingestCheckedListings([]);
        expect(await dropped()).toBe(150);
      });

      it("is not shown to another account, which cannot acknowledge it either", async () => {
        await env.chrome.storage.local.set({ [ACCOUNT_KEY]: { email: "grace@example.com" } });
        expect(await dropped()).toBe(0);
        await ingest.acknowledgeDroppedListings();
        expect(queue().dropped).toBe(100);
      });

      it("acknowledging never throws, and does nothing with no account connected", async () => {
        await env.chrome.storage.local.remove(TOKEN_KEY);
        const held = queue();
        await expect(ingest.acknowledgeDroppedListings()).resolves.toBeUndefined();
        expect(queue()).toEqual(held);

        env.chrome.storage.local.get.mockRejectedValue(new Error("storage is gone"));
        await expect(ingest.acknowledgeDroppedListings()).resolves.toBeUndefined();
      });
    });
  });

  it("never logs, and shows the popup counts only: no token, no listing", async () => {
    const logs = ["log", "info", "warn", "error", "debug"].map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const failed = await failCycle();
    const status = await ingest.getListingSyncStatus();
    const sent = await ingest.ingestCheckedListings([]);

    for (const log of logs) expect(log).not.toHaveBeenCalled();
    const visible = JSON.stringify([failed, status, sent, await ingest.getListingSyncStatus()]);
    expect(visible).not.toContain(TEST_TOKEN);
    expect(visible).not.toContain("Engineer");
    expect(visible).not.toContain("linkedin.com");
    expect(visible).not.toContain(ADA);
  });
});
