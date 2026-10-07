// local-import.js — offering, and doing, the import of this browser's own
// watches, feed and settings into a WatchDesk account it has just been
// connected to (WD-81). Runs in the service worker; background.js calls it.
//
// Before this ticket a first connection uploaded the browser's watches
// without asking (WD-54) and replaced its settings with the account's
// (WD-79). Now a pairing that completes puts the browser on hold first:
// account-connection.js writes { phase: "connecting" } in the same storage
// call as the token, and until the user has answered nothing is synced with
// the account (isAccountActive): the extension goes on working from its own
// watches and settings, exactly as with no account connected.
//
//   connecting  just paired; not yet decided whether there is anything to
//               ask. prepareImportOffer() settles it as soon as it can.
//   offered     the popup is showing the question. Nothing is uploaded and
//               nothing is lost, however long it stays unanswered.
//   importing   the user said yes: the steps below, resumable.
//   done        the import ended; the popup shows what happened, by site
//               (WD-83). "Close" only puts the report away (`closed`): the
//               settings panel shows it again. It stays until the user
//               confirms it, see "After the import" below.
//   declined    the user said no. The account is synced as it is; a watch
//               that is only in this browser is set aside by watch-sync.js
//               (never uploaded, never deleted), and the settings panel
//               offers the import again ("offered-again", which holds
//               nothing: the browser is already working with the account).
//   no record   nothing to ask: no data in this browser, an account that
//               already answered, or a browser connected before this
//               existed. The connection behaves as it did before WD-81.
//
// "First" pairing is told by the account, named by its email as
// listing-ingest.js names the owner of its queue: watchdeskImportAnswers
// remembers what each account answered in this browser. An account that
// said yes is not asked again and connects as before (WD-54); one that said
// no is not asked again and is not uploaded to either; a different account
// is asked afresh, and nothing read for one account is sent to another.
//
// The import, in order (each step safe to repeat, so it can stop anywhere):
//   1. watches   watch-sync.js's first sync: each watch of this browser
//                becomes the account's watch that is the same search
//                (watch-url.js), or is uploaded. From then on its feed
//                entries carry its id on WatchDesk.
//   2. listings  the feed, by watch, at most INGEST_MAX_LISTINGS a request,
//                straight to POST /api/listings/ingest and not through
//                listing-ingest.js's retry queue, whose cap drops the oldest.
//                WatchDesk keeps one row per posting however often it is
//                sent. A request it refuses (400) is halved until the one
//                listing it will not take is found and left out. Each
//                listing says when this browser first found it (WD-117), so
//                a listing that is new to the account keeps that date.
//   3. applied   an "applied" mark, for the listings this import added
//                (WatchDesk names only those): PATCH /api/listings/[id].
//   4. settings  the settings the user had chosen here, through
//                account-settings.js's one read-modify-write, so the watcher
//                state WatchDesk holds is sent back untouched.
// What cannot be carried over is counted, never silently dropped: a feed
// entry whose watch is gone or was refused, a listing or a setting WatchDesk
// will not take, an applied mark on a listing the account already had.
// Nothing is ever removed from this browser.
//
// After the import (WD-83): the import itself still removes nothing, and
// neither does closing the report, a timer, a disconnection or another
// import. Only confirmImport(), the user's explicit "remove the earlier
// copies", does, and only this:
//   - watchdeskWatchesBeforeConnect, when this import is the one that
//     uploaded the watches in it (an import asked for after a "no", which
//     read them at `ownTakenAt`) and WatchDesk refused none of them;
//   - watchdeskSettingsBeforeConnect, when it holds exactly the settings
//     this import saved (the record's `settings`) and WatchDesk refused none;
//   - the finished record, which is the report.
// A copy that holds anything the account did not get is kept, and so is
// everything the extension works from (the feed, the seen postings, the
// watch list, the settings, the connection, the queue): docs/tickets/WD-83.md
// lists every key. It acts only on the finished import of the account that
// is connected. An import that looked wrong can be run again
// (offerImportAgain, from the report): the question is asked as after a
// "no", and "Not now" there goes back to the report (`back`). The extension
// cannot undo an import: no route deletes a listing.
//
// What the account already has (WD-82) is never doubled and never replaced:
//   - a watch that is the same search as one of the account's becomes that
//     watch, which keeps its label, its paused state and its URL. How many
//     did, and how many of them were named or paused differently here, is
//     counted (watchesMatched, watchesMatchedDiffer);
//   - a posting the account already has (WatchDesk decides, by the site and
//     the site's id of the posting) is skipped, not added: it stays with the
//     watch that found it first there, with its status. It is counted as
//     listingsExisting, apart from listingsNew, and both are also counted by
//     site in counts.bySite. One thing WatchDesk does do to it, as on every
//     later sighting of a posting: its title, URL and Easy Apply flag become
//     the ones sent, and a salary or workplace type it lacked is filled in;
//   - a posting this browser holds under two watches is sent once, for the
//     watch that found it first, and counted once as new.
//
// The date a listing was found (WD-117): a feed entry's detectedAt goes with
// its listing as an ISO 8601 string, here and nowhere else (a check cycle
// and its retry queue send none: what a check finds, it finds now). It is
// read from the stored entry every time, so a request sent again after a
// stop says the same. An entry that holds no time that can be sent sends no
// field at all, never a bad one, which would refuse the whole request.
// WatchDesk uses the time only for a listing the request adds and only
// within its own limits; one it does not use is dated the day of the import
// and counted (listingsDatedToday). Nothing the import adds is announced:
// no notification, tone or badge comes from here.
//
// WatchDesk allows 120 requests a minute per device, shared with the check
// cycle: requests go out one at a time, IMPORT_REQUEST_GAP_MS apart. When
// WatchDesk cannot take a step (offline, rate limited beyond what
// authorizedRequest() waits out, a 5xx, a 403) the import stops where it is,
// says why, and is tried again by its alarm: after the Retry-After, or after
// a wait that doubles from a minute to half an hour. The popup's Retry does
// it at once.
//
// Storage (chrome.storage.local only; nothing here leaves this browser but
// the requests themselves):
//   watchdeskImport         the record: { phase, owner, … }. While importing:
//     { phase, owner, again, startedAt, step, own, settings, sent, marks,
//       listingsTotal, appliedTotal, counts, problem, attempts, resumeAt }
//       own       watches set aside earlier, to upload with the rest
//       settings  the settings to save, as stored when the user said yes
//       sent      the feed entries WatchDesk has answered for
//       marks     WatchDesk's ids of the listings still to mark applied
//       counts    what was done and what was left out (the result)
//       problem   { kind, message } while the import is stopped, else null
//       ownTakenAt  when the watches in `own` were set aside (WD-83)
//     When done: { phase, owner, again, finishedAt, counts, settings,
//       ownTakenAt, closed }.
//     Every write goes through account-connection.js's changeImportRecord(),
//     the queue a new token is stored in, and only while the record is still
//     this import's: a pairing that completes ends it.
//   watchdeskImportAnswers  { <account email>: "accepted" | "declined" }
//   watchdeskImportInterrupted  { <account email>: <its importing record> }
//     An import that was under way when a different account connected. That
//     account is asked its own question and gets nothing of it; the import
//     goes on when its own account is connected again.
//   Reset Extension removes all of these and the watches set aside
//   (resetImport); a disconnection removes none of them.
//   Nothing that must survive a worker restart is in a module variable.
//
// Nothing here sees the device token (every request is bound to the
// connection the run began with, WD-110) and nothing here logs: a listing's
// title and URL say what the user is searching for.

import {
  captureConnection,
  changeImportRecord,
  getAccountOwner,
  isConnected,
  isCurrentConnection,
  IMPORT_KEY,
} from "./account-connection.js";
import {
  getOwnWatches,
  getServerWatchIds,
  getSetAsideWatches,
  keepOwnWatches,
  uploadOwnWatches,
  WATCHES_SNAPSHOT_KEY,
} from "./watch-sync.js";
import { importAccountSettings, SETTINGS_SNAPSHOT_KEY, SYNCED_SETTINGS } from "./account-settings.js";
import { toListing } from "./listing-ingest.js";
import { ingestListings, setListingStatus, INGEST_MAX_LISTINGS } from "./watchdesk-api.js";
import { settingsProblem } from "./settings-limits.js";

export const IMPORT_ANSWERS_KEY = "watchdeskImportAnswers";
export const IMPORT_INTERRUPTED_KEY = "watchdeskImportInterrupted";
export const IMPORT_ALARM = "watchdesk-import";
// chrome.alarms' minimum period. It wakes a worker that was stopped
// mid-import, and retries a stopped import when its wait is over.
const IMPORT_ALARM_PERIOD_MINUTES = 0.5;
// Between two requests of the import: at most 100 a minute, under
// WatchDesk's 120 a minute per device with room for a check cycle's own.
export const IMPORT_REQUEST_GAP_MS = 600;
// How long a stopped import waits before it is tried again: a minute, then
// double each time it stops again, up to half an hour.
export const IMPORT_RETRY_BASE_MS = 60 * 1000;
export const IMPORT_RETRY_MAX_MS = 30 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- storage ----------

async function readRecord() {
  const { [IMPORT_KEY]: record } = await chrome.storage.local.get(IMPORT_KEY);
  return record && typeof record === "object" ? record : null;
}

async function readAnswers() {
  const { [IMPORT_ANSWERS_KEY]: answers } = await chrome.storage.local.get(IMPORT_ANSWERS_KEY);
  return answers && typeof answers === "object" ? answers : {};
}

async function rememberAnswer(owner, answer) {
  await chrome.storage.local.set({ [IMPORT_ANSWERS_KEY]: { ...(await readAnswers()), [owner]: answer } });
}

// Imports that were under way when a different account connected, by the
// account they belong to.
async function readInterrupted() {
  const { [IMPORT_INTERRUPTED_KEY]: kept } = await chrome.storage.local.get(IMPORT_INTERRUPTED_KEY);
  return kept && typeof kept === "object" ? kept : {};
}

async function keepInterrupted(record) {
  await chrome.storage.local.set({ [IMPORT_INTERRUPTED_KEY]: { ...(await readInterrupted()), [record.owner]: record } });
}

async function forgetInterrupted(owner) {
  const kept = await readInterrupted();
  if (!(owner in kept)) return;
  delete kept[owner];
  if (Object.keys(kept).length === 0) await chrome.storage.local.remove(IMPORT_INTERRUPTED_KEY);
  else await chrome.storage.local.set({ [IMPORT_INTERRUPTED_KEY]: kept });
}

// What became of the feed's entries, in all and (bySite) for each site:
//   listingsNew        added to the account
//   listingsExisting   skipped: the account already had the posting, or this
//                      browser held it twice
//   listingsRefused    WatchDesk would not store it
//   listingsWatchGone  its watch was deleted on WatchDesk during the import
//   listingsNoWatch    its watch is not on WatchDesk
//   listingsInvalid    not a posting WatchDesk could store
// listingsUploaded is listingsNew + listingsExisting: what WatchDesk answered
// for.
// Beside them, and in all only (WD-117): listingsDatedToday, how many of
// listingsNew are dated the day of the import because this browser had no
// time for them that WatchDesk took. Absent while there is none, as in a
// record from before it was counted.
const emptySiteCounts = () => ({
  listingsNew: 0,
  listingsExisting: 0,
  listingsRefused: 0,
  listingsWatchGone: 0,
  listingsNoWatch: 0,
  listingsInvalid: 0,
});

const emptyCounts = () => ({
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
  bySite: {},
  watchesBySite: {},
});

// What became of this browser's watches, for each site (WD-83; in all, the
// three counts of the same names above).
const emptyWatchCounts = () => ({ watchesUploaded: 0, watchesMatched: 0, watchesRefused: 0 });

// `held` with one run of the watch step (uploadOwnWatches' bySite) added.
// Like the counts in all: uploaded and matched add up over the runs of an
// import; refused is the number the last run found, not an addition to it.
function withWatchSites(held, bySite) {
  const next = {};
  for (const site of new Set([...Object.keys(held || {}), ...Object.keys(bySite || {})])) {
    const before = { ...emptyWatchCounts(), ...held?.[site] };
    const run = bySite?.[site] || {};
    next[site] = {
      watchesUploaded: before.watchesUploaded + (run.created || 0),
      watchesMatched: before.watchesMatched + (run.matched || 0),
      watchesRefused: run.rejected || 0,
    };
  }
  return next;
}

// The site a count is kept under when an entry names none.
const OTHER_SITE = "other";

// Adds `n` to one of the listing counts of `counts`, in all and for `site`.
function tally(counts, site, name, n) {
  if (n <= 0) return;
  counts[name] = (counts[name] || 0) + n;
  const held = { ...emptySiteCounts(), ...counts.bySite?.[site] };
  counts.bySite = { ...counts.bySite, [site]: { ...held, [name]: held[name] + n } };
}

// ---------- what this browser has ----------

// The settings the user stored in this browser, out of the ones an account
// keeps. A key that was never stored is not there: the default applied, and
// a default is nothing to import over what the account holds.
function storedSettings(found) {
  return Object.fromEntries(SYNCED_SETTINGS.filter((key) => key in (found || {})).map((key) => [key, found[key]]));
}

async function feedEntries() {
  const { feed } = await chrome.storage.local.get("feed");
  return Array.isArray(feed) ? feed.filter((entry) => entry && typeof entry === "object") : [];
}

// What a freshly paired browser holds of its own: { exists, watches,
// listings, settings }. `exists` is what decides whether there is anything
// to ask: a stored watch list, a feed entry or a stored setting. A browser
// that has stored none of them is showing the default watch and nothing
// else, and connects as it did before.
async function ownData() {
  const found = await chrome.storage.sync.get(["watches", ...SYNCED_SETTINGS]);
  const settings = storedSettings(found);
  const listings = (await feedEntries()).length;
  const storedWatches = Array.isArray(found.watches) ? found.watches.length : 0;
  return {
    exists: storedWatches > 0 || listings > 0 || Object.keys(settings).length > 0,
    watches: (await getOwnWatches()).length,
    listings,
    settings,
  };
}

// What was left out by an earlier "no": the watches set aside, the feed,
// and the settings kept from before the account's replaced them (WD-79).
async function setAsideData() {
  const { [SETTINGS_SNAPSHOT_KEY]: snapshot } = await chrome.storage.local.get(SETTINGS_SNAPSHOT_KEY);
  const settings = storedSettings(snapshot?.settings);
  const watches = await getSetAsideWatches();
  const listings = (await feedEntries()).length;
  return {
    exists: watches.length > 0 || listings > 0 || Object.keys(settings).length > 0,
    watches: watches.length,
    listings,
    settings,
    own: watches,
  };
}

// ---------- the copies from before the import (WD-83) ----------

// Equal whatever order the keys are in.
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, ordered(value[key])]),
  );
}
const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));

// What this browser keeps from before it worked with the account, beside a
// finished import `record`: { watches, watchesRemovable, settings,
// settingsRemovable }. `watches` is how many watches are set aside and
// `settings` the names of the settings kept. A copy is removable, by
// confirmImport() and nothing else, only when this import put all of it into
// the account: it is the copy the import read, and WatchDesk refused nothing
// of it. One that holds anything else is somebody's only copy and stays.
async function safetyCopies(record) {
  const stored = await chrome.storage.local.get([WATCHES_SNAPSHOT_KEY, SETTINGS_SNAPSHOT_KEY]);
  const counts = { ...emptyCounts(), ...record.counts };
  const watchCopy = stored[WATCHES_SNAPSHOT_KEY];
  const kept = storedSettings(stored[SETTINGS_SNAPSHOT_KEY]?.settings);
  const watches = (await getSetAsideWatches()).length;
  const settings = Object.keys(kept);
  return {
    watches,
    watchesRemovable:
      watches > 0 &&
      // Set only by an import that uploaded watches that had been set aside.
      Number.isFinite(record.ownTakenAt) &&
      watchCopy.takenAt === record.ownTakenAt &&
      counts.watchesRefused === 0,
    settings,
    settingsRemovable:
      settings.length > 0 &&
      Boolean(record.settings) &&
      typeof record.settings === "object" &&
      same(kept, record.settings) &&
      counts.settingsRefused.length === 0,
  };
}

// ---------- what the popup sees ----------

// Null when there is nothing to show (no account connected, or no record),
// else one of
//   { phase: "checking" }  just paired, not yet settled
//   { phase: "offered", again, watches, listings, settings }
//       what saying yes would upload: two counts and whether there are
//       settings. `again` is the offer made from the settings panel, or
//       (with `redo: true`, WD-83) from the report of an import that ended.
//   { phase: "importing", step, listingsDone, listingsTotal, appliedDone,
//     appliedTotal, problem, counts }
//       `problem` is { message, retryAt } while the import is stopped.
//   { phase: "done", closed, finishedAt, counts, listingsHere, copies,
//     confirmable, redo }
//       WD-83. `closed`: the report was put away (the settings panel shows
//       it again). `listingsHere`: the feed entries this browser still has.
//       `copies`: what it keeps from before (safetyCopies). `confirmable`:
//       the connected account is the import's, so its copies may be removed.
//       `redo`: there is something an import could send again.
//   { phase: "declined", available, watches, listings, settings }
//       `available`: there is something an import could still upload.
// No token, no listing, no watch URL.
export async function getImportStatus() {
  if (!(await isConnected())) return null;
  const record = await readRecord();
  switch (record?.phase) {
    case "connecting":
      return { phase: "checking" };
    case "offered":
    case "offered-again": {
      const again = record.phase === "offered-again";
      const data = again ? await setAsideData() : await ownData();
      return {
        phase: "offered",
        again,
        watches: data.watches,
        listings: data.listings,
        settings: Object.keys(data.settings).length > 0,
        ...(record.back ? { redo: true } : {}),
      };
    }
    case "importing": {
      const marks = Array.isArray(record.marks) ? record.marks.length : 0;
      const appliedTotal = Number.isInteger(record.appliedTotal) ? record.appliedTotal : null;
      return {
        phase: "importing",
        step: record.step,
        listingsDone: Array.isArray(record.sent) ? record.sent.length : 0,
        listingsTotal: Number.isInteger(record.listingsTotal) ? record.listingsTotal : null,
        appliedDone: appliedTotal === null ? 0 : Math.max(0, appliedTotal - marks),
        appliedTotal,
        problem: record.problem ? { message: record.problem.message, retryAt: record.resumeAt ?? null } : null,
        counts: { ...emptyCounts(), ...record.counts },
      };
    }
    case "done": {
      const owner = await getAccountOwner();
      return {
        phase: "done",
        closed: record.closed === true,
        finishedAt: Number.isFinite(record.finishedAt) ? record.finishedAt : null,
        counts: { ...emptyCounts(), ...record.counts },
        listingsHere: (await feedEntries()).length,
        copies: await safetyCopies(record),
        confirmable: Boolean(owner) && owner === record.owner,
        redo: (await setAsideData()).exists,
      };
    }
    case "declined": {
      const data = await setAsideData();
      return {
        phase: "declined",
        available: data.exists,
        watches: data.watches,
        listings: data.listings,
        settings: Object.keys(data.settings).length > 0,
      };
    }
    default:
      return null;
  }
}

// Tells an open popup where the import stands. With no popup open there is
// no receiver, which is fine.
async function announce() {
  try {
    await chrome.runtime.sendMessage({ type: "local-import-changed", localImport: await getImportStatus() });
  } catch {
    // No popup open.
  }
}

async function ensureAlarm() {
  if (await chrome.alarms.get(IMPORT_ALARM)) return;
  await chrome.alarms.create(IMPORT_ALARM, { periodInMinutes: IMPORT_ALARM_PERIOD_MINUTES });
}

// ---------- deciding whether to ask ----------

// One decision at a time: the popup opening and an alarm tick can both ask.
let lastTurn = Promise.resolve();
function inTurn(run) {
  const result = lastTurn.then(run, run);
  lastTurn = result.catch(() => {});
  return result;
}

// What becomes of a "connecting" record, given what this browser holds,
// whose the connection is, and what that account answered before.
// Undefined: not yet (WatchDesk has not said whose the token is).
// `kept` is the import this account had under way when another account
// connected, if any.
function settle(record, data, owner, answers, kept) {
  // The same account again: an import a disconnection stopped goes on,
  // whether it reconnects at once or after another account has been here.
  // From the watches, which changes nothing that was done: a new connection
  // knows no watch by its WatchDesk id until a sync has told it
  // (watch-sync.js), and the listings that are left need those ids.
  const interrupted = owner && record.interrupted?.owner === owner ? record.interrupted : owner ? kept : null;
  if (interrupted) return { ...interrupted, step: "watches", problem: null, attempts: 0, resumeAt: null };
  // An import is waiting to hear whose account this is; it is not dropped
  // for want of a name.
  if (record.interrupted && !owner) return undefined;
  if (!data.exists) return null;
  if (!owner) return undefined;
  if (answers[owner] === "accepted") return null;
  if (answers[owner] === "declined") return { phase: "declined", owner };
  return { phase: "offered", owner };
}

async function decide() {
  const record = await readRecord();
  if (!record) return;
  const connection = await captureConnection();
  if (!connection) return;

  let settled = false;
  if (record.phase === "connecting") {
    const data = await ownData();
    const answers = await readAnswers();
    const { owner } = connection;
    // Another account's import was under way: it is put by, under that
    // account's name, before this account is settled, and taken up again
    // when that account is back. This account gets nothing of it.
    if (owner && record.interrupted?.owner && record.interrupted.owner !== owner) await keepInterrupted(record.interrupted);
    const kept = owner ? (await readInterrupted())[owner] : undefined;
    const next = await changeImportRecord(async (stored) => {
      if (stored?.phase !== "connecting" || !(await isCurrentConnection(connection))) return undefined;
      const outcome = settle(stored, data, owner, answers, kept);
      settled = outcome !== undefined;
      return outcome;
    });
    if (settled && next?.phase === "importing") await forgetInterrupted(owner);
  } else if (record.phase === "offered" && !(await ownData()).exists) {
    // Reset, or cleared by hand, while the question was open: nothing is
    // left to ask about.
    await changeImportRecord((stored) => {
      settled = stored?.phase === "offered";
      return settled ? null : undefined;
    });
  }

  if ((await readRecord())?.phase === "importing") await ensureAlarm();
  if (settled) await announce();
}

// Settles a freshly paired browser: asks, or does not. background.js calls
// it before anything that syncs (the popup opening, a check, a sync) and
// whenever WatchDesk has just said whose the token is, so a browser with
// nothing to ask about is not held up, and one with something is asked the
// first time the popup opens. A browser with data of its own stays on hold
// until the account has a name: whose it is decides whether to ask. Sends
// nothing. Never throws.
export function prepareImportOffer() {
  return inTurn(async () => {
    try {
      await decide();
    } catch {
      // Still on hold; the next call tries again.
    }
  });
}

// ---------- the user's answer ----------

// "Import": the record becomes the import, which runImport() then carries
// out. Resolves to the status the popup shows.
export async function acceptImport() {
  const record = await readRecord();
  if (record?.phase === "offered" || record?.phase === "offered-again") {
    const again = record.phase === "offered-again";
    const data = again ? await setAsideData() : await ownData();
    // WD-83: which copy of the set-aside watches this import uploads.
    const { [WATCHES_SNAPSHOT_KEY]: watchCopy } = await chrome.storage.local.get(WATCHES_SNAPSHOT_KEY);
    const ownTakenAt = again && data.own.length > 0 && Number.isFinite(watchCopy?.takenAt) ? watchCopy.takenAt : null;
    const connection = await captureConnection();
    let accepted = false;
    await changeImportRecord(async (stored) => {
      if (stored?.phase !== record.phase || stored.owner !== record.owner) return undefined;
      // The answer is for the account that was asked.
      if (!connection || connection.owner !== stored.owner || !(await isCurrentConnection(connection))) return undefined;
      accepted = true;
      return {
        phase: "importing",
        owner: stored.owner,
        again,
        startedAt: Date.now(),
        step: "watches",
        own: again ? data.own : [],
        ownTakenAt,
        settings: data.settings,
        sent: [],
        marks: [],
        listingsTotal: null,
        appliedTotal: null,
        counts: emptyCounts(),
        problem: null,
        attempts: 0,
        resumeAt: null,
      };
    });
    if (accepted) {
      await rememberAnswer(record.owner, "accepted");
      await ensureAlarm();
    }
  }
  return getImportStatus();
}

// "Not now": this browser's watches are kept as they are, the answer is
// remembered, and from here the browser works with the account as it is.
// Nothing is uploaded and nothing in this browser is removed.
export async function declineImport() {
  const record = await readRecord();
  if (record?.phase === "offered" || record?.phase === "offered-again") {
    // Before the answer: the first sync after it replaces the stored list.
    if (record.phase === "offered") await keepOwnWatches();
    let declined = false;
    await changeImportRecord((stored) => {
      if (stored?.phase !== record.phase || stored.owner !== record.owner) return undefined;
      // WD-83: asked from the report of an import that ended, "Not now" goes
      // back to that report. The account's answer stays yes.
      if (stored.back) return { ...stored.back, closed: false };
      declined = true;
      return { phase: "declined", owner: stored.owner };
    });
    if (declined) await rememberAnswer(record.owner, "declined");
  }
  return getImportStatus();
}

// The settings panel's "Import…" after an earlier "no": asks again, about
// what was set aside. The browser goes on working with the account while
// the question is open.
// WD-83: also the report's "Import again", for an import that looked wrong.
// The same question, about the same things; the report is kept in `back`
// for a "Not now". Only for the account the import was for.
export async function offerImportAgain() {
  if ((await setAsideData()).exists) {
    const owner = await getAccountOwner();
    await changeImportRecord((stored) => {
      if (stored?.phase === "declined") return { phase: "offered-again", owner: stored.owner };
      if (stored?.phase === "done" && owner && owner === stored.owner) {
        return { phase: "offered-again", owner: stored.owner, back: stored };
      }
      return undefined;
    });
  }
  return getImportStatus();
}

// Reset Extension: everything this module keeps goes, like the watches and
// the feed it was about: the record (an import under way ends there), what
// each account answered, the imports put by for other accounts, and the
// watches set aside by a "no". A connected browser is then an ordinary
// connected one, with nothing of its own left to ask about.
// One thing stays: a question that is still open. Removing it would let the
// browser start syncing with an account whose user never answered; it is
// asked about what the reset left (the default watch and settings) instead.
export async function resetImport() {
  await changeImportRecord((stored) => {
    if (stored?.phase === "offered") return { phase: "offered", owner: stored.owner };
    if (stored?.phase === "connecting") return { phase: "connecting" };
    return null;
  });
  await chrome.storage.local.remove([IMPORT_ANSWERS_KEY, IMPORT_INTERRUPTED_KEY, WATCHES_SNAPSHOT_KEY]);
  await chrome.alarms.clear(IMPORT_ALARM);
}

// "Close": the report is put away, not removed (WD-83). Nothing else
// changes; the settings panel shows it again.
export async function dismissImport() {
  await changeImportRecord((stored) => (stored?.phase === "done" ? { ...stored, closed: true } : undefined));
  return getImportStatus();
}

// The settings panel's way back to the report.
export async function reviewImport() {
  await changeImportRecord((stored) => (stored?.phase === "done" ? { ...stored, closed: false } : undefined));
  return getImportStatus();
}

// The user has checked the report and asked for the earlier copies to be
// removed (WD-83): the one place anything of this browser's is removed after
// an import. `finishedAt` names the report the user was looking at; a
// different one, an import that is not finished, no account, or an account
// that is not the import's removes nothing. Removes the copies this import
// put into the account in full (safetyCopies) and the report itself, in the
// queue a new token is stored in, so a pairing cannot come between the
// check and the removal. Resolves to what was removed, { watches, settings },
// or null when nothing was.
export async function confirmImport(finishedAt) {
  const connection = await captureConnection();
  let removed = null;
  await changeImportRecord(async (stored) => {
    if (stored?.phase !== "done" || !Number.isFinite(finishedAt) || stored.finishedAt !== finishedAt) return undefined;
    if (!connection?.owner || connection.owner !== stored.owner || !(await isCurrentConnection(connection))) return undefined;
    const copies = await safetyCopies(stored);
    const keys = [
      ...(copies.watchesRemovable ? [WATCHES_SNAPSHOT_KEY] : []),
      ...(copies.settingsRemovable ? [SETTINGS_SNAPSHOT_KEY] : []),
    ];
    if (keys.length > 0) await chrome.storage.local.remove(keys);
    removed = {
      watches: copies.watchesRemovable ? copies.watches : 0,
      settings: copies.settingsRemovable ? copies.settings : [],
    };
    return null;
  });
  return removed;
}

// ---------- the import ----------

// Ends a run: the import is no longer this run's to continue (another
// account connected, the token was refused, the record was replaced), or it
// has stopped with its problem recorded.
class Stopped extends Error {}

// Writes the import's progress, only while the stored record is still this
// import: a pairing that completed meanwhile has replaced it, and the run
// ends there.
async function progress(run, patch) {
  const { owner, startedAt } = run.record;
  let written = false;
  const next = await changeImportRecord((stored) => {
    if (stored?.phase !== "importing" || stored.owner !== owner || stored.startedAt !== startedAt) return undefined;
    written = true;
    return { ...stored, ...patch };
  });
  if (!written) throw new Stopped();
  run.record = next;
  await announce();
}

function outageMessage(result) {
  switch (result?.kind) {
    case "unreachable":
      return "Can't reach WatchDesk.";
    case "rate-limited":
      return "WatchDesk is busy.";
    case "forbidden":
      return "WatchDesk isn't accepting this from your account yet. Verify your email address on WatchDesk.";
    case "not-found":
      return "WatchDesk has no settings for this account yet. Sign in to WatchDesk once.";
    default:
      return "WatchDesk couldn't take it just now.";
  }
}

// WatchDesk did not take a step, for a reason a later try may not meet. The
// import stays where it is and says why; its alarm tries again after the
// wait. An account that is no longer this run's ends the run without a word:
// there is nobody to tell.
async function stop(run, result) {
  if (result?.kind === "connection-changed" || result?.kind === "unauthorized") throw new Stopped();
  const attempts = (run.record.attempts || 0) + 1;
  const wait =
    result?.kind === "rate-limited" && result.retryAfterSeconds
      ? result.retryAfterSeconds * 1000
      : Math.min(IMPORT_RETRY_BASE_MS * 2 ** (attempts - 1), IMPORT_RETRY_MAX_MS);
  const resumeAt = Date.now() + wait;
  await progress(run, {
    problem: { kind: result?.kind || "error", message: outageMessage(result) },
    attempts,
    resumeAt,
  });
  // The alarm next fires when the wait is over, not every half minute of it.
  await chrome.alarms.create(IMPORT_ALARM, { when: resumeAt, periodInMinutes: IMPORT_ALARM_PERIOD_MINUTES });
  throw new Stopped();
}

async function pace(run) {
  if (run.requests > 0) await sleep(IMPORT_REQUEST_GAP_MS);
  run.requests += 1;
}

// 1. The watches.
async function importWatches(run) {
  const result = await uploadOwnWatches(Array.isArray(run.record.own) ? run.record.own : [], run.connection);
  if (!result.ok) await stop(run, result);
  const counts = {
    ...run.record.counts,
    watchesUploaded: run.record.counts.watchesUploaded + result.created,
    watchesMatched: run.record.counts.watchesMatched + result.matched,
    watchesMatchedDiffer: (run.record.counts.watchesMatchedDiffer || 0) + result.differing,
    // The watches WatchDesk refused stay in this browser and are named by
    // every sync, so this is their number, not an addition to it.
    watchesRefused: result.rejected,
    // WD-83: the same three, for each site.
    watchesBySite: withWatchSites(run.record.counts.watchesBySite, result.bySite),
  };
  if (result.waiting > 0) {
    // Some went up before WatchDesk stopped taking them. The rest are still
    // in this browser's list and are offered again by the next try.
    await progress(run, { counts });
    await stop(run, result.stoppedBy);
  }
  await progress(run, { counts, own: [], step: "listings", attempts: 0 });
}

// A feed entry's own name: what `sent` remembers it by.
const entryKey = (entry) =>
  typeof entry.id === "string" && entry.id ? entry.id : typeof entry.sourceKey === "string" ? entry.sourceKey : "";

// The site's own id of an entry's posting. sourceKey is "<site>:<id>" and an
// entry from before that field existed has id "<watch>:<id>"; neither a site
// id nor a watch id holds a colon.
function jobIdOf(entry) {
  const key = typeof entry.sourceKey === "string" && entry.sourceKey ? entry.sourceKey : entryKey(entry);
  const cut = key.indexOf(":");
  return cut >= 0 ? key.slice(cut + 1) : "";
}

const siteOfEntry = (entry) =>
  entry.siteId || (typeof entry.sourceKey === "string" ? entry.sourceKey.split(":")[0] : "") || null;

// The form WatchDesk takes a time in: "2026-09-30T08:15:30.123Z".
const ISO_LENGTH = 24;

// When this browser first found an entry's posting (WD-117), as { at, iso }:
// the feed's epoch milliseconds, and the string WatchDesk is sent. Null when
// the entry holds no time that can be sent: none, not a number, not finite,
// zero or negative, or beyond what a Date holds or writes with a four-digit
// year. Whether a time is too old or in the future is WatchDesk's to say.
function foundAt(entry) {
  const at = entry.detectedAt;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString();
  return iso.length === ISO_LENGTH ? { at, iso } : null;
}

// The feed entries still to send, as { groups, pending, leftOut }: `groups`
// is watch id -> the postings to send for it, each { listing, keys, applied,
// site }. A posting is named as WatchDesk names it, by its watch's site and
// the site's id of it, and is sent once: one this browser holds under two
// watches (WD-82) goes to the watch that found it first, as WatchDesk files
// a posting two watches find, and the other entry only adds its key and its
// applied mark. Left out, and counted by site in `leftOut`: an entry whose
// watch is not on WatchDesk (removed here since, or refused there) or is on
// another site than the entry — a listing's site comes from its watch, so it
// would be filed as a different posting — and an entry WatchDesk could not
// store. A listing carries the time its entry was found, when it has one
// (foundAt).
async function planListings(run) {
  const serverIds = new Set(await getServerWatchIds());
  const { watches } = await chrome.storage.sync.get("watches");
  const siteOfWatch = new Map(
    (Array.isArray(watches) ? watches : []).filter((w) => w && serverIds.has(w.id)).map((w) => [w.id, w.siteId || null]),
  );
  const sent = new Set(run.record.sent);
  const postings = new Map();
  const leftOut = {};
  let pending = 0;
  for (const entry of await feedEntries()) {
    const key = entryKey(entry);
    if (key && sent.has(key)) continue;
    const site = siteOfWatch.get(entry.watchId);
    const entrySite = siteOfEntry(entry);
    const stored = key ? toListing({ ...entry, id: jobIdOf(entry) }) : null;
    if (!stored) {
      tally(leftOut, entrySite || site || OTHER_SITE, "listingsInvalid", 1);
      continue;
    }
    if (site === undefined || (site && entrySite && site !== entrySite)) {
      tally(leftOut, entrySite || OTHER_SITE, "listingsNoWatch", 1);
      continue;
    }
    pending += 1;
    const postingSite = site || entrySite || OTHER_SITE;
    const posting = `${postingSite}:${stored.id}`;
    const when = foundAt(entry);
    const listing = when ? { ...stored, detectedAt: when.iso } : stored;
    const found = when ? when.at : Infinity;
    const held = postings.get(posting);
    if (!held) {
      postings.set(posting, {
        listing,
        keys: [key],
        applied: entry.applied === true,
        site: postingSite,
        watchId: entry.watchId,
        found,
      });
      continue;
    }
    held.keys.push(key);
    held.applied = held.applied || entry.applied === true;
    if (found < held.found) Object.assign(held, { listing, watchId: entry.watchId, found });
  }
  const groups = new Map();
  for (const item of postings.values()) {
    if (!groups.has(item.watchId)) groups.set(item.watchId, []);
    groups.get(item.watchId).push(item);
  }
  return { groups, pending, leftOut };
}

// The entries of `items` are answered for: WatchDesk has them, or never will.
function answered(run, items, counts, extra = {}) {
  return progress(run, {
    sent: [...run.record.sent, ...items.flatMap((item) => item.keys)],
    counts,
    attempts: 0,
    ...extra,
  });
}

const entriesIn = (items) => items.reduce((sum, item) => sum + item.keys.length, 0);

// Sends one request's worth of one watch's listings. Resolves to true when
// WatchDesk no longer has the watch.
async function sendListings(run, watchId, items) {
  await pace(run);
  const result = await ingestListings(
    watchId,
    items.map((item) => item.listing),
    run.connection,
  );
  const counts = { ...run.record.counts };
  if (result.kind === "ok") {
    // WatchDesk names the listings this request added, and only those: an
    // applied mark can follow them, not one the account already had. The
    // others it already had (WD-82): skipped, with the watch and the status
    // they have there.
    const added = new Map(result.inserted.map((row) => [row.jobId, row.id]));
    // WD-117: the times WatchDesk says it did not use for a listing it added.
    // An answer without them, or with an outcome this code does not know,
    // names none.
    const undated = new Set(
      (result.detectedTimes || []).filter((time) => time.outcome === "out-of-range").map((time) => time.jobId),
    );
    const marks = [...run.record.marks];
    let datedToday = 0;
    for (const item of items) {
      const isNew = added.has(item.listing.id);
      if (isNew && (!item.listing.detectedAt || undated.has(item.listing.id))) datedToday += 1;
      tally(counts, item.site, "listingsNew", isNew ? 1 : 0);
      tally(counts, item.site, "listingsExisting", item.keys.length - (isNew ? 1 : 0));
      if (!item.applied) continue;
      if (isNew) marks.push(added.get(item.listing.id));
      else counts.appliedNotCarried += 1;
    }
    if (datedToday > 0) counts.listingsDatedToday = (counts.listingsDatedToday || 0) + datedToday;
    counts.listingsUploaded += entriesIn(items);
    await answered(run, items, counts, { marks });
    return false;
  }
  if (result.kind === "not-found") {
    for (const item of items) tally(counts, item.site, "listingsWatchGone", item.keys.length);
    await answered(run, items, counts);
    return true;
  }
  if (result.kind === "invalid") {
    // One listing WatchDesk will not take refuses the whole request. Halve
    // it until that one is alone, leave it out, and send the rest.
    if (items.length === 1) {
      tally(counts, items[0].site, "listingsRefused", entriesIn(items));
      await answered(run, items, counts);
      return false;
    }
    const half = Math.ceil(items.length / 2);
    if (await sendListings(run, watchId, items.slice(0, half))) return watchGone(run, items.slice(half));
    return sendListings(run, watchId, items.slice(half));
  }
  return stop(run, result);
}

// The watch was deleted on WatchDesk since the watches went up: what is left
// of its listings has nowhere to go.
async function watchGone(run, items) {
  if (items.length > 0) {
    const counts = { ...run.record.counts };
    for (const item of items) tally(counts, item.site, "listingsWatchGone", item.keys.length);
    await answered(run, items, counts);
  }
  return true;
}

// 2. The feed.
async function importListings(run) {
  const plan = await planListings(run);
  // What this browser holds now that cannot go, not a sum over runs: these
  // entries are looked at afresh by every run.
  const counts = { ...run.record.counts, listingsNoWatch: 0, listingsInvalid: 0, bySite: {} };
  for (const [site, held] of Object.entries(run.record.counts.bySite || {})) {
    counts.bySite[site] = { ...emptySiteCounts(), ...held, listingsNoWatch: 0, listingsInvalid: 0 };
  }
  for (const [site, left] of Object.entries(plan.leftOut.bySite || {})) {
    tally(counts, site, "listingsNoWatch", left.listingsNoWatch);
    tally(counts, site, "listingsInvalid", left.listingsInvalid);
  }
  await progress(run, { listingsTotal: run.record.sent.length + plan.pending, counts });
  for (const [watchId, items] of plan.groups) {
    for (let start = 0; start < items.length; start += INGEST_MAX_LISTINGS) {
      if (await sendListings(run, watchId, items.slice(start, start + INGEST_MAX_LISTINGS))) {
        await watchGone(run, items.slice(start + INGEST_MAX_LISTINGS));
        break;
      }
    }
  }
  await progress(run, { step: "applied", appliedTotal: run.record.marks.length, attempts: 0 });
}

// 3. The applied marks.
async function importApplied(run) {
  while (run.record.marks.length > 0) {
    const [listingId, ...rest] = run.record.marks;
    await pace(run);
    const result = await setListingStatus(listingId, "applied", run.connection);
    const counts = { ...run.record.counts };
    if (result.kind === "ok") counts.appliedMarked += 1;
    // A listing deleted since, or a status WatchDesk no longer knows: no
    // retry changes that.
    else if (result.kind === "not-found" || result.kind === "invalid") counts.appliedNotCarried += 1;
    else await stop(run, result);
    await progress(run, { marks: rest, counts, attempts: 0 });
  }
  await progress(run, { step: "settings", attempts: 0 });
}

// 4. The settings. One WatchDesk's limits refuse is left out and named, so
// one long keyword list does not keep the interval from being saved.
async function importSettings(run) {
  const settings = run.record.settings && typeof run.record.settings === "object" ? run.record.settings : {};
  const patch = {};
  const refused = [];
  for (const setting of SYNCED_SETTINGS) {
    if (!(setting in settings)) continue;
    const reason = settingsProblem({ [setting]: settings[setting] });
    if (reason) refused.push({ setting, reason });
    else patch[setting] = settings[setting];
  }
  let saved = [];
  if (Object.keys(patch).length > 0) {
    const result = await importAccountSettings(patch, run.connection);
    if (result.kind === "ok") saved = Object.keys(patch);
    else if (result.kind === "refused" || result.kind === "invalid") {
      const reason = result.message || "WatchDesk didn't accept it.";
      refused.push(...Object.keys(patch).map((setting) => ({ setting, reason })));
    } else await stop(run, result);
  }
  return { ...run.record.counts, settingsSaved: saved, settingsRefused: refused };
}

async function runSteps(force) {
  const record = await readRecord();
  if (record?.phase !== "importing") return;
  const connection = await captureConnection();
  // Another account, none, or one WatchDesk has not named yet: nothing of
  // this import is sent. The same account connecting again takes it up.
  if (!connection || !connection.owner || connection.owner !== record.owner) return;
  if (!force && record.resumeAt && Date.now() < record.resumeAt) return;

  const run = { record, connection, requests: 0 };
  try {
    if (record.problem || record.resumeAt) await progress(run, { problem: null, resumeAt: null });
    if (run.record.step === "watches") await importWatches(run);
    if (run.record.step === "listings") await importListings(run);
    if (run.record.step === "applied") await importApplied(run);
    const counts = await importSettings(run);
    const { owner, startedAt } = run.record;
    let finished = false;
    await changeImportRecord((stored) => {
      if (stored?.phase !== "importing" || stored.owner !== owner || stored.startedAt !== startedAt) return undefined;
      finished = true;
      return {
        phase: "done",
        owner,
        again: Boolean(stored.again),
        finishedAt: Date.now(),
        counts,
        // WD-83: what this import saved and which set-aside watches it
        // uploaded, so that confirmImport() can tell its own copies.
        settings: stored.settings && typeof stored.settings === "object" ? stored.settings : {},
        ownTakenAt: stored.ownTakenAt ?? null,
      };
    });
    if (!finished) return;
    await forgetInterrupted(owner);
    await chrome.alarms.clear(IMPORT_ALARM);
    await announce();
  } catch (err) {
    if (err instanceof Stopped) return;
    // Something this code has no rule for (storage refusing a write, say):
    // the import stays where it is and is tried again like any other stop.
    await stop(run, { kind: "error" }).catch(() => {});
  }
}

// Never two at once: the popup's click, the alarm and a restarted worker
// all end up here, and a second caller is given the run already under way.
let running = null;

// Carries the import on from wherever it stands, until it is done or
// WatchDesk cannot take the next step. Does nothing when no import is under
// way, when its account is not the connected one, or (unless `force`, the
// popup's Retry) while it is waiting to try again. Never throws.
export function runImport({ force = false } = {}) {
  if (!running) {
    running = runSteps(force)
      .catch(() => {})
      .finally(() => {
        running = null;
      });
  }
  return running;
}

// ---------- worker wiring ----------

// Called once, synchronously, at the top level of background.js, so the
// listener exists whenever Chrome wakes the worker for the alarm.
export function registerLocalImport() {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== IMPORT_ALARM) return;
    // The alarm outlives its import only when a worker was stopped between
    // the two; it is cleared rather than left ticking for nothing.
    if ((await readRecord())?.phase !== "importing" || !(await isConnected())) {
      await chrome.alarms.clear(IMPORT_ALARM);
      return;
    }
    await runImport();
  });
  // A worker restarted mid-import picks up where it left off.
  runImport().catch(() => {});
}
