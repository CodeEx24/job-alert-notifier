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
//
// While WatchDesk is unreachable a change is refused with a message, not
// queued: a queue would have to be replayed against a list that may have
// changed on the web in the meantime.
//
// Nothing here sees the device token: the calls go through
// watchdesk-api.js's authorizedRequest().

import { isConnected, WATCH_SYNC_KEY } from "./account-connection.js";
import { listWatches, createWatch, updateWatch, deleteWatch } from "./watchdesk-api.js";

const WATCHES_KEY = "watches";
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

// ---------- what background.js and the popup ask ----------

export function usesAccountWatches() {
  return isConnected();
}

// True once this connection has had WatchDesk's list. From then on an empty
// list means the account has no watches, not "show the default watch".
export async function hasSyncedAccountWatches() {
  return (await isConnected()) && (await readState()).lastSyncedAt != null;
}

// What the popup shows about the list:
//   { mode: "local" }  not connected
//   { mode: "account", offline, lastSyncedAt, localOnly }
// `localOnly` counts watches kept in this browser that are not on WatchDesk
// (waiting to be uploaded, or refused by it).
export async function getWatchSyncStatus() {
  if (!(await isConnected())) return { mode: "local" };
  const state = await readState();
  let localOnly = 0;
  if (state.lastSyncedAt != null) {
    const known = new Set(state.serverIds);
    localOnly = (await readCopy()).filter((w) => !known.has(w.id)).length;
  }
  return { mode: "account", offline: state.offline, lastSyncedAt: state.lastSyncedAt, localOnly };
}

// ---------- sync ----------

async function runSync() {
  if (!(await isConnected())) return;

  const listed = await listWatches();
  // A 401 has already discarded the token (and this module's state with it).
  if (listed.kind === "unauthorized") return;
  if (listed.kind !== "ok") {
    await setOffline(true);
    return;
  }

  const state = await readState();
  const stored = await readCopy();
  // A browser that never stored a list is showing its default watch.
  const copy = stored.length > 0 || state.lastSyncedAt != null ? stored : config.unsyncedFallback();

  const onServer = new Set(listed.watches.map((w) => w.id));
  const byUrl = new Map();
  for (const watch of listed.watches) {
    if (!byUrl.has(watch.url)) byUrl.set(watch.url, watch);
  }
  const known = new Set(state.serverIds);
  const rejected = new Set(state.rejectedIds);

  const idMap = new Map(); // own watch id -> the server id it became
  const removedIds = [];
  const created = [];
  const localOnly = [];
  const rejectedIds = [];
  let uploading = true;

  for (const watch of copy) {
    if (onServer.has(watch.id)) continue;
    if (known.has(watch.id)) {
      removedIds.push(watch.id);
      continue;
    }
    const twin = byUrl.get(watch.url);
    if (twin) {
      idMap.set(watch.id, twin.id);
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
    const result = await createWatch({ url: watch.url, label: watch.label, enabled: watch.enabled !== false });
    if (result.kind === "ok") {
      created.push(result.watch);
      idMap.set(watch.id, result.watch.id);
      // Another own watch with the same URL becomes this one, whichever
      // spelling of the URL (as stored here, as stored there) it has.
      byUrl.set(watch.url, result.watch);
      if (!byUrl.has(result.watch.url)) byUrl.set(result.watch.url, result.watch);
      continue;
    }
    if (result.kind === "unauthorized") return;
    // A 400 will be a 400 next time too. Anything else (offline, rate
    // limit, unverified email) ends the uploads for this sync; the next
    // one offers what is left again.
    if (result.kind === "invalid") rejectedIds.push(watch.id);
    else uploading = false;
    localOnly.push(watch);
  }

  await carryRunState(idMap, removedIds);
  await writeCopy([...listed.watches, ...created, ...localOnly], stored);
  await writeState({
    serverIds: [...onServer, ...created.map((w) => w.id)],
    rejectedIds,
    lastSyncedAt: Date.now(),
    offline: false,
  });
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

// After an import replaced the copy: every watch in it is the browser's own
// again, so the next sync matches each to WatchDesk by URL or uploads it,
// instead of reading a missing id as "deleted on WatchDesk".
export function forgetKnownWatches() {
  return withLock(async () => {
    const state = await readState();
    await writeState({ ...state, serverIds: [], rejectedIds: [] });
  });
}
