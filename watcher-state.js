// watcher-state.js — whether the periodic job check is running or paused
// (WD-71): the popup's Start Watching / Pause Watching. Runs in the service
// worker; background.js calls it.
//
// This browser's own state decides whether the check alarm exists.
// background.js reads it wherever it creates the alarm, so a paused browser
// stays paused through a worker restart, a browser restart and an update.
// It is not a watch's `enabled` (Pause All): pausing here changes no watch.
//
// With a WatchDesk account connected the state is also sent to the account
// (settings.watcherState), for the web app to show. That is a report, not a
// sync:
//   - it is sent after the alarm has been changed and the popup answered, so
//     an unreachable WatchDesk can never hold up or undo a pause or a start;
//   - the state is never read back from WatchDesk into this browser;
//   - a report that did not get through is sent again on the next sync
//     (popup open, Check now, an alarm tick, a browser start) until it has.
// With no account connected nothing is sent.
//
// Storage (chrome.storage.local only; nothing here leaves this browser):
//   watcherState          "running" | "paused". Missing means running: the
//                         extension has always checked from the moment it
//                         was installed.
//   watchdeskWatcherSync  { sent, failed } — the state this connection's
//                         account was last given (null: none yet), and
//                         whether the latest attempt failed. It belongs to
//                         one connection: account-connection.js removes it
//                         whenever a token is stored or dropped, so a new
//                         connection is told the state afresh.
//
// Nothing here sees the device token: the write goes through
// account-settings.js's changeAccountSettings() (WD-79), the one place that
// builds a PUT of the account's settings, bound to the connection captured
// at the start, so settings read from one account are never written to
// another.

import { captureConnection, isConnected, isCurrentConnection, WATCHER_SYNC_KEY } from "./account-connection.js";
import { changeAccountSettings } from "./account-settings.js";

export const WATCHER_STATE_KEY = "watcherState";
export const WATCHER_STATES = Object.freeze(["running", "paused"]);

export function isWatcherState(value) {
  return WATCHER_STATES.includes(value);
}

// ---------- this browser's state ----------

export async function getWatcherState() {
  const { [WATCHER_STATE_KEY]: state } = await chrome.storage.local.get(WATCHER_STATE_KEY);
  return state === "paused" ? "paused" : "running";
}

export async function isWatchingPaused() {
  return (await getWatcherState()) === "paused";
}

// Records the state only. background.js clears or creates the alarm, and
// calls reflectWatcherState() once it has.
export async function saveWatcherState(state) {
  await chrome.storage.local.set({ [WATCHER_STATE_KEY]: state === "paused" ? "paused" : "running" });
}

// ---------- telling WatchDesk ----------

// One at a time, so a pause and the start that follows it reach WatchDesk
// in that order.
let lockTail = Promise.resolve();
function withLock(fn) {
  const run = lockTail.then(fn, fn);
  lockTail = run.catch(() => {});
  return run;
}

async function readRecord() {
  const { [WATCHER_SYNC_KEY]: record } = await chrome.storage.local.get(WATCHER_SYNC_KEY);
  return { sent: isWatcherState(record?.sent) ? record.sent : null, failed: Boolean(record?.failed) };
}

// The state WatchDesk has not been given although an attempt was made, or
// null. Null too while the first attempt is still to come.
function unsentState(record, state) {
  return record.failed && record.sent !== state ? state : null;
}

// "sent" when the account now holds `state`, "failed" when it does not, and
// "gone" when the connection ended or changed, so there is nothing to record.
async function sendState(state, connection) {
  // The account's settings as they are now, with only the watcher state
  // changed: PUT replaces them all, so it is built where every other write
  // to them is (WD-79) and waits its turn behind one already on its way.
  const result = await changeAccountSettings({ watcherState: state }, connection);
  if (result.kind === "unauthorized" || result.kind === "connection-changed") return "gone";
  // A WatchDesk that does not know the setting yet answers 200 without it.
  return result.kind === "ok" && result.settings.watcherState === state ? "sent" : "failed";
}

async function runReflect() {
  const connection = await captureConnection();
  if (!connection) return false;

  const state = await getWatcherState();
  const before = await readRecord();
  if (before.sent === state) return false;

  const outcome = await sendState(state, connection);
  if (outcome === "gone") return false;
  const after = outcome === "sent" ? { sent: state, failed: false } : { sent: before.sent, failed: true };
  if (after.sent === before.sent && after.failed === before.failed) return false;
  // The record belongs to the connection it was made on.
  if (!(await isCurrentConnection(connection))) return false;
  await chrome.storage.local.set({ [WATCHER_SYNC_KEY]: after });

  // The state may have changed again while the request was out; what the
  // popup is told is how the record stands against the state as it is now.
  const current = await getWatcherState();
  return unsentState(before, current) !== unsentState(after, current);
}

// Gives the connected account this browser's state, unless it already has
// it. At most one GET and one PUT, one attempt each. Sends nothing with no
// account connected. Never throws. Resolves to true when what the popup
// shows about it (getWatcherSyncStatus) has changed.
export function reflectWatcherState() {
  return withLock(async () => {
    try {
      return await runReflect();
    } catch {
      return false;
    }
  });
}

// What the popup's sync line says about it: the state WatchDesk could not
// be given ("running" | "paused"), or null — also null with no account
// connected.
export async function getWatcherSyncStatus() {
  if (!(await isConnected())) return null;
  return unsentState(await readRecord(), await getWatcherState());
}
