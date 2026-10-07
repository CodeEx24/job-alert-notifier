// WD-83: after an import of this browser's own data (WD-81, WD-82) the popup
// shows what was imported, by site, and nothing this browser keeps is
// removed until the user asks for it. Driven through the real service
// worker, a real pairing against the fake WatchDesk, and the real popup.
//
// What is checked: the table and its totals; an import that stopped part of
// the way; the report surviving the popup; that "Remove the earlier copies"
// removes exactly the copies this import put into the account, leaves every
// key the extension works from byte for byte as it was, and is never done by
// anything but the user's second click; and that it acts only on the
// finished import of the account that is connected.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startExtension, NOW, WATCHES } from "./helpers/popup-harness.js";
import { TEST_TOKEN } from "./helpers/fake-watchdesk.js";
import { IMPORT_KEY, TOKEN_KEY } from "../account-connection.js";
import { WATCHES_SNAPSHOT_KEY } from "../watch-sync.js";
import { SETTINGS_SNAPSHOT_KEY } from "../account-settings.js";
import { IMPORT_ALARM, IMPORT_ANSWERS_KEY } from "../local-import.js";
import {
  describeImport,
  describeImportReview,
  describeReport,
  initLocalImport,
  renderLocalImport,
} from "../popup-local-import.js";

const [OJ, GD, LI, LI_VUE, UP] = WATCHES;
const ADA = "ada@example.com";
const BOB = "bob@example.com";
// The same search as OJ, spelled another way (WD-82).
const OJ_SPELLED = "http://onlinejobs.ph/jobseekers/jobsearch/#results";

// A feed entry as background.js stores one.
const entry = (watch, n, extra = {}) => ({
  id: `${watch.id}:${n}`,
  sourceKey: `${watch.siteId}:${n}`,
  siteId: watch.siteId,
  watchId: watch.id,
  watchLabel: watch.label,
  title: `Job ${n}`,
  url: `https://jobs.example.com/view/${n}`,
  postedRaw: null,
  postedAt: null,
  postedApprox: false,
  salaryRaw: null,
  easyApply: false,
  workplaceType: null,
  detectedAt: NOW - n * 60000,
  visited: false,
  applied: false,
  appliedAt: null,
  ...extra,
});

let ext;
let page;
afterEach(() => ext?.dispose());

const local = () => ext.local();
const record = () => local()[IMPORT_KEY];
const status = async () => (await ext.send({ type: "get-state" })).localImport;
const drive = async (ms = 5 * 60 * 1000) => {
  await vi.advanceTimersByTimeAsync(ms);
  await ext.settle();
};
const tick = async (name) => {
  const done = ext.chrome.alarms.onAlarm.dispatch({ name, scheduledTime: Date.now() });
  await drive();
  await done;
};

// A browser that has been in use, paired with an account for the first time
// and asked the question.
async function paired({ feed = [entry(OJ, 1), entry(GD, 2)], sync = { soundId: "soft" }, watches = WATCHES, account = ADA } = {}) {
  ext = await startExtension({ watches, sync, local: { feed } });
  ext.api.setCurrent(() =>
    ext.api.json(200, { account: { email: account, displayName: null }, device: { id: "d1", label: "Chrome" } }),
  );
  await ext.pair();
  await ext.send({ type: "get-state" });
  ext.take();
  return ext;
}

// "Import", to its end, and then what an open popup asks for when it ends:
// the account's list and settings. The settings sync is what keeps the copy
// of the settings this browser had (WD-79).
async function imported(options) {
  await paired(options);
  await ext.send({ type: "local-import-accept" });
  await drive();
  await ext.send({ type: "sync-watches" });
  await ext.send({ type: "sync-settings" });
  expect(record().phase).toBe("done");
  ext.take();
}

// "Not now", then the import asked for from the settings panel: the watches
// set aside are uploaded by it.
async function importedLater(options) {
  await paired(options);
  await ext.send({ type: "local-import-decline" });
  await ext.send({ type: "sync-watches" });
  await ext.send({ type: "sync-settings" });
  await ext.send({ type: "local-import-again" });
  await ext.send({ type: "local-import-accept" });
  await drive();
  await ext.send({ type: "sync-settings" });
  expect(record()).toMatchObject({ phase: "done", again: true });
  ext.take();
}

// The message the popup's second click sends, for the report in storage (or
// the one named).
const confirm = async (finishedAt) =>
  (await ext.send({ type: "local-import-confirm", finishedAt: finishedAt === undefined ? record()?.finishedAt : finishedAt }))
    .localImportConfirmed;

async function loseConnection() {
  ext.api.setCurrent(() => ext.api.json(401, { error: "Sign in to continue." }));
  await ext.send({ type: "account-refresh" });
  expect(local()[TOKEN_KEY]).toBeUndefined();
}

async function pairAs(email) {
  ext.api.setCurrent(() =>
    ext.api.json(200, { account: { email, displayName: null }, device: { id: "d2", label: "Chrome" } }),
  );
  await ext.pair();
  await ext.send({ type: "get-state" });
}

const refuseWatch = (label) =>
  ext.api.setWatchRoute((request) =>
    request.method === "POST" && request.body.label === label
      ? ext.api.json(400, { error: "Check the highlighted fields.", fieldErrors: { url: ["That search is not supported"] } })
      : undefined,
  );

// The popup's card.
const shownButtons = () =>
  [...page.$("local-import").querySelectorAll("button")].filter((b) => !b.hidden).map((b) => b.textContent.trim());
const details = () => [...page.$("local-import-details").children].map((item) => item.textContent);
const cells = (row) => [...row.children].map((cell) => cell.textContent);
const table = () => {
  const found = page.$("local-import-report").querySelector("table");
  if (!found || page.$("local-import-report").hidden) return null;
  return {
    caption: found.querySelector("caption").textContent,
    head: [...found.querySelectorAll("thead tr")].map(cells),
    body: [...found.querySelectorAll("tbody tr")].map(cells),
    foot: cells(found.querySelector("tfoot tr")),
  };
};
const messages = () => ext.take().filter((m) => m.type.startsWith("local-import-"));
// Clicks a button the way a keyboard user does: it has the focus.
const press = async (id) => {
  page.$(id).focus();
  await page.click(page.$(id));
};

// An import with something of everything, on all four sites: a watch the
// account already has, one WatchDesk refuses, a listing the account already
// has, one WatchDesk refuses, one that cannot be stored, two without a watch
// on WatchDesk, two applied marks (one carried, one not), two settings.
const MIXED_FEED = [
  entry(OJ, 1, { applied: true }),
  entry(OJ, 2),
  entry(OJ, 3, { title: "" }),
  entry(GD, 10, { applied: true }),
  entry(GD, 666),
  entry(LI, 20),
  entry(LI, 21),
  entry(LI_VUE, 22),
  entry(UP, 30),
  entry({ id: "w_gone", siteId: "upwork", label: "Removed long ago" }, 31),
];
async function mixedImport() {
  await paired({ feed: MIXED_FEED, sync: { intervalMinutes: 30, soundId: "soft" } });
  const theirs = ext.api.addWatch({ url: OJ_SPELLED, label: "My OJ search" });
  ext.api.listings.push({ listingId: "listing-old", sourceKey: "onlinejobsph:1", watchId: theirs.id, listing: { id: "1" }, status: "interviewing" });
  refuseWatch(LI_VUE.label);
  ext.api.setIngestRoute((request) =>
    request.body.listings.some((listing) => listing.id === "666")
      ? ext.api.json(400, { error: "Check the highlighted fields.", fieldErrors: { "listings.0.title": ["Title is required"] } })
      : undefined,
  );
  page = await ext.openPopup();
  await page.click(page.$("local-import-accept"));
  await drive();
}
const MIXED_ROWS = [
  //          watches: added, already, left out   listings: added, already, left out
  ["LinkedIn", "1", "0", "1", "2", "0", "1"],
  ["Glassdoor", "1", "0", "0", "1", "0", "1"],
  ["Upwork", "1", "0", "0", "1", "0", "1"],
  ["OnlineJobs.ph", "0", "1", "0", "1", "1", "1"],
];

describe("the report of an import that ended: what was imported, by site", () => {
  it("shows, for each of the four sites, the watches and the listings added, already in the account and left out", async () => {
    await mixedImport();

    expect(page.text("local-import-title")).toBe("Your data was imported, with some left out");
    expect(table()).toEqual({
      caption: "What was imported, by site",
      head: [
        ["", "Watches", "Listings"],
        ["Site", "Added", "Already in your account", "Left out", "Added", "Already in your account", "Left out"],
      ],
      body: MIXED_ROWS,
      foot: ["Total", "3", "1", "1", "5", "1", "4"],
    });
    // Why each was left out, in plain words, by site; then the applied
    // marks and the settings.
    expect(details().slice(0, 9)).toEqual([
      "LinkedIn: WatchDesk didn't accept 1 watch. It stays in this browser.",
      "LinkedIn: 1 listing left out, because its watch isn't in your account.",
      "Glassdoor: 1 listing left out, because WatchDesk didn't accept it.",
      "Upwork: 1 listing left out, because its watch isn't in your account.",
      "OnlineJobs.ph: 1 listing left out, because it isn't complete enough to store.",
      "Listings that were left out are still in this browser's feed.",
      "1 applied mark not carried over: WatchDesk already had that listing, and its own status was left as it is.",
      "1 applied mark carried over.",
      "Settings imported: the check interval and the alert sound.",
    ]);
    // No jargon.
    expect(page.$("local-import").textContent).not.toMatch(/source.?key|by.?site\b|skipped|upsert|snapshot/i);
  });

  it("totals that are the sums of the rows, and the counts the import recorded", async () => {
    await mixedImport();

    const { body, foot } = table();
    for (let column = 1; column <= 6; column += 1) {
      expect(body.reduce((sum, row) => sum + Number(row[column]), 0)).toBe(Number(foot[column]));
    }
    const { counts } = record();
    expect(foot.slice(1).map(Number)).toEqual([
      counts.watchesUploaded,
      counts.watchesMatched,
      counts.watchesRefused,
      counts.listingsNew,
      counts.listingsExisting,
      counts.listingsRefused + counts.listingsWatchGone + counts.listingsNoWatch + counts.listingsInvalid,
    ]);
    // Every feed entry is in exactly one of the three listing columns.
    expect(foot.slice(4).reduce((sum, value) => sum + Number(value), 0)).toBe(MIXED_FEED.length);
    // The watches by site add up to the watches in all (the new counts).
    expect(counts.watchesBySite).toEqual({
      onlinejobsph: { watchesUploaded: 0, watchesMatched: 1, watchesRefused: 0 },
      glassdoor: { watchesUploaded: 1, watchesMatched: 0, watchesRefused: 0 },
      linkedin: { watchesUploaded: 1, watchesMatched: 0, watchesRefused: 1 },
      upwork: { watchesUploaded: 1, watchesMatched: 0, watchesRefused: 0 },
    });
    // What WatchDesk has is what the table says was added.
    expect(ext.api.watches).toHaveLength(4);
    expect(ext.api.listings).toHaveLength(6);
  });

  it("is a real table: a caption, a header for every column and row, and every number tied to its headers", async () => {
    await mixedImport();

    const found = page.$("local-import-report").querySelector("table");
    expect(found.querySelector("caption")).not.toBeNull();
    expect([...found.querySelectorAll("thead th")].map((th) => th.getAttribute("scope"))).toEqual([
      "colgroup",
      "colgroup",
      "col",
      "col",
      "col",
      "col",
      "col",
      "col",
      "col",
    ]);
    expect([...found.querySelectorAll("tbody th, tfoot th")].every((th) => th.getAttribute("scope") === "row")).toBe(true);
    const named = (cell) =>
      cell
        .getAttribute("headers")
        .split(" ")
        .map((id) => page.$(id).textContent);
    const numbers = [...found.querySelectorAll("tbody td, tfoot td")];
    expect(numbers).toHaveLength(5 * 6);
    expect(named(numbers[0])).toEqual(["LinkedIn", "Watches", "Added"]);
    expect(named(numbers[5])).toEqual(["LinkedIn", "Listings", "Left out"]);
    expect(named(numbers.at(-2))).toEqual(["Total", "Listings", "Already in your account"]);
    // Ids are not doubled, and the table is the only one.
    const ids = [...page.document.querySelectorAll("[id]")].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(page.document.querySelectorAll("#local-import table")).toHaveLength(1);
    // The popup's one role="status" is still the sync line (WD-73).
    expect([...page.document.querySelectorAll('[role="status"]')].map((node) => node.id)).toEqual(["watch-sync-text"]);
  });

  it("says what became of the settings: imported, none to import, or refused with the reason", async () => {
    const keywords = Array.from({ length: 101 }, (_, i) => `keyword ${i}`);
    await paired({ sync: { soundId: "soft", titleFilter: { enabled: true, keywords } } });
    page = await ext.openPopup();
    await page.click(page.$("local-import-accept"));
    await drive();

    expect(page.text("local-import-title")).toBe("Your data was imported, with some left out");
    expect(details()).toContain("The keyword filter wasn't imported: Keep at most 100 keywords");
    expect(details()).toContain("Settings imported: the alert sound.");

    const none = describeImport({ phase: "done", closed: false, counts: { ...record().counts, settingsSaved: [], settingsRefused: [] } });
    expect(none.details).toContain("No settings were imported: none had been changed in this browser.");
  });

  it("writes everything as text, the table included", async () => {
    // A feed entry can name any site: it is this browser's own storage, but
    // it is still not markup.
    const odd = { id: "w_odd", siteId: "<img src=x onerror=alert(2)>", label: "Odd" };
    await paired({ feed: [entry(OJ, 1), entry(odd, 9)], sync: { soundId: "soft" } });
    ext.api.setSettingsRoute((request) =>
      request.method === "PUT"
        ? ext.api.json(400, { error: "Check the highlighted fields.", fieldErrors: { soundId: ['<img src=x onerror="alert(1)"> not a sound'] } })
        : undefined,
    );
    page = await ext.openPopup();
    await page.click(page.$("local-import-accept"));
    await drive();

    expect(page.$("local-import").querySelector("img")).toBeNull();
    expect(details()).toContain('The alert sound wasn\'t imported: <img src=x onerror="alert(1)"> not a sound');
    expect(table().body.at(-1)).toEqual(["<img src=x onerror=alert(2)>", "0", "0", "0", "0", "0", "1"]);
    expect(page.document.documentElement.innerHTML).not.toContain(TEST_TOKEN);
  });

  it("the second step does not outlive the report it was about, in a popup that stays open", () => {
    const doc = new JSDOM(readFileSync(resolve("popup.html"), "utf8")).window.document;
    const done = {
      phase: "done",
      closed: false,
      finishedAt: NOW,
      confirmable: true,
      redo: false,
      listingsHere: 0,
      copies: { watches: 0, watchesRemovable: false, settings: ["soundId"], settingsRemovable: true },
      counts: { watchesUploaded: 1, watchesMatched: 0, watchesRefused: 0, settingsSaved: ["soundId"], settingsRefused: [] },
    };
    const sent = [];
    initLocalImport({ send: async (message) => sent.push(message), onState: () => {} }, doc);
    const title = () => doc.getElementById("local-import-title").textContent;

    renderLocalImport(done, doc);
    doc.getElementById("local-import-confirm").click();
    expect(title()).toBe("Remove the earlier copies from this browser?");

    // The report is closed, or gone, by something else; when a report is on
    // show again it is the report, not the question about removing.
    for (const between of [{ ...done, closed: true }, null, { phase: "importing", step: "watches", problem: null, counts: done.counts }]) {
      renderLocalImport(between, doc);
      renderLocalImport(done, doc);
      expect(title()).toBe("Your data was imported");
      doc.getElementById("local-import-confirm").click();
      expect(title()).toBe("Remove the earlier copies from this browser?");
    }
    expect(sent).toEqual([]);
  });
});

describe("describeReport: the rows and the totals", () => {
  const NONE = {
    watchesUploaded: 0,
    watchesMatched: 0,
    watchesRefused: 0,
    listingsNew: 0,
    listingsExisting: 0,
    listingsRefused: 0,
    listingsWatchGone: 0,
    listingsNoWatch: 0,
    listingsInvalid: 0,
  };

  it("always lists the four sites, in the same order, with zeros where nothing happened", () => {
    const report = describeReport({ ...NONE, bySite: {}, watchesBySite: {} });
    expect(report.rows.map((row) => [row.name, ...row.cells])).toEqual([
      ["LinkedIn", 0, 0, 0, 0, 0, 0],
      ["Glassdoor", 0, 0, 0, 0, 0, 0],
      ["Upwork", 0, 0, 0, 0, 0, 0],
      ["OnlineJobs.ph", 0, 0, 0, 0, 0, 0],
    ]);
    expect(report.total).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('adds "Other sites" only when the counts have it, after the four', () => {
    const report = describeReport({
      ...NONE,
      listingsInvalid: 2,
      watchesUploaded: 1,
      bySite: { other: { listingsInvalid: 2 } },
      watchesBySite: { other: { watchesUploaded: 1 } },
    });
    expect(report.rows.map((row) => row.name)).toEqual(["LinkedIn", "Glassdoor", "Upwork", "OnlineJobs.ph", "Other sites"]);
    expect(report.rows.at(-1).cells).toEqual([1, 0, 0, 0, 0, 2]);
    expect(report.total).toEqual([1, 0, 0, 0, 0, 2]);
  });

  it("an import finished before the counts were kept by site still adds up: the rest has a row of its own", () => {
    // WD-82's record: listings by site, watches only in all.
    const report = describeReport({
      ...NONE,
      watchesUploaded: 4,
      watchesMatched: 1,
      listingsNew: 3,
      listingsExisting: 2,
      bySite: { linkedin: { listingsNew: 3, listingsExisting: 2 } },
    });
    expect(report.rows.map((row) => [row.name, ...row.cells])).toEqual([
      ["LinkedIn", 0, 0, 0, 3, 2, 0],
      ["Glassdoor", 0, 0, 0, 0, 0, 0],
      ["Upwork", 0, 0, 0, 0, 0, 0],
      ["OnlineJobs.ph", 0, 0, 0, 0, 0, 0],
      ["Site not recorded", 4, 1, 0, 0, 0, 0],
    ]);
    expect(report.total).toEqual([4, 1, 0, 3, 2, 0]);
  });

  it("never shows a number that is not a count", () => {
    const report = describeReport({
      ...NONE,
      bySite: { linkedin: { listingsNew: -2, listingsExisting: "3", listingsRefused: 1.5 } },
      watchesBySite: null,
    });
    expect(report.rows[0].cells).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("an import that stopped part of the way is not shown as complete", () => {
  it("shows what did get in so far, says it is not finished, and offers only Retry", async () => {
    await paired({ feed: [entry(OJ, 1), entry(OJ, 2), entry(GD, 3), entry(LI, 4)] });
    // OnlineJobs.ph's listings go up; then WatchDesk stops answering.
    let sent = 0;
    ext.api.setIngestRoute(() => {
      sent += 1;
      return sent > 1 ? ext.api.networkError() : undefined;
    });
    page = await ext.openPopup();
    await page.click(page.$("local-import-accept"));
    await drive(30000);

    expect(record()).toMatchObject({ phase: "importing", step: "listings" });
    expect(page.text("local-import-title")).toBe("The import has stopped for now");
    expect(page.$("local-import").dataset.tone).toBe("problem");
    expect(table()).toMatchObject({
      caption: "Imported so far, by site",
      body: [
        ["LinkedIn", "2", "0", "0", "0", "0", "0"],
        ["Glassdoor", "1", "0", "0", "0", "0", "0"],
        ["Upwork", "1", "0", "0", "0", "0", "0"],
        ["OnlineJobs.ph", "1", "0", "0", "2", "0", "0"],
      ],
      foot: ["Total", "5", "0", "0", "2", "0", "0"],
    });
    expect(details()[0]).toBe("The import is not finished: the table shows only what has reached your account so far.");
    // Nothing to confirm, nothing to remove, no second import: only Retry.
    expect(shownButtons()).toEqual(["Retry now"]);
    expect(await confirm(record().startedAt)).toBeNull();
    expect(record().phase).toBe("importing");

    // The same after the popup is closed and opened again.
    page = await ext.openPopup();
    expect(page.text("local-import-title")).toBe("The import has stopped for now");
    expect(table().foot).toEqual(["Total", "5", "0", "0", "2", "0", "0"]);

    ext.api.setIngestRoute(() => undefined);
    await page.click(page.$("local-import-retry"));
    await drive();
    expect(page.text("local-import-title")).toBe("Your data was imported");
    expect(table().foot).toEqual(["Total", "5", "0", "0", "4", "0", "0"]);
  });

  it("shows no table while the import is running", () => {
    expect(
      describeImport({ phase: "importing", step: "listings", listingsDone: 1, listingsTotal: 2, problem: null, counts: {} }).report,
    ).toBeNull();
  });
});

describe("the report survives the popup, and can be found again", () => {
  it("is still there when the popup is opened again, from storage and nothing else", async () => {
    await mixedImport();
    const before = table();

    page = await ext.openPopup();
    expect(page.text("local-import-title")).toBe("Your data was imported, with some left out");
    expect(table()).toEqual(before);

    // And after the service worker was stopped and started.
    await ext.restartWorker();
    page = await ext.openPopup();
    expect(table()).toEqual(before);
  });

  it("Close puts it away without removing anything; Settings shows it again", async () => {
    await imported();
    page = await ext.openPopup();
    const kept = structuredClone(record());

    await page.click(page.$("local-import-dismiss"));
    expect(page.$("local-import").hidden).toBe(true);
    expect(record()).toEqual({ ...kept, closed: true });
    expect(local()[SETTINGS_SNAPSHOT_KEY]).toBeDefined();

    page = await ext.openPopup();
    expect(page.$("local-import").hidden).toBe(true);
    const review = page.$("local-import-review-group");
    expect(review.hidden).toBe(false);
    expect(page.text("local-import-review")).toBe("Show what the import did…");
    expect(page.text("local-import-review-hint")).toBe(
      "What was imported into your account, by site. This browser still keeps a copy of your settings (the alert sound) from before it was connected.",
    );

    // From the settings panel back to the report on the main page.
    await page.click(page.$("settings-toggle"));
    expect(page.$("settings-panel").classList.contains("open")).toBe(true);
    ext.take();
    await page.click(page.$("local-import-review"));

    expect(messages()).toEqual([{ type: "local-import-review" }]);
    expect(page.$("local-import").hidden).toBe(false);
    expect(page.$("settings-panel").classList.contains("open")).toBe(false);
    expect(page.document.activeElement.id).toBe("local-import-dismiss");
    expect(review.hidden).toBe(true);
    expect(table().foot).toEqual(["Total", "5", "0", "0", "2", "0", "0"]);
    expect(record()).toEqual({ ...kept, closed: false });
  });

  it("the settings panel's row is there only for a report that was closed", () => {
    const done = { phase: "done", closed: true, copies: { watches: 0, settings: [] } };
    expect(describeImportReview(done)).toBe("What was imported into your account, by site.");
    expect(describeImportReview({ ...done, closed: false })).toBeNull();
    expect(describeImportReview({ phase: "declined", available: true })).toBeNull();
    expect(describeImportReview(null)).toBeNull();
    expect(describeImportReview({ ...done, copies: { watches: 3, settings: ["intervalMinutes", "titleFilter"] } })).toBe(
      "What was imported into your account, by site. This browser still keeps a copy of the 3 watches and your settings (the check interval and the keyword filter) from before it was connected.",
    );
  });
});

// The copies this browser only keeps, as against every key it works from.
const COPIES = [SETTINGS_SNAPSHOT_KEY, WATCHES_SNAPSHOT_KEY];
const bytes = (value) => JSON.stringify(value);

describe("nothing in this browser is removed until the user confirms", () => {
  it("the import itself removes nothing: the feed, the watches and the settings it had are all still here", async () => {
    const feed = [entry(OJ, 1, { applied: true }), entry(GD, 2, { visited: true })];
    await imported({ feed, sync: { soundId: "soft", intervalMinutes: 30 } });

    expect(local().feed.map((e) => [e.id, e.applied, e.visited])).toEqual(feed.map((e) => [e.id, e.applied, e.visited]));
    expect(ext.watches().map((w) => w.label)).toEqual(WATCHES.map((w) => w.label));
    // The settings it had, kept beside the account's.
    expect(local()[SETTINGS_SNAPSHOT_KEY]).toEqual({ takenAt: expect.any(Number), settings: { intervalMinutes: 30, soundId: "soft" } });
    expect(await status()).toMatchObject({
      phase: "done",
      closed: false,
      listingsHere: 2,
      confirmable: true,
      copies: { watches: 0, watchesRemovable: false, settings: ["intervalMinutes", "soundId"], settingsRemovable: true },
    });
  });

  it("not by closing the report, a check, an alarm, a week going by, a restarted worker, or the popup", async () => {
    await importedLater({ sync: { soundId: "soft" } });
    const copies = () => bytes([local()[SETTINGS_SNAPSHOT_KEY], local()[WATCHES_SNAPSHOT_KEY]]);
    const before = copies();
    expect(local()[WATCHES_SNAPSHOT_KEY].watches).toHaveLength(5);
    const kept = structuredClone(record());

    page = await ext.openPopup();
    await page.click(page.$("local-import-dismiss"));
    page.close();
    await tick("check-jobs");
    await tick(IMPORT_ALARM);
    await drive(7 * 24 * 60 * 60 * 1000);
    await ext.restartWorker();
    await ext.send({ type: "sync-watches" });
    await ext.send({ type: "sync-settings" });
    page = await ext.openPopup();
    await page.click(page.$("settings-toggle"));
    await page.click(page.$("local-import-review"));
    page.close();

    expect(copies()).toBe(before);
    expect(record()).toEqual({ ...kept, closed: false });
    expect(ext.take().filter((m) => m.type === "local-import-confirm")).toEqual([]);
  });

  it("not by the first button: it only says what would be removed, and sends nothing", async () => {
    await importedLater({ sync: { soundId: "soft" } });
    page = await ext.openPopup();
    const before = bytes(local());
    ext.take();

    await page.click(page.$("local-import-confirm"));

    expect(messages()).toEqual([]);
    expect(bytes(local())).toBe(before);
    expect(page.text("local-import-title")).toBe("Remove the earlier copies from this browser?");
    expect(page.text("local-import-text")).toBe(
      "This removes, from this browser only, its copy of the 5 watches and your settings (the alert sound) from before it was connected, and this report.",
    );
    expect(details()).toEqual([
      "Your WatchDesk account keeps everything that was imported: that is the copy that remains.",
      "This browser keeps its feed, its watch list and everything it needs to go on checking.",
      "This can't be undone.",
    ]);
    expect(table()).toBeNull();
    expect(shownButtons()).toEqual(["Keep them", "Remove the copies"]);

    // "Keep them" goes back to the report; still nothing sent or removed.
    await page.click(page.$("local-import-keep"));
    expect(page.text("local-import-title")).toBe("Your data was imported");
    expect(shownButtons()).toEqual(["Close", "Import again…", "Remove the earlier copies…"]);
    expect(messages()).toEqual([]);
    expect(bytes(local())).toBe(before);

    // A popup closed on the second step opens on the report again.
    const kept = bytes([record(), local()[SETTINGS_SNAPSHOT_KEY], local()[WATCHES_SNAPSHOT_KEY]]);
    await page.click(page.$("local-import-confirm"));
    page = await ext.openPopup();
    expect(page.text("local-import-title")).toBe("Your data was imported");
    expect(bytes([record(), local()[SETTINGS_SNAPSHOT_KEY], local()[WATCHES_SNAPSHOT_KEY]])).toBe(kept);
  });

  it("the focus is never handed to a button that removes something", async () => {
    await paired();
    page = await ext.openPopup();
    await press("local-import-accept");
    await drive();
    // The import ended: the focus is on "Close".
    expect(page.document.activeElement.id).toBe("local-import-dismiss");

    await press("local-import-confirm");
    // The second step: on "Keep them", not on "Remove the copies".
    expect(page.document.activeElement.id).toBe("local-import-keep");
    // And a real button each: Enter and Space press them with nothing added.
    for (const id of ["local-import-confirm", "local-import-keep", "local-import-remove", "local-import-redo"]) {
      expect([page.$(id).tagName, page.$(id).type, page.$(id).getAttribute("tabindex")]).toEqual(["BUTTON", "button", null]);
    }
  });

  it("the button that removes does nothing unless the second step is on show", async () => {
    await imported();
    page = await ext.openPopup();
    const before = bytes(local());
    ext.take();

    // Pressed by a script, or by a click that landed on a hidden button.
    await page.click(page.$("local-import-remove"));

    expect(messages()).toEqual([]);
    expect(bytes(local())).toBe(before);
  });
});

describe("Remove the copies: exactly the copies this import put into the account", () => {
  it("after an import at the first question: the copy of the settings it saved, and the report", async () => {
    await imported({ sync: { soundId: "soft" } });
    const before = local();
    const sync = bytes(ext.sync());
    expect(Object.keys(before)).toEqual(expect.arrayContaining([IMPORT_KEY, SETTINGS_SNAPSHOT_KEY]));

    expect(await confirm()).toEqual({ watches: 0, settings: ["soundId"] });

    const after = local();
    expect(Object.keys(before).filter((key) => !(key in after)).sort()).toEqual([IMPORT_KEY, SETTINGS_SNAPSHOT_KEY].sort());
    expect(Object.keys(after).filter((key) => !(key in before))).toEqual([]);
    expect(bytes(ext.sync())).toBe(sync);
    expect(await status()).toBeNull();
  });

  it("after an import asked for later: the watches that were set aside too, which it uploaded", async () => {
    await importedLater({ sync: { soundId: "soft" } });
    const before = local();
    expect(record().ownTakenAt).toBe(before[WATCHES_SNAPSHOT_KEY].takenAt);
    expect(await status()).toMatchObject({
      copies: { watches: 5, watchesRemovable: true, settings: ["soundId"], settingsRemovable: true },
    });
    // All five are in the account.
    expect(ext.api.watches.map((w) => w.label)).toEqual(WATCHES.map((w) => w.label));

    expect(await confirm()).toEqual({ watches: 5, settings: ["soundId"] });

    const after = local();
    expect(Object.keys(before).filter((key) => !(key in after)).sort()).toEqual(
      [IMPORT_KEY, SETTINGS_SNAPSHOT_KEY, WATCHES_SNAPSHOT_KEY].sort(),
    );
  });

  it("leaves every key the extension works from byte for byte as it was, and the next check announces nothing twice", async () => {
    const job = (n) => ({ id: String(n), title: `PHP Developer ${n}`, url: `https://www.onlinejobs.ph/jobseekers/job/${n}` });
    await imported({ watches: [OJ], feed: [], sync: { soundId: "soft", intervalMinutes: 30 } });
    // The account does not mute: a new posting is announced.
    ext.api.setSettings({ notificationsMuted: false });
    ext.api.setSite(() => new Response("<html></html>", { status: 200 }));
    // The first check takes the baseline; the second finds a new posting and
    // says so, which is what a check that had forgotten what it saw would do
    // again.
    ext.pages.onlinejobsph = [job(1), job(2)];
    await tick("check-jobs");
    ext.pages.onlinejobsph = [job(3), job(1), job(2)];
    await tick("check-jobs");
    expect(ext.chrome.notifications.create).toHaveBeenCalledTimes(1);
    expect(local().feed.map((e) => e.sourceKey)).toEqual(["onlinejobsph:3"]);
    ext.chrome.notifications.create.mockClear();
    ext.sounds.length = 0;
    // Stored once the user has pressed Start or Pause Watching (WD-71).
    await ext.send({ type: "set-watcher-state", state: "paused" });
    await ext.send({ type: "set-watcher-state", state: "running" });
    await drive();

    const before = local();
    const sync = ext.sync();
    // The inventory of docs/tickets/WD-83.md: everything this browser holds
    // at this point.
    expect(Object.keys(before).sort()).toEqual(INVENTORY_AFTER_AN_IMPORT);

    expect(await confirm()).toEqual({ watches: 0, settings: ["intervalMinutes", "soundId"] });

    const after = local();
    const working = Object.keys(before).filter((key) => key !== IMPORT_KEY && !COPIES.includes(key));
    expect(working).toHaveLength(INVENTORY_AFTER_AN_IMPORT.length - 2);
    for (const key of working) expect(bytes(after[key]), key).toBe(bytes(before[key]));
    expect(Object.keys(after).sort()).toEqual([...working].sort());
    expect(bytes(ext.sync())).toBe(bytes(sync));
    // The connection, and what the account answered, are among them.
    expect(after[TOKEN_KEY]).toBe(TEST_TOKEN);
    expect(after[IMPORT_ANSWERS_KEY]).toEqual({ [ADA]: "accepted" });

    // The same page again: nothing is new, nothing is announced.
    await tick("check-jobs");
    expect(ext.chrome.notifications.create).not.toHaveBeenCalled();
    expect(ext.sounds).toEqual([]);
    expect(local().feed.map((e) => e.sourceKey)).toEqual(["onlinejobsph:3"]);
    expect(local().seenIds).toEqual(before.seenIds);
    // And it still notices what is new.
    ext.pages.onlinejobsph = [job(4), job(3), job(1), job(2)];
    await tick("check-jobs");
    expect(ext.chrome.notifications.create).toHaveBeenCalledTimes(1);
    expect(local().feed.map((e) => e.sourceKey).sort()).toEqual(["onlinejobsph:3", "onlinejobsph:4"]);
    // The account is still synced with.
    expect((await ext.send({ type: "get-state" })).watchSync).toMatchObject({ mode: "account", offline: false, localOnly: 0 });
  });

  it("through the popup: two clicks, one message, and then it says what it removed", async () => {
    await imported({ sync: { soundId: "soft" } });
    page = await ext.openPopup();
    const { finishedAt } = record();
    ext.take();

    await press("local-import-confirm");
    await press("local-import-remove");

    expect(messages()).toEqual([{ type: "local-import-confirm", finishedAt }]);
    expect(record()).toBeUndefined();
    expect(local()[SETTINGS_SNAPSHOT_KEY]).toBeUndefined();
    expect(page.text("local-import-title")).toBe("The earlier copies were removed");
    expect(page.text("local-import-text")).toBe(
      "Removed from this browser: its copy of your settings (the alert sound) from before it was connected, and the report. Your account has what was imported, and this browser goes on checking as before.",
    );
    expect(shownButtons()).toEqual(["Close"]);
    expect(page.document.activeElement.id).toBe("local-import-dismiss");
    // The list is on show as before.
    expect(page.labels()).toEqual(WATCHES.map((w) => w.label));

    // "Close" has no report left to put away: nothing is sent.
    ext.take();
    await page.click(page.$("local-import-dismiss"));
    expect(messages()).toEqual([]);
    expect(page.$("local-import").hidden).toBe(true);

    // It is over: no card, no way back to a report, no question.
    page = await ext.openPopup();
    expect(page.$("local-import").hidden).toBe(true);
    expect(page.$("local-import-review-group").hidden).toBe(true);
    expect(page.$("local-import-again-group").hidden).toBe(true);
  });
});

// Every chrome.storage.local key of a connected browser that has imported
// and checked, before it confirms. All but the report and the one copy are
// what the extension works from.
const INVENTORY_AFTER_AN_IMPORT = [
  "badgeCount",
  "consecutiveErrors",
  "feed",
  "lastChecked",
  "lastGap",
  "lastResult",
  "lastRunAt",
  "seenIds",
  "watchdeskAccount",
  "watchdeskImport",
  "watchdeskImportAnswers",
  "watchdeskListingSync",
  "watchdeskSettingsBeforeConnect",
  "watchdeskSettingsCopy",
  "watchdeskSettingsSync",
  "watchdeskToken",
  "watchdeskWatchSync",
  "watchdeskWatcherSync",
  "watcherState",
].sort();

describe("a copy that holds anything the account did not get is kept", () => {
  it("the settings, when WatchDesk refused one of them: it is the only copy of that one", async () => {
    const keywords = Array.from({ length: 101 }, (_, i) => `keyword ${i}`);
    await imported({ sync: { soundId: "soft", titleFilter: { enabled: true, keywords } } });
    const copy = bytes(local()[SETTINGS_SNAPSHOT_KEY]);
    expect(JSON.parse(copy).settings.titleFilter.keywords).toHaveLength(101);
    expect((await status()).copies).toEqual({
      watches: 0,
      watchesRemovable: false,
      settings: ["soundId", "titleFilter"],
      settingsRemovable: false,
    });

    // The popup says so before the click, and the label says what is left
    // to remove.
    page = await ext.openPopup();
    expect(shownButtons()).toEqual(["Close", "Import again…", "Remove this report…"]);
    await page.click(page.$("local-import-confirm"));
    expect(page.text("local-import-title")).toBe("Remove this report?");
    expect(page.text("local-import-text")).toBe("This removes this report from this browser. Nothing else is removed.");
    expect(details()).toContain(
      "Its copy of your settings (the alert sound and the keyword filter) is kept: this import did not put all of it into your account.",
    );
    expect(shownButtons()).toEqual(["Keep it", "Remove the report"]);
    await page.click(page.$("local-import-remove"));

    expect(record()).toBeUndefined();
    expect(bytes(local()[SETTINGS_SNAPSHOT_KEY])).toBe(copy);
    expect(page.text("local-import-title")).toBe("The report was removed");
    expect(page.text("local-import-text")).toBe("Nothing else was removed from this browser.");
  });

  it("the watches set aside, when WatchDesk refused one of them", async () => {
    await paired({ sync: { soundId: "soft" } });
    await ext.send({ type: "local-import-decline" });
    await ext.send({ type: "sync-watches" });
    await ext.send({ type: "sync-settings" });
    refuseWatch(UP.label);
    await ext.send({ type: "local-import-again" });
    await ext.send({ type: "local-import-accept" });
    await drive();
    await ext.send({ type: "sync-settings" });
    expect(record().counts).toMatchObject({ watchesUploaded: 4, watchesRefused: 1 });
    const copy = bytes(local()[WATCHES_SNAPSHOT_KEY]);

    expect(await confirm()).toEqual({ watches: 0, settings: ["soundId"] });

    expect(bytes(local()[WATCHES_SNAPSHOT_KEY])).toBe(copy);
    expect(local()[SETTINGS_SNAPSHOT_KEY]).toBeUndefined();
  });

  it("a copy this import did not read: watches set aside since, or settings that are not the ones it saved", async () => {
    await importedLater({ sync: { soundId: "soft" } });
    // Changed since: no longer what the import read.
    const late = { id: "w_late", siteId: "upwork", url: "https://www.upwork.com/nx/search/jobs/?q=late", label: "Late", enabled: true };
    const watchCopy = { takenAt: record().ownTakenAt + 1, watches: [...local()[WATCHES_SNAPSHOT_KEY].watches, late] };
    const settingsCopy = { takenAt: NOW, settings: { soundId: "alert" } };
    await ext.chrome.storage.local.set({ [WATCHES_SNAPSHOT_KEY]: watchCopy, [SETTINGS_SNAPSHOT_KEY]: settingsCopy });

    expect((await status()).copies).toMatchObject({ watches: 6, watchesRemovable: false, settingsRemovable: false });
    expect(await confirm()).toEqual({ watches: 0, settings: [] });

    expect(local()[WATCHES_SNAPSHOT_KEY]).toEqual(watchCopy);
    expect(local()[SETTINGS_SNAPSHOT_KEY]).toEqual(settingsCopy);
    expect(record()).toBeUndefined();
  });

  it("a record written before this version names no copy as its own, so none is removed", async () => {
    await imported({ sync: { soundId: "soft" } });
    const old = { ...record() };
    delete old.settings;
    delete old.ownTakenAt;
    await ext.chrome.storage.local.set({ [IMPORT_KEY]: old });
    const copy = bytes(local()[SETTINGS_SNAPSHOT_KEY]);

    expect((await status()).copies).toMatchObject({ settings: ["soundId"], settingsRemovable: false });
    expect(await confirm()).toEqual({ watches: 0, settings: [] });
    expect(bytes(local()[SETTINGS_SNAPSHOT_KEY])).toBe(copy);
  });
});

describe("only the finished import of the account that is connected", () => {
  it("removes nothing for a report other than the one on show", async () => {
    await imported();
    const before = bytes(local());

    expect(await confirm(record().finishedAt + 1)).toBeNull();
    expect(await confirm(null)).toBeNull();
    expect(await confirm("now")).toBeNull();
    expect((await ext.send({ type: "local-import-confirm" })).localImportConfirmed).toBeNull();

    expect(bytes(local())).toBe(before);
  });

  it("removes nothing while no account is connected, and shows nothing", async () => {
    await imported();
    const { finishedAt } = record();
    await loseConnection();
    const before = bytes(local());

    expect(await status()).toBeNull();
    expect(await confirm(finishedAt)).toBeNull();

    expect(bytes(local())).toBe(before);
    expect(local()[SETTINGS_SNAPSHOT_KEY]).toBeDefined();
  });

  it("never removes what was kept under one account while another is connected", async () => {
    // Ada says "Not now": her browser's watches are set aside, her settings
    // kept. Nothing of them is on WatchDesk.
    await paired({ sync: { soundId: "soft" } });
    await ext.send({ type: "local-import-decline" });
    await ext.send({ type: "sync-watches" });
    await ext.send({ type: "sync-settings" });
    const watchCopy = bytes(local()[WATCHES_SNAPSHOT_KEY]);
    const settingsCopy = bytes(local()[SETTINGS_SNAPSHOT_KEY]);
    expect(JSON.parse(watchCopy).watches).toHaveLength(5);

    // Bob connects, imports at his own first question, and confirms.
    await loseConnection();
    await pairAs(BOB);
    expect((await status()).phase).toBe("offered");
    await ext.send({ type: "local-import-accept" });
    await drive();
    await ext.send({ type: "sync-settings" });
    expect(record()).toMatchObject({ phase: "done", owner: BOB, again: false });
    // He is told what this browser keeps, and none of it is his to remove.
    expect((await status()).copies).toEqual({ watches: 5, watchesRemovable: false, settings: ["soundId"], settingsRemovable: false });

    expect(await confirm()).toEqual({ watches: 0, settings: [] });

    expect(bytes(local()[WATCHES_SNAPSHOT_KEY])).toBe(watchCopy);
    expect(bytes(local()[SETTINGS_SNAPSHOT_KEY])).toBe(settingsCopy);
  });

  it("a different account connecting takes the report with it: nothing of the first account's is confirmed", async () => {
    await imported();
    const { finishedAt } = record();
    const settingsCopy = bytes(local()[SETTINGS_SNAPSHOT_KEY]);
    await loseConnection();
    await pairAs(BOB);

    // Bob is asked his own question; Ada's report is not his.
    expect(await status()).toMatchObject({ phase: "offered", again: false });
    expect(await confirm(finishedAt)).toBeNull();
    expect(bytes(local()[SETTINGS_SNAPSHOT_KEY])).toBe(settingsCopy);
  });

  it("is not on offer while the connected account goes by another name than the import's", async () => {
    await imported();
    const copy = bytes(local()[SETTINGS_SNAPSHOT_KEY]);
    await ext.chrome.storage.local.set({ [IMPORT_KEY]: { ...record(), owner: BOB } });

    const shown = await status();
    expect(shown.confirmable).toBe(false);
    expect(describeImport(shown).buttons).toEqual(["dismiss"]);
    expect(describeImport(shown, { step: "confirm" }).buttons).toEqual(["dismiss"]);
    expect(await confirm()).toBeNull();
    expect(bytes(local()[SETTINGS_SNAPSHOT_KEY])).toBe(copy);
    expect(record().phase).toBe("done");
  });
});

describe("after the copies were removed", () => {
  it("the same account is not asked again, and connects as an ordinary one", async () => {
    await imported();
    await confirm();
    await loseConnection();
    await pairAs(ADA);

    expect(await status()).toBeNull();
    expect(local()[IMPORT_ANSWERS_KEY]).toEqual({ [ADA]: "accepted" });
    expect(local()[IMPORT_KEY]).toBeUndefined();
  });

  it("a different account is still asked, and may still say Not now", async () => {
    await imported();
    await confirm();
    await loseConnection();
    await pairAs(BOB);

    expect((await status()).phase).toBe("offered");
    expect((await ext.send({ type: "local-import-decline" })).localImport).toMatchObject({ phase: "declined" });
    expect(local()[IMPORT_ANSWERS_KEY]).toEqual({ [ADA]: "accepted", [BOB]: "declined" });
  });

  it("Reset Extension still clears the report and the watches set aside, confirmed or not", async () => {
    await importedLater();
    expect(local()[WATCHES_SNAPSHOT_KEY]).toBeDefined();

    await ext.send({ type: "reset-extension" });

    expect(local()[IMPORT_KEY]).toBeUndefined();
    expect(local()[IMPORT_ANSWERS_KEY]).toBeUndefined();
    expect(local()[WATCHES_SNAPSHOT_KEY]).toBeUndefined();
    expect(await status()).toBeNull();
    expect(local().feed).toEqual([]);
  });

  it("Reset says it clears the watches a finished import still keeps a copy of", async () => {
    await importedLater();
    page = await ext.openPopup({ confirm: false });

    await page.click(page.$("reset-extension"));

    expect(page.confirm).toHaveBeenCalledWith(expect.stringContaining(", and the watches it kept from before it was connected"));
    // Not confirmed: nothing was reset.
    expect(local()[WATCHES_SNAPSHOT_KEY]).toBeDefined();
    expect(record().phase).toBe("done");
  });
});

describe("when the import looked wrong: import again", () => {
  it("asks first, about the same data, and Not now goes back to the report with nothing changed", async () => {
    await imported({ sync: { soundId: "soft" } });
    const kept = structuredClone(record());
    page = await ext.openPopup();
    const calls = ext.api.requests.length;
    ext.take();

    await page.click(page.$("local-import-redo"));

    expect(messages()).toEqual([{ type: "local-import-again" }]);
    expect(page.text("local-import-title")).toBe("Import this browser's data again");
    expect(page.text("local-import-text")).toBe(
      "This sends 2 listings and your settings from this browser to your WatchDesk account again. It can take a minute.",
    );
    expect(details()).toEqual([
      "What your account already has is not added twice, so importing again can only add what the first import missed.",
      "Your settings from before this browser was connected replace the account's.",
      "Imported listings keep the date this browser found them. One your account already has keeps the date it has there.",
      "Not now goes back to the report and changes nothing.",
    ]);
    expect(shownButtons()).toEqual(["Import", "Not now"]);
    // The account it is working with stays the account: nothing is held.
    expect((await ext.send({ type: "get-state" })).watchSync.mode).toBe("account");

    await page.click(page.$("local-import-decline"));

    expect(page.text("local-import-title")).toBe("Your data was imported");
    expect(record()).toEqual({ ...kept, closed: false });
    // Its answer is still yes: a "Not now" here is not a "no" to the account.
    expect(local()[IMPORT_ANSWERS_KEY]).toEqual({ [ADA]: "accepted" });
    expect(local()[WATCHES_SNAPSHOT_KEY]).toBeUndefined();
    expect(ext.api.requests.slice(calls).filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("Import then runs it again: nothing is added twice, and the new report says so", async () => {
    await imported({ sync: { soundId: "soft" } });
    const watches = structuredClone(ext.api.watches);
    const listings = structuredClone(ext.api.listings);

    await ext.send({ type: "local-import-again" });
    expect(await status()).toEqual({ phase: "offered", again: true, watches: 0, listings: 2, settings: true, redo: true });
    await ext.send({ type: "local-import-accept" });
    await drive();

    expect(ext.api.watches).toEqual(watches);
    expect(ext.api.listings).toEqual(listings);
    expect(record()).toMatchObject({ phase: "done", owner: ADA, again: true });
    expect(record().counts).toMatchObject({ watchesUploaded: 0, listingsNew: 0, listingsExisting: 2, settingsSaved: ["soundId"] });
    expect(describeImport(await status()).text).toBe("2 listings were already in your account, your settings saved.");
    // The feed is as it was.
    expect(local().feed).toHaveLength(2);
  });

  it("while that question is open, a watch that is only in this browser is not set aside", async () => {
    await paired();
    refuseWatch(UP.label);
    await ext.send({ type: "local-import-accept" });
    await drive();
    expect(record().counts.watchesRefused).toBe(1);
    expect(ext.watches().map((w) => w.label)).toContain(UP.label);

    await ext.send({ type: "local-import-again" });
    expect((await status()).redo).toBe(true);
    await ext.send({ type: "sync-watches" });
    await tick("check-jobs");

    // Still in the list, where the user can see it; not moved to a copy.
    expect(ext.watches().map((w) => w.label)).toContain(UP.label);
    expect(local()[WATCHES_SNAPSHOT_KEY]).toBeUndefined();
  });

  it("is not on offer to an account the import was not for, or when there is nothing to send", async () => {
    await imported();
    await ext.chrome.storage.local.set({ [IMPORT_KEY]: { ...record(), owner: BOB } });
    expect((await ext.send({ type: "local-import-again" })).localImport.phase).toBe("done");

    const nothing = {
      phase: "done",
      closed: false,
      confirmable: true,
      redo: false,
      listingsHere: 0,
      copies: { watches: 0, settings: [] },
      counts: record().counts,
    };
    expect(describeImport(nothing).buttons).toEqual(["dismiss", "confirm"]);
    expect(describeImport(nothing).details.at(-1)).toBe(
      "If the import looks wrong, you can leave everything as it is. The extension can't undo an import or delete anything from your account; that is done on WatchDesk.",
    );
  });
});
