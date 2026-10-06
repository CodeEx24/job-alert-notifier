// account-settings.js — the settings of a browser connected to a WatchDesk
// account (WD-79), and the one place that writes the account's settings.
// Runs in the service worker; background.js and watcher-state.js call it.
//
// Two modes, decided by whether a device token is stored:
//
//   not connected  Nothing here does anything. The check interval, the alert
//                  sound, mute and the title filter live in
//                  chrome.storage.sync exactly as before.
//   connected      WatchDesk's settings are the truth. The same four keys in
//                  chrome.storage.sync — the ones background.js's
//                  getSettings() has always read — become the last-synced
//                  copy of them, so every check cycle reads its settings
//                  with no request, WatchDesk reachable or not. A change
//                  made in the popup is sent to WatchDesk first and reaches
//                  the copy only once WatchDesk has taken it.
//
// PUT /api/settings replaces every setting, and the same object holds
// `watcherState` (WD-71), which this browser reports and never reads back. So
// every write, whoever makes it, is the same read-modify-write
// (changeAccountSettings): GET the settings as they are now, change only the
// fields being changed, PUT them all back. Saving a setting therefore sends
// back the watcher state WatchDesk holds, and reporting the watcher state
// sends back the settings WatchDesk holds; neither can undo the other. They
// run one at a time, so of two quick changes the second is built on the
// first's result and nothing is lost.
//
// While WatchDesk cannot be reached a change is refused with a message, not
// queued: a queued write sent hours later would replace whatever had been
// changed on the web in the meantime.
//
// Storage:
//   chrome.storage.sync  -> intervalMinutes, soundId, notificationsMuted,
//                           titleFilter       the copy (as before)
//   chrome.storage.local -> watchdeskSettingsSync { lastSyncedAt, problem }
//     lastSyncedAt  epoch ms of the last time the copy was brought in step
//                   with the account, or null.
//     problem       null, "offline" (the last call could not reach
//                   WatchDesk) or "unavailable" (it answered, but not with
//                   the settings).
//     It belongs to one connection: account-connection.js removes it
//     whenever a token is stored or dropped.
//   chrome.storage.local -> watchdeskSettingsBeforeConnect { takenAt, settings }
//     What the four keys held just before a connection's first sync
//     replaced them: the settings the user had chosen in this browser. A key
//     missing from `settings` was never stored (the extension's default
//     applied). Kept through a disconnect, for the import of local data
//     (WD-81); nothing here reads it back. It is taken again at a later
//     connection only if the keys then hold something the account did not
//     give (watchdeskSettingsCopy), that is, the user changed them while
//     disconnected.
//   chrome.storage.local -> watchdeskSettingsCopy   the settings an account
//     last gave this browser; only what tells the two cases above apart.
//
// After a disconnect the copy stays where it is and is this browser's own
// settings again, so nothing changes under the user.
//
// Nothing here sees the device token: the calls go through
// watchdesk-api.js's authorizedRequest(), bound to the connection captured
// at the start (WD-110), so settings read from one account are never written
// to, or copied for, another.

import { captureConnection, isConnected, isCurrentConnection, SETTINGS_SYNC_KEY } from "./account-connection.js";
import { readSettings, replaceSettings } from "./watchdesk-api.js";
import { settingsProblem } from "./settings-limits.js";

export const SETTINGS_SNAPSHOT_KEY = "watchdeskSettingsBeforeConnect";
export const SETTINGS_COPY_KEY = "watchdeskSettingsCopy";
// The settings this module syncs. `watcherState` is not one of them: this
// browser decides it (watcher-state.js).
export const SYNCED_SETTINGS = Object.freeze(["intervalMinutes", "soundId", "notificationsMuted", "titleFilter"]);

let config = { onCopyChanged: async () => {} };

// background.js calls this once, at load. `onCopyChanged()` runs after the
// copy has been written with different values, so the check alarm can follow
// an interval changed on WatchDesk.
export function configureAccountSettings({ onCopyChanged }) {
  config = { onCopyChanged };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// One queue for every sync and every write, so a write is always built on
// the result of the one before it.
let lockTail = Promise.resolve();
function withLock(fn) {
  const run = lockTail.then(fn, fn);
  lockTail = run.catch(() => {});
  return run;
}

// ---------- the one write ----------

// GET, change `patch`'s fields, PUT. One attempt each, both on `connection`.
// Resolves to { kind: "ok", settings } — the account's settings as they now
// are — or a failure as watchdesk-api.js names it. A failed PUT also carries
// `current`, the settings the GET had just returned. Nothing is sent when
// the account already holds every value in `patch`.
async function readModifyWrite(patch, connection) {
  const read = await readSettings(connection);
  if (read.kind !== "ok") return read;
  if (Object.keys(patch).every((field) => same(read.settings[field], patch[field]))) return read;

  // The settings as they were just read, with only these fields changed,
  // including any field this version does not know.
  const replaced = await replaceSettings({ ...read.settings, ...patch }, connection);
  return replaced.kind === "ok" ? replaced : { ...replaced, current: read.settings };
}

// THE way to change a connected account's settings: every caller's PUT body
// is built here. watcher-state.js uses it for `watcherState`; this module
// for the settings the popup edits. Never throws for an answer WatchDesk
// gave; it resolves to that answer.
export function changeAccountSettings(patch, connection) {
  return withLock(() => readModifyWrite(patch, connection));
}

// ---------- the copy ----------

async function readState() {
  const { [SETTINGS_SYNC_KEY]: state } = await chrome.storage.local.get(SETTINGS_SYNC_KEY);
  return {
    lastSyncedAt: typeof state?.lastSyncedAt === "number" ? state.lastSyncedAt : null,
    problem: state?.problem === "offline" || state?.problem === "unavailable" ? state.problem : null,
  };
}

// Not written once the connection is gone: the state belongs to it.
async function setProblem(problem, connection) {
  const state = await readState();
  if (state.problem === problem || !(await isCurrentConnection(connection))) return;
  await chrome.storage.local.set({ [SETTINGS_SYNC_KEY]: { ...state, problem } });
}

// The synced settings out of an answer, or null when it is not settings this
// browser could run on: the copy is what the check cycle reads.
function readCopy(settings) {
  const { intervalMinutes, soundId, notificationsMuted, titleFilter } = settings || {};
  if (typeof intervalMinutes !== "number" || !Number.isFinite(intervalMinutes) || intervalMinutes < 1) return null;
  if (typeof soundId !== "string" || !soundId) return null;
  if (typeof notificationsMuted !== "boolean") return null;
  if (!titleFilter || typeof titleFilter.enabled !== "boolean" || !Array.isArray(titleFilter.keywords)) return null;
  if (titleFilter.keywords.some((keyword) => typeof keyword !== "string")) return null;
  return {
    intervalMinutes,
    soundId,
    notificationsMuted,
    titleFilter: { enabled: titleFilter.enabled, keywords: [...titleFilter.keywords] },
  };
}

// Makes the copy what the account holds. Resolves to "stored", "malformed"
// (the answer was not settings) or "gone" (the connection ended or changed
// while the request was out, so the answer is nobody's to keep).
async function storeCopy(settings, connection) {
  const copy = readCopy(settings);
  if (!copy) return "malformed";
  if (!(await isCurrentConnection(connection))) return "gone";

  // In SYNCED_SETTINGS' order, whatever order storage answers in, so two
  // equal sets of settings compare equal.
  const found = await chrome.storage.sync.get(SYNCED_SETTINGS);
  const stored = Object.fromEntries(SYNCED_SETTINGS.filter((key) => key in found).map((key) => [key, found[key]]));
  const state = await readState();
  const kept = await chrome.storage.local.get([SETTINGS_SNAPSHOT_KEY, SETTINGS_COPY_KEY]);
  const local = {};
  // This connection's first sync is about to replace settings the user chose
  // in this browser; they are kept for WD-81 first. Stored, and waited for,
  // before the copy is touched: a worker stopped between the two writes, or
  // a copy write that fails, must not leave them replaced and not kept.
  if (state.lastSyncedAt == null && (!kept[SETTINGS_SNAPSHOT_KEY] || !same(stored, kept[SETTINGS_COPY_KEY]))) {
    await chrome.storage.local.set({ [SETTINGS_SNAPSHOT_KEY]: { takenAt: Date.now(), settings: stored } });
  }

  // chrome.storage.sync limits writes per minute and per hour, so only what
  // differs is written.
  const patch = {};
  for (const key of SYNCED_SETTINGS) {
    if (!same(stored[key], copy[key])) patch[key] = copy[key];
  }
  const changed = Object.keys(patch).length > 0;
  if (changed) await chrome.storage.sync.set(patch);
  if (!same(kept[SETTINGS_COPY_KEY], copy)) local[SETTINGS_COPY_KEY] = copy;
  await chrome.storage.local.set({ ...local, [SETTINGS_SYNC_KEY]: { lastSyncedAt: Date.now(), problem: null } });
  // The settings are stored by now, whatever becomes of the alarm.
  if (changed) await Promise.resolve(config.onCopyChanged()).catch(() => {});
  return "stored";
}

// Records whether WatchDesk answered, for the popup's line. A 401 or a
// changed connection has taken the record with it. A 400 is WatchDesk
// answering: it refused that change, and is not out of reach.
async function noteAnswer(result, connection) {
  if (result.kind === "unauthorized" || result.kind === "connection-changed") return;
  const answered = result.kind === "ok" || result.kind === "invalid";
  await setProblem(answered ? null : result.kind === "unreachable" ? "offline" : "unavailable", connection);
}

// ---------- what background.js and the popup ask ----------

export function usesAccountSettings() {
  return isConnected();
}

// What the popup says about where the settings live:
//   { mode: "local" }  not connected
//   { mode: "account", lastSyncedAt, problem }
export async function getSettingsSyncStatus() {
  if (!(await isConnected())) return { mode: "local" };
  return { mode: "account", ...(await readState()) };
}

async function runSync() {
  const connection = await captureConnection();
  if (!connection) return;
  try {
    const read = await readSettings(connection);
    await noteAnswer(read, connection);
    if (read.kind === "ok" && (await storeCopy(read.settings, connection)) === "malformed") {
      await setProblem("unavailable", connection);
    }
  } catch {
    // For example chrome.storage.sync refusing the write.
    await setProblem("unavailable", connection).catch(() => {});
  }
}

// Brings the copy in step with the account: one GET. Sends nothing when not
// connected. Never throws: a failure leaves the copy as it was and is
// reported through the status this resolves to.
export function syncAccountSettings() {
  return withLock(async () => {
    await runSync().catch(() => {});
    return getSettingsSyncStatus();
  });
}

function failureMessage(result) {
  switch (result.kind) {
    case "unreachable":
      return "Can't reach WatchDesk, so that wasn't saved. Your settings are shown as last loaded.";
    case "rate-limited": {
      const seconds = result.retryAfterSeconds;
      if (!seconds) return "WatchDesk is busy, so that wasn't saved. Try again in a moment.";
      return `WatchDesk is busy, so that wasn't saved. Try again in ${seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${Math.ceil(seconds)} s`}.`;
    }
    case "invalid":
      return result.message || "WatchDesk didn't accept that.";
    case "unauthorized":
      return "This browser was disconnected from your WatchDesk account, so that wasn't saved. Settings are saved in this browser only now.";
    case "connection-changed":
      return "The connected WatchDesk account changed, so that wasn't saved.";
    case "forbidden":
      return "WatchDesk isn't accepting changes from this account right now, so that wasn't saved.";
    case "not-found":
      return "WatchDesk has no settings for this account yet, so that wasn't saved. Sign in to WatchDesk once, then try again.";
    default:
      return "WatchDesk couldn't save that just now. Try again.";
  }
}

const failed = (result) => ({ ok: false, error: failureMessage(result) });

// Saves a change to the synced settings (any of SYNCED_SETTINGS) in the
// connected account, then in the copy. Always resolves to { ok, error? }, so
// the popup's message is always answered. A value WatchDesk would refuse is
// refused here, with its words, before anything is sent. When WatchDesk
// answered the GET but refused the PUT, the copy is still brought to what the
// account holds, which is what the popup's controls go back to.
export function saveAccountSettings(patch) {
  return withLock(async () => {
    try {
      const problem = settingsProblem(patch);
      if (problem) return { ok: false, error: problem };

      const connection = await captureConnection();
      if (!connection) return failed({ kind: "unauthorized" });
      const result = await readModifyWrite(patch, connection);
      if (result.kind !== "ok") {
        if (result.current) await storeCopy(result.current, connection);
        // After the copy, which records a sync: the line then says what
        // stopped the write.
        await noteAnswer(result, connection);
        return failed(result);
      }
      const outcome = await storeCopy(result.settings, connection);
      if (outcome === "stored") return { ok: true };
      return failed({ kind: outcome === "gone" ? "connection-changed" : "error" });
    } catch {
      return failed({ kind: "error" });
    }
  });
}
