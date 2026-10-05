// popup-watch-sync.js — the sync status inside the account card at the top
// of the popup (WD-73): how this browser stands against the connected
// WatchDesk account. It is the popup's one sync indicator, and has two
// parts:
//   "Last synced 2m ago"   the most recent time WatchDesk and this browser
//                          agreed: the later of the last sync that got the
//                          account's watch list (WD-54) and the last check
//                          cycle after which no listing was left to send
//                          (WD-59). "Never synced" before either.
//   the state              how many listings are waiting to be sent (WD-60),
//                          and anything in the way: offline, listings that
//                          could not be sent, an account WatchDesk is
//                          refusing (403, WD-110), listings dropped, a
//                          watcher state (running / paused) WatchDesk has
//                          not been given yet (WD-71), watches that are
//                          only in this browser.
// The time is kept apart from the state because it changes as the minutes
// pass: the state is the live region and is announced when it changes, the
// time is not announced on every tick.
//
// It only sees the status object the service worker sends (watch-sync.js's
// getWatchSyncStatus plus listing-ingest.js's getListingSyncStatus and
// watcher-state.js's getWatcherSyncStatus, as `watcherUnsent`), which
// the worker reads from chrome.storage every time. Everything it writes into
// the page goes through textContent. With no account connected it is hidden.

function formatAgo(timestamp, now) {
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const count = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
const time = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const listingsWord = (n) => (n === 1 ? "1 listing" : `${n} listings`);

// When WatchDesk and this browser last agreed: the later of the two times
// above, or null when neither has happened.
function lastSyncedAt(status) {
  const times = [time(status.lastSyncedAt), time(status.listings?.lastIngestedAt)].filter((at) => at !== null);
  return times.length > 0 ? Math.max(...times) : null;
}

// What the status shows: null when there is nothing to show (no account
// connected), else { tone, lastSynced, text }. `lastSynced` is the label
// that follows the clock; `text` is the state and holds no time, so it only
// changes when the state does. Pure, so the tests can check every state.
// `status.listings` is { lastIngestedAt, failed, reason?, queued, dropped }:
// `queued` is how many listings are waiting in this account's queue,
// `dropped` how many the queue had to drop, and `reason` is "forbidden" when
// the last cycle ended because WatchDesk refused the account.
export function describeWatchSync(status, now = Date.now()) {
  if (!status || status.mode !== "account") return null;

  const at = lastSyncedAt(status);
  const lastSynced = at === null ? "Never synced" : `Last synced ${formatAgo(at, now)}`;
  const synced = status.lastSyncedAt != null;
  const listingsFailed = Boolean(status.listings?.failed);
  const queued = count(status.listings?.queued);
  const dropped = count(status.listings?.dropped);
  const waiting = queued > 0 ? `${listingsWord(queued)} waiting to be sent` : "Nothing waiting to be sent";
  let tone;
  let text;
  if (status.offline) {
    tone = "offline";
    text = synced
      ? "Offline — couldn't reach WatchDesk. Your watches are shown as last synced."
      : "Offline — couldn't reach WatchDesk. Showing the watches saved in this browser.";
    text += " They can't be changed until it's back.";
    // Offline already says why nothing is getting through.
    if (queued > 0) text += ` ${waiting}.`;
  } else if (!synced) {
    tone = "neutral";
    text = "Syncing your watches with WatchDesk…";
    if (queued > 0) text += ` · ${waiting}`;
  } else if (listingsFailed) {
    tone = "warning";
    text =
      status.listings.reason === "forbidden"
        ? "WatchDesk isn't accepting listings from this account. Verify your email address on WatchDesk"
        : "Listings couldn't be sent to WatchDesk last time";
    text += ` · ${waiting}`;
  } else {
    tone = "ok";
    text = waiting;
  }

  // WD-60: said in every state, because these listings are gone for good.
  if (dropped > 0) {
    if (tone !== "offline") tone = "warning";
    text += ` · WatchDesk was out of reach for too long: the ${
      dropped === 1 ? "oldest unsent listing was" : `${dropped} oldest unsent listings were`
    } dropped`;
  }

  // WD-71: pausing or starting has already happened in this browser; this
  // is only WatchDesk not having been told yet.
  if (status.watcherUnsent === "paused" || status.watcherUnsent === "running") {
    if (tone !== "offline") tone = "warning";
    text += ` · WatchDesk hasn't been told that watching is ${status.watcherUnsent} yet; it will be sent again`;
  }

  if (status.localOnly > 0) {
    text +=
      status.localOnly === 1
        ? " · 1 watch is only in this browser, not on WatchDesk."
        : ` · ${status.localOnly} watches are only in this browser, not on WatchDesk.`;
  }
  return { tone, lastSynced, text };
}

// `now` is the one clock: popup.js's tick and the tests both pass through
// here.
export function renderWatchSync(status, doc = document, now = Date.now()) {
  const line = doc.getElementById("watch-sync-status");
  if (!line) return;
  const view = describeWatchSync(status, now);
  line.hidden = !view;
  line.dataset.tone = view ? view.tone : "";
  doc.getElementById("watch-sync-last").textContent = view ? view.lastSynced : "";
  const state = doc.getElementById("watch-sync-text");
  const text = view ? view.text : "";
  // Rewritten only when it changes, so the live region speaks once per
  // change rather than on every re-render.
  if (state.textContent !== text) state.textContent = text;
}

// Shows why a change to the watch list was refused (the worker's
// { ok: false, error }), or clears the message after one that worked.
// Returns whether the change went through.
export function renderWatchChange(result, doc = document) {
  const refused = Boolean(result) && result.ok === false;
  const line = doc.getElementById("watch-change-error");
  if (line) line.textContent = refused ? result.error || "Couldn't change that watch." : "";
  return !refused;
}
