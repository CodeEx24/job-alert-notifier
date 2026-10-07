// WD-82: what the import of a browser's own data does when the account
// already has some of it. Driven through the real service worker and a real
// pairing against the fake WatchDesk, which treats a watch and a posting it
// already holds the way the real routes do (WD-52: a URL is stored as sent
// and may be held twice; WD-57: one row per posting, which a second sighting
// refreshes but never moves or re-statuses).
//
// Two browsers are played: a first device, whose account is empty, and a
// second device, whose account already has overlapping watches and listings.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startExtension, NOW, WATCHES, OJ_URL, GLASSDOOR_URL, LINKEDIN_REACT_URL } from "./helpers/popup-harness.js";
import { IMPORT_KEY, TOKEN_KEY } from "../account-connection.js";
import { WATCHES_SNAPSHOT_KEY } from "../watch-sync.js";
import { IMPORT_ANSWERS_KEY } from "../local-import.js";

const [OJ, GD, LI, LI_VUE, UP] = WATCHES;
const ADA = "ada@example.com";
// The same OnlineJobs.ph search as OJ_URL, as someone else would paste it.
const OJ_SPELLED = "http://onlinejobs.ph/jobseekers/jobsearch/?utm_source=newsletter#results";
// The same LinkedIn search as LINKEDIN_REACT_URL, parameters the other way.
const LI_SPELLED = "https://www.linkedin.com/jobs/search/?sortBy=DD&keywords=react";

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
const siteCounts = (counts) => ({
  listingsNew: 0,
  listingsExisting: 0,
  listingsRefused: 0,
  listingsWatchGone: 0,
  listingsNoWatch: 0,
  listingsInvalid: 0,
  ...counts,
});

let ext;
afterEach(() => ext?.dispose());

const record = () => ext.local()[IMPORT_KEY];
const counts = () => record().counts;
const drive = async (ms = 5 * 60 * 1000) => {
  await vi.advanceTimersByTimeAsync(ms);
  await ext.settle();
};
const posted = () => ext.api.watchCalls("POST");
const row = (sourceKey) => ext.api.listings.find((r) => r.sourceKey === sourceKey);
const sourceKeys = () => ext.api.listings.map((r) => r.sourceKey).sort();
// Every write the extension made to the account's watches other than adding
// one: there must never be any (nothing on WatchDesk is overwritten).
const watchChanges = () => ext.api.watchCalls().filter((r) => r.method === "PATCH" || r.method === "DELETE");
// A posting the account already has, found there by `watch`.
const have = (watch, n, status = "new", listing = {}) => {
  const held = {
    listingId: `listing-had-${n}`,
    sourceKey: `${watch.siteId}:${n}`,
    watchId: watch.id,
    listing: { id: String(n), title: `Job ${n} (as WatchDesk has it)`, url: `https://jobs.example.com/view/${n}`, ...listing },
    status,
  };
  ext.api.listings.push(held);
  return held;
};
const named = (email) => () =>
  ext.api.json(200, { account: { email, displayName: null }, device: { id: "d1", label: "Chrome" } });

// A browser that has been in use, paired with an account for the first time,
// with the popup opened once: the question is asked.
async function paired({ feed = [], watches = WATCHES, local = {} } = {}) {
  ext = await startExtension({ watches, local: { feed, ...local } });
  ext.api.setCurrent(named(ADA));
  await ext.pair();
  await ext.send({ type: "get-state" });
  ext.take();
  return ext;
}

async function accept() {
  await ext.send({ type: "local-import-accept" });
  await drive();
  expect(record().phase).toBe("done");
}

describe("a first device: the account is empty", () => {
  it("everything is added and nothing is matched or skipped", async () => {
    await paired({ feed: [entry(OJ, 1), entry(GD, 2, { applied: true })] });
    await accept();

    expect(posted()).toHaveLength(5);
    expect(sourceKeys()).toEqual(["glassdoor:2", "onlinejobsph:1"]);
    expect(counts()).toMatchObject({
      watchesUploaded: 5,
      watchesMatched: 0,
      watchesMatchedDiffer: 0,
      listingsUploaded: 2,
      listingsNew: 2,
      listingsExisting: 0,
      appliedMarked: 1,
      appliedNotCarried: 0,
    });
  });

  it("two watches of this browser that are the same search are uploaded once, and what both had seen is kept", async () => {
    const again = { id: "w_again", siteId: "onlinejobsph", url: OJ_SPELLED, label: "The same, pasted again", enabled: false };
    await paired({
      watches: [OJ, again],
      feed: [entry(OJ, 1), entry(again, 3)],
      local: { seenIds: { [OJ.id]: ["1", "2"], [again.id]: ["2", "3"] } },
    });
    await accept();

    // One watch on WatchDesk, the first of the two as it was here.
    expect(posted().map((r) => r.body)).toEqual([{ url: OJ_URL, label: OJ.label, enabled: true }]);
    expect(ext.api.watches).toHaveLength(1);
    const [{ id }] = ext.api.watches;
    expect(ext.watches().map((w) => w.id)).toEqual([id]);
    // Neither watch's postings are announced as new again.
    expect(ext.local().seenIds).toEqual({ [id]: ["1", "2", "3"] });
    // Both watches' feed is that one watch's, here and on WatchDesk.
    expect(ext.local().feed.map((e) => e.watchId)).toEqual([id, id]);
    expect(ext.api.ingestCalls()).toHaveLength(1);
    expect(ext.api.listings.map((r) => [r.sourceKey, r.watchId])).toEqual([
      ["onlinejobsph:1", id],
      ["onlinejobsph:3", id],
    ]);
    // Said to the user: one watch was not uploaded, and its name and paused
    // state were not kept.
    expect(counts()).toMatchObject({ watchesUploaded: 1, watchesMatched: 1, watchesMatchedDiffer: 1, listingsNew: 2 });
  });

  it("a posting this browser holds under two watches is sent once, to the watch that found it first", async () => {
    const php = { id: "w_php", siteId: "onlinejobsph", url: `${OJ_URL}?jobkeyword=php`, label: "PHP", enabled: true };
    await paired({
      watches: [OJ, php],
      feed: [
        // Found later by the wider search, earlier by the narrower one, where
        // it was marked applied.
        entry(OJ, 7, { detectedAt: NOW - 1000 }),
        entry(php, 7, { detectedAt: NOW - 9000, applied: true, title: "Job 7 as the PHP search read it" }),
        entry(OJ, 8),
      ],
    });
    await accept();

    const phpOnServer = ext.api.watches.find((w) => w.label === "PHP");
    const sent = ext.api.ingestCalls().flatMap((call) => call.body.listings.map((l) => `${call.body.watchId}:${l.id}`));
    expect(sent.filter((key) => key.endsWith(":7"))).toEqual([`${phpOnServer.id}:7`]);
    expect(ext.api.listings.filter((r) => r.sourceKey === "onlinejobsph:7")).toHaveLength(1);
    expect(row("onlinejobsph:7")).toMatchObject({ watchId: phpOnServer.id, status: "applied" });
    expect(row("onlinejobsph:7").listing.title).toBe("Job 7 as the PHP search read it");
    // Three entries here, two postings there: one counted as already had.
    expect(counts()).toMatchObject({
      listingsUploaded: 3,
      listingsNew: 2,
      listingsExisting: 1,
      appliedMarked: 1,
      appliedNotCarried: 0,
      bySite: { onlinejobsph: siteCounts({ listingsNew: 2, listingsExisting: 1 }) },
    });
    // Both entries are still here, as they were.
    expect(ext.local().feed.map((e) => e.id)).toEqual(["default:7", "w_php:7", "default:8"]);
  });
});

describe("a second device: the account already has some of the watches", () => {
  it("a watch that is the same search under another spelling becomes the account's watch, which is left exactly as it is", async () => {
    await paired({ feed: [entry(OJ, 1), entry(LI, 2), entry(LI_VUE, 3)] });
    const theirOj = ext.api.addWatch({ url: OJ_SPELLED, label: "My OJ search", enabled: false });
    const theirLi = ext.api.addWatch({ url: LI_SPELLED, label: LI.label });
    const before = structuredClone(ext.api.watches);

    await accept();

    // Only what the account lacked went up: the other LinkedIn search is a
    // different search, one filter value apart.
    expect(posted().map((r) => r.body.url)).toEqual([GLASSDOOR_URL, LI_VUE.url, UP.url]);
    expect(ext.api.watches.slice(0, 2)).toEqual(before);
    expect(watchChanges()).toEqual([]);
    // This browser now has the account's two, as the account has them.
    expect(ext.watch("My OJ search")).toEqual({ id: theirOj.id, siteId: "onlinejobsph", url: OJ_SPELLED, label: "My OJ search", enabled: false });
    expect(ext.watches().find((w) => w.id === theirLi.id).url).toBe(LI_SPELLED);
    expect(ext.watches().filter((w) => w.siteId === "onlinejobsph")).toHaveLength(1);
    expect(ext.watches().filter((w) => w.siteId === "linkedin")).toHaveLength(2);
    // The local watches' feed is attached to the account's watches.
    expect(ext.local().feed.map((e) => e.watchId).slice(0, 2)).toEqual([theirOj.id, theirLi.id]);
    expect(row("onlinejobsph:1").watchId).toBe(theirOj.id);
    expect(row("linkedin:2").watchId).toBe(theirLi.id);
    expect(row("linkedin:3").watchId).toBe(ext.api.watches.find((w) => w.label === LI_VUE.label).id);
    // Two matched; one of them is named and paused differently there.
    expect(counts()).toMatchObject({ watchesUploaded: 3, watchesMatched: 2, watchesMatchedDiffer: 1, listingsNew: 3, listingsExisting: 0 });
  });

  it("of two watches of the account that are the same search, the one spelled like this browser's is taken, else the oldest", async () => {
    await paired({ watches: [OJ, LI], feed: [entry(OJ, 1), entry(LI, 2)] });
    // WatchDesk allows a search to be held twice (WD-52).
    ext.api.addWatch({ url: OJ_SPELLED, label: "OJ, older, spelled differently" });
    const sameSpelling = ext.api.addWatch({ url: OJ_URL, label: "OJ, newer, same spelling" });
    const oldest = ext.api.addWatch({ url: LI_SPELLED, label: "LinkedIn, older" });
    ext.api.addWatch({ url: `${LINKEDIN_REACT_URL}#x`, label: "LinkedIn, newer" });

    await accept();

    expect(posted()).toEqual([]);
    expect(ext.api.watches).toHaveLength(4);
    expect(row("onlinejobsph:1").watchId).toBe(sameSpelling.id);
    expect(row("linkedin:2").watchId).toBe(oldest.id);
    // All four are the account's, so all four are this browser's list now.
    expect(ext.watches().map((w) => w.id)).toEqual(ext.api.watches.map((w) => w.id));
    expect(counts()).toMatchObject({ watchesUploaded: 0, watchesMatched: 2 });
  });

  it("a watch the account deleted between the question and the answer is uploaded again", async () => {
    await paired({ watches: [OJ], feed: [entry(OJ, 1)] });
    ext.api.addWatch({ url: OJ_URL, label: "Was here when the question was asked" });
    expect((await ext.send({ type: "get-state" })).localImport.phase).toBe("offered");
    // Deleted on the web before the user pressed Import.
    ext.api.watches.length = 0;

    await accept();

    expect(posted().map((r) => r.body)).toEqual([{ url: OJ_URL, label: OJ.label, enabled: true }]);
    expect(ext.api.watches).toHaveLength(1);
    expect(row("onlinejobsph:1").watchId).toBe(ext.api.watches[0].id);
    expect(counts()).toMatchObject({ watchesUploaded: 1, watchesMatched: 0, listingsNew: 1 });
  });

  it("Not now: a watch that is the same search still becomes the account's, and nothing is uploaded", async () => {
    await paired({ watches: [OJ, GD], feed: [entry(OJ, 1)] });
    const theirs = ext.api.addWatch({ url: OJ_SPELLED, label: "My OJ search" });

    await ext.send({ type: "local-import-decline" });
    await ext.send({ type: "sync-watches" });
    await drive();

    expect(posted()).toEqual([]);
    expect(ext.watches().map((w) => w.id)).toEqual([theirs.id]);
    expect(ext.local().feed[0].watchId).toBe(theirs.id);
    // Both are kept aside as they were, the matched one included.
    expect(ext.local()[WATCHES_SNAPSHOT_KEY].watches).toEqual([OJ, GD]);
    expect(ext.api.ingestCalls()).toEqual([]);
  });
});

describe("a second device: the account already has some of the listings", () => {
  it.each(["new", "viewed", "applied", "interviewing", "offer", "rejected", "archived"])(
    "a posting the account has as %j is skipped: not doubled, not marked, its status untouched",
    async (status) => {
      await paired({ watches: [OJ], feed: [entry(OJ, 1, { applied: true }), entry(OJ, 2, { applied: true })] });
      const theirs = ext.api.addWatch({ url: OJ_URL, label: "My OJ search" });
      have(theirs, 1, status);

      await accept();

      expect(sourceKeys()).toEqual(["onlinejobsph:1", "onlinejobsph:2"]);
      expect(row("onlinejobsph:1")).toMatchObject({ listingId: "listing-had-1", watchId: theirs.id, status });
      // The applied mark went only to the posting the import added.
      expect(ext.api.statusCalls().map((r) => r.path)).toEqual([`/api/listings/${row("onlinejobsph:2").listingId}`]);
      expect(row("onlinejobsph:2").status).toBe("applied");
      expect(counts()).toMatchObject({
        listingsUploaded: 2,
        listingsNew: 1,
        listingsExisting: 1,
        appliedMarked: 1,
        appliedNotCarried: 1,
        bySite: { onlinejobsph: siteCounts({ listingsNew: 1, listingsExisting: 1 }) },
      });
    },
  );

  it("a posting the account has under another watch stays with that watch", async () => {
    await paired({ watches: [OJ], feed: [entry(OJ, 1), entry(OJ, 2)] });
    const twin = ext.api.addWatch({ url: OJ_URL, label: "The same search" });
    const other = ext.api.addWatch({ url: `${OJ_URL}?jobkeyword=php`, label: "Another search that found it first" });
    have(other, 1, "interviewing");

    await accept();

    // Sent for the local watch's twin, as every listing of that watch is;
    // WatchDesk keeps the posting where it was.
    expect(ext.api.ingestCalls().map((call) => call.body.watchId)).toEqual([twin.id]);
    expect(row("onlinejobsph:1")).toMatchObject({ watchId: other.id, status: "interviewing" });
    expect(row("onlinejobsph:2").watchId).toBe(twin.id);
    expect(ext.api.listings).toHaveLength(2);
    expect(counts()).toMatchObject({ listingsNew: 1, listingsExisting: 1 });
  });

  it("what WatchDesk does to a posting it already has is what it does on any later sighting, and no more", async () => {
    await paired({
      watches: [OJ],
      feed: [entry(OJ, 1, { title: "Title as this browser read it", salaryRaw: null, workplaceType: null, postedRaw: "5 days ago" })],
    });
    const theirs = ext.api.addWatch({ url: OJ_URL });
    have(theirs, 1, "offer", { salaryRaw: "$10/hr", workplaceType: "Remote", postedRaw: "1 day ago", postedAt: "2026-10-04T00:00:00.000Z" });

    await accept();

    const kept = row("onlinejobsph:1");
    // The page's own words are the ones sent (WD-57: title, URL, Easy Apply).
    expect(kept.listing.title).toBe("Title as this browser read it");
    // What the account knew and this browser did not is not erased, and the
    // first posted date stays.
    expect(kept.listing).toMatchObject({ salaryRaw: "$10/hr", workplaceType: "Remote", postedRaw: "1 day ago", postedAt: "2026-10-04T00:00:00.000Z" });
    expect(kept).toMatchObject({ listingId: "listing-had-1", watchId: theirs.id, status: "offer" });
    // Nothing the extension sends could say otherwise: no status, no watch
    // of its own choosing, no date found.
    for (const call of ext.api.ingestCalls()) {
      expect(Object.keys(call.body).sort()).toEqual(["listings", "watchId"]);
      for (const listing of call.body.listings) {
        expect(listing).not.toHaveProperty("status");
        expect(listing).not.toHaveProperty("applied");
        expect(listing).not.toHaveProperty("detectedAt");
      }
    }
  });

  it("counts what was added, what was already there and what was left out, in all and by site, and they add up to the feed", async () => {
    const feed = [
      entry(OJ, 1),
      entry(OJ, 2),
      entry(GD, 3),
      // WatchDesk refuses this one.
      entry(GD, 666),
      // Not a posting WatchDesk could store.
      entry(OJ, 5, { title: "" }),
      // Its watch was removed from this browser long ago.
      entry({ id: "w_gone", siteId: "upwork", label: "Removed" }, 6),
    ];
    await paired({ watches: [OJ, GD], feed });
    const theirs = ext.api.addWatch({ url: OJ_SPELLED, label: "My OJ search" });
    have(theirs, 1, "applied");
    ext.api.setIngestRoute((request) =>
      request.body.listings.some((listing) => listing.id === "666")
        ? ext.api.json(400, { error: "Check the highlighted fields.", fieldErrors: { "listings.0.title": ["Title is required"] } })
        : undefined,
    );

    await accept();

    expect(sourceKeys()).toEqual(["glassdoor:3", "onlinejobsph:1", "onlinejobsph:2"]);
    const result = counts();
    expect(result).toMatchObject({
      watchesUploaded: 1,
      watchesMatched: 1,
      listingsUploaded: 3,
      listingsNew: 2,
      listingsExisting: 1,
      listingsRefused: 1,
      listingsInvalid: 1,
      listingsNoWatch: 1,
      listingsWatchGone: 0,
    });
    expect(result.bySite).toEqual({
      onlinejobsph: siteCounts({ listingsNew: 1, listingsExisting: 1, listingsInvalid: 1 }),
      glassdoor: siteCounts({ listingsNew: 1, listingsRefused: 1 }),
      upwork: siteCounts({ listingsNoWatch: 1 }),
    });
    const all = ["listingsNew", "listingsExisting", "listingsRefused", "listingsInvalid", "listingsNoWatch", "listingsWatchGone"];
    expect(all.reduce((sum, name) => sum + result[name], 0)).toBe(feed.length);
    for (const name of all) {
      expect(Object.values(result.bySite).reduce((sum, site) => sum + site[name], 0)).toBe(result[name]);
    }
    // The popup is told the same, and nothing but counts.
    const shown = (await ext.send({ type: "get-state" })).localImport;
    expect(shown.counts.bySite).toEqual(result.bySite);
    expect(JSON.stringify(shown)).not.toContain("jobs.example.com");
    // Nothing left this browser.
    expect(ext.local().feed).toHaveLength(feed.length);
  });

  it("counts a listing of a watch deleted on WatchDesk mid-import under its site", async () => {
    await paired({ watches: [OJ, GD], feed: [entry(OJ, 1), entry(GD, 2)] });
    ext.api.setIngestRoute(() => {
      // Deleted on the web once the watches had gone up.
      const at = ext.api.watches.findIndex((w) => w.siteId === "glassdoor");
      if (at >= 0) ext.api.watches.splice(at, 1);
      return undefined;
    });

    await accept();

    expect(counts()).toMatchObject({
      listingsNew: 1,
      listingsWatchGone: 1,
      bySite: { onlinejobsph: siteCounts({ listingsNew: 1 }), glassdoor: siteCounts({ listingsWatchGone: 1 }) },
    });
  });
});

describe("an import that is run again", () => {
  it("a request WatchDesk stored but never answered is sent again, and nothing is doubled or counted twice", async () => {
    const feed = Array.from({ length: 6 }, (_, i) => entry(OJ, 100 + i, { applied: i === 0 }));
    await paired({ watches: [OJ, GD], feed: [...feed, entry(GD, 9)] });
    // The first request is stored, and the worker is stopped before it hears.
    let stuck = true;
    ext.api.setIngestRoute((request) => {
      if (!stuck) return undefined;
      const watch = ext.api.watches.find((w) => w.id === request.body.watchId);
      for (const listing of request.body.listings) have(watch, listing.id, "new");
      return new Promise(() => {});
    });
    await ext.send({ type: "local-import-accept" });
    await drive(5000);
    expect(record()).toMatchObject({ phase: "importing", step: "listings", sent: [] });
    expect(ext.api.listings).toHaveLength(6);

    stuck = false;
    await ext.restartWorker();
    await drive();

    expect(record().phase).toBe("done");
    // Seven postings, seven rows.
    expect(ext.api.listings).toHaveLength(7);
    expect(new Set(sourceKeys()).size).toBe(7);
    // WatchDesk said the six were there already: they are counted once, as
    // that, and their one applied mark could not follow them.
    expect(counts()).toMatchObject({
      listingsUploaded: 7,
      listingsNew: 1,
      listingsExisting: 6,
      appliedMarked: 0,
      appliedNotCarried: 1,
    });
    expect(posted()).toHaveLength(2);
  });

  it("an import that stopped and was tried again counts what it leaves out once, in all and by site", async () => {
    const feed = [entry(OJ, 1), entry(OJ, 5, { title: "" }), entry({ id: "w_gone", siteId: "upwork", label: "Removed" }, 6)];
    await paired({ watches: [OJ], feed });
    ext.api.setIngestRoute(ext.api.networkError);
    await ext.send({ type: "local-import-accept" });
    await drive(30000);
    expect(record()).toMatchObject({ phase: "importing", step: "listings", problem: { kind: "unreachable" } });
    expect(counts()).toMatchObject({ listingsInvalid: 1, listingsNoWatch: 1 });

    ext.api.setIngestRoute(() => undefined);
    await ext.send({ type: "local-import-retry" });
    await drive();

    expect(record().phase).toBe("done");
    expect(counts()).toMatchObject({ listingsNew: 1, listingsExisting: 0, listingsInvalid: 1, listingsNoWatch: 1 });
    expect(counts().bySite).toEqual({
      onlinejobsph: siteCounts({ listingsNew: 1, listingsInvalid: 1 }),
      upwork: siteCounts({ listingsNoWatch: 1 }),
    });
  });

  it("the same data imported into the same account a second time adds nothing and changes nothing", async () => {
    const feed = [entry(OJ, 1, { applied: true }), entry(GD, 2)];
    await paired({ feed });
    await accept();
    expect(counts()).toMatchObject({ watchesUploaded: 5, listingsNew: 2, listingsExisting: 0, appliedMarked: 1 });
    // The user has since moved a listing on and renamed a watch, on the web.
    row("onlinejobsph:1").status = "interviewing";
    ext.api.watches[0].label = "Renamed on the web";
    const watchesBefore = structuredClone(ext.api.watches);
    const listingsBefore = structuredClone(ext.api.listings);
    const postsBefore = posted().length;
    const statusCallsBefore = ext.api.statusCalls().length;

    // A second browser of the same user, played on this one: the device is
    // revoked, storage is put back to the same watches and feed under their
    // local ids with no memory of an import, and it is paired again.
    ext.api.setCurrent(() => ext.api.json(401, { error: "Sign in to continue." }));
    await ext.send({ type: "account-refresh" });
    expect(ext.local()[TOKEN_KEY]).toBeUndefined();
    await ext.chrome.storage.local.remove([IMPORT_KEY, IMPORT_ANSWERS_KEY, "seenIds"]);
    await ext.chrome.storage.local.set({ feed });
    await ext.chrome.storage.sync.set({ watches: WATCHES });
    ext.api.setCurrent(named(ADA));
    await ext.pair();
    expect((await ext.send({ type: "get-state" })).localImport).toMatchObject({ phase: "offered", watches: 5, listings: 2 });

    await accept();

    expect(posted()).toHaveLength(postsBefore);
    expect(watchChanges()).toEqual([]);
    expect(ext.api.statusCalls()).toHaveLength(statusCallsBefore);
    expect(ext.api.watches).toEqual(watchesBefore);
    expect(ext.api.listings).toEqual(listingsBefore);
    expect(counts()).toMatchObject({
      watchesUploaded: 0,
      watchesMatched: 5,
      // The watch renamed on the web keeps that name.
      watchesMatchedDiffer: 1,
      listingsUploaded: 2,
      listingsNew: 0,
      listingsExisting: 2,
      appliedMarked: 0,
      appliedNotCarried: 1,
    });
    expect(ext.watches()[0].label).toBe("Renamed on the web");
  });
});
