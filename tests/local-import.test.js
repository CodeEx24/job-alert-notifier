// WD-81: the import of a browser's own watches, feed and settings into the
// WatchDesk account it has just been connected to (local-import.js), driven
// through the real service worker and a real pairing against the fake
// WatchDesk. What is asked and when; that nothing is synced before the
// answer; what "Import" uploads, in which order and at what pace; what "Not
// now" leaves alone; and that an import stops, resumes and never crosses
// accounts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startExtension, NOW, WATCHES, OJ_URL, GLASSDOOR_URL } from "./helpers/popup-harness.js";
import { TEST_TOKEN } from "./helpers/fake-watchdesk.js";
import { IMPORT_KEY, TOKEN_KEY, WATCH_SYNC_KEY } from "../account-connection.js";
import { WATCHES_SNAPSHOT_KEY } from "../watch-sync.js";
import { SETTINGS_SNAPSHOT_KEY } from "../account-settings.js";
import {
  IMPORT_ALARM,
  IMPORT_ANSWERS_KEY,
  IMPORT_INTERRUPTED_KEY,
  IMPORT_REQUEST_GAP_MS,
  IMPORT_RETRY_BASE_MS,
} from "../local-import.js";

const [OJ, GD, LI, LI_VUE, UP] = WATCHES;
const ADA = "ada@example.com";
const BOB = "bob@example.com";

// A feed entry as background.js stores one.
const entry = (watch, n, extra = {}) => ({
  id: `${watch.id}:${n}`,
  sourceKey: `${watch.siteId}:${n}`,
  siteId: watch.siteId,
  watchId: watch.id,
  watchLabel: watch.label,
  title: `Job ${n}`,
  url: `https://jobs.example.com/view/${n}`,
  postedRaw: "2 days ago",
  postedAt: "2026-10-03T09:00:00.000Z",
  postedApprox: true,
  salaryRaw: null,
  easyApply: false,
  workplaceType: null,
  detectedAt: NOW - n * 60000,
  visited: false,
  applied: false,
  appliedAt: null,
  ...extra,
});
// One site's share of the import's listing counts (WD-82).
const siteCounts = (counts) => ({
  listingsNew: 0,
  listingsExisting: 0,
  listingsRefused: 0,
  listingsWatchGone: 0,
  listingsNoWatch: 0,
  listingsInvalid: 0,
  ...counts,
});
const entries = (watch, from, count) => Array.from({ length: count }, (_, i) => entry(watch, from + i));

let ext;
afterEach(() => ext?.dispose());

const record = () => ext.local()[IMPORT_KEY];
const answers = () => ext.local()[IMPORT_ANSWERS_KEY];
const status = async () => (await ext.send({ type: "get-state" })).localImport;
// Lets the import run: its pauses between requests are (faked) timers.
const drive = async (ms = 5 * 60 * 1000) => {
  await vi.advanceTimersByTimeAsync(ms);
  await ext.settle();
};
// An alarm fires. Its listeners wait on (faked) timers too, so the clock is
// moved on while they run.
const tick = async (name, ms) => {
  const done = ext.chrome.alarms.onAlarm.dispatch({ name, scheduledTime: Date.now() });
  await drive(ms);
  await done;
};
// Requests that carry or fetch the user's data. GET /api/devices/current
// only names the account and is not one of them.
const dataCalls = () => [
  ...ext.api.watchCalls(),
  ...ext.api.ingestCalls(),
  ...ext.api.statusCalls(),
  ...ext.api.settingsCalls(),
];
const posted = () => ext.api.watchCalls("POST");
const sourceKeys = () => ext.api.listings.map((row) => row.sourceKey).sort();

// A browser that has been in use, paired with an account for the first time.
async function paired({ feed = [entry(OJ, 1), entry(GD, 2)], sync = {}, watches = WATCHES, account = ADA } = {}) {
  ext = await startExtension({ watches, sync, local: { feed } });
  ext.api.setCurrent(() =>
    ext.api.json(200, { account: { email: account, displayName: null }, device: { id: "d1", label: "Chrome" } }),
  );
  await ext.pair();
  // The popup is opened: this is where the browser is asked.
  await ext.send({ type: "get-state" });
  ext.take();
  return ext;
}

async function accept() {
  const state = await ext.send({ type: "local-import-accept" });
  await drive();
  return state;
}

// The connected token is refused: what a device revoked on WatchDesk looks
// like to the extension.
async function loseConnection() {
  ext.api.setCurrent(() => ext.api.json(401, { error: "Sign in to continue." }));
  await ext.send({ type: "account-refresh" });
  expect(ext.local()[TOKEN_KEY]).toBeUndefined();
}

async function pairAs(email) {
  ext.api.setCurrent(() =>
    ext.api.json(200, { account: { email, displayName: null }, device: { id: "d2", label: "Chrome" } }),
  );
  await ext.pair();
}

describe("a first pairing of a browser that has data of its own", () => {
  it("offers the import, and syncs nothing before the answer", async () => {
    await paired({ sync: { intervalMinutes: 30 } });
    expect(ext.local()[TOKEN_KEY]).toBe(TEST_TOKEN);

    const state = await ext.send({ type: "get-state" });
    expect(state.localImport).toEqual({ phase: "offered", again: false, watches: 5, listings: 2, settings: true });
    expect(record()).toEqual({ phase: "offered", owner: ADA });
    // Connected, and still working as with no account: the list and the
    // settings are this browser's.
    expect(state.watchSync).toEqual({ mode: "local" });
    expect(state.settingsSync).toEqual({ mode: "local" });
    expect(JSON.stringify(state)).not.toContain(TEST_TOKEN);

    // Everything that syncs, asked for: none of it does.
    expect(await ext.send({ type: "sync-watches" })).toEqual({ mode: "local" });
    await ext.send({ type: "sync-settings" });
    await ext.send({ type: "check-now" });
    await ext.send({ type: "set-watcher-state", state: "paused" });
    await tick("check-jobs");
    await drive();

    expect(dataCalls()).toEqual([]);
    expect(ext.watches()).toEqual(WATCHES);
    expect(ext.sync().intervalMinutes).toBe(30);
    expect(ext.local().feed).toHaveLength(2);
    expect(ext.local()[WATCH_SYNC_KEY]).toBeUndefined();
    expect(ext.local()[SETTINGS_SNAPSHOT_KEY]).toBeUndefined();
    expect(answers()).toBeUndefined();
  });

  it("keeps watching on this browser's own list while the question is open", async () => {
    await paired({ watches: [OJ], feed: [] , sync: { soundId: "ping" } });
    expect((await status()).phase).toBe("offered");
    ext.api.setSite(() => new Response("<html></html>", { status: 200 }));

    // The first check takes the baseline; the second finds a new posting.
    ext.pages.onlinejobsph = [{ id: "1", title: "PHP Developer", url: "https://www.onlinejobs.ph/jobseekers/job/1" }];
    await tick("check-jobs");
    ext.pages.onlinejobsph = [
      { id: "2", title: "PHP Developer II", url: "https://www.onlinejobs.ph/jobseekers/job/2" },
      ...ext.pages.onlinejobsph,
    ];
    await tick("check-jobs");
    await drive();

    expect(ext.local().feed.map((e) => e.sourceKey)).toEqual(["onlinejobsph:2"]);
    expect(ext.local().feed[0].watchId).toBe(OJ.id);
    // A watch added meanwhile is this browser's, like the rest.
    expect(await ext.send({ type: "add-watch", url: GLASSDOOR_URL, label: "Glassdoor" })).toEqual({ ok: true, error: null });
    expect(ext.watches().map((w) => w.url)).toEqual([OJ_URL, GLASSDOOR_URL]);
    expect(dataCalls()).toEqual([]);
    // And the offer counts what there is now.
    expect(await status()).toEqual({ phase: "offered", again: false, watches: 2, listings: 1, settings: true });
  });

  it("asks again next time when the popup was closed without an answer", async () => {
    await paired();
    expect((await status()).phase).toBe("offered");

    await ext.restartWorker();
    await tick("check-jobs");
    await drive();

    expect(await status()).toEqual({ phase: "offered", again: false, watches: 5, listings: 2, settings: false });
    expect(dataCalls()).toEqual([]);
    expect(ext.watches()).toEqual(WATCHES);
  });

  it("stays on hold, sending nothing, until WatchDesk has said whose the account is", async () => {
    ext = await startExtension({ local: { feed: [entry(OJ, 1)] } });
    ext.api.setCurrent(ext.api.networkError);
    await ext.pair();
    await drive(90000);

    expect(await status()).toEqual({ phase: "checking" });
    await ext.send({ type: "sync-watches" });
    await tick("check-jobs");
    await drive(90000);
    expect(dataCalls()).toEqual([]);
    expect(record()).toEqual({ phase: "connecting" });

    // The popup asks who it is (WD-73); the answer settles the question.
    ext.api.setCurrent(() =>
      ext.api.json(200, { account: { email: ADA, displayName: null }, device: { id: "d1", label: "Chrome" } }),
    );
    await ext.send({ type: "account-refresh" });
    expect((await status()).phase).toBe("offered");
    expect(dataCalls()).toEqual([]);
  });

  it("drops the question when the user removes everything it was about", async () => {
    await paired({ watches: [OJ], feed: [entry(OJ, 1)] });
    expect((await status()).phase).toBe("offered");

    await ext.send({ type: "clear-feed" });
    await ext.send({ type: "remove-watch", id: "default" });
    expect(await status()).toBeNull();
    expect(record()).toBeUndefined();
  });
});

describe("a pairing with nothing to ask about", () => {
  it("makes no offer for a browser with no data, and connects as it did before", async () => {
    ext = await startExtension({ watches: null });
    await ext.pair();

    expect(await status()).toBeNull();
    expect(record()).toBeUndefined();
    // WD-54, unchanged: the default watch such a browser is showing goes up.
    expect(await ext.send({ type: "sync-watches" })).toMatchObject({ mode: "account", localOnly: 0 });
    expect(posted().map((r) => r.body.url)).toEqual([OJ_URL]);
  });

  it("makes no offer for a browser that was connected before this existed", async () => {
    ext = await startExtension({ connected: true, synced: false, local: { feed: [entry(OJ, 1)] } });

    expect(await status()).toBeNull();
    await ext.send({ type: "sync-watches" });
    expect(posted()).toHaveLength(5);
  });
});

describe("Import", () => {
  it("uploads the watches, then the feed, then the applied marks, then the settings, and removes nothing here", async () => {
    const feed = [
      entry(OJ, 1, { applied: true, appliedAt: NOW - 5000 }),
      entry(OJ, 2, { visited: true }),
      entry(GD, 3, { applied: true, appliedAt: NOW - 4000 }),
      entry(LI, 4),
      entry(UP, 5),
    ];
    await paired({ feed, sync: { intervalMinutes: 30, soundId: "alert" } });
    // The account as the web app left it; watching is paused there.
    ext.api.setSettings({ watcherState: "paused" });
    const before = ext.api.settings();

    const state = await ext.send({ type: "local-import-accept" });
    expect(state.localImport).toMatchObject({ phase: "importing", step: "watches", problem: null });
    await drive();

    // The account has it all.
    expect(ext.api.watches.map((w) => [w.label, w.enabled])).toEqual(WATCHES.map((w) => [w.label, w.enabled]));
    expect(sourceKeys()).toEqual(["glassdoor:3", "linkedin:4", "onlinejobsph:1", "onlinejobsph:2", "upwork:5"]);
    const statusOf = Object.fromEntries(ext.api.listings.map((row) => [row.sourceKey, row.status]));
    expect(statusOf).toEqual({
      "onlinejobsph:1": "applied",
      "onlinejobsph:2": "new",
      "glassdoor:3": "applied",
      "linkedin:4": "new",
      "upwork:5": "new",
    });
    // Only what the user had stored here, and the watcher state is the
    // account's own, sent back as it was.
    expect(ext.api.settings()).toEqual({ ...before, intervalMinutes: 30, soundId: "alert" });
    const [put] = ext.api.settingsCalls("PUT");
    expect(ext.api.settingsCalls("PUT")).toHaveLength(1);
    expect(put.body).toEqual({ ...before, intervalMinutes: 30, soundId: "alert" });
    expect(put.body.watcherState).toBe("paused");

    // In that order.
    const order = ext.api.requests.map((r) => `${r.method} ${r.path.replace(/listing-\d+$/, ":id")}`);
    const first = (call) => order.indexOf(call);
    const last = (call) => order.lastIndexOf(call);
    expect(last("POST /api/watches")).toBeLessThan(first("POST /api/listings/ingest"));
    expect(last("POST /api/listings/ingest")).toBeLessThan(first("PATCH /api/listings/:id"));
    expect(last("PATCH /api/listings/:id")).toBeLessThan(first("PUT /api/settings"));

    // One watch a request, named by its id on WatchDesk, with the adapter's
    // fields and nothing else: no local id, no detection time, no mark.
    for (const call of ext.api.ingestCalls()) {
      expect(ext.api.watches.map((w) => w.id)).toContain(call.body.watchId);
      for (const listing of call.body.listings) {
        expect(Object.keys(listing).sort()).toEqual(
          ["easyApply", "id", "postedApprox", "postedAt", "postedRaw", "salaryRaw", "title", "url", "workplaceType"].sort(),
        );
      }
    }
    expect(ext.api.ingestCalls().flatMap((call) => call.body.listings.map((l) => l.id)).sort()).toEqual(["1", "2", "3", "4", "5"]);

    // Nothing is removed from this browser: the feed is all there, now under
    // the watches' ids on WatchDesk, marks included.
    const stored = ext.local().feed;
    expect(stored.map((e) => [e.id, e.applied, e.visited])).toEqual(feed.map((e) => [e.id, e.applied, e.visited]));
    expect(new Set(stored.map((e) => e.watchId))).toEqual(new Set(ext.api.watches.slice(0, 5).filter((w) => w.label !== LI_VUE.label).map((w) => w.id)));
    expect(ext.watches().map((w) => w.id)).toEqual(ext.api.watches.map((w) => w.id));

    expect(record()).toEqual({
      phase: "done",
      owner: ADA,
      again: false,
      finishedAt: expect.any(Number),
      counts: {
        watchesUploaded: 5,
        watchesMatched: 0,
        watchesMatchedDiffer: 0,
        watchesRefused: 0,
        listingsUploaded: 5,
        listingsNew: 5,
        listingsExisting: 0,
        // WD-82: the same counts, by site.
        bySite: {
          onlinejobsph: siteCounts({ listingsNew: 2 }),
          glassdoor: siteCounts({ listingsNew: 1 }),
          linkedin: siteCounts({ listingsNew: 1 }),
          upwork: siteCounts({ listingsNew: 1 }),
        },
        listingsNoWatch: 0,
        listingsWatchGone: 0,
        listingsInvalid: 0,
        listingsRefused: 0,
        appliedMarked: 2,
        appliedNotCarried: 0,
        settingsSaved: ["intervalMinutes", "soundId"],
        settingsRefused: [],
        // WD-83: the watches by site too.
        watchesBySite: {
          onlinejobsph: { watchesUploaded: 1, watchesMatched: 0, watchesRefused: 0 },
          glassdoor: { watchesUploaded: 1, watchesMatched: 0, watchesRefused: 0 },
          linkedin: { watchesUploaded: 2, watchesMatched: 0, watchesRefused: 0 },
          upwork: { watchesUploaded: 1, watchesMatched: 0, watchesRefused: 0 },
        },
      },
      // WD-83: what it saved, so that the copy of exactly these settings can
      // be told from any other; no watches had been set aside.
      settings: { intervalMinutes: 30, soundId: "alert" },
      ownTakenAt: null,
    });
    expect(answers()).toEqual({ [ADA]: "accepted" });
    expect(await ext.chrome.alarms.get(IMPORT_ALARM)).toBeUndefined();
    expect(JSON.stringify(ext.local()[IMPORT_KEY])).not.toContain(TEST_TOKEN);

    // The card is closed (WD-83: put away, not removed); the browser is an
    // ordinary connected one.
    expect((await ext.send({ type: "local-import-dismiss" })).localImport).toMatchObject({ phase: "done", closed: true });
    expect((await ext.send({ type: "get-state" })).watchSync).toMatchObject({ mode: "account", localOnly: 0 });
  });

  it("sends a large feed in requests of at most 200 listings, one watch each, spaced out", async () => {
    const feed = [...entries(OJ, 1000, 450), ...entries(GD, 2000, 250), ...entries(UP, 3000, 30)];
    await paired({ feed });
    await accept();

    const calls = ext.api.ingestCalls();
    const idOf = (label) => ext.api.watches.find((w) => w.label === label).id;
    expect(calls.map((call) => [call.body.watchId, call.body.listings.length])).toEqual([
      [idOf(OJ.label), 200],
      [idOf(OJ.label), 200],
      [idOf(OJ.label), 50],
      [idOf(GD.label), 200],
      [idOf(GD.label), 50],
      [idOf(UP.label), 30],
    ]);
    for (let i = 1; i < calls.length; i += 1) {
      expect(calls[i].at - calls[i - 1].at).toBeGreaterThanOrEqual(IMPORT_REQUEST_GAP_MS);
    }
    expect(ext.api.listings).toHaveLength(730);
    expect(new Set(sourceKeys()).size).toBe(730);
    expect(record().counts).toMatchObject({ listingsUploaded: 730, listingsNew: 730 });
    // None of it went through the retry queue, whose cap would have dropped
    // the oldest (WD-60).
    expect(ext.local().watchdeskListingQueue).toBeUndefined();
  });

  it("waits out a 429's Retry-After, says why it stopped, and goes on from where it was", async () => {
    await paired({ feed: [...entries(OJ, 1000, 250), ...entries(GD, 2000, 10)] });
    let refusals = 1;
    ext.api.setIngestRoute((request) => {
      if (request.body.listings.length === 50 && refusals > 0) {
        refusals -= 1;
        return ext.api.json(429, { error: "Too many requests." }, { "Retry-After": "45" });
      }
      return undefined;
    });

    await ext.send({ type: "local-import-accept" });
    await drive(20000);

    expect(await status()).toMatchObject({
      phase: "importing",
      step: "listings",
      listingsDone: 200,
      listingsTotal: 260,
      problem: { message: "WatchDesk is busy.", retryAt: expect.any(Number) },
    });
    const stoppedAt = record().resumeAt;
    expect(stoppedAt - Date.now()).toBeGreaterThan(20000);
    expect(stoppedAt - Date.now()).toBeLessThanOrEqual(45000);
    const sentSoFar = ext.api.ingestCalls().length;
    expect(sentSoFar).toBe(2);
    // Its alarm is set for the end of the wait.
    expect(await ext.chrome.alarms.get(IMPORT_ALARM)).toMatchObject({ when: stoppedAt });

    // Its alarm ticks before the wait is over: nothing is sent.
    await tick(IMPORT_ALARM, 1000);
    expect(ext.api.ingestCalls()).toHaveLength(sentSoFar);

    // And after it: the import carries on with what was left, only.
    await drive(45000);
    await tick(IMPORT_ALARM);

    expect(record().phase).toBe("done");
    expect(ext.api.ingestCalls().map((call) => call.body.listings.length)).toEqual([200, 50, 50, 10]);
    expect(ext.api.listings).toHaveLength(260);
    expect(record().counts).toMatchObject({ listingsUploaded: 260, listingsNew: 260 });
  });

  it("leaves out the one listing WatchDesk refuses and sends the rest of its request", async () => {
    await paired({ feed: [...entries(OJ, 1000, 40), entry(OJ, 666), ...entries(GD, 2000, 3)] });
    // All or nothing, like the real route: one bad listing refuses the batch.
    ext.api.setIngestRoute((request) =>
      request.body.listings.some((listing) => listing.id === "666")
        ? ext.api.json(400, { error: "Check the highlighted fields.", fieldErrors: { "listings.0.title": ["Title is required"] } })
        : undefined,
    );
    await accept();

    expect(record().phase).toBe("done");
    expect(ext.api.listings).toHaveLength(43);
    expect(sourceKeys()).not.toContain("onlinejobsph:666");
    expect(record().counts).toMatchObject({ listingsUploaded: 43, listingsNew: 43, listingsRefused: 1 });
    // Found by halving: far fewer requests than one per listing.
    expect(ext.api.ingestCalls().length).toBeLessThan(16);
    // Still in this browser.
    expect(ext.local().feed.map((e) => e.sourceKey)).toContain("onlinejobsph:666");
  });

  it("carries on after the service worker is stopped mid-import, without sending anything twice", async () => {
    await paired({ feed: [...entries(OJ, 1000, 450), ...entries(GD, 2000, 20)] });
    // The second request never answers: the worker is stopped waiting on it.
    let stuck = true;
    ext.api.setIngestRoute((request) =>
      stuck && request.body.listings[0].id === "1200" ? new Promise(() => {}) : undefined,
    );
    await ext.send({ type: "local-import-accept" });
    await drive(5000);
    expect(record()).toMatchObject({ phase: "importing", step: "listings" });
    expect(record().sent).toHaveLength(200);
    expect(ext.api.listings).toHaveLength(200);

    stuck = false;
    await ext.restartWorker();
    await drive();

    expect(record().phase).toBe("done");
    expect(ext.api.listings).toHaveLength(470);
    expect(new Set(sourceKeys()).size).toBe(470);
    // The first 200 went once; the request that was cut off went again.
    const firstIds = ext.api.ingestCalls().map((call) => call.body.listings[0].id);
    expect(firstIds).toEqual(["1000", "1200", "1200", "1400", "2000"]);
    expect(posted()).toHaveLength(5);
    expect(record().counts).toMatchObject({ watchesUploaded: 5, listingsUploaded: 470, listingsNew: 470 });
  });

  it("never runs twice at once", async () => {
    await paired({ feed: entries(OJ, 1000, 30) });
    await Promise.all([
      ext.send({ type: "local-import-accept" }),
      ext.send({ type: "local-import-accept" }),
      ext.send({ type: "local-import-retry" }),
    ]);
    await tick(IMPORT_ALARM);

    expect(posted()).toHaveLength(5);
    expect(ext.api.ingestCalls()).toHaveLength(1);
    expect(ext.api.settingsCalls("PUT")).toHaveLength(0);
    expect(record().phase).toBe("done");
  });

  it("an account that already has the data gets no duplicates: watches are matched by URL, listings by posting", async () => {
    const feed = [entry(OJ, 1, { applied: true }), entry(GD, 2)];
    await paired({ feed });
    // A second device's account: the same OnlineJobs.ph watch, one of the
    // postings already there with a status of its own, and a watch this
    // browser does not have.
    const theirs = ext.api.addWatch({ url: OJ_URL, label: "My OJ search", enabled: false });
    ext.api.addWatch({ url: "https://www.upwork.com/nx/search/jobs/?q=vue", label: "Upwork Vue" });
    ext.api.listings.push({ listingId: "listing-old", sourceKey: "onlinejobsph:1", watchId: theirs.id, listing: { id: "1" }, status: "interviewing" });

    expect((await status()).phase).toBe("offered");
    await accept();

    expect(posted().map((r) => r.body.label)).toEqual([GD.label, LI.label, LI_VUE.label, UP.label]);
    expect(ext.api.watches.filter((w) => w.url === OJ_URL)).toHaveLength(1);
    // The account's label and paused state win (WD-54's rule, unchanged).
    expect(ext.watch("My OJ search")).toMatchObject({ id: theirs.id, enabled: false });
    expect(sourceKeys()).toEqual(["glassdoor:2", "onlinejobsph:1"]);
    // WatchDesk already had that listing: its own status is left alone.
    expect(ext.api.listings.find((row) => row.sourceKey === "onlinejobsph:1").status).toBe("interviewing");
    expect(ext.api.statusCalls()).toEqual([]);
    expect(record().counts).toMatchObject({
      watchesUploaded: 4,
      watchesMatched: 1,
      listingsUploaded: 2,
      listingsNew: 1,
      appliedMarked: 0,
      appliedNotCarried: 1,
    });
  });

  it("imports only the settings the user stored here, never a default over the account's", async () => {
    await paired({ sync: { soundId: "soft" } });
    const before = ext.api.settings();
    await accept();

    expect(ext.api.settings()).toEqual({ ...before, soundId: "soft" });
    expect(record().counts.settingsSaved).toEqual(["soundId"]);
    // The copy this browser now runs on is the account's.
    expect(ext.sync()).toMatchObject({ intervalMinutes: 15, soundId: "soft", notificationsMuted: true });
  });

  it("sends no settings request at all when none was stored here", async () => {
    await paired();
    await accept();

    expect(record().phase).toBe("done");
    expect(ext.api.settingsCalls()).toEqual([]);
    expect(record().counts).toMatchObject({ settingsSaved: [], settingsRefused: [] });
  });

  it("leaves out a setting WatchDesk's limits refuse, names it, and saves the others", async () => {
    const keywords = Array.from({ length: 101 }, (_, i) => `keyword ${i}`);
    await paired({ sync: { intervalMinutes: 1, titleFilter: { enabled: true, keywords } } });
    await accept();

    expect(ext.api.settings()).toMatchObject({ intervalMinutes: 1, titleFilter: { enabled: true, keywords: ["php"] } });
    expect(record().counts).toMatchObject({
      settingsSaved: ["intervalMinutes"],
      settingsRefused: [{ setting: "titleFilter", reason: "Keep at most 100 keywords" }],
    });
  });

  it("counts, and keeps here, the feed entries that have no watch on WatchDesk", async () => {
    const unsupported = { id: "w_x", siteId: null, url: "https://jobs.example.org/search?q=php", label: "Elsewhere", enabled: true };
    const feed = [
      entry(OJ, 1),
      // Its watch was removed from this browser long ago.
      entry({ id: "w_gone", siteId: "onlinejobsph", label: "Removed" }, 2),
      // Its watch is on a site WatchDesk does not take.
      entry({ ...unsupported, siteId: "elsewhere" }, 3),
      // Not a posting WatchDesk could store.
      entry(OJ, 4, { url: "javascript:alert(1)" }),
      entry(OJ, 5, { title: "" }),
    ];
    await paired({ feed, watches: [OJ, unsupported] });
    await accept();

    expect(sourceKeys()).toEqual(["onlinejobsph:1"]);
    expect(record().counts).toMatchObject({
      watchesUploaded: 1,
      watchesRefused: 1,
      listingsUploaded: 1,
      listingsNoWatch: 2,
      listingsInvalid: 2,
    });
    expect(ext.local().feed).toHaveLength(5);
    // The refused watch stays in this browser's list (WD-54).
    expect(ext.watches().map((w) => w.label)).toEqual([OJ.label, "Elsewhere"]);
  });

  it("drops what is left of a watch's listings when the watch is deleted on WatchDesk mid-import", async () => {
    await paired({ feed: [...entries(OJ, 1000, 250), ...entries(GD, 2000, 5)], watches: [OJ, GD] });
    let calls = 0;
    ext.api.setIngestRoute(() => {
      calls += 1;
      if (calls === 2) ext.api.watches.splice(0, 1);
      return undefined;
    });
    await accept();

    expect(record().phase).toBe("done");
    expect(record().counts).toMatchObject({ listingsUploaded: 205, listingsWatchGone: 50 });
    expect(ext.api.listings).toHaveLength(205);
  });

  it("an entry stored before sourceKey existed is filed under the same posting", async () => {
    const old = entry(OJ, 77);
    delete old.sourceKey;
    delete old.siteId;
    await paired({ feed: [old], watches: [OJ] });
    await accept();

    expect(sourceKeys()).toEqual(["onlinejobsph:77"]);
  });
});

describe("when WatchDesk cannot take a step", () => {
  it("stops where it is with the reason, tries again by itself after a wait that doubles, and Retry tries at once", async () => {
    await paired({ feed: entries(OJ, 1000, 3) });
    ext.api.setWatchRoute(ext.api.networkError);

    await ext.send({ type: "local-import-accept" });
    await drive(1000);
    expect(await status()).toMatchObject({
      phase: "importing",
      step: "watches",
      problem: { message: "Can't reach WatchDesk." },
    });
    expect(record().resumeAt - Date.now()).toBeLessThanOrEqual(IMPORT_RETRY_BASE_MS);
    expect(posted()).toEqual([]);
    expect(ext.watches()).toEqual(WATCHES);

    // Its own retry, a minute on, fails too: the next wait is two.
    await drive(IMPORT_RETRY_BASE_MS);
    await tick(IMPORT_ALARM, 1000);
    expect(record().attempts).toBe(2);
    expect(record().resumeAt - Date.now()).toBeGreaterThan(IMPORT_RETRY_BASE_MS);

    // WatchDesk is back and the user does not wait.
    ext.api.setWatchRoute(() => undefined);
    await ext.send({ type: "local-import-retry" });
    await drive();
    expect(record().phase).toBe("done");
    expect(posted()).toHaveLength(5);
    expect(ext.api.listings).toHaveLength(3);
  });

  it("says to verify the email when WatchDesk will not take watches from the account (403), and finishes once it does", async () => {
    await paired({ feed: [entry(OJ, 1), entry(GD, 2)] });
    let verified = false;
    ext.api.setWatchRoute((request) =>
      request.method === "POST" && !verified ? ext.api.json(403, { error: "Verify your email address." }) : undefined,
    );
    await ext.send({ type: "local-import-accept" });
    await drive(1000);

    expect(await status()).toMatchObject({
      phase: "importing",
      step: "watches",
      problem: {
        message: "WatchDesk isn't accepting this from your account yet. Verify your email address on WatchDesk.",
      },
    });
    expect(ext.api.ingestCalls()).toEqual([]);
    // Nothing was lost from this browser's list.
    expect(ext.watches().map((w) => w.label)).toEqual(WATCHES.map((w) => w.label));

    verified = true;
    await ext.send({ type: "local-import-retry" });
    await drive();
    expect(record().phase).toBe("done");
    expect(ext.api.watches).toHaveLength(5);
    expect(ext.api.listings).toHaveLength(2);
  });

  it("holds the settings step, not the rest, when only the settings route is down", async () => {
    await paired({ feed: [entry(OJ, 1)], sync: { soundId: "soft" } });
    ext.api.setSettingsRoute(() => ext.api.json(503, { error: "Unavailable" }));
    await ext.send({ type: "local-import-accept" });
    await drive(30000);

    expect(await status()).toMatchObject({ phase: "importing", step: "settings", problem: { message: "WatchDesk couldn't take it just now." } });
    expect(ext.api.listings).toHaveLength(1);

    ext.api.setSettingsRoute(() => undefined);
    await ext.send({ type: "local-import-retry" });
    await drive();
    expect(record().phase).toBe("done");
    expect(ext.api.settings().soundId).toBe("soft");
    // The steps before it were not done again.
    expect(posted()).toHaveLength(5);
    expect(ext.api.ingestCalls()).toHaveLength(1);
  });
});

describe("Not now", () => {
  it("uploads nothing, keeps this browser's data, and starts with the account as it is", async () => {
    const feed = [entry(OJ, 1, { applied: true }), entry(GD, 2)];
    await paired({ feed, sync: { intervalMinutes: 30 } });
    const accountBefore = ext.api.settings();

    const state = await ext.send({ type: "local-import-decline" });
    expect(state.localImport).toEqual({ phase: "declined", available: true, watches: 5, listings: 2, settings: false });
    expect(answers()).toEqual({ [ADA]: "declined" });
    expect(dataCalls()).toEqual([]);
    // Set aside before anything replaces the stored list.
    expect(ext.local()[WATCHES_SNAPSHOT_KEY]).toEqual({ takenAt: Date.now(), watches: WATCHES });

    // Now the browser works with the account: its (empty) list and its
    // settings.
    await ext.send({ type: "sync-watches" });
    await ext.send({ type: "sync-settings" });
    await drive();

    expect(posted()).toEqual([]);
    expect(ext.api.ingestCalls()).toEqual([]);
    expect(ext.api.watches).toEqual([]);
    expect(ext.api.listings).toEqual([]);
    // The watcher state is reported as ever (WD-71); no setting of this
    // browser's goes with it.
    for (const put of ext.api.settingsCalls("PUT")) {
      expect(put.body).toEqual({ ...accountBefore, watcherState: put.body.watcherState });
    }
    expect(ext.api.settings()).toMatchObject({ intervalMinutes: 15, soundId: "ping" });

    // Untouched in this browser: the feed as it was, the watches set aside,
    // the settings kept (WD-79).
    expect(ext.local().feed).toEqual(feed);
    expect(ext.local()[WATCHES_SNAPSHOT_KEY].watches).toEqual(WATCHES);
    expect(ext.local()[SETTINGS_SNAPSHOT_KEY].settings).toEqual({ intervalMinutes: 30 });
    expect(ext.watches()).toEqual([]);
    const after = await ext.send({ type: "get-state" });
    expect(after.watchSync).toMatchObject({ mode: "account", localOnly: 0 });
    expect(after.settings.watches).toEqual([]);
    expect(after.localImport).toEqual({ phase: "declined", available: true, watches: 5, listings: 2, settings: true });
  });

  it("a watch whose URL the account already has becomes that watch; the others are set aside, never uploaded", async () => {
    await paired({ feed: [entry(OJ, 1)] });
    const theirs = ext.api.addWatch({ url: OJ_URL, label: "My OJ search" });

    await ext.send({ type: "local-import-decline" });
    await ext.send({ type: "sync-watches" });
    await tick("check-jobs");
    await drive();

    expect(posted()).toEqual([]);
    expect(ext.watches()).toEqual([{ id: theirs.id, siteId: "onlinejobsph", url: OJ_URL, label: "My OJ search", enabled: true }]);
    expect(ext.local()[WATCHES_SNAPSHOT_KEY].watches.map((w) => w.label)).toEqual(WATCHES.map((w) => w.label));
    // Its feed entry follows it, so the next check does not start over.
    expect(ext.local().feed[0].watchId).toBe(theirs.id);
  });

  it("the settings panel's import then uploads what was set aside", async () => {
    const feed = [entry(OJ, 1, { applied: true }), entry(GD, 2)];
    await paired({ feed, sync: { soundId: "soft" } });
    await ext.send({ type: "local-import-decline" });
    await ext.send({ type: "sync-watches" });
    await ext.send({ type: "sync-settings" });
    // Meanwhile a watch was made on the web.
    ext.api.addWatch({ url: "https://www.upwork.com/nx/search/jobs/?q=vue", label: "Upwork Vue" });
    await ext.send({ type: "sync-watches" });
    await drive();

    const asked = await ext.send({ type: "local-import-again" });
    expect(asked.localImport).toEqual({ phase: "offered", again: true, watches: 5, listings: 2, settings: true });
    // The question being open again holds nothing: the browser is working
    // with the account.
    expect(asked.watchSync.mode).toBe("account");
    expect(posted()).toEqual([]);

    await accept();

    expect(record().phase).toBe("done");
    expect(ext.api.watches.map((w) => w.label)).toEqual(["Upwork Vue", ...WATCHES.map((w) => w.label)]);
    expect(ext.watches().map((w) => w.label)).toEqual(["Upwork Vue", ...WATCHES.map((w) => w.label)]);
    expect(sourceKeys()).toEqual(["glassdoor:2", "onlinejobsph:1"]);
    expect(ext.api.listings.find((row) => row.sourceKey === "onlinejobsph:1").status).toBe("applied");
    expect(ext.api.settings().soundId).toBe("soft");
    expect(record()).toMatchObject({ again: true, counts: { watchesUploaded: 5, listingsUploaded: 2, appliedMarked: 1, settingsSaved: ["soundId"] } });
    expect(answers()).toEqual({ [ADA]: "accepted" });
  });

  it("asked again and answered no again, everything stays as it was", async () => {
    await paired();
    await ext.send({ type: "local-import-decline" });
    await ext.send({ type: "sync-watches" });
    await ext.send({ type: "local-import-again" });

    const state = await ext.send({ type: "local-import-decline" });
    await ext.send({ type: "sync-watches" });
    await drive();

    expect(state.localImport.phase).toBe("declined");
    expect(posted()).toEqual([]);
    expect(ext.local()[WATCHES_SNAPSHOT_KEY].watches).toEqual(WATCHES);
  });
});

describe("which pairing is the first", () => {
  it("does not ask an account that said yes again, and connects it as before", async () => {
    await paired({ feed: [entry(OJ, 1)] });
    await accept();
    await ext.send({ type: "local-import-dismiss" });
    const uploads = posted().length;

    await loseConnection();
    await ext.send({ type: "add-watch", url: "https://www.upwork.com/nx/search/jobs/?q=vue", label: "Upwork Vue" });
    await pairAs(ADA);

    expect(await status()).toBeNull();
    // WD-54, unchanged: the watch added while disconnected goes up.
    await ext.send({ type: "sync-watches" });
    expect(posted()).toHaveLength(uploads + 1);
    expect(answers()).toEqual({ [ADA]: "accepted" });
  });

  it("does not ask an account that said no again, and still uploads nothing to it", async () => {
    await paired({ feed: [entry(OJ, 1)] });
    await ext.send({ type: "local-import-decline" });
    // Disconnected before the first sync ever ran: the stored list is still
    // this browser's own.
    await loseConnection();
    await pairAs(ADA);

    expect((await status()).phase).toBe("declined");
    await ext.send({ type: "sync-watches" });
    await drive();
    expect(posted()).toEqual([]);
    expect(ext.api.ingestCalls()).toEqual([]);
    expect(ext.local()[WATCHES_SNAPSHOT_KEY].watches).toEqual(WATCHES);
  });

  it("asks a different account afresh, and sends it nothing without its own answer", async () => {
    await paired({ feed: [entry(OJ, 1)], sync: { soundId: "soft" } });
    await accept();
    await ext.send({ type: "local-import-dismiss" });
    await loseConnection();
    const before = dataCalls().length;

    await pairAs(BOB);
    const state = await ext.send({ type: "get-state" });

    expect(state.localImport).toMatchObject({ phase: "offered", again: false, watches: 5, listings: 1 });
    expect(record()).toEqual({ phase: "offered", owner: BOB });
    await ext.send({ type: "sync-watches" });
    await ext.send({ type: "sync-settings" });
    await tick("check-jobs");
    await drive();
    expect(dataCalls()).toHaveLength(before);
    expect(answers()).toEqual({ [ADA]: "accepted" });

    await ext.send({ type: "local-import-decline" });
    expect(answers()).toEqual({ [ADA]: "accepted", [BOB]: "declined" });
  });
});

describe("what the import keeps in storage, on a reset and on a disconnection", () => {
  const KEPT = [IMPORT_KEY, IMPORT_ANSWERS_KEY, IMPORT_INTERRUPTED_KEY, WATCHES_SNAPSHOT_KEY];
  const kept = () => Object.fromEntries(KEPT.filter((key) => key in ext.local()).map((key) => [key, ext.local()[key]]));

  it("Reset Extension clears the answer, the watches set aside and the record", async () => {
    await paired({ feed: [entry(OJ, 1)] });
    await ext.send({ type: "local-import-decline" });
    await ext.send({ type: "sync-watches" });
    expect(Object.keys(kept()).sort()).toEqual([IMPORT_KEY, IMPORT_ANSWERS_KEY, WATCHES_SNAPSHOT_KEY].sort());

    await ext.send({ type: "reset-extension" });

    expect(kept()).toEqual({});
    expect(await status()).toBeNull();
    // An ordinary connected browser: the account's watches are untouched,
    // and nothing of the old list comes back or goes up.
    await ext.send({ type: "sync-watches" });
    await drive();
    expect(posted()).toEqual([]);
    expect(ext.watches()).toEqual([]);
  });

  it("Reset Extension ends an import that is under way, and clears one put by for another account", async () => {
    await paired({ feed: entries(OJ, 1000, 3) });
    ext.api.setIngestRoute(ext.api.networkError);
    await ext.send({ type: "local-import-accept" });
    await drive(30000);
    expect(record()).toMatchObject({ phase: "importing", step: "listings" });
    await ext.chrome.storage.local.set({ [IMPORT_INTERRUPTED_KEY]: { [BOB]: { phase: "importing", owner: BOB } } });
    ext.api.setIngestRoute(() => undefined);

    await ext.send({ type: "reset-extension" });
    await tick(IMPORT_ALARM);

    expect(kept()).toEqual({});
    expect(await ext.chrome.alarms.get(IMPORT_ALARM)).toBeUndefined();
    expect(ext.api.listings).toEqual([]);
  });

  it("Reset Extension leaves an unanswered question open, so nothing starts syncing without an answer", async () => {
    await paired({ watches: [OJ], feed: [entry(OJ, 1)] });
    await ext.chrome.storage.local.set({ [IMPORT_ANSWERS_KEY]: { [BOB]: "accepted" } });

    await ext.send({ type: "reset-extension" });
    await ext.send({ type: "sync-watches" });
    await tick("check-jobs");

    // Asked about what the reset left: the default watch and settings.
    expect(kept()).toEqual({ [IMPORT_KEY]: { phase: "offered", owner: ADA } });
    expect(await status()).toEqual({ phase: "offered", again: false, watches: 1, listings: 0, settings: true });
    expect(dataCalls()).toEqual([]);
  });

  it.each([
    ["the question is open", async () => {}],
    ["the user said no", async () => { await ext.send({ type: "local-import-decline" }); await ext.send({ type: "sync-watches" }); }],
    ["the import is done", async () => { await accept(); }],
  ])("a disconnection removes none of it (%s)", async (_name, answer) => {
    await paired({ feed: [entry(OJ, 1)] });
    await answer();
    const before = kept();
    expect(Object.keys(before)).toContain(IMPORT_KEY);
    const feed = ext.local().feed;

    await loseConnection();

    expect(kept()).toEqual(before);
    expect(ext.local().feed).toEqual(feed);
    // With no account connected there is nothing to show for it.
    expect(await status()).toBeNull();
  });
});

describe("an import belongs to one account", () => {
  it("stops when the browser is disconnected, and the same account connecting again carries it on", async () => {
    await paired({ feed: [...entries(OJ, 1000, 250), ...entries(GD, 2000, 5)] });
    let revoked = false;
    ext.api.setIngestRoute((request) => {
      if (request.body.listings.length === 50) revoked = true;
      return revoked ? ext.api.json(401, { error: "Sign in to continue." }) : undefined;
    });
    await ext.send({ type: "local-import-accept" });
    await drive();

    expect(ext.local()[TOKEN_KEY]).toBeUndefined();
    expect(record()).toMatchObject({ phase: "importing", owner: ADA, step: "listings" });
    expect(record().sent).toHaveLength(200);
    const sentBefore = ext.api.ingestCalls().length;
    // Disconnected, there is nothing to show and nothing is tried.
    expect(await status()).toBeNull();
    await tick(IMPORT_ALARM);
    await drive();
    expect(ext.api.ingestCalls()).toHaveLength(sentBefore);
    expect(await ext.chrome.alarms.get(IMPORT_ALARM)).toBeUndefined();

    revoked = false;
    ext.api.setIngestRoute(() => undefined);
    await pairAs(ADA);
    expect((await status()).phase).toBe("importing");
    await ext.send({ type: "local-import-retry" });
    await drive();

    expect(record().phase).toBe("done");
    expect(ext.api.listings).toHaveLength(255);
    expect(new Set(sourceKeys()).size).toBe(255);
    expect(record().counts).toMatchObject({ listingsUploaded: 255 });
  });

  it("is dropped when a different account connects, which is asked its own question and sent nothing", async () => {
    await paired({ feed: [...entries(OJ, 1000, 250), ...entries(GD, 2000, 5)] });
    let revoked = false;
    ext.api.setIngestRoute((request) => {
      if (request.body.listings.length === 50) revoked = true;
      return revoked ? ext.api.json(401, { error: "Sign in to continue." }) : undefined;
    });
    await ext.send({ type: "local-import-accept" });
    await drive();
    expect(record()).toMatchObject({ phase: "importing", owner: ADA });
    const before = dataCalls().length;

    ext.api.setIngestRoute(() => undefined);
    await pairAs(BOB);

    expect(await status()).toMatchObject({ phase: "offered", again: false });
    expect(record()).toEqual({ phase: "offered", owner: BOB });
    await ext.send({ type: "local-import-retry" });
    await tick(IMPORT_ALARM);
    await tick("check-jobs");
    await drive();
    expect(dataCalls()).toHaveLength(before);
  });

  it("is put by while another account is connected, and finished when its own account is back", async () => {
    await paired({ feed: [...entries(OJ, 1000, 250), ...entries(GD, 2000, 5)], sync: { soundId: "soft" } });
    let revoked = false;
    ext.api.setIngestRoute((request) => {
      if (request.body.listings.length === 50) revoked = true;
      return revoked ? ext.api.json(401, { error: "Sign in to continue." }) : undefined;
    });
    await ext.send({ type: "local-import-accept" });
    await drive();
    expect(record()).toMatchObject({ phase: "importing", owner: ADA, step: "listings" });
    expect(ext.api.listings).toHaveLength(200);
    revoked = false;
    ext.api.setIngestRoute(() => undefined);

    // Bob connects, is asked his own question, says no, and uses the browser.
    await pairAs(BOB);
    expect(await status()).toMatchObject({ phase: "offered", again: false });
    expect(ext.local()[IMPORT_INTERRUPTED_KEY]).toEqual({ [ADA]: expect.objectContaining({ phase: "importing", owner: ADA }) });
    const adasWatches = ext.api.watches.splice(0);
    const adasListings = ext.api.listings.splice(0);
    await ext.send({ type: "local-import-decline" });
    await ext.send({ type: "sync-watches" });
    await tick("check-jobs");
    // Nothing of Ada's import went to Bob's (empty) account.
    expect(ext.api.watches).toEqual([]);
    expect(ext.api.listings).toEqual([]);
    expect(posted()).toHaveLength(5);

    // Ada is back: not asked again, and the rest of her import goes up.
    await loseConnection();
    ext.api.watches.push(...adasWatches);
    ext.api.listings.push(...adasListings);
    await pairAs(ADA);
    expect(await status()).toMatchObject({ phase: "importing" });
    expect(ext.local()[IMPORT_INTERRUPTED_KEY]).toBeUndefined();
    await ext.send({ type: "local-import-retry" });
    await drive();

    expect(record()).toMatchObject({ phase: "done", owner: ADA });
    expect(ext.api.listings).toHaveLength(255);
    expect(new Set(sourceKeys()).size).toBe(255);
    // What was sent before the switch was not sent again.
    expect(ext.api.ingestCalls().filter((call) => call.body.listings.length === 200)).toHaveLength(1);
    expect(record().counts).toMatchObject({ listingsUploaded: 255 });
    expect(ext.api.settings().soundId).toBe("soft");
    expect(answers()).toEqual({ [ADA]: "accepted", [BOB]: "declined" });
  });

  it("sends nothing more once the token is another one, even with a request in flight", async () => {
    await paired({ feed: [...entries(OJ, 1000, 250), ...entries(GD, 2000, 5)], sync: { soundId: "soft" } });
    // The second request is still out when another pairing completes.
    let release;
    ext.api.setIngestRoute((request) =>
      request.body.listings.length === 50 && !release
        ? new Promise((resolve) => {
            release = () => resolve(ext.api.json(200, { watchId: request.body.watchId, siteId: "onlinejobsph", received: 50, inserted: [] }));
          })
        : undefined,
    );
    await ext.send({ type: "local-import-accept" });
    await drive(5000);
    expect(release).toBeTypeOf("function");

    // What completePairing() writes, in one call: a new token, no account
    // name yet, and the hold.
    await ext.chrome.storage.local.set({
      [TOKEN_KEY]: "wd_another.token-of-another-account",
      watchdeskAccount: null,
      [IMPORT_KEY]: { phase: "connecting", interrupted: record() },
    });
    const before = ext.api.requests.length;
    release();
    await drive();

    // The answer that came back was the old account's; nothing follows it,
    // and nothing of the old import is written over the new connection.
    expect(ext.api.requests.slice(before).filter((r) => r.path !== "/api/devices/current")).toEqual([]);
    expect(ext.api.requests.every((r) => r.headers.Authorization !== "Bearer wd_another.token-of-another-account" || r.path === "/api/devices/current")).toBe(true);
    expect(record().phase).toBe("connecting");
    expect(ext.api.settingsCalls("PUT")).toEqual([]);
  });

  it("each request goes out with the token the run began with, or not at all", async () => {
    await paired({ feed: [...entries(OJ, 1000, 250), ...entries(GD, 2000, 5)], sync: { soundId: "soft" } });
    // The stored token is replaced under a run, with nothing else changed:
    // not something a pairing does (it replaces the record too), which is
    // why the requests are bound to the connection and not left to that.
    ext.api.setIngestRoute((request) => {
      if (request.body.listings.length === 200) {
        ext.chrome.storage.local.set({ [TOKEN_KEY]: "wd_another.token-of-another-account" });
      }
      return undefined;
    });
    await ext.send({ type: "local-import-accept" });
    await drive();

    expect(ext.api.ingestCalls()).toHaveLength(1);
    expect(ext.api.statusCalls()).toEqual([]);
    expect(ext.api.settingsCalls("PUT")).toEqual([]);
    expect(ext.api.requests.filter((r) => r.headers.Authorization !== `Bearer ${TEST_TOKEN}` && r.path !== "/api/devices/current" && r.path.startsWith("/api/") && !r.path.startsWith("/api/auth/"))).toEqual([]);
    expect(record()).toMatchObject({ phase: "importing", step: "listings" });
    expect(record().sent).toHaveLength(200);
  });

  it("is not carried on while the connected account goes by another name", async () => {
    await paired({ feed: entries(OJ, 1000, 3) });
    ext.api.setWatchRoute(ext.api.networkError);
    await ext.send({ type: "local-import-accept" });
    await drive(1000);
    expect(record()).toMatchObject({ phase: "importing", owner: ADA, step: "watches" });
    ext.api.setWatchRoute(() => undefined);

    // WatchDesk now names another account for this browser.
    ext.api.setCurrent(() =>
      ext.api.json(200, { account: { email: BOB, displayName: null }, device: { id: "d1", label: "Chrome" } }),
    );
    await ext.send({ type: "account-refresh" });
    await ext.send({ type: "local-import-retry" });
    await tick(IMPORT_ALARM);

    expect(posted()).toEqual([]);
    expect(ext.api.ingestCalls()).toEqual([]);
    expect(record()).toMatchObject({ phase: "importing", owner: ADA, step: "watches" });
  });
});
