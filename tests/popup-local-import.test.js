// WD-81: the popup's "Import your existing data" card (popup-local-import.js)
// in the real popup, against the real service worker and the fake WatchDesk:
// the question in plain words, the two answers, the progress, how it ends,
// and the way back to the question from the settings panel.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startExtension, NOW, WATCHES } from "./helpers/popup-harness.js";
import { TEST_TOKEN } from "./helpers/fake-watchdesk.js";
import { describeImport, describeImportAgain } from "../popup-local-import.js";

const [OJ, GD] = WATCHES;

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

let ext;
let page;
afterEach(() => ext?.dispose());

const drive = async (ms = 5 * 60 * 1000) => {
  await vi.advanceTimersByTimeAsync(ms);
  await ext.settle();
};
const dataCalls = () => [
  ...ext.api.watchCalls(),
  ...ext.api.ingestCalls(),
  ...ext.api.statusCalls(),
  ...ext.api.settingsCalls(),
];
const shownButtons = () =>
  [...page.$("local-import").querySelectorAll("button")].filter((b) => !b.hidden).map((b) => b.textContent.trim());
const details = () => [...page.$("local-import-details").children].map((item) => item.textContent);

// A browser in use, paired for the first time, with the popup open.
async function pairedPopup({ feed = [entry(OJ, 1, { applied: true }), entry(GD, 2)], sync = { soundId: "soft" } } = {}) {
  ext = await startExtension({ sync, local: { feed } });
  await ext.pair();
  page = await ext.openPopup();
  return page;
}

describe("what the card says (describeImport)", () => {
  it("shows nothing when there is nothing to say", () => {
    expect(describeImport(null)).toBeNull();
    expect(describeImport({ phase: "checking" })).toBeNull();
    expect(describeImport({ phase: "declined", available: true, watches: 1, listings: 0, settings: false })).toBeNull();
  });

  it("the question says what would be uploaded, what No means, and that it can take a minute", () => {
    const view = describeImport({ phase: "offered", again: false, watches: 3, listings: 41, settings: true });
    expect(view).toMatchObject({ tone: "neutral", title: "Import your existing data", buttons: ["accept", "decline"] });
    expect(view.text).toBe(
      "This browser has 3 watches, 41 listings and your settings of its own. Import them into your WatchDesk account? It can take a minute.",
    );
    expect(view.details).toEqual([
      "Import uploads them to your account. They stay in this browser too.",
      // WD-82: an import adds to the account, it replaces nothing there.
      "A watch or a listing your account already has is not added twice: the account keeps its own, with its name, paused state and status.",
      // Said before the choice, in plain words.
      "Imported listings keep the date this browser found them. One your account already has keeps the date it has there.",
      "Not now keeps everything in this browser and starts the account without it. The watch list here then shows your account's watches; this browser's own are kept, and you can import them later from Settings.",
      "Until you choose, nothing is sent to WatchDesk and this browser keeps checking its own watches.",
    ]);
  });

  it("says nothing about dates when there is no listing to import, and says it in the second question too", () => {
    const dated = (status) => describeImport({ phase: "offered", ...status }).details.filter((line) => line.includes("keep the date this browser found them"));
    expect(dated({ again: false, watches: 2, listings: 0, settings: true })).toEqual([]);
    expect(dated({ again: true, watches: 2, listings: 3, settings: false })).toHaveLength(1);
    expect(dated({ again: true, watches: 2, listings: 0, settings: false })).toEqual([]);
  });

  it("names only what there is, in the singular where there is one", () => {
    const text = (status) => describeImport({ phase: "offered", again: false, ...status }).text;
    expect(text({ watches: 1, listings: 1, settings: false })).toContain("has 1 watch and 1 listing of its own");
    expect(text({ watches: 2, listings: 0, settings: false })).toContain("has 2 watches of its own");
    expect(text({ watches: 1, listings: 0, settings: true })).toContain("has 1 watch and your settings of its own");
  });

  it("the progress names the step and, for the feed, how far it is", () => {
    const at = (status) => describeImport({ phase: "importing", problem: null, counts: COUNTS, ...status });
    expect(at({ step: "watches" })).toMatchObject({ title: "Importing your data…", text: "Uploading your watches…", buttons: [] });
    expect(at({ step: "listings", listingsDone: 0, listingsTotal: null }).text).toBe("Uploading your listings…");
    expect(at({ step: "listings", listingsDone: 200, listingsTotal: 730 }).text).toBe("Uploading your listings: 200 of 730…");
    expect(at({ step: "applied", appliedDone: 3, appliedTotal: 12 }).text).toBe("Marking the listings you applied to: 3 of 12…");
    expect(at({ step: "settings" }).text).toBe("Saving your settings…");
  });

  it("a stopped import says why, where, that it will be tried again, and offers Retry", () => {
    expect(
      describeImport({
        phase: "importing",
        step: "listings",
        listingsDone: 200,
        listingsTotal: 730,
        problem: { message: "Can't reach WatchDesk.", retryAt: NOW + 60000 },
        counts: COUNTS,
      }),
    ).toMatchObject({
      tone: "problem",
      title: "The import has stopped for now",
      text: "Can't reach WatchDesk. It stopped while uploading your listings, and will be tried again automatically. Nothing is lost.",
      // WD-83: and what did get in so far (tests/import-confirmation.test.js).
      details: ["The import is not finished: the table shows only what has reached your account so far."],
      buttons: ["retry"],
    });
  });

  it("a clean end says what was uploaded, and nothing about dates: the listings kept theirs (WD-117)", () => {
    expect(
      describeImport({
        phase: "done",
        counts: { ...COUNTS, watchesUploaded: 4, watchesMatched: 1, listingsUploaded: 41, listingsNew: 41, appliedMarked: 2, settingsSaved: ["soundId"] },
      }),
    ).toMatchObject({
      tone: "ok",
      title: "Your data was imported",
      text: "4 watches uploaded, 1 watch was already in your account, 41 listings uploaded, 2 marked applied, your settings saved.",
      // WD-83: the rest of the report is in tests/import-confirmation.test.js.
      details: expect.arrayContaining([
        "2 applied marks carried over.",
        "Settings imported: the alert sound.",
          "Nothing was removed from this browser.",
      ]),
      // Not the connected account's import as far as this status says: no
      // way to remove anything.
      buttons: ["dismiss"],
    });
  });

  it("an end with something left out says what, each in its own line", () => {
    const view = describeImport({
      phase: "done",
      counts: {
        ...COUNTS,
        watchesUploaded: 2,
        watchesRefused: 1,
        listingsUploaded: 10,
        listingsNoWatch: 2,
        listingsWatchGone: 1,
        listingsInvalid: 1,
        listingsRefused: 1,
        appliedNotCarried: 2,
        settingsRefused: [{ setting: "titleFilter", reason: "Keep at most 100 keywords" }],
        // WD-83: by site, and each reason in its own words.
        watchesBySite: {
          linkedin: { watchesUploaded: 2, watchesMatched: 0, watchesRefused: 0 },
          glassdoor: { watchesUploaded: 0, watchesMatched: 0, watchesRefused: 1 },
        },
        bySite: {
          linkedin: { listingsNew: 10, listingsNoWatch: 2, listingsWatchGone: 1 },
          upwork: { listingsInvalid: 1, listingsRefused: 1 },
        },
      },
    });
    expect(view).toMatchObject({ tone: "problem", title: "Your data was imported, with some left out", buttons: ["dismiss"] });
    expect(view.details.slice(0, 8)).toEqual([
      "LinkedIn: 2 listings left out, because their watch isn't in your account.",
      "LinkedIn: 1 listing left out, because its watch was deleted on WatchDesk during the import.",
      "Glassdoor: WatchDesk didn't accept 1 watch. It stays in this browser.",
      "Upwork: 1 listing left out, because WatchDesk didn't accept it.",
      "Upwork: 1 listing left out, because it isn't complete enough to store.",
      "Listings that were left out are still in this browser's feed.",
      "2 applied marks not carried over: WatchDesk already had those listings, and its own status was left as it is.",
      "The keyword filter wasn't imported: Keep at most 100 keywords",
    ]);
  });

  it("an import that found nothing new says so", () => {
    expect(describeImport({ phase: "done", counts: COUNTS }).text).toBe("There was nothing WatchDesk didn't already have.");
  });

  // WD-82: what the account already had is told apart from what was added.
  it("says how many listings were added and how many the account already had, never the two as one number", () => {
    const view = describeImport({
      phase: "done",
      counts: { ...COUNTS, watchesUploaded: 1, listingsUploaded: 41, listingsNew: 30, listingsExisting: 11 },
    });
    expect(view.text).toBe("1 watch uploaded, 30 listings uploaded, 11 listings were already in your account.");
    expect(view.tone).toBe("ok");
    expect(describeImport({ phase: "done", counts: { ...COUNTS, listingsUploaded: 1, listingsExisting: 1 } }).text).toBe(
      "1 listing was already in your account.",
    );
  });

  it("says when a watch the account already had is named or paused differently there, and that the account's was kept", () => {
    const line = (counts) =>
      describeImport({ phase: "done", counts: { ...COUNTS, ...counts } }).details.filter((text) => text.includes("different name"));
    expect(line({ watchesMatched: 2, watchesMatchedDiffer: 1 })).toEqual([
      "1 watch your account already had has a different name or paused state there. The account's was kept.",
    ]);
    expect(line({ watchesMatched: 3, watchesMatchedDiffer: 2 })).toEqual([
      "2 watches your account already had have a different name or paused state there. The account's were kept.",
    ]);
    expect(line({ watchesMatched: 3, watchesMatchedDiffer: 0 })).toEqual([]);
    // Not something left out: the import is not "with some left out" for it.
    expect(describeImport({ phase: "done", counts: { ...COUNTS, watchesMatched: 1, watchesMatchedDiffer: 1 } }).tone).toBe("ok");
  });

  it("both questions say, before the choice, that what the account has is not added twice and is kept", () => {
    const said = "A watch or a listing your account already has is not added twice: the account keeps its own, with its name, paused state and status.";
    expect(describeImport({ phase: "offered", again: false, watches: 1, listings: 0, settings: false }).details).toContain(said);
    expect(describeImport({ phase: "offered", again: true, watches: 1, listings: 0, settings: false }).details).toEqual([
      "Import uploads them to your account. Your settings from then replace the account's.",
      said,
      "Not now leaves everything as it is.",
    ]);
  });

  it("the settings panel's row is there only after a No, while something could still be imported", () => {
    expect(describeImportAgain({ phase: "declined", available: true, watches: 5, listings: 2, settings: true })).toBe(
      "This browser kept 5 watches, 2 listings and your settings from before it was connected. Nothing of it was uploaded.",
    );
    expect(describeImportAgain({ phase: "declined", available: false, watches: 0, listings: 0, settings: false })).toBeNull();
    expect(describeImportAgain({ phase: "offered", again: true, watches: 5, listings: 2, settings: true })).toBeNull();
    expect(describeImportAgain(null)).toBeNull();
  });
});

describe("in the popup, on a second device whose account already has some of it (WD-82)", () => {
  it("the end says what was added, what the account already had, and whose name and status were kept", async () => {
    await pairedPopup();
    const theirs = ext.api.addWatch({ url: "http://onlinejobs.ph/jobseekers/jobsearch/#results", label: "My OJ search", enabled: false });
    ext.api.listings.push({ listingId: "listing-old", sourceKey: "onlinejobsph:1", watchId: theirs.id, listing: { id: "1" }, status: "interviewing" });

    await page.click(page.$("local-import-accept"));
    await drive();

    expect(page.text("local-import-title")).toBe("Your data was imported, with some left out");
    expect(page.text("local-import-text")).toBe(
      "4 watches uploaded, 1 watch was already in your account, 1 listing uploaded, 1 listing was already in your account, your settings saved.",
    );
    expect(details()).toEqual([
      "1 applied mark not carried over: WatchDesk already had that listing, and its own status was left as it is.",
      "Settings imported: the alert sound.",
      "1 watch your account already had has a different name or paused state there. The account's was kept.",
      // WD-83: what this browser still has, and what can be done.
      "Nothing was removed from this browser. Its feed still has all 2 listings.",
      "It also keeps a copy of your settings (the alert sound) from before it was connected, inside this extension and in this browser only. The copy stays until you remove it below.",
      "If the import looks wrong, you can leave everything as it is, or import again: what your account already has is not added twice. The extension can't undo an import or delete anything from your account; that is done on WatchDesk.",
    ]);
    // The list is the account's: the watch under the account's name, paused.
    expect(page.labels()).toContain("My OJ search");
    expect(page.labels()).not.toContain(OJ.label);
    expect(ext.api.listings.find((row) => row.sourceKey === "onlinejobsph:1").status).toBe("interviewing");
    expect(ext.api.watches.filter((w) => w.siteId === "onlinejobsph")).toHaveLength(1);
  });
});

describe("in the popup, after a first pairing", () => {
  it("asks the question under the account card, and nothing has been sent", async () => {
    await pairedPopup();

    expect(page.$("local-import").hidden).toBe(false);
    expect(page.text("local-import-title")).toBe("Import your existing data");
    expect(page.text("local-import-text")).toBe(
      "This browser has 5 watches, 2 listings and your settings of its own. Import them into your WatchDesk account? It can take a minute.",
    );
    expect(details()).toHaveLength(5);
    expect(details()[1]).toContain("already has is not added twice");
    expect(details()[2]).toContain("Imported listings keep the date this browser found them");
    expect(shownButtons()).toEqual(["Import", "Not now"]);
    // Connected, by name, and not syncing: no sync line, the browser's own
    // watches in the list, and the settings panel says why.
    expect(page.text("account-title")).toBe("ada@example.com");
    expect(page.$("watch-sync-status").hidden).toBe(true);
    expect(page.labels()).toEqual(WATCHES.map((w) => w.label));
    expect(page.text("settings-sync-note")).toBe(
      'The check interval, alert sound, mute and keyword filter stay in this browser only until you answer "Import your existing data" at the top of this popup.',
    );
    expect(page.$("local-import-again-group").hidden).toBe(true);

    expect(page.opening.filter((m) => m.type.startsWith("local-import-"))).toEqual([]);
    expect(dataCalls()).toEqual([]);
    expect(page.document.documentElement.innerHTML).not.toContain(TEST_TOKEN);
  });

  it("Import: one click, the progress, then what was done; Close puts the card away", async () => {
    await pairedPopup();
    ext.take();

    await page.click(page.$("local-import-accept"));
    expect(ext.take().filter((m) => m.type.startsWith("local-import-"))).toEqual([{ type: "local-import-accept" }]);
    expect(page.text("local-import-title")).toBe("Importing your data…");
    expect(shownButtons()).toEqual([]);

    await drive();

    expect(page.text("local-import-title")).toBe("Your data was imported");
    expect(page.text("local-import-text")).toBe("5 watches uploaded, 2 listings uploaded, 1 marked applied, your settings saved.");
    expect(details()).toEqual([
      "1 applied mark carried over.",
      "Settings imported: the alert sound.",
      "Nothing was removed from this browser. Its feed still has all 2 listings.",
      "It also keeps a copy of your settings (the alert sound) from before it was connected, inside this extension and in this browser only. The copy stays until you remove it below.",
      "If the import looks wrong, you can leave everything as it is, or import again: what your account already has is not added twice. The extension can't undo an import or delete anything from your account; that is done on WatchDesk.",
    ]);
    expect(page.$("local-import").dataset.tone).toBe("ok");
    // WD-83: "Close" first; the button that removes something is last.
    expect(shownButtons()).toEqual(["Close", "Import again…", "Remove the earlier copies…"]);
    // The popup is now an ordinary connected one: the account's list (the
    // same five watches), the sync line, the account's settings.
    expect(page.labels()).toEqual(WATCHES.map((w) => w.label));
    expect(page.$("watch-sync-status").hidden).toBe(false);
    expect(page.text("settings-sync-note")).toContain("are saved in your WatchDesk account.");
    expect(page.$("sound").value).toBe("soft");
    expect(ext.api.watches).toHaveLength(5);
    expect(ext.api.listings).toHaveLength(2);

    await page.click(page.$("local-import-dismiss"));
    expect(page.$("local-import").hidden).toBe(true);
    // And it does not come back by itself (WD-83: the settings panel has
    // the way back to it).
    page = await ext.openPopup();
    expect(page.$("local-import").hidden).toBe(true);
    expect(page.$("local-import-again-group").hidden).toBe(true);
    expect(page.$("local-import-review-group").hidden).toBe(false);
  });

  it("shows the progress as it goes", async () => {
    const feed = Array.from({ length: 450 }, (_, i) => entry(OJ, 1000 + i));
    await pairedPopup({ feed, sync: {} });
    // The second request waits, so the popup is seen mid-import.
    let release;
    ext.api.setIngestRoute((request) =>
      request.body.listings[0].id === "1200" && !release
        ? new Promise((resolve) => {
            release = () => resolve(undefined);
          }).then(() => ext.api.json(200, { watchId: request.body.watchId, siteId: "onlinejobsph", received: 200, inserted: [] }))
        : undefined,
    );

    await page.click(page.$("local-import-accept"));
    await drive(5000);
    expect(page.text("local-import-text")).toBe("Uploading your listings: 200 of 450…");
    // The watches went up first; the list already shows the account's.
    expect(ext.api.watches).toHaveLength(5);

    release();
    await drive();
    expect(page.text("local-import-title")).toBe("Your data was imported");
  });

  it("Not now: the card goes, nothing was uploaded, the list is the account's, and Settings offers the import", async () => {
    await pairedPopup();
    ext.api.addWatch({ url: "https://www.upwork.com/nx/search/jobs/?q=vue", label: "Upwork Vue" });
    ext.take();

    await page.click(page.$("local-import-decline"));
    await drive(1000);

    expect(page.$("local-import").hidden).toBe(true);
    expect(ext.api.watchCalls("POST")).toEqual([]);
    expect(ext.api.ingestCalls()).toEqual([]);
    expect(page.labels()).toEqual(["Upwork Vue"]);
    expect(page.$("watch-sync-status").hidden).toBe(false);
    expect(page.text("settings-sync-note")).toContain("are saved in your WatchDesk account.");
    // The feed is this browser's, as it was.
    expect(page.document.querySelectorAll("#feed-list .feed-item")).toHaveLength(2);

    expect(page.$("local-import-again-group").hidden).toBe(false);
    expect(page.text("local-import-again")).toBe("Import this browser's data into your account…");
    expect(page.text("local-import-again-hint")).toBe(
      "This browser kept 5 watches, 2 listings and your settings from before it was connected. Nothing of it was uploaded.",
    );
  });

  it("Reset, after Not now, says it clears the watches that were kept, and does", async () => {
    await pairedPopup();
    await page.click(page.$("local-import-decline"));
    await drive(1000);
    page = await ext.openPopup();
    await page.click(page.$("settings-toggle"));

    await page.click(page.$("reset-extension"));

    expect(page.confirm).toHaveBeenCalledWith(
      "Reset Job Alert Notifier? This clears the whole feed in this browser, and the watches it kept from before it was connected. Your watches and settings are kept: they belong to your WatchDesk account. This can't be undone.",
    );
    expect(ext.local().watchdeskWatchesBeforeConnect).toBeUndefined();
    expect(ext.local().watchdeskImport).toBeUndefined();
    expect(page.$("local-import-again-group").hidden).toBe(true);
    expect(ext.api.watchCalls("POST")).toEqual([]);
  });

  it("the way back: Settings asks again, about what was kept, and Import then uploads it", async () => {
    await pairedPopup();
    await page.click(page.$("local-import-decline"));
    await drive(1000);
    page = await ext.openPopup();
    await page.click(page.$("settings-toggle"));
    ext.take();

    await page.click(page.$("local-import-again"));
    expect(ext.take().filter((m) => m.type.startsWith("local-import-"))).toEqual([{ type: "local-import-again" }]);
    expect(page.$("local-import").hidden).toBe(false);
    expect(page.text("local-import-title")).toBe("Import this browser's earlier data");
    expect(page.text("local-import-text")).toBe(
      "This browser kept 5 watches, 2 listings and your settings from before it was connected. Import them into your WatchDesk account? It can take a minute.",
    );
    expect(shownButtons()).toEqual(["Import", "Not now"]);
    expect(page.$("local-import-again-group").hidden).toBe(true);
    // Asking again holds nothing: the popup is still the account's.
    expect(page.$("watch-sync-status").hidden).toBe(false);

    await page.click(page.$("local-import-accept"));
    await drive();

    expect(page.text("local-import-title")).toBe("Your data was imported");
    expect(page.labels()).toEqual(WATCHES.map((w) => w.label));
    expect(ext.api.listings).toHaveLength(2);
    expect(page.$("local-import-again-group").hidden).toBe(true);
  });

  it("a stopped import says so in the popup, and Retry now carries it on", async () => {
    await pairedPopup();
    ext.api.setWatchRoute(ext.api.networkError);
    await page.click(page.$("local-import-accept"));
    await drive(1000);

    expect(page.text("local-import-title")).toBe("The import has stopped for now");
    expect(page.text("local-import-text")).toBe(
      "Can't reach WatchDesk. It stopped while uploading your watches, and will be tried again automatically. Nothing is lost.",
    );
    expect(page.$("local-import").dataset.tone).toBe("problem");
    expect(shownButtons()).toEqual(["Retry now"]);
    // Nothing went anywhere: the list is still this browser's own.
    expect(page.labels()).toEqual(WATCHES.map((w) => w.label));

    ext.api.setWatchRoute(() => undefined);
    ext.take();
    await page.click(page.$("local-import-retry"));
    expect(ext.take().filter((m) => m.type.startsWith("local-import-"))).toEqual([{ type: "local-import-retry" }]);
    await drive();
    expect(page.text("local-import-title")).toBe("Your data was imported");
  });

  it("is still asking when the popup is opened again, and while it is importing shows where it is", async () => {
    await pairedPopup();
    page = await ext.openPopup();
    expect(page.text("local-import-title")).toBe("Import your existing data");

    // Stopped by an outage, then the popup is closed and opened.
    ext.api.setWatchRoute(ext.api.networkError);
    await page.click(page.$("local-import-accept"));
    await drive(1000);
    page = await ext.openPopup();
    expect(page.text("local-import-title")).toBe("The import has stopped for now");
    expect(shownButtons()).toEqual(["Retry now"]);
  });

  it("can be answered from the keyboard, and keeps the focus in the card when its buttons change", async () => {
    await pairedPopup();
    const accept = page.$("local-import-accept");
    const decline = page.$("local-import-decline");
    // Two real buttons, in reading order, in the tab order.
    for (const button of [accept, decline]) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.tabIndex).toBe(0);
      expect(button.disabled).toBe(false);
    }
    expect(accept.compareDocumentPosition(decline) & 4).toBe(4);

    accept.focus();
    expect(page.document.activeElement).toBe(accept);
    // Enter or Space on a focused button is its click.
    await page.click(accept);
    // The button is gone while the import runs; the focus is on the card,
    // not lost to the top of the page.
    expect(accept.hidden).toBe(true);
    expect(page.document.activeElement).toBe(page.$("local-import"));

    // The pressed button is never disabled: a browser would take the focus
    // from it before the card could hand it on.
    expect(accept.disabled).toBe(false);

    // When the card has a button again, the focus is on it.
    await drive();
    const close = page.$("local-import-dismiss");
    expect(close.hidden).toBe(false);
    expect(page.document.activeElement).toBe(close);
  });

  it("answers once to a double click", async () => {
    await pairedPopup();
    ext.take();
    const accept = page.$("local-import-accept");
    accept.click();
    accept.click();
    await drive();

    expect(ext.take().filter((m) => m.type === "local-import-accept")).toHaveLength(1);
    expect(ext.api.watches).toHaveLength(5);
  });

  it("writes what WatchDesk says as text, never as markup", async () => {
    await pairedPopup({ sync: { soundId: "soft" } });
    ext.api.setSettingsRoute((request) =>
      request.method === "PUT"
        ? ext.api.json(400, { error: "Check the highlighted fields.", fieldErrors: { soundId: ['<img src=x onerror="alert(1)"> not a sound'] } })
        : undefined,
    );
    await page.click(page.$("local-import-accept"));
    await drive();

    expect(page.text("local-import-title")).toBe("Your data was imported, with some left out");
    expect(details()).toContain('The alert sound wasn\'t imported: <img src=x onerror="alert(1)"> not a sound');
    expect(page.$("local-import").querySelector("img")).toBeNull();
  });
});

describe("in the popup, with nothing to ask", () => {
  it("shows no card to a browser with no account connected, and sends nothing for it", async () => {
    ext = await startExtension();
    page = await ext.openPopup();

    expect(page.$("local-import").hidden).toBe(true);
    expect(page.$("local-import-again-group").hidden).toBe(true);
    expect(page.opening.filter((m) => m.type.startsWith("local-import-"))).toEqual([]);
    expect(page.text("settings-sync-note")).toContain("No WatchDesk account is connected");
  });

  it("shows no card to a browser that was already connected", async () => {
    ext = await startExtension({ connected: true });
    page = await ext.openPopup();

    expect(page.$("local-import").hidden).toBe(true);
    expect(page.$("local-import-again-group").hidden).toBe(true);
  });
});
