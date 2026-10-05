// The three gaps WD-110 closes in listing-ingest.js's queue: a cycle's
// listings are queued before they are sent, a batch WatchDesk will not take
// cannot hold the queue up, and a request can only go out with the token of
// the connection its cycle started with. Same mocks as
// listing-ingest.test.js: a mocked chrome.*, a fake WatchDesk behind a mocked
// fetch, and the real authorizedRequest().
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { installFakeWatchDesk, TEST_TOKEN } from "./helpers/fake-watchdesk.js";
import {
  ACCOUNT_KEY,
  LISTING_QUEUE_KEY,
  LISTING_SYNC_KEY,
  TOKEN_KEY,
  WATCH_SYNC_KEY,
} from "../account-connection.js";

const LI = "https://www.linkedin.com/jobs/search/?keywords=engineer";
const UP = "https://www.upwork.com/nx/search/jobs/?q=react";
const OJ = "https://www.onlinejobs.ph/jobseekers/jobsearch?jobkeyword=va";
const ADA = "ada@example.com";
// The token of a pairing that completes later.
const OTHER_TOKEN = "wd_fedcba9876543210fedcba9876543210.othersecret-abcdefghijklmnopqrstuvwxyz012";

const job = (n) => ({
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
const many = (count, from = 0) => Array.from({ length: count }, (_unused, n) => job(from + n));

let env;
let api;
let ingest;
let watch;
let second;
let third;

const listingState = () => env.chrome.storage.local.dump()[LISTING_SYNC_KEY];
const queue = () => env.chrome.storage.local.dump()[LISTING_QUEUE_KEY];
const name = (watchId) => (watchId === watch.id ? "a" : watchId === second.id ? "b" : "c");
const queuedIds = () => (queue()?.items ?? []).map((item) => `${name(item.watchId)}:${item.listing.id}`);
// Each request as "watch:ids".
const sentIds = () =>
  api.ingestCalls().map((request) => `${name(request.body.watchId)}:${request.body.listings.map((listing) => listing.id)}`);
const cycle = (first = [job(1)], other = [job(2)], last = [job(3)]) => [
  { watchId: watch.id, jobs: first },
  { watchId: second.id, jobs: other },
  { watchId: third.id, jobs: last },
];
// Lets a call that has to wait out its retries finish.
async function settle(promise) {
  await vi.advanceTimersByTimeAsync(120000);
  return promise;
}
const recover = () => api.setIngestRoute(() => undefined);
async function failCycle(checked = cycle()) {
  api.setIngestRoute(api.networkError);
  const outcome = await settle(ingest.ingestCheckedListings(checked));
  recover();
  return outcome;
}
// WatchDesk answers every request for the first watch with `status`.
const refuseFirstWatchWith = (status) =>
  api.setIngestRoute((request) => (request.body.watchId === watch.id ? api.json(status, { error: "No." }) : undefined));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-05T09:00:00Z"));
  env = installChromeMock();
  api = installFakeWatchDesk();
  vi.resetModules();
  const account = await import("../account-connection.js");
  const sync = await import("../watch-sync.js");
  ingest = await import("../listing-ingest.js");
  await env.chrome.storage.local.set({ [TOKEN_KEY]: TEST_TOKEN });
  // WatchDesk says whose the token is: ada@example.com.
  await account.refreshAccount();
  watch = api.addWatch({ url: LI, label: "Engineers" });
  second = api.addWatch({ url: UP });
  third = api.addWatch({ url: OJ });
  await sync.syncWatches();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a cycle's listings are queued before they are sent", () => {
  it("writes every batch to the queue before the first request, and takes each out as WatchDesk takes it", async () => {
    const seen = [];
    api.setIngestRoute(() => {
      seen.push(queuedIds());
    });
    const outcome = await ingest.ingestCheckedListings(cycle());

    expect(outcome).toEqual({ status: "ok", sent: 3, unsent: 0 });
    expect(seen).toEqual([["a:401", "b:402", "c:403"], ["b:402", "c:403"], ["c:403"]]);
    expect(queue()).toBeUndefined();
    expect(listingState()).toEqual({ lastIngestedAt: Date.now(), failed: false });
  });

  it("a worker killed midway through the loop loses nothing", async () => {
    // The first request is answered; the worker dies waiting for the second.
    api.setIngestRoute((request) => (request.body.watchId === watch.id ? undefined : api.hang(request)));
    ingest.ingestCheckedListings(cycle());
    await vi.advanceTimersByTimeAsync(1);
    expect(sentIds()).toEqual(["a:401", "b:402"]);
    // Its timers die with it; storage stays.
    const now = Date.now();
    vi.clearAllTimers();
    vi.setSystemTime(now);
    vi.resetModules();

    expect(queue().owner).toBe(ADA);
    expect(queuedIds()).toEqual(["b:402", "c:403"]);

    // The next worker's cycle. The postings have left their pages since.
    recover();
    const restarted = await import("../listing-ingest.js");
    expect(await restarted.getListingSyncStatus()).toMatchObject({ queued: 2, dropped: 0 });
    expect(await restarted.ingestCheckedListings([])).toEqual({ status: "ok", sent: 2, unsent: 0 });
    expect(api.listings.map((row) => row.listing.id).sort()).toEqual(["401", "402", "403"]);
    expect(queue()).toBeUndefined();
  });

  it("a worker killed before the first answer loses nothing either", async () => {
    api.setIngestRoute(api.hang);
    ingest.ingestCheckedListings(cycle());
    await vi.advanceTimersByTimeAsync(1);
    expect(api.ingestCalls()).toHaveLength(1);
    vi.clearAllTimers();
    vi.resetModules();

    expect(queuedIds()).toEqual(["a:401", "b:402", "c:403"]);
  });

  it("holds a posting once, and sends it once, when it is still on the page the next cycle", async () => {
    await failCycle();
    const before = api.ingestCalls().length;
    const outcome = await ingest.ingestCheckedListings(cycle());

    expect(outcome).toEqual({ status: "ok", sent: 3, unsent: 0 });
    expect(sentIds().slice(before)).toEqual(["a:401", "b:402", "c:403"]);
    expect(queue()).toBeUndefined();
  });

  it("does not store a cycle twice: the queue holds what the cycles read, once", async () => {
    await failCycle();
    await failCycle();

    expect(queuedIds()).toEqual(["a:401", "b:402", "c:403"]);
  });

  it("drops nothing to make room for a cycle WatchDesk goes on to take", async () => {
    await failCycle([{ watchId: watch.id, jobs: many(ingest.QUEUE_MAX_LISTINGS) }]);
    expect(await ingest.getListingSyncStatus()).toMatchObject({ queued: 2000, dropped: 0 });

    const outcome = await ingest.ingestCheckedListings([{ watchId: second.id, jobs: many(50, 5000) }]);

    expect(outcome).toEqual({ status: "ok", sent: 11, unsent: 0 });
    expect(api.listings).toHaveLength(2050);
    expect(await ingest.getListingSyncStatus()).toEqual({ lastIngestedAt: Date.now(), failed: false, queued: 0, dropped: 0 });
  });

  it("still holds the queue to its cap when the cycle is not taken", async () => {
    await failCycle([{ watchId: watch.id, jobs: many(ingest.QUEUE_MAX_LISTINGS) }]);
    await failCycle([{ watchId: second.id, jobs: many(50, 5000) }]);

    expect(queue().items).toHaveLength(2000);
    expect(queue().dropped).toBe(50);
    expect(queue().items.at(-1).listing.id).toBe(job(5049).id);
  });

  describe("a queue a killed worker left over its cap", () => {
    beforeEach(async () => {
      await env.chrome.storage.local.set({
        [LISTING_QUEUE_KEY]: {
          owner: ADA,
          items: many(2010).map((listing) => ({ watchId: watch.id, listing })),
          dropped: 0,
          droppedSeen: false,
        },
      });
    });

    it("is held to the cap by the next cycle WatchDesk does not take", async () => {
      await failCycle([{ watchId: second.id, jobs: [job(1)] }]);

      expect(queue().items).toHaveLength(2000);
      expect(queue().dropped).toBe(11);
      expect(queuedIds().at(-1)).toBe("b:401");
    });

    it("loses nothing when WatchDesk takes the next cycle", async () => {
      const outcome = await ingest.ingestCheckedListings([{ watchId: second.id, jobs: [job(1)] }]);

      // Ten requests for what was waiting, one for the cycle's own.
      expect(outcome).toEqual({ status: "ok", sent: 11, unsent: 0 });
      expect(queue().items).toHaveLength(10);
      expect(queue().dropped).toBe(0);
      await ingest.ingestCheckedListings([]);
      expect(api.listings).toHaveLength(2011);
      expect(queue()).toBeUndefined();
    });
  });
});

describe("a batch WatchDesk answers with something there is no rule for", () => {
  describe("a 403: WatchDesk is not taking this account's listings", () => {
    const forbid = () => api.setIngestRoute(() => api.json(403, { error: "Verify your email to continue." }));

    it("ends the cycle like an outage, asked once, and everything stays queued without an attempt counted", async () => {
      forbid();
      const outcome = await ingest.ingestCheckedListings(cycle());

      expect(outcome).toEqual({ status: "failed", sent: 0, unsent: 3 });
      expect(sentIds()).toEqual(["a:401"]);
      expect(queue()).toEqual({
        owner: ADA,
        items: [
          { watchId: watch.id, listing: job(1) },
          { watchId: second.id, listing: job(2) },
          { watchId: third.id, listing: job(3) },
        ],
        dropped: 0,
        droppedSeen: false,
      });
    });

    it("for many cycles drops nothing, and says so in the sync line's status", async () => {
      forbid();
      await ingest.ingestCheckedListings(cycle());
      for (let n = 0; n < 20; n++) await ingest.ingestCheckedListings([]);

      expect(queuedIds()).toEqual(["a:401", "b:402", "c:403"]);
      expect(queue().items.every((item) => !("attempts" in item))).toBe(true);
      // What the popup's line is drawn from: amber, three waiting, none dropped.
      expect(await ingest.getListingSyncStatus()).toEqual({ lastIngestedAt: null, failed: true, queued: 3, dropped: 0 });

      // The user puts it right; the next cycle sends everything.
      recover();
      expect(await ingest.ingestCheckedListings([])).toEqual({ status: "ok", sent: 3, unsent: 0 });
      expect(api.listings).toHaveLength(3);
      expect(queue()).toBeUndefined();
    });

    it("does not add to the attempts a listing already has", async () => {
      refuseFirstWatchWith(422);
      await ingest.ingestCheckedListings(cycle([job(1)], [], []));
      forbid();
      for (let n = 0; n < 5; n++) await ingest.ingestCheckedListings([]);

      expect(queue().items).toEqual([{ watchId: watch.id, listing: job(1), attempts: 1 }]);
    });
  });

  it.each([413, 422])("a %i for many cycles drops the batch after 3 attempts, counted in the warning", async (status) => {
    refuseFirstWatchWith(status);
    await ingest.ingestCheckedListings(cycle());
    for (let n = 0; n < 20; n++) await ingest.ingestCheckedListings([]);

    // Three requests for it in all, then never again.
    expect(sentIds().filter((sent) => sent === "a:401")).toHaveLength(3);
    expect(queue()).toEqual({ owner: ADA, items: [], dropped: 1, droppedSeen: false });
    expect(await ingest.getListingSyncStatus()).toMatchObject({ queued: 0, dropped: 1 });
    expect(api.listings).toHaveLength(2);
  });

  it.each([402, 409, 413, 422])("a %i does not end the cycle: the batches behind it still go", async (status) => {
    refuseFirstWatchWith(status);
    const outcome = await ingest.ingestCheckedListings(cycle());

    expect(outcome).toEqual({ status: "failed", sent: 2, unsent: 1 });
    // Asked once: the retry policy does not repeat a refusal.
    expect(sentIds()).toEqual(["a:401", "b:402", "c:403"]);
    expect(queue().items).toEqual([{ watchId: watch.id, listing: job(1), attempts: 1 }]);
    expect(listingState()).toEqual({ lastIngestedAt: null, failed: true });
  });

  it("never holds up the head of the queue: what waits behind it is sent in the same cycle", async () => {
    await failCycle();
    refuseFirstWatchWith(422);
    const before = api.ingestCalls().length;
    const outcome = await ingest.ingestCheckedListings([]);

    expect(outcome).toEqual({ status: "failed", sent: 2, unsent: 1 });
    expect(sentIds().slice(before)).toEqual(["a:401", "b:402", "c:403"]);
    expect(queuedIds()).toEqual(["a:401"]);
  });

  it("is dropped after 3 attempts, counted in the dropped warning, and never sent again", async () => {
    refuseFirstWatchWith(422);
    await ingest.ingestCheckedListings(cycle());
    await ingest.ingestCheckedListings([]);
    expect(queue().items).toEqual([{ watchId: watch.id, listing: job(1), attempts: 2 }]);
    expect(await ingest.getListingSyncStatus()).toMatchObject({ queued: 1, dropped: 0 });

    const last = await ingest.ingestCheckedListings([]);

    expect(ingest.QUEUE_MAX_ATTEMPTS).toBe(3);
    expect(last).toEqual({ status: "failed", sent: 0, unsent: 1 });
    expect(queue()).toEqual({ owner: ADA, items: [], dropped: 1, droppedSeen: false });
    expect(await ingest.getListingSyncStatus()).toEqual({ lastIngestedAt: null, failed: true, queued: 0, dropped: 1 });

    const before = api.ingestCalls().length;
    expect((await ingest.ingestCheckedListings([])).status).toBe("nothing-to-send");
    expect(api.ingestCalls()).toHaveLength(before);
  });

  it("counts every listing of the batch", async () => {
    refuseFirstWatchWith(413);
    await ingest.ingestCheckedListings(cycle([job(1), job(4), job(5)], [], []));
    await ingest.ingestCheckedListings([]);
    await ingest.ingestCheckedListings([]);

    expect(queue()).toEqual({ owner: ADA, items: [], dropped: 3, droppedSeen: false });
  });

  it("keeps the count when the posting is read again: a newer reading is not a fresh start", async () => {
    refuseFirstWatchWith(422);
    const updated = { ...job(1), title: "Engineer 1 (updated)" };
    await ingest.ingestCheckedListings(cycle());
    await ingest.ingestCheckedListings(cycle([updated], [], []));
    expect(queue().items).toEqual([{ watchId: watch.id, listing: updated, attempts: 2 }]);

    await ingest.ingestCheckedListings(cycle([job(1)], [], []));
    expect(queue()).toEqual({ owner: ADA, items: [], dropped: 1, droppedSeen: false });
  });

  it("drops only the listings that have had their attempts", async () => {
    refuseFirstWatchWith(422);
    await ingest.ingestCheckedListings(cycle([job(1)], [], []));
    // 401 has left the page; 404 is new.
    await ingest.ingestCheckedListings(cycle([job(4)], [], []));
    expect(queue().items.map((item) => [item.listing.id, item.attempts])).toEqual([
      ["401", 2],
      ["404", 1],
    ]);

    await ingest.ingestCheckedListings([]);
    expect(queue().items.map((item) => [item.listing.id, item.attempts])).toEqual([["404", 2]]);
    expect(queue().dropped).toBe(1);
  });

  it("is sent, and its count forgotten, when WatchDesk takes it after all", async () => {
    refuseFirstWatchWith(422);
    await ingest.ingestCheckedListings(cycle());
    recover();

    expect(await ingest.ingestCheckedListings([])).toEqual({ status: "ok", sent: 1, unsent: 0 });
    expect(queue()).toBeUndefined();
    expect(api.listings).toHaveLength(3);
  });

  it("an outage is not an attempt: unreachable, a 5xx and a 429 are waited out", async () => {
    for (const answer of [
      api.networkError,
      () => api.json(503, {}),
      () => api.json(429, {}, { "Retry-After": "60" }),
      api.networkError,
      () => api.json(500, {}),
    ]) {
      api.setIngestRoute(answer);
      await settle(ingest.ingestCheckedListings([{ watchId: watch.id, jobs: [job(1)] }]));
    }

    expect(queue()).toEqual({
      owner: ADA,
      items: [{ watchId: watch.id, listing: job(1) }],
      dropped: 0,
      droppedSeen: false,
    });
  });

  it("an outage still ends the cycle at once, without trying the batches behind", async () => {
    api.setIngestRoute(() => api.json(429, {}, { "Retry-After": "60" }));
    const outcome = await ingest.ingestCheckedListings(cycle());

    expect(outcome).toEqual({ status: "failed", sent: 0, unsent: 3 });
    expect(sentIds()).toEqual(["a:401"]);
  });

  it("shows the dropped count again after the user had seen an earlier one", async () => {
    await env.chrome.storage.local.set({
      [LISTING_QUEUE_KEY]: { owner: ADA, items: [], dropped: 5, droppedSeen: true },
      [LISTING_SYNC_KEY]: { lastIngestedAt: null, failed: true },
    });
    refuseFirstWatchWith(422);
    await ingest.ingestCheckedListings(cycle([job(1)], [], []));
    await ingest.ingestCheckedListings([]);
    await ingest.ingestCheckedListings([]);

    expect(queue()).toMatchObject({ dropped: 6, droppedSeen: false });
  });

  it("while the account's email is not known, it still does not end the cycle (and nothing is queued)", async () => {
    await env.chrome.storage.local.remove(ACCOUNT_KEY);
    refuseFirstWatchWith(422);
    const outcome = await ingest.ingestCheckedListings(cycle());

    expect(outcome).toEqual({ status: "failed", sent: 2, unsent: 1 });
    expect(queue()).toBeUndefined();
  });
});

describe("a pairing that completes while a cycle is sending", () => {
  // What account-connection.js leaves once the new pairing is through:
  // another token, another account's name beside it, and nothing of what
  // belonged to the old connection.
  const pairAsGrace = async () => {
    await env.chrome.storage.local.set({ [TOKEN_KEY]: OTHER_TOKEN, [ACCOUNT_KEY]: { email: "grace@example.com" } });
    await env.chrome.storage.local.remove([WATCH_SYNC_KEY, LISTING_SYNC_KEY]);
  };
  // Runs `during` just before the one storage read that `isTheOne` picks.
  const beforeRead = (isTheOne, during) => {
    const read = env.chrome.storage.local.get.getMockImplementation();
    let reads = 0;
    let previous = null;
    let done = false;
    env.chrome.storage.local.get.mockImplementation(async (keys) => {
      reads += 1;
      if (!done && isTheOne({ keys, previous, reads })) {
        done = true;
        await during();
      }
      previous = keys;
      return read(keys);
    });
    return { happened: () => done, reads: () => reads };
  };
  // The owner check reads the account; the next read of the token is the
  // request's own.
  const theRequestsTokenRead = ({ keys, previous }) => keys === TOKEN_KEY && previous === ACCOUNT_KEY;
  const expectNothingWentWithTheNewToken = () => {
    for (const request of api.ingestCalls()) expect(request.headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(JSON.stringify(api.ingestCalls())).not.toContain(OTHER_TOKEN);
  };

  it("between the owner check and the request reading the token: nothing is sent, and nothing is lost", async () => {
    const pairing = beforeRead(theRequestsTokenRead, pairAsGrace);
    const outcome = await ingest.ingestCheckedListings(cycle());

    expect(pairing.happened()).toBe(true);
    expect(outcome).toEqual({ status: "not-connected", sent: 0, unsent: 0 });
    expect(api.ingestCalls()).toHaveLength(0);
    // Still Ada's, for when she connects again; not Grace's to see or send.
    expect(queue().owner).toBe(ADA);
    expect(queuedIds()).toEqual(["a:401", "b:402", "c:403"]);
    expect(await ingest.getListingSyncStatus()).toMatchObject({ queued: 0, dropped: 0 });
    expect((await ingest.ingestCheckedListings([])).status).toBe("nothing-to-send");
    expect(api.ingestCalls()).toHaveLength(0);
  });

  it("before the new account's name is known: still nothing goes with the new token", async () => {
    const pairing = beforeRead(theRequestsTokenRead, async () => {
      await env.chrome.storage.local.set({ [TOKEN_KEY]: OTHER_TOKEN });
      await env.chrome.storage.local.remove(ACCOUNT_KEY);
    });
    const outcome = await ingest.ingestCheckedListings(cycle());

    expect(pairing.happened()).toBe(true);
    expect(outcome).toEqual({ status: "not-connected", sent: 0, unsent: 0 });
    expect(api.ingestCalls()).toHaveLength(0);
  });

  it("a queued batch is bound the same way", async () => {
    await failCycle();
    const before = api.ingestCalls().length;
    const pairing = beforeRead(theRequestsTokenRead, pairAsGrace);
    await ingest.ingestCheckedListings([]);

    expect(pairing.happened()).toBe(true);
    expect(api.ingestCalls()).toHaveLength(before);
  });

  it("between two batches: the first went to the old account, the rest go nowhere", async () => {
    api.setIngestRoute(() => {
      pairAsGrace();
    });
    const outcome = await ingest.ingestCheckedListings(cycle());

    expect(outcome).toEqual({ status: "not-connected", sent: 1, unsent: 0 });
    expect(api.ingestCalls()).toHaveLength(1);
    expectNothingWentWithTheNewToken();
  });

  it("while a request waits to be retried: the retry is not sent with the new token", async () => {
    api.setIngestRoute(() => {
      pairAsGrace();
      return api.json(503, {});
    });
    const outcome = await settle(ingest.ingestCheckedListings(cycle()));

    expect(outcome).toEqual({ status: "not-connected", sent: 0, unsent: 0 });
    expect(api.ingestCalls()).toHaveLength(1);
    expectNothingWentWithTheNewToken();
    expect(queuedIds()).toEqual(["a:401", "b:402", "c:403"]);
  });

  // Wherever in the cycle the pairing lands, no request carries the new
  // token: the cycle's listings were all read for the old account.
  const READS = 80;
  it.each(Array.from({ length: READS }, (_unused, n) => n + 1))(
    "landing before storage read %i of the cycle: nothing goes with the new token",
    async (nth) => {
      beforeRead(({ reads }) => reads === nth, pairAsGrace);
      await ingest.ingestCheckedListings(cycle());

      expectNothingWentWithTheNewToken();
    },
  );

  it("(the cases above reach past the last storage read a cycle makes)", async () => {
    const counter = beforeRead(
      () => false,
      () => {},
    );
    await ingest.ingestCheckedListings(cycle());

    expect(api.ingestCalls()).toHaveLength(3);
    expect(counter.reads()).toBeGreaterThan(10);
    expect(counter.reads()).toBeLessThanOrEqual(READS);
  });

  it("to the same account: the cycle stops, and the next one sends what was left with the new token", async () => {
    api.setIngestRoute(() => {
      env.chrome.storage.local.set({ [TOKEN_KEY]: OTHER_TOKEN });
    });
    const outcome = await ingest.ingestCheckedListings(cycle());
    expect(outcome).toEqual({ status: "not-connected", sent: 1, unsent: 0 });
    expect(queuedIds()).toEqual(["b:402", "c:403"]);

    recover();
    expect(await ingest.ingestCheckedListings([])).toEqual({ status: "ok", sent: 2, unsent: 0 });
    expect(
      api
        .ingestCalls()
        .slice(1)
        .map((request) => request.headers.Authorization),
    ).toEqual([`Bearer ${OTHER_TOKEN}`, `Bearer ${OTHER_TOKEN}`]);
    expect(queue()).toBeUndefined();
  });
});
