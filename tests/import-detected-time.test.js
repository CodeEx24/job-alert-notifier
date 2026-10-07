// WD-117: the import of a browser's own feed tells WatchDesk when each
// listing was first found, so that months of history are not all dated the
// day of the import. Driven through the real service worker and a real
// pairing against the fake WatchDesk, which takes a `detectedAt` the way the
// real route does (an ISO 8601 string or a 400; used only for a new listing
// and only within its limits; the answer says what became of each).
//
// What is sent and in which form; what is left out rather than sent badly;
// that a check cycle and its retry queue never send one; that sending again
// says the same; that the answer is read whatever it holds; that no existing
// count changes; and that an import announces nothing.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startExtension, NOW, WATCHES } from "./helpers/popup-harness.js";
import { IMPORT_KEY, LISTING_QUEUE_KEY } from "../account-connection.js";
import { toListing } from "../listing-ingest.js";
import { describeImport, describeReport } from "../popup-local-import.js";

const [OJ, GD] = WATCHES;
const ADA = "ada@example.com";
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const iso = (ms) => new Date(ms).toISOString();
// The one form a time is sent in.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
  detectedAt: NOW - n * DAY,
  visited: false,
  applied: false,
  appliedAt: null,
  ...extra,
});
// An entry with no detectedAt at all, as one stored before the field existed.
const undatedEntry = (watch, n) => {
  const made = entry(watch, n);
  delete made.detectedAt;
  return made;
};

let ext;
let page;
afterEach(() => ext?.dispose());

const record = () => ext.local()[IMPORT_KEY];
const counts = () => record().counts;
const drive = async (ms = 5 * 60 * 1000) => {
  await vi.advanceTimersByTimeAsync(ms);
  await ext.settle();
};
const tick = async (name) => {
  const done = ext.chrome.alarms.onAlarm.dispatch({ name, scheduledTime: Date.now() });
  await drive();
  await done;
};
const row = (sourceKey) => ext.api.listings.find((r) => r.sourceKey === sourceKey);
// Every listing of every ingest request so far, in the order sent.
const sentListings = () => ext.api.ingestCalls().flatMap((call) => call.body.listings);
const sentListing = (id) => sentListings().find((listing) => listing.id === String(id));
// The six counts that say what became of every feed entry (WD-82).
const SIX = ["listingsNew", "listingsExisting", "listingsRefused", "listingsWatchGone", "listingsNoWatch", "listingsInvalid"];
const accountedFor = (held) => SIX.reduce((sum, name) => sum + held[name], 0);

// A browser that has been in use, paired with an account for the first time,
// with the popup opened once: the question is asked.
async function paired({ feed, watches = [OJ], sync = {} }) {
  ext = await startExtension({ watches, sync, local: { feed } });
  ext.api.setCurrent(() =>
    ext.api.json(200, { account: { email: ADA, displayName: null }, device: { id: "d1", label: "Chrome" } }),
  );
  await ext.pair();
  await ext.send({ type: "get-state" });
  ext.take();
  return ext;
}

async function accept() {
  await ext.send({ type: "local-import-accept" });
  await drive();
}

async function imported(options) {
  await paired(options);
  await accept();
  expect(record().phase).toBe("done");
}

// Whatever a test did, a time was never sent as anything but the ISO string:
// a number is a 400 that refuses the whole request.
afterEach(() => {
  for (const listing of ext ? sentListings() : []) {
    if ("detectedAt" in listing) expect(listing.detectedAt).toMatch(ISO_UTC);
  }
});

describe("what an import's listing request says about when a listing was found", () => {
  it("sends the feed entry's detectedAt as an ISO 8601 string, and the account's listing is dated then", async () => {
    const feed = [entry(OJ, 1), entry(OJ, 40), entry(OJ, 400)];
    await imported({ feed });

    expect(ext.api.ingestCalls()).toHaveLength(1);
    for (const held of feed) {
      const n = held.sourceKey.split(":")[1];
      const sent = sentListing(n);
      expect(sent.detectedAt).toBe(new Date(held.detectedAt).toISOString());
      expect(typeof sent.detectedAt).toBe("string");
      expect(row(held.sourceKey).detectedAt).toBe(iso(held.detectedAt));
    }
    // Months of history, not the day of the import.
    expect(row("onlinejobsph:400").detectedAt).toBe("2025-08-31T09:00:00.000Z");
    // The time is beside the listing's own fields, in the listings array,
    // and nowhere else in the body.
    expect(Object.keys(ext.api.ingestCalls()[0].body).sort()).toEqual(["listings", "watchId"]);
    expect(counts()).toMatchObject({ listingsNew: 3, listingsExisting: 0, listingsUploaded: 3 });
    expect(counts()).not.toHaveProperty("listingsDatedToday");
  });

  // Each of these is a feed entry whose time cannot be sent. A request that
  // carried any of them as it is would be refused whole.
  const UNUSABLE = [
    ["null", null],
    ["not a number (NaN)", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["zero", 0],
    ["a negative number", -1],
    ["a negative date", -86400000],
    ["the number as a string", String(NOW)],
    ["an ISO string", "2026-10-01T09:00:00.000Z"],
    ["a boolean", true],
    ["an object", { at: NOW }],
    ["a number beyond what a Date holds", 8.64e15 + 1],
    ["a number a Date writes with a six-digit year", Date.UTC(10000, 0, 1)],
  ];

  it.each(UNUSABLE)("leaves the field out for an entry whose detectedAt is %s, and still sends the listing", async (_name, value) => {
    await imported({ feed: [entry(OJ, 1), entry(OJ, 2, { detectedAt: value })] });

    expect(ext.api.ingestCalls()).toHaveLength(1);
    expect(sentListing(1).detectedAt).toBe(iso(NOW - DAY));
    expect(sentListing(2)).not.toHaveProperty("detectedAt");
    expect(Object.keys(sentListing(2)).sort()).toEqual(
      ["easyApply", "id", "postedApprox", "postedAt", "postedRaw", "salaryRaw", "title", "url", "workplaceType"].sort(),
    );
    // Stored all the same, dated by WatchDesk.
    expect(row("onlinejobsph:2")).toBeTruthy();
    expect(Date.parse(row("onlinejobsph:2").detectedAt)).toBeGreaterThanOrEqual(NOW);
    expect(counts()).toMatchObject({ listingsNew: 2, listingsRefused: 0, listingsDatedToday: 1 });
  });

  it("leaves the field out for an entry that has no detectedAt at all", async () => {
    await imported({ feed: [undatedEntry(OJ, 1)] });
    expect(sentListing(1)).not.toHaveProperty("detectedAt");
    expect(row("onlinejobsph:1")).toBeTruthy();
    expect(counts()).toMatchObject({ listingsNew: 1, listingsDatedToday: 1 });
  });

  it("one bad entry does not fail a request of 200: it goes in one request and all 200 are stored", async () => {
    const feed = Array.from({ length: 200 }, (_unused, i) => entry(OJ, i + 1, i === 77 ? { detectedAt: NaN } : {}));
    await imported({ feed });

    expect(ext.api.ingestCalls()).toHaveLength(1);
    expect(ext.api.ingestCalls()[0].body.listings).toHaveLength(200);
    expect(ext.api.listings).toHaveLength(200);
    expect(sentListings().filter((listing) => !("detectedAt" in listing)).map((listing) => listing.id)).toEqual(["78"]);
    expect(counts()).toMatchObject({ listingsNew: 200, listingsRefused: 0, listingsDatedToday: 1 });
  });

  it("never sends the number: every time in every request is the string", async () => {
    await imported({ feed: [entry(OJ, 1), entry(OJ, 2, { detectedAt: NOW - 0.5 }), entry(GD, 3)], watches: [OJ, GD] });
    const times = sentListings().map((listing) => listing.detectedAt);
    expect(times).toHaveLength(3);
    for (const time of times) {
      expect(typeof time).toBe("string");
      expect(time).toMatch(ISO_UTC);
    }
    // And the fake refuses a number as the real route does, so a regression
    // here would also show as listings left out.
    expect(counts().listingsRefused).toBe(0);
  });

  it("a posting held under two watches is sent once, with the earliest time this browser has for it", async () => {
    const twin = { ...OJ, id: "watch-oj-twin", label: "The same search again" };
    await imported({
      watches: [OJ, twin],
      // The first entry has no usable time; the second found it a week ago.
      feed: [entry(OJ, 1, { detectedAt: 0 }), entry(twin, 1, { detectedAt: NOW - 7 * DAY })],
    });
    expect(sentListings()).toHaveLength(1);
    expect(sentListing(1).detectedAt).toBe(iso(NOW - 7 * DAY));
    expect(row("onlinejobsph:1").detectedAt).toBe(iso(NOW - 7 * DAY));
    expect(counts()).toMatchObject({ listingsNew: 1, listingsExisting: 1 });
    expect(counts()).not.toHaveProperty("listingsDatedToday");
  });
});

describe("a time WatchDesk does not use", () => {
  const SIX_YEARS = 6 * 365 * DAY;

  it("is sent as it is, not clamped or held back; the listing is stored with WatchDesk's date and counted", async () => {
    const feed = [
      entry(OJ, 1),
      entry(OJ, 2, { detectedAt: NOW - SIX_YEARS }),
      entry(OJ, 3, { detectedAt: NOW + 60 * MINUTE }),
      // A browser clock a little fast: taken, as WatchDesk's own clock.
      entry(OJ, 4, { detectedAt: NOW + 2 * MINUTE }),
    ];
    await imported({ feed });

    expect(sentListing(2).detectedAt).toBe(iso(NOW - SIX_YEARS));
    expect(sentListing(3).detectedAt).toBe(iso(NOW + 60 * MINUTE));
    expect(sentListing(4).detectedAt).toBe(iso(NOW + 2 * MINUTE));
    expect(ext.api.ingestCalls()).toHaveLength(1);

    expect(ext.api.listings).toHaveLength(4);
    expect(row("onlinejobsph:1").detectedAt).toBe(iso(NOW - DAY));
    for (const key of ["onlinejobsph:2", "onlinejobsph:3"]) {
      const stored = Date.parse(row(key).detectedAt);
      expect(stored).toBeGreaterThanOrEqual(NOW);
      expect(stored).toBeLessThanOrEqual(Date.now());
    }
    // Two of the four are dated today; every existing count is what it would
    // have been, and the six still account for every feed entry.
    expect(counts()).toMatchObject({ listingsUploaded: 4, listingsNew: 4, listingsExisting: 0, listingsDatedToday: 2 });
    expect(accountedFor(counts())).toBe(feed.length);
    expect(accountedFor(counts().bySite.onlinejobsph)).toBe(feed.length);
    expect(counts().bySite.onlinejobsph).not.toHaveProperty("listingsDatedToday");
  });

  it("a listing the account already had keeps the date it has there, and is not counted as dated today", async () => {
    await paired({ feed: [entry(OJ, 1), entry(OJ, 2)] });
    const theirs = ext.api.addWatch({ url: OJ.url });
    ext.api.listings.push({
      listingId: "listing-had-1",
      sourceKey: "onlinejobsph:1",
      watchId: theirs.id,
      listing: { id: "1", title: "Job 1", url: "https://jobs.example.com/view/1" },
      status: "viewed",
      detectedAt: "2026-06-01T00:00:00.000Z",
    });
    await accept();

    expect(sentListing(1).detectedAt).toBe(iso(NOW - DAY));
    expect(row("onlinejobsph:1")).toMatchObject({ detectedAt: "2026-06-01T00:00:00.000Z", status: "viewed" });
    expect(row("onlinejobsph:2").detectedAt).toBe(iso(NOW - 2 * DAY));
    expect(counts()).toMatchObject({ listingsNew: 1, listingsExisting: 1 });
    expect(counts()).not.toHaveProperty("listingsDatedToday");
  });

  it("the report says how many were imported with today's date, in the popup", async () => {
    ext = await startExtension({
      watches: [OJ],
      local: { feed: [entry(OJ, 1), entry(OJ, 2, { detectedAt: NOW - SIX_YEARS }), undatedEntry(OJ, 3)] },
    });
    await ext.pair();
    page = await ext.openPopup();
    await page.click(page.$("local-import-accept"));
    await drive();

    const details = [...page.$("local-import-details").children].map((item) => item.textContent);
    expect(page.text("local-import-title")).toBe("Your data was imported");
    expect(page.text("local-import-text")).toBe("1 watch uploaded, 3 listings uploaded.");
    expect(details).toContain(
      "2 listings were imported with today's date: this browser had no date for them that your account accepts.",
    );
    expect(details.join("\n")).not.toContain("found today");
  });
});

describe("what the card says about dates (describeImport)", () => {
  const COUNTS = {
    watchesUploaded: 0,
    watchesMatched: 0,
    watchesMatchedDiffer: 0,
    watchesRefused: 0,
    listingsUploaded: 0,
    listingsNew: 0,
    listingsExisting: 0,
    listingsNoWatch: 0,
    listingsWatchGone: 0,
    listingsInvalid: 0,
    listingsRefused: 0,
    appliedMarked: 0,
    appliedNotCarried: 0,
    settingsSaved: [],
    settingsRefused: [],
  };
  const done = (extra) => describeImport({ phase: "done", counts: { ...COUNTS, listingsUploaded: 9, listingsNew: 9, ...extra } });
  const dateLines = (view) => view.details.filter((line) => /date|found today/.test(line));

  it("before the choice: imported listings keep the date this browser found them", () => {
    const said = "Imported listings keep the date this browser found them. One your account already has keeps the date it has there.";
    for (const status of [{ again: false }, { again: true }, { again: true, redo: true }]) {
      const view = describeImport({ phase: "offered", watches: 1, listings: 3, settings: false, ...status });
      expect(view.details).toContain(said);
      expect(view.details.join("\n")).not.toContain("dated the day of the import");
    }
  });

  it("after it: one line, only when a listing was imported with today's date", () => {
    expect(dateLines(done({ listingsDatedToday: 1 }))).toEqual([
      "1 listing was imported with today's date: this browser had no date for it that your account accepts.",
    ]);
    expect(dateLines(done({ listingsDatedToday: 3 }))).toEqual([
      "3 listings were imported with today's date: this browser had no date for them that your account accepts.",
    ]);
    expect(dateLines(done({ listingsDatedToday: 0 }))).toEqual([]);
    // Not something left out: the listing is in the account.
    expect(done({ listingsDatedToday: 3 })).toMatchObject({ tone: "ok", title: "Your data was imported" });
  });

  it("a report finished before the count was kept renders as it did, without a line about dates", () => {
    const view = done({});
    expect(dateLines(view)).toEqual([]);
    expect(view).toMatchObject({ tone: "ok", title: "Your data was imported", text: "9 listings uploaded." });
    // Nor does a value that is not a count.
    for (const odd of [null, "2", -1, 1.5, NaN]) expect(dateLines(done({ listingsDatedToday: odd }))).toEqual([]);
  });

  it("the table is the same with the count or without it: its totals are still the sums of its rows", () => {
    const held = {
      ...COUNTS,
      listingsUploaded: 9,
      listingsNew: 7,
      listingsExisting: 2,
      listingsRefused: 1,
      bySite: {
        linkedin: { listingsNew: 4, listingsExisting: 2, listingsRefused: 1, listingsWatchGone: 0, listingsNoWatch: 0, listingsInvalid: 0 },
        upwork: { listingsNew: 3, listingsExisting: 0, listingsRefused: 0, listingsWatchGone: 0, listingsNoWatch: 0, listingsInvalid: 0 },
      },
    };
    const report = describeReport({ ...held, listingsDatedToday: 5 });
    expect(report).toEqual(describeReport(held));
    expect(report.total).toEqual(report.rows.reduce((sums, r) => sums.map((sum, i) => sum + r.cells[i]), [0, 0, 0, 0, 0, 0]));
    expect(report.total.slice(3)).toEqual([7, 2, 1]);
  });
});

describe("an answer that says little, nothing or something new about the times", () => {
  // WatchDesk's ordinary answer for a request, with `extra` in place of what
  // it says about the times.
  const answerWith = (extra) =>
    ext.api.setIngestRoute((request) =>
      ext.api.json(200, {
        watchId: request.body.watchId,
        siteId: "onlinejobsph",
        received: request.body.listings.length,
        inserted: request.body.listings.map((listing) => ({ id: `listing-${listing.id}`, jobId: listing.id })),
        ...extra(request.body.listings),
      }),
    );

  it.each([
    ["has no detectedTimes", () => ({})],
    ["has an empty detectedTimes", () => ({ detectedTimes: [] })],
    ["has detectedTimes: null", () => ({ detectedTimes: null })],
    ["has a detectedTimes that is not a list", () => ({ detectedTimes: "out-of-range" })],
    [
      "names an outcome this extension does not know",
      (listings) => ({ detectedTimes: listings.map((l) => ({ jobId: l.id, detectedAt: l.detectedAt, outcome: "postdated" })) }),
    ],
    [
      "holds entries that are not what they should be",
      () => ({ detectedTimes: [null, 7, "x", {}, { jobId: 1, outcome: "out-of-range" }, { outcome: "out-of-range" }, { jobId: "1" }] }),
    ],
    ["says out-of-range of a listing that was not sent", () => ({ detectedTimes: [{ jobId: "999", detectedAt: iso(NOW), outcome: "out-of-range" }] })],
  ])("an answer that %s is read as before: the import ends, with the counts it always had", async (_name, extra) => {
    await paired({ feed: [entry(OJ, 1, { applied: true }), entry(OJ, 2), entry(OJ, 3)] });
    answerWith(extra);
    ext.api.setListingRoute(() => ext.api.json(200, { status: "applied" }));
    await accept();

    expect(record().phase).toBe("done");
    expect(counts()).toMatchObject({
      listingsUploaded: 3,
      listingsNew: 3,
      listingsExisting: 0,
      listingsRefused: 0,
      appliedMarked: 1,
      appliedNotCarried: 0,
      bySite: { onlinejobsph: { listingsNew: 3, listingsExisting: 0 } },
    });
    expect(counts()).not.toHaveProperty("listingsDatedToday");
    expect(accountedFor(counts())).toBe(3);
    // The applied mark still follows the listing WatchDesk said it added.
    expect(ext.api.statusCalls().map((call) => call.path)).toEqual(["/api/listings/listing-1"]);
  });

  it("kept and used need no word of their own; out-of-range is counted only for a listing the request added", async () => {
    await paired({ feed: [entry(OJ, 1), entry(OJ, 2), entry(OJ, 3)] });
    ext.api.setIngestRoute((request) =>
      ext.api.json(200, {
        watchId: request.body.watchId,
        siteId: "onlinejobsph",
        received: 3,
        // 2 was already there.
        inserted: [
          { id: "listing-1", jobId: "1" },
          { id: "listing-3", jobId: "3" },
        ],
        detectedTimes: [
          { jobId: "1", detectedAt: iso(NOW - DAY), outcome: "used" },
          { jobId: "2", detectedAt: iso(NOW - 90 * DAY), outcome: "out-of-range" },
          { jobId: "3", detectedAt: iso(NOW), outcome: "out-of-range" },
        ],
      }),
    );
    await accept();
    expect(counts()).toMatchObject({ listingsNew: 2, listingsExisting: 1, listingsDatedToday: 1 });
  });
});

describe("sending a listing again", () => {
  it("an import that stopped and was resumed sends the same time, from the stored entry and not from the clock", async () => {
    const feed = [entry(OJ, 1), entry(OJ, 2, { detectedAt: NOW - 30 * DAY })];
    await paired({ feed });
    // WatchDesk cannot take the listings yet.
    ext.api.setIngestRoute(() => ext.api.json(503, { error: "Try again." }));
    await accept();
    expect(record()).toMatchObject({ phase: "importing", step: "listings", problem: { kind: "error" } });
    const first = structuredClone(ext.api.ingestCalls()[0].body.listings);
    const tried = ext.api.ingestCalls().length;

    // Hours later, on a new service worker.
    await vi.advanceTimersByTimeAsync(3 * 60 * MINUTE);
    ext.api.setIngestRoute(() => undefined);
    await ext.restartWorker();
    await ext.send({ type: "local-import-retry" });
    await drive();

    expect(record().phase).toBe("done");
    const again = ext.api.ingestCalls().slice(tried);
    expect(again).toHaveLength(1);
    expect(again[0].body.listings).toEqual(first);
    expect(again[0].body.listings.map((listing) => listing.detectedAt)).toEqual([iso(NOW - DAY), iso(NOW - 30 * DAY)]);
    expect(row("onlinejobsph:2").detectedAt).toBe(iso(NOW - 30 * DAY));
    expect(counts()).not.toHaveProperty("listingsDatedToday");
  });

  it("importing again sends the same times, and the account keeps the dates the first import gave", async () => {
    const feed = [entry(OJ, 1), entry(OJ, 2, { detectedAt: NOW - 30 * DAY })];
    await imported({ feed });
    const first = structuredClone(sentListings());
    const dates = ext.api.listings.map((r) => [r.sourceKey, r.detectedAt]);
    const once = ext.api.ingestCalls().length;

    await vi.advanceTimersByTimeAsync(2 * DAY);
    await ext.send({ type: "local-import-again" });
    await accept();

    expect(record().phase).toBe("done");
    expect(ext.api.ingestCalls().slice(once).flatMap((call) => call.body.listings)).toEqual(first);
    expect(ext.api.listings.map((r) => [r.sourceKey, r.detectedAt])).toEqual(dates);
    // WatchDesk answered "kept" for both: skipped, and not dated today.
    expect(counts()).toMatchObject({ listingsNew: 0, listingsExisting: 2 });
    expect(counts()).not.toHaveProperty("listingsDatedToday");
  });
});

describe("only the import sends a time: a check cycle and its retry queue never do", () => {
  const job = (n, extra = {}) => ({
    id: String(n),
    title: `PHP Developer ${n}`,
    url: `https://www.onlinejobs.ph/jobseekers/job/${n}`,
    ...extra,
  });
  const queue = () => ext.local()[LISTING_QUEUE_KEY];

  it("a posting never becomes a listing with a detectedAt, whatever the posting holds", () => {
    for (const detectedAt of [NOW, iso(NOW), 0, null]) {
      expect(toListing(job(1, { detectedAt }))).not.toHaveProperty("detectedAt");
    }
    expect(Object.keys(toListing(job(1, { detectedAt: NOW }))).sort()).toEqual(
      ["easyApply", "id", "postedApprox", "postedAt", "postedRaw", "salaryRaw", "title", "url", "workplaceType"].sort(),
    );
  });

  it("after an import, a check sends what it read without a time, queued or not, and is the only one that announces anything", async () => {
    await imported({ feed: [entry(OJ, 1)], sync: { notificationsMuted: false } });
    await ext.send({ type: "sync-watches" });
    await ext.send({ type: "sync-settings" });
    ext.api.setSettings({ notificationsMuted: false });
    ext.api.setSite(() => new Response("<html></html>", { status: 200 }));
    const imports = ext.api.ingestCalls().length;
    expect(sentListings().every((listing) => "detectedAt" in listing)).toBe(true);
    const fromChecks = () => ext.api.ingestCalls().slice(imports);

    // The first check takes the baseline; the second finds a new posting.
    // Even a page that named a time for a posting would not get it sent.
    ext.pages.onlinejobsph = [job(11, { detectedAt: NOW - DAY }), job(12, { detectedAt: iso(NOW - DAY) })];
    await tick("check-jobs");
    ext.pages.onlinejobsph = [job(13), ...ext.pages.onlinejobsph];
    await tick("check-jobs");
    expect(fromChecks().length).toBeGreaterThanOrEqual(2);
    expect(ext.chrome.notifications.create).toHaveBeenCalledTimes(1);
    // The feed entry the check made has the time; the request does not.
    expect(ext.local().feed.find((e) => e.sourceKey === "onlinejobsph:13").detectedAt).toEqual(expect.any(Number));

    // WatchDesk is unreachable for a cycle: what the check read waits in the
    // queue, and goes out on the next one.
    ext.api.setIngestRoute(ext.api.networkError);
    ext.pages.onlinejobsph = [job(14), ...ext.pages.onlinejobsph];
    await tick("check-jobs");
    expect(queue().items.length).toBeGreaterThan(0);
    for (const item of queue().items) expect(item.listing).not.toHaveProperty("detectedAt");
    expect(JSON.stringify(queue())).not.toContain("detectedAt");
    ext.api.setIngestRoute(() => undefined);
    await tick("check-jobs");
    expect(queue()).toBeUndefined();
    expect(ext.api.listings.map((r) => r.sourceKey)).toContain("onlinejobsph:14");

    const afterImport = fromChecks();
    expect(afterImport.flatMap((call) => call.body.listings).length).toBeGreaterThan(4);
    for (const call of afterImport) {
      expect(Object.keys(call.body).sort()).toEqual(["listings", "watchId"]);
      for (const listing of call.body.listings) expect(listing).not.toHaveProperty("detectedAt");
      expect(JSON.stringify(call.body)).not.toContain("detectedAt");
    }
  });

  it("the only module that writes the field into a request is the import", () => {
    const source = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    // listing-ingest.js (the check cycle and its queue) never names it.
    expect(source("listing-ingest.js")).not.toContain("detectedAt");
    expect(source("local-import.js")).toContain("detectedAt: when.iso");
  });
});

describe("an import announces nothing", () => {
  it("raises no notification, plays no tone and sets no badge for the listings it adds, backdated or not", async () => {
    // Neither this browser nor the account mutes, and a tone is chosen.
    await paired({
      feed: [entry(OJ, 1), entry(OJ, 2, { detectedAt: NOW - 90 * DAY }), entry(OJ, 3, { detectedAt: NOW - 6 * 365 * DAY }), undatedEntry(OJ, 4)],
      sync: { notificationsMuted: false, soundId: "alert" },
    });
    ext.api.setSettings({ notificationsMuted: false, soundId: "alert" });
    ext.chrome.notifications.create.mockClear();
    ext.chrome.action.setBadgeText.mockClear();
    ext.sounds.length = 0;

    await accept();
    // And what an open popup asks for when the import ends.
    await ext.send({ type: "sync-watches" });
    await ext.send({ type: "sync-settings" });
    await ext.send({ type: "get-state" });

    expect(record().phase).toBe("done");
    // WatchDesk named all four as new to the account.
    expect(counts()).toMatchObject({ listingsNew: 4, listingsDatedToday: 2 });
    expect(ext.chrome.notifications.create).not.toHaveBeenCalled();
    expect(ext.sounds).toEqual([]);
    for (const [badge] of ext.chrome.action.setBadgeText.mock.calls) expect(badge.text).toBe("");
  });

  it("the import's code has no way to: it never touches notifications, the badge or the tone", () => {
    const source = readFileSync(new URL("../local-import.js", import.meta.url), "utf8");
    for (const api of ["chrome.notifications", "chrome.action", "chrome.offscreen", "play-sound", "playAlertSound", "updateBadge"]) {
      expect(source).not.toContain(api);
    }
  });
});
