// account-connection.js — connecting the extension to a WatchDesk account
// (WD-42). Runs in the service worker; background.js registers its
// listeners and routes the popup's "account-*" messages here.
//
// The flow (device pairing, docs/adr/0002-extension-auth.md in the
// WatchDesk repo):
//   1. "Connect Account" → POST /api/auth/device/start gives a public code
//      and a poll secret only the extension keeps.
//   2. A new tab opens at <origin>/connect-extension?code=<code> (never the
//      secret), where the signed-in user approves or denies it.
//   3. Meanwhile this worker polls GET /api/auth/device/poll until it
//      answers approved (with the token, exactly once), denied or expired.
//   4. The token goes to chrome.storage.local; GET /api/devices/current then
//      gives the account's email for the popup.
//
// Storage:
//   chrome.storage.session -> watchdeskPairing  { code, pollSecret,
//                               expiresAt, pollIntervalMs, nextPollAt, tabId }
//                             watchdeskPairingOutcome { reason, retryAfterSeconds }
//     In memory only, never written to disk, readable by extension pages and
//     the worker but not by content scripts. Survives a worker restart, so
//     polling resumes; cleared by a browser restart, which therefore ends a
//     pending pairing (a fresh "Connect Account" is one click).
//   chrome.storage.local   -> watchdeskToken   the device token (a secret)
//                             watchdeskAccount { email, displayName, deviceLabel }
//                             watchdeskWatchSync  what watch-sync.js knows
//                               about this connection's watches (WD-54). It
//                               belongs to one connection, so it is removed
//                               here whenever a token is stored or dropped.
//                             watchdeskListingSync  when listing-ingest.js
//                               last got a check's listings to WatchDesk
//                               (WD-59). Removed here with it, for the same
//                               reason.
//   Never chrome.storage.sync: nothing here may leave this browser.
//
// Keeping the polling alive in an MV3 worker: the worker is stopped after
// ~30 s without extension events or extension API calls, and timers die
// with it. The poll loop below sleeps at most MAX_SLEEP_MS between storage
// reads, and every read is an extension API call, so the worker stays up
// for the whole pairing. If it is stopped anyway (or restarted by Chrome),
// the pairing is still in session storage: registering the listeners at
// startup resumes the loop, and a 30-second backstop alarm wakes the worker
// to do the same.
//
// Secrets: the token and the poll secret are never logged, never sent to
// the popup or a content script (getConnectionState() returns neither), and
// never put in the tab URL.
//
// Losing the connection (WD-44): every authenticated call goes through
// watchdesk-api.js's authorizedRequest(), which reads the token from here
// and reports a 401 to discardToken() below — the one place a refused token
// is dropped. It records the outcome "revoked" and tells an open popup
// ("account-state-changed"), so the popup flips to not connected at once.

import { WATCHDESK_ORIGIN } from "./config.js";
import { startPairing, pollPairing, getCurrentDevice, configureAuth } from "./watchdesk-api.js";

export const TOKEN_KEY = "watchdeskToken";
export const ACCOUNT_KEY = "watchdeskAccount";
export const WATCH_SYNC_KEY = "watchdeskWatchSync";
export const LISTING_SYNC_KEY = "watchdeskListingSync";
export const PAIRING_KEY = "watchdeskPairing";
export const OUTCOME_KEY = "watchdeskPairingOutcome";
export const PAIRING_ALARM = "watchdesk-pairing";

// chrome.alarms' minimum period (Chrome 120+). Only a backstop; the loop
// itself polls every pollIntervalSeconds.
const PAIRING_ALARM_PERIOD_MINUTES = 0.5;
// Longest single sleep in the loop. Well under the worker's 30 s idle
// timeout, so the storage read after each sleep keeps the worker alive even
// through a long Retry-After.
const MAX_SLEEP_MS = 20000;
// WD-41's code lifetime. Used only when the server's expiresAt makes no
// sense against this computer's clock (see startConnecting).
const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000;
const MAX_PAIRING_TTL_MS = 15 * 60 * 1000;
// How long to wait after a network failure or a 5xx before polling again.
const RETRY_AFTER_FAILURE_MS = 5000;

export function connectExtensionUrl(code) {
  return `${WATCHDESK_ORIGIN}/connect-extension?code=${encodeURIComponent(code)}`;
}

// ---------- storage ----------

async function readToken() {
  const { [TOKEN_KEY]: token } = await chrome.storage.local.get(TOKEN_KEY);
  return typeof token === "string" && token ? token : null;
}

// Whether a device token is stored: all watch-sync.js needs to know to pick
// between the account's watches and this browser's own. Never the token.
export async function isConnected() {
  return (await readToken()) !== null;
}

// WatchDesk refused this token (401). Drop it, unless a new pairing has
// stored another one while the request was out, and tell the popup.
async function discardToken(refusedToken) {
  const discarded = await withLock(async () => {
    if ((await readToken()) !== refusedToken) return false;
    await chrome.storage.local.remove([TOKEN_KEY, ACCOUNT_KEY, WATCH_SYNC_KEY, LISTING_SYNC_KEY]);
    await chrome.storage.session.set({ [OUTCOME_KEY]: { reason: "revoked" } });
    return true;
  });
  if (discarded) await notifyStateChanged();
}

// Tells any open extension page (the popup) the new connection state. Only
// extension pages receive runtime messages from the worker — content
// scripts would need tabs.sendMessage — and the state never holds the
// token. With no popup open there is no receiver, which is fine.
async function notifyStateChanged() {
  try {
    await chrome.runtime.sendMessage({ type: "account-state-changed", state: await getConnectionState() });
  } catch {
    // No popup open.
  }
}

async function readPairing() {
  const { [PAIRING_KEY]: pairing } = await chrome.storage.session.get(PAIRING_KEY);
  return pairing || null;
}

// Every change to the pairing goes through this queue, so a read-modify-
// write in the poll loop cannot bring back a pairing that a closed tab or a
// Cancel removed in the meantime.
let lockTail = Promise.resolve();
function withLock(fn) {
  const run = lockTail.then(fn, fn);
  lockTail = run.catch(() => {});
  return run;
}

// Changes the stored pairing only if it is still the one with this code.
function updatePairing(code, patch) {
  return withLock(async () => {
    const pairing = await readPairing();
    if (!pairing || pairing.code !== code) return null;
    const next = { ...pairing, ...patch };
    await chrome.storage.session.set({ [PAIRING_KEY]: next });
    return next;
  });
}

// Ends the pairing with this code and records why, for the popup. A pairing
// that has already ended, or been replaced by a newer one, is left alone.
function endPairing(code, outcome) {
  return withLock(async () => {
    const pairing = await readPairing();
    if (!pairing || pairing.code !== code) return;
    await chrome.storage.session.remove(PAIRING_KEY);
    await chrome.storage.session.set({ [OUTCOME_KEY]: outcome });
    await chrome.alarms.clear(PAIRING_ALARM);
  });
}

// `approved` is answered once, so the token is stored the moment it
// arrives — even if the pairing was cancelled while that poll was in
// flight: the user did approve on WatchDesk, and dropping the only copy
// would leave a device nobody holds. The token is written first and the
// pairing cleared second; wherever both exist (a worker stopped between the
// two writes), the token wins and the leftover pairing is discarded.
async function completePairing(token) {
  await withLock(async () => {
    await chrome.storage.local.set({ [TOKEN_KEY]: token });
    await chrome.storage.local.remove([ACCOUNT_KEY, WATCH_SYNC_KEY, LISTING_SYNC_KEY]);
    await chrome.storage.session.remove([PAIRING_KEY, OUTCOME_KEY]);
    await chrome.alarms.clear(PAIRING_ALARM);
  });
  await refreshAccount();
}

// ---------- the poll loop ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let pollLoop = null;

// Starts the loop unless this worker is already running it. Resolves when
// the pairing has ended.
export function ensurePolling() {
  if (!pollLoop) {
    pollLoop = runPollLoop().finally(() => {
      pollLoop = null;
    });
  }
  return pollLoop;
}

async function runPollLoop() {
  for (;;) {
    const pairing = await readPairing();
    if (!pairing) {
      await chrome.alarms.clear(PAIRING_ALARM);
      return;
    }
    if (await readToken()) {
      await withLock(() => chrome.storage.session.remove(PAIRING_KEY));
      await chrome.alarms.clear(PAIRING_ALARM);
      return;
    }
    const now = Date.now();
    if (now >= pairing.expiresAt) {
      await endPairing(pairing.code, { reason: "expired" });
      return;
    }
    const waitMs = Math.min(pairing.nextPollAt, pairing.expiresAt) - now;
    if (waitMs > 0) {
      await sleep(Math.min(waitMs, MAX_SLEEP_MS));
      continue;
    }
    await pollOnce(pairing);
  }
}

async function pollOnce(pairing) {
  const result = await pollPairing(pairing.code, pairing.pollSecret);
  const now = Date.now();
  switch (result.kind) {
    case "approved":
      await completePairing(result.token);
      return;
    case "denied":
    case "expired":
      await endPairing(pairing.code, { reason: result.kind });
      return;
    case "pending":
      await updatePairing(pairing.code, { nextPollAt: now + pairing.pollIntervalMs });
      return;
    case "rate-limited": {
      const retryMs = (result.retryAfterSeconds ?? 0) * 1000;
      await updatePairing(pairing.code, { nextPollAt: now + Math.max(retryMs, pairing.pollIntervalMs) });
      return;
    }
    case "error":
      // A 4xx other than 429 means the request itself is wrong (WD-41's 400
      // for a malformed code or a missing secret); asking again will not
      // change the answer.
      if (result.status >= 400 && result.status < 500) {
        await endPairing(pairing.code, { reason: "error" });
        return;
      }
      await updatePairing(pairing.code, { nextPollAt: now + Math.max(RETRY_AFTER_FAILURE_MS, pairing.pollIntervalMs) });
      return;
    default:
      // "unreachable": keep trying until the code expires.
      await updatePairing(pairing.code, { nextPollAt: now + Math.max(RETRY_AFTER_FAILURE_MS, pairing.pollIntervalMs) });
  }
}

// The connect tab was closed, or the user pressed Cancel. One last poll
// first, so an approval made just before closing the tab is not lost; then
// the pairing ends and the popup says why.
async function stopPairing(pairing, reason) {
  const result = await pollPairing(pairing.code, pairing.pollSecret);
  if (result.kind === "approved") {
    await completePairing(result.token);
    return;
  }
  const outcome = result.kind === "denied" || result.kind === "expired" ? result.kind : reason;
  await endPairing(pairing.code, { reason: outcome });
}

// ---------- what the popup calls ----------

// What the popup may know. Never the token, never the poll secret.
export async function getConnectionState() {
  if (await readToken()) {
    const { [ACCOUNT_KEY]: account } = await chrome.storage.local.get(ACCOUNT_KEY);
    return {
      status: "connected",
      email: account?.email ?? null,
      displayName: account?.displayName ?? null,
      deviceLabel: account?.deviceLabel ?? null,
    };
  }
  const pairing = await readPairing();
  if (pairing) {
    ensurePolling();
    return { status: "pending", code: pairing.code, expiresAt: pairing.expiresAt };
  }
  const { [OUTCOME_KEY]: outcome } = await chrome.storage.session.get(OUTCOME_KEY);
  return { status: "not-connected", outcome: outcome || null };
}

// Starts a pairing and opens the approval tab. If one is already pending,
// brings its tab forward instead of starting another.
export async function startConnecting() {
  const reuse = await withLock(async () => {
    if (await readToken()) return true;
    const existing = await readPairing();
    if (existing && existing.expiresAt > Date.now()) return existing;

    await chrome.storage.session.remove([PAIRING_KEY, OUTCOME_KEY]);
    const started = await startPairing();
    if (started.kind !== "ok") {
      const outcome =
        started.kind === "rate-limited"
          ? { reason: "rate-limited", retryAfterSeconds: started.retryAfterSeconds ?? null }
          : { reason: started.kind === "unreachable" ? "unreachable" : "error" };
      await chrome.storage.session.set({ [OUTCOME_KEY]: outcome });
      return false;
    }

    const now = Date.now();
    const ttl = started.expiresAt - now;
    const pairing = {
      code: started.code,
      pollSecret: started.pollSecret,
      // Trust the server's expiry unless this computer's clock is far
      // enough off to make it nonsense; the server says "expired" anyway.
      expiresAt: ttl > 0 && ttl <= MAX_PAIRING_TTL_MS ? started.expiresAt : now + DEFAULT_PAIRING_TTL_MS,
      pollIntervalMs: started.pollIntervalMs,
      nextPollAt: now + started.pollIntervalMs,
      tabId: null,
    };
    await chrome.storage.session.set({ [PAIRING_KEY]: pairing });
    await chrome.alarms.create(PAIRING_ALARM, { periodInMinutes: PAIRING_ALARM_PERIOD_MINUTES });
    return { ...pairing, isNew: true };
  });

  if (reuse && typeof reuse === "object") {
    if (reuse.isNew) {
      let tab;
      try {
        tab = await chrome.tabs.create({ url: connectExtensionUrl(reuse.code) });
      } catch {
        await endPairing(reuse.code, { reason: "error" });
        return getConnectionState();
      }
      await updatePairing(reuse.code, { tabId: tab?.id ?? null });
      ensurePolling();
    } else {
      await showPairingTab();
    }
  }
  return getConnectionState();
}

// Brings the pending pairing's tab forward, or opens a new one at the same
// URL if it is gone.
export async function showPairingTab() {
  const pairing = await readPairing();
  if (!pairing) return getConnectionState();
  try {
    const tab = await chrome.tabs.update(pairing.tabId, { active: true });
    if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    const tab = await chrome.tabs.create({ url: connectExtensionUrl(pairing.code) });
    await updatePairing(pairing.code, { tabId: tab?.id ?? null });
  }
  return getConnectionState();
}

export async function cancelConnecting() {
  const pairing = await readPairing();
  if (pairing) await stopPairing(pairing, "cancelled");
  return getConnectionState();
}

// Asks WatchDesk who this token belongs to and caches the answer for the
// popup. Runs when the popup opens and after every job-check alarm, so a
// revoked device is noticed without opening the popup. A 401 means the
// token is dead (revoked, or the account deleted): authorizedRequest() has
// already discarded it through discardToken(). Any other failure, after
// the retries, keeps the token and the last known account; the next check
// asks again.
export async function refreshAccount() {
  if (!(await readToken())) return getConnectionState();

  const result = await getCurrentDevice();
  if (result.kind === "ok") {
    await chrome.storage.local.set({
      [ACCOUNT_KEY]: {
        email: result.account.email,
        displayName: result.account.displayName,
        deviceLabel: result.device.label,
      },
    });
  }

  const state = await getConnectionState();
  if (state.status === "connected" && result.kind !== "ok") state.accountCheckFailed = true;
  return state;
}

// ---------- worker wiring ----------

// The authenticated path reads the token from here and reports a refused
// one here. Done at load, so it is in place before any call can be made.
configureAuth({ getToken: readToken, onUnauthorized: discardToken });

async function handleTabRemoved(tabId) {
  const pairing = await readPairing();
  if (pairing && pairing.tabId === tabId) await stopPairing(pairing, "tab-closed");
}

// Called once, synchronously, at the top level of background.js, so the
// listeners exist whenever Chrome wakes the worker for one of these events.
export function registerAccountConnection() {
  chrome.tabs.onRemoved.addListener((tabId) => handleTabRemoved(tabId));
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== PAIRING_ALARM) return undefined;
    return ensurePolling();
  });
  // A worker restarted mid-pairing picks up where it left off.
  ensurePolling().catch(() => {});
}
