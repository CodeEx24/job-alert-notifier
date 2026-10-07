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
//   done        the import ended; the popup shows what happened until the
//               user closes the card.
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
//                becomes the account's watch with the same URL, or is
//                uploaded. From then on its feed entries carry its id on
//                WatchDesk.
//   2. listings  the feed, by watch, at most INGEST_MAX_LISTINGS a request,
//                straight to POST /api/listings/ingest and not through
//                listing-ingest.js's retry queue, whose cap drops the oldest.
//                WatchDesk keeps one row per posting however often it is
//                sent. A request it refuses (400) is halved until the one
//                listing it will not take is found and left out.
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
//     Every write goes through account-connection.js's changeImportRecord(),
//     the queue a new token is stored in, and only while the record is still
//     this import's: a pairing that completes ends it.
//   watchdeskImportAnswers  { <account email>: "accepted" | "declined" }
//   Nothing that must survive a worker restart is in a module variable.
//
// Nothing here sees the device token (every request is bound to the
// connection the run began with, WD-110) and nothing here logs: a listing's
// title and URL say what the user is searching for.

import {
  captureConnection,
  changeImportRecord,
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
} from "./watch-sync.js";
import { importAccountSettings, SETTINGS_SNAPSHOT_KEY, SYNCED_SETTINGS } from "./account-settings.js";
import { toListing } from "./listing-ingest.js";
import { ingestListings, setListingStatus, INGEST_MAX_LISTINGS } from "./watchdesk-api.js";
import { settingsProblem } from "./settings-limits.js";

export const IMPORT_ANSWERS_KEY = "watchdeskImportAnswers";
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

const emptyCounts = () => ({
  watchesUploaded: 0,
  watchesMatched: 0,
  watchesRefused: 0,
  listingsUploaded: 0,
  listingsNew: 0,
  listingsNoWatch: 0,
  listingsWatchGone: 0,
  listingsInvalid: 0,
  listingsRefused: 0,
  appliedMarked: 0,
  appliedNotCarried: 0,
  settingsSaved: [],
  settingsRefused: [],
});

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

// ---------- what the popup sees ----------

// Null when there is nothing to show (no account connected, or no record),
// else one of
//   { phase: "checking" }  just paired, not yet settled
//   { phase: "offered", again, watches, listings, settings }
//       what saying yes would upload: two counts and whether there are
//       settings. `again` is the offer made from the settings panel.
//   { phase: "importing", step, listingsDone, listingsTotal, appliedDone,
//     appliedTotal, problem, counts }
//       `problem` is { message, retryAt } while the import is stopped.
//   { phase: "done", counts }
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
    case "done":
      return { phase: "done", counts: { ...emptyCounts(), ...record.counts } };
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
function settle(record, data, owner, answers) {
  // The same account again: an import a disconnection stopped goes on. From
  // the watches, which changes nothing that was done: a new connection knows
  // no watch by its WatchDesk id until a sync has told it (watch-sync.js),
  // and the listings that are left need those ids.
  if (owner && record.interrupted?.owner === owner) {
    return { ...record.interrupted, step: "watches", problem: null, attempts: 0, resumeAt: null };
  }
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
    await changeImportRecord(async (stored) => {
      if (stored?.phase !== "connecting" || !(await isCurrentConnection(connection))) return undefined;
      const next = settle(stored, data, connection.owner, answers);
      settled = next !== undefined;
      return next;
    });
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
export async function offerImportAgain() {
  if ((await setAsideData()).exists) {
    await changeImportRecord((stored) =>
      stored?.phase === "declined" ? { phase: "offered-again", owner: stored.owner } : undefined,
    );
  }
  return getImportStatus();
}

// The user has read how the import ended.
export async function dismissImport() {
  await changeImportRecord((stored) => (stored?.phase === "done" ? null : undefined));
  return getImportStatus();
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
    // The watches WatchDesk refused stay in this browser and are named by
    // every sync, so this is their number, not an addition to it.
    watchesRefused: result.rejected,
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

// The feed entries still to send, as { groups, pending, noWatch, invalid }:
// `groups` is watch id -> the postings to send for it, each { listing, keys,
// applied }. Left out, and counted: an entry whose watch is not on WatchDesk
// (removed here since, or refused there) or is on another site than the
// entry — a listing's site comes from its watch, so it would be filed as a
// different posting — and an entry WatchDesk could not store.
async function planListings(run) {
  const serverIds = new Set(await getServerWatchIds());
  const { watches } = await chrome.storage.sync.get("watches");
  const siteOfWatch = new Map(
    (Array.isArray(watches) ? watches : []).filter((w) => w && serverIds.has(w.id)).map((w) => [w.id, w.siteId || null]),
  );
  const sent = new Set(run.record.sent);
  const groups = new Map();
  let pending = 0;
  let noWatch = 0;
  let invalid = 0;
  for (const entry of await feedEntries()) {
    const key = entryKey(entry);
    if (key && sent.has(key)) continue;
    const listing = key ? toListing({ ...entry, id: jobIdOf(entry) }) : null;
    if (!listing) {
      invalid += 1;
      continue;
    }
    const site = siteOfWatch.get(entry.watchId);
    const entrySite = siteOfEntry(entry);
    if (site === undefined || (site && entrySite && site !== entrySite)) {
      noWatch += 1;
      continue;
    }
    if (!groups.has(entry.watchId)) groups.set(entry.watchId, new Map());
    const group = groups.get(entry.watchId);
    const item = group.get(listing.id) || { listing, keys: [], applied: false };
    item.keys.push(key);
    item.applied = item.applied || entry.applied === true;
    group.set(listing.id, item);
    pending += 1;
  }
  return { groups, pending, noWatch, invalid };
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
    // applied mark can follow them, not one the account already had.
    const added = new Map(result.inserted.map((row) => [row.jobId, row.id]));
    const marks = [...run.record.marks];
    for (const item of items) {
      if (!item.applied) continue;
      if (added.has(item.listing.id)) marks.push(added.get(item.listing.id));
      else counts.appliedNotCarried += 1;
    }
    counts.listingsUploaded += entriesIn(items);
    counts.listingsNew += result.inserted.length;
    await answered(run, items, counts, { marks });
    return false;
  }
  if (result.kind === "not-found") {
    counts.listingsWatchGone += entriesIn(items);
    await answered(run, items, counts);
    return true;
  }
  if (result.kind === "invalid") {
    // One listing WatchDesk will not take refuses the whole request. Halve
    // it until that one is alone, leave it out, and send the rest.
    if (items.length === 1) {
      counts.listingsRefused += entriesIn(items);
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
    counts.listingsWatchGone += entriesIn(items);
    await answered(run, items, counts);
  }
  return true;
}

// 2. The feed.
async function importListings(run) {
  const plan = await planListings(run);
  await progress(run, {
    listingsTotal: run.record.sent.length + plan.pending,
    // What this browser holds now, not a sum over runs: these entries are
    // looked at afresh by every run.
    counts: { ...run.record.counts, listingsNoWatch: plan.noWatch, listingsInvalid: plan.invalid },
  });
  for (const [watchId, group] of plan.groups) {
    const items = [...group.values()];
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
      return { phase: "done", owner, again: Boolean(stored.again), finishedAt: Date.now(), counts };
    });
    if (!finished) return;
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
