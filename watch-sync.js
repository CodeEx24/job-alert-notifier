// watch-sync.js — the watch list of a browser connected to a WatchDesk
// account (WD-54). Runs in the service worker; background.js calls it.
//
// Two modes, decided by whether a device token is stored:
//
//   not connected  Nothing here does anything. background.js keeps the
//                  watch list in chrome.storage.sync exactly as before.
//   connected      WatchDesk's list is the truth. chrome.storage.sync's
//                  `watches` — the key the check cycle has always read —
//                  becomes the last-synced copy of it, so checks, the popup
//                  and Open All Tabs keep working from it with WatchDesk
//                  unreachable. Add, rename, pause and remove call the API
//                  first and change the copy only once WatchDesk has agreed.
//
// A sync (syncWatches) asks for the account's list and reconciles the copy
// with it:
//   - a watch on WatchDesk is taken as it is there (label, URL, enabled);
//   - a watch this browser got from WatchDesk earlier and that is no longer
//     listed was deleted there, and goes;
//   - any other watch is this browser's own, from before it was connected.
//     One whose URL is already on WatchDesk becomes that watch; the rest are
//     uploaded. So connecting never loses a watch and never doubles one.
// A watch that takes a server id keeps its run state (seen jobs, last
// result), moved from its old id, so it does not start over.
// An import (importAccountWatches, WD-111) is a sync in which the backup
// file's watches stand in for the copy; it changes nothing unless WatchDesk
// answers.
//
// Storage:
//   chrome.storage.sync  -> watches            the copy (as before)
//   chrome.storage.local -> watchdeskWatchSync { serverIds, rejectedIds,
//                             lastSyncedAt, offline }
//     serverIds     ids this browser got from WatchDesk: what tells "deleted
//                   there" from "not uploaded yet".
//     rejectedIds   own watches WatchDesk refused (400). Kept in this
//                   browser, not offered again.
//     lastSyncedAt  epoch ms of the last sync that got the list, or null.
//     offline       the last call could not reach WatchDesk.
//   account-connection.js removes this key whenever a token is stored or
//   dropped, so a new connection starts from "every watch is this
//   browser's own".
//   chrome.storage.local -> watchdeskWatchesBeforeConnect { takenAt, watches }
//     The watches of this browser that the user chose not to import into an
//     account (WD-81), as they were. Never uploaded, never removed here:
//     local-import.js offers them again from the settings panel.
//
// A freshly paired browser (WD-81): until the user has answered the import
// question (account-connection.js's isAccountActive), nothing here does
// anything, as with no account connected. If the answer is no, a watch that
// is only in this browser is set aside in the snapshot above instead of
// being uploaded, so the account starts without it and it is not lost.
//
// While WatchDesk is unreachable a change is refused with a message, not
// queued: a queue would have to be replayed against a list that may have
// changed on the web in the meantime.
//
// Nothing here sees the device token: the calls go through
// watchdesk-api.js's authorizedRequest().

import {
  isAccountActive,
  isConnected,
  isCurrentConnection,
  keepsOwnWatchesLocal,
  WATCH_SYNC_KEY,
} from "./account-connection.js";
import { listWatches, createWatch, updateWatch, deleteWatch } from "./watchdesk-api.js";

const WATCHES_KEY = "watches";
export const WATCHES_SNAPSHOT_KEY = "watchdeskWatchesBeforeConnect";
// Run state background.js keeps per watch id, in chrome.storage.local.
const RUN_STATE_MAPS = ["seenIds", "lastChecked", "lastResult", "consecutiveErrors"];

const OFFLINE_MESSAGE =
  "Can't reach WatchDesk, so your watches can't be changed right now. The list shown is the last one synced.";

let config = { unsyncedFallback: () => [] };

// background.js calls this once, at load. `unsyncedFallback()` returns the
// watches a browser with nothing stored is showing (its default watch), so
// the first sync uploads that too instead of dropping it.
export function configureWatchSync({ unsyncedFallback }) {
  config = { unsyncedFallback };
}

// ---------- storage ----------

// One queue for every sync and every change, so two of them cannot both
// read the copy, change it, and write over each other.
let lockTail = Promise.resolve();
function withLock(fn) {
  const run = lockTail.then(fn, fn);
  lockTail = run.catch(() => {});
  return run;
}

const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);

async function readState() {
  const { [WATCH_SYNC_KEY]: state } = await chrome.storage.local.get(WATCH_SYNC_KEY);
  return {
    serverIds: strings(state?.serverIds),
    rejectedIds: strings(state?.rejectedIds),
    lastSyncedAt: typeof state?.lastSyncedAt === "number" ? state.lastSyncedAt : null,
    offline: Boolean(state?.offline),
  };
}

// Not written once the token is gone: the state belongs to a connection.
async function writeState(state) {
  if (await isConnected()) await chrome.storage.local.set({ [WATCH_SYNC_KEY]: state });
}

async function setOffline(offline) {
  const state = await readState();
  if (state.offline !== offline) await writeState({ ...state, offline });
}

async function readCopy() {
  const { [WATCHES_KEY]: watches } = await chrome.storage.sync.get(WATCHES_KEY);
  return Array.isArray(watches) ? watches.filter((w) => w && typeof w.id === "string") : [];
}

// chrome.storage.sync limits writes per minute and per hour, so the copy is
// written only when it differs.
async function writeCopy(next, previous) {
  if (JSON.stringify(next) !== JSON.stringify(previous)) await chrome.storage.sync.set({ [WATCHES_KEY]: next });
}

// Moves run state from an own watch's id to the server id it became, and
// drops it for watches deleted on WatchDesk.
async function carryRunState(idMap, removedIds) {
  if (idMap.size === 0 && removedIds.length === 0) return;
  const stored = await chrome.storage.local.get([...RUN_STATE_MAPS, "feed"]);
  const patch = {};
  for (const key of RUN_STATE_MAPS) {
    const map = stored[key];
    if (!map || typeof map !== "object") continue;
    let changed = false;
    for (const [from, to] of idMap) {
      if (!(from in map)) continue;
      if (!(to in map)) map[to] = map[from];
      delete map[from];
      changed = true;
    }
    for (const id of removedIds) {
      if (!(id in map)) continue;
      delete map[id];
      changed = true;
    }
    if (changed) patch[key] = map;
  }
  // Feed entries keep their own id; watchId only picks the entry's colour.
  if (Array.isArray(stored.feed) && stored.feed.some((entry) => idMap.has(entry?.watchId))) {
    patch.feed = stored.feed.map((entry) =>
      idMap.has(entry?.watchId) ? { ...entry, watchId: idMap.get(entry.watchId) } : entry,
    );
  }
  if (Object.keys(patch).length > 0) await chrome.storage.local.set(patch);
}

// ---------- watches kept out of the account (WD-81) ----------

// The watches set aside so far: this browser's own, which the user chose not
// to import.
export async function getSetAsideWatches() {
  const { [WATCHES_SNAPSHOT_KEY]: snapshot } = await chrome.storage.local.get(WATCHES_SNAPSHOT_KEY);
  return Array.isArray(snapshot?.watches)
    ? snapshot.watches.filter((w) => w && typeof w.id === "string" && typeof w.url === "string")
    : [];
}

// Adds `watches` to the ones set aside, one per URL, the first kept.
async function setAside(watches) {
  const kept = await getSetAsideWatches();
  const urls = new Set(kept.map((w) => w.url));
  const added = [];
  for (const watch of watches) {
    if (!watch || typeof watch.url !== "string" || urls.has(watch.url)) continue;
    urls.add(watch.url);
    added.push(watch);
  }
  if (added.length === 0) return;
  await chrome.storage.local.set({ [WATCHES_SNAPSHOT_KEY]: { takenAt: Date.now(), watches: [...kept, ...added] } });
}

// What a first sync treats as this browser's own list: the stored one, or
// the default watch of a browser that never stored any.
export async function getOwnWatches() {
  const stored = await readCopy();
  return stored.length > 0 ? stored : config.unsyncedFallback();
}

// The user declined the import: this browser's list is kept as it is now,
// before the first sync makes the stored list the account's.
export function keepOwnWatches() {
  return withLock(async () => setAside(await getOwnWatches()));
}

// ---------- what background.js and the popup ask ----------

// Not while a freshly paired browser is still waiting for the user's answer
// to the import question (WD-81): until then the list is this browser's own.
export function usesAccountWatches() {
  return isAccountActive();
}

// True once this connection has had WatchDesk's list. From then on an empty
// list means the account has no watches, not "show the default watch".
export async function hasSyncedAccountWatches() {
  return (await isAccountActive()) && (await readState()).lastSyncedAt != null;
}

// What the popup shows about the list:
//   { mode: "local" }  not connected
//   { mode: "account", offline, lastSyncedAt, localOnly }
// `localOnly` counts watches kept in this browser that are not on WatchDesk
// (waiting to be uploaded, or refused by it).
export async function getWatchSyncStatus() {
  if (!(await isAccountActive())) return { mode: "local" };
  const state = await readState();
  let localOnly = 0;
  if (state.lastSyncedAt != null) {
    const known = new Set(state.serverIds);
    localOnly = (await readCopy()).filter((w) => !known.has(w.id)).length;
  }
  return { mode: "account", offline: state.offline, lastSyncedAt: state.lastSyncedAt, localOnly };
}

// The ids WatchDesk knows this browser's watches by: all listing-ingest.js
// may name a watch with (WD-59). A watch still waiting to be uploaded, or
// refused by WatchDesk, has only a local id and is not in here. Empty when
// not connected.
export async function getServerWatchIds() {
  if (!(await isAccountActive())) return [];
  return (await readState()).serverIds;
}

// ---------- sync ----------

// Resolves to WatchDesk's answer to the list request ({ kind, … }), or null
// when not connected. With `imported` (WD-111), those watches take the place
// of the copy once WatchDesk has answered, every one of them the browser's
// own: matched to the account by URL or uploaded, never read as "deleted on
// WatchDesk" because its id is missing there. Until WatchDesk has answered,
// the copy is not touched.
// `own` (WD-81) are watches set aside earlier that the user now wants in the
// account: they join the copy for this sync and are matched or uploaded like
// any other watch of this browser. `connection` binds the list request and
// every upload to one token; without it nothing changes.
// A successful answer carries `outcome`: how many of this browser's watches
// were uploaded (`created`), became a watch the account already had
// (`matched`), were refused by WatchDesk (`rejected`) or could not be sent
// yet (`waiting`, with `stoppedBy`, the answer that ended the uploads).
async function runSync(imported, { own = [], connection } = {}) {
  if (!(await isAccountActive())) return null;

  const listed = await listWatches(connection);
  // A 401 has already discarded the token (and this module's state with it);
  // a changed connection is another account's, and nothing here is its.
  if (listed.kind === "unauthorized" || listed.kind === "connection-changed") return listed;
  if (listed.kind !== "ok") {
    await setOffline(true);
    return listed;
  }

  const state = await readState();
  const stored = await readCopy();
  // A browser that never stored a list is showing its default watch.
  const current = imported || (stored.length > 0 || state.lastSyncedAt != null ? stored : config.unsyncedFallback());
  const held = new Set(current.map((w) => w.id));
  const copy = [...current, ...own.filter((w) => w && typeof w.id === "string" && !held.has(w.id))];
  // WD-81: the user declined the import, so what is only in this browser
  // stays out of the account.
  const keepOwn = !imported && own.length === 0 && (await keepsOwnWatchesLocal());

  const onServer = new Set(listed.watches.map((w) => w.id));
  const byUrl = new Map();
  for (const watch of listed.watches) {
    if (!byUrl.has(watch.url)) byUrl.set(watch.url, watch);
  }
  const known = new Set(imported ? [] : state.serverIds);
  const rejected = new Set(imported ? [] : state.rejectedIds);

  const idMap = new Map(); // own watch id -> the server id it became
  const removedIds = [];
  const created = [];
  const localOnly = [];
  const rejectedIds = [];
  const aside = [];
  let uploading = true;
  let stoppedBy = null;

  for (const watch of copy) {
    if (onServer.has(watch.id)) continue;
    if (known.has(watch.id)) {
      removedIds.push(watch.id);
      continue;
    }
    // The one conflict rule: a watch of this browser whose URL the account
    // already has becomes that watch, and the account's label and paused
    // state win. WD-82 (conflict handling for the import) changes it here.
    const twin = byUrl.get(watch.url);
    if (twin) {
      idMap.set(watch.id, twin.id);
      continue;
    }
    if (keepOwn) {
      aside.push(watch);
      continue;
    }
    if (rejected.has(watch.id)) {
      rejectedIds.push(watch.id);
      localOnly.push(watch);
      continue;
    }
    if (!uploading) {
      localOnly.push(watch);
      continue;
    }
    const result = await createWatch(
      { url: watch.url, label: watch.label, enabled: watch.enabled !== false },
      connection,
    );
    if (result.kind === "ok") {
      created.push(result.watch);
      idMap.set(watch.id, result.watch.id);
      // Another own watch with the same URL becomes this one, whichever
      // spelling of the URL (as stored here, as stored there) it has.
      byUrl.set(watch.url, result.watch);
      if (!byUrl.has(result.watch.url)) byUrl.set(result.watch.url, result.watch);
      continue;
    }
    if (result.kind === "unauthorized" || result.kind === "connection-changed") return result;
    // A 400 will be a 400 next time too. Anything else (offline, rate
    // limit, unverified email) ends the uploads for this sync; the next
    // one offers what is left again.
    if (result.kind === "invalid") rejectedIds.push(watch.id);
    else {
      uploading = false;
      stoppedBy = result;
    }
    localOnly.push(watch);
  }

  // What was read and uploaded was this connection's; it is not written into
  // a browser that has since been connected to another account.
  if (connection && !(await isCurrentConnection(connection))) return { kind: "connection-changed" };
  // Before the copy loses them: a worker stopped between the two writes must
  // not leave a watch neither in the list nor set aside.
  if (aside.length > 0) await setAside(aside);
  await carryRunState(idMap, removedIds);
  await writeCopy([...listed.watches, ...created, ...localOnly], stored);
  await writeState({
    serverIds: [...onServer, ...created.map((w) => w.id)],
    rejectedIds,
    lastSyncedAt: Date.now(),
    offline: false,
  });
  return {
    ...listed,
    outcome: {
      created: created.length,
      matched: idMap.size - created.length,
      rejected: rejectedIds.length,
      waiting: localOnly.length - rejectedIds.length,
      stoppedBy,
    },
  };
}

// Brings the copy in step with WatchDesk. Sends nothing when not connected.
// Never throws: a failure leaves the copy as it was and is reported through
// the status this resolves to.
export function syncWatches() {
  return withLock(async () => {
    try {
      await runSync();
    } catch {
      // For example chrome.storage.sync refusing a list over its quota.
      await setOffline(true).catch(() => {});
    }
    return getWatchSyncStatus();
  });
}

// ---------- changes ----------

function failureMessage(result) {
  switch (result.kind) {
    case "unreachable":
      return OFFLINE_MESSAGE;
    case "rate-limited": {
      const seconds = result.retryAfterSeconds;
      if (!seconds) return "WatchDesk is busy. Try again in a moment.";
      return `WatchDesk is busy. Try again in ${seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${Math.ceil(seconds)} s`}.`;
    }
    case "invalid":
      return result.message || "WatchDesk didn't accept that.";
    case "forbidden":
      return "Verify your email address on WatchDesk to add watches.";
    case "unauthorized":
      return "This browser was disconnected from your WatchDesk account, so nothing was changed.";
    case "not-found":
      return "That watch was already deleted on WatchDesk.";
    default:
      return "WatchDesk couldn't do that just now. Try again.";
  }
}

const failed = (result) => ({ ok: false, error: failureMessage(result) });

// Records whether WatchDesk answered, for the popup's offline indicator.
async function noteAnswer(result) {
  if (result.kind === "unauthorized") return;
  await setOffline(result.kind === "unreachable");
}

// A change is made against a reconciled list. If this connection has not
// had WatchDesk's list yet, get it first; if that fails, refuse the change.
async function readyForChange() {
  if ((await readState()).lastSyncedAt == null) await runSync();
  return (await readState()).lastSyncedAt != null;
}

// Runs one change under the lock. Always resolves to { ok, error? }, so the
// popup's message is always answered.
function change(fn) {
  return withLock(async () => {
    try {
      if (!(await readyForChange())) return { ok: false, error: OFFLINE_MESSAGE };
      return await fn(await readState(), await readCopy());
    } catch {
      return failed({ kind: "error" });
    }
  });
}

// POST /api/watches, then the new watch joins the copy.
export function addAccountWatch({ url, label }) {
  return change(async (_state, copy) => {
    const result = await createWatch({ url, label });
    await noteAnswer(result);
    if (result.kind !== "ok") return failed(result);
    await writeCopy([...copy, result.watch], copy);
    const current = await readState();
    await writeState({ ...current, serverIds: [...current.serverIds, result.watch.id] });
    return { ok: true };
  });
}

// PATCHes the watches in `targets` one at a time and writes the new copy.
// Stops at the first one WatchDesk does not answer for. A watch that is
// only in this browser is changed here; one that WatchDesk no longer has
// leaves the copy.
async function patchWatches(state, copy, targets, patch) {
  const known = new Set(state.serverIds);
  let next = copy;
  let done = 0;
  let gone = 0;
  let failure = null;
  for (const target of targets) {
    if (!known.has(target.id)) {
      next = next.map((w) => (w.id === target.id ? { ...w, ...patch } : w));
      done += 1;
      continue;
    }
    const result = await updateWatch(target.id, patch);
    await noteAnswer(result);
    if (result.kind === "ok") {
      next = next.map((w) => (w.id === target.id ? result.watch : w));
      done += 1;
    } else if (result.kind === "not-found") {
      next = next.filter((w) => w.id !== target.id);
      gone += 1;
      failure = failure || result;
    } else {
      failure = result;
      break;
    }
  }
  await writeCopy(next, copy);
  return { done, gone, failure };
}

// PATCH /api/watches/[id] with { label } or { enabled }.
export function updateAccountWatch(id, patch) {
  return change(async (state, copy) => {
    const watch = copy.find((w) => w.id === id);
    if (!watch) return { ok: false, error: "Watch not found." };
    const { failure } = await patchWatches(state, copy, [watch], patch);
    return failure ? failed(failure) : { ok: true };
  });
}

// Pause All / Resume All and their per-site forms: one PATCH per watch that
// is not already in that state. `siteId` undefined means every watch.
export function setAccountWatchesEnabled(enabled, siteId) {
  return change(async (state, copy) => {
    const targets = copy.filter((w) => (siteId === undefined || w.siteId === siteId) && Boolean(w.enabled) !== enabled);
    const { done, gone, failure } = await patchWatches(state, copy, targets, { enabled });
    // A watch that turned out to be deleted on WatchDesk is not a failure
    // of "pause everything".
    if (!failure || failure.kind === "not-found") return { ok: true };
    const left = targets.length - done - gone;
    const verb = enabled ? "resumed" : "paused";
    return { ok: false, error: done > 0 ? `${left} not ${verb}. ${failureMessage(failure)}` : failureMessage(failure) };
  });
}

// DELETE /api/watches/[id]. A watch WatchDesk no longer has is removed here
// all the same: gone is what was asked for.
export function removeAccountWatch(id) {
  return change(async (state, copy) => {
    if (state.serverIds.includes(id)) {
      const result = await deleteWatch(id);
      await noteAnswer(result);
      if (result.kind !== "ok" && result.kind !== "not-found") return failed(result);
    }
    await writeCopy(
      copy.filter((w) => w.id !== id),
      copy,
    );
    const current = await readState();
    await writeState({
      ...current,
      serverIds: current.serverIds.filter((known) => known !== id),
      rejectedIds: current.rejectedIds.filter((known) => known !== id),
    });
    return { ok: true };
  });
}

// Import (WD-54, WD-111): adds a backup file's watches to the account. Like
// every other change it asks WatchDesk first: the account's list is fetched,
// each of `watches` is matched to it by URL or uploaded, and the copy
// becomes the account's list. When WatchDesk does not answer with the list,
// nothing is imported and the copy stays as it was, so the file's watches
// are never shown as the list without being on WatchDesk. A watch WatchDesk
// then refuses, or cannot take just now, stays in this browser and is
// counted as `localOnly`, as after any sync.
export function importAccountWatches(watches) {
  return withLock(async () => {
    try {
      const listed = await runSync(watches);
      if (listed?.kind === "ok") return { ok: true };
      return { ok: false, error: `Nothing was imported. ${failureMessage(listed || { kind: "unauthorized" })}` };
    } catch {
      // For example chrome.storage.sync refusing a list over its quota.
      await setOffline(true).catch(() => {});
      return failed({ kind: "error" });
    }
  });
}

// The first step of importing this browser's own data (WD-81): a sync that
// uploads every watch that is only in this browser, `own` (the ones set
// aside by an earlier "no") included, on `connection` only. Safe to repeat:
// a watch already uploaded is matched by its id or its URL, never made
// twice. Resolves to { ok: true, created, matched, rejected, waiting,
// stoppedBy } (see runSync), or { ok: false, kind, retryAfterSeconds?, error }
// when WatchDesk did not give the account's list and nothing was done. Never
// throws.
export function uploadOwnWatches(own, connection) {
  return withLock(async () => {
    try {
      const listed = await runSync(undefined, { own, connection });
      if (listed?.kind === "ok") return { ok: true, ...listed.outcome };
      const failure = listed || { kind: "connection-changed" };
      return {
        ok: false,
        kind: failure.kind,
        retryAfterSeconds: failure.retryAfterSeconds ?? null,
        error: failureMessage(failure),
      };
    } catch {
      // For example chrome.storage.sync refusing a list over its quota.
      await setOffline(true).catch(() => {});
      return { ok: false, kind: "error", retryAfterSeconds: null, error: failureMessage({ kind: "error" }) };
    }
  });
}
