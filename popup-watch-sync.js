// popup-watch-sync.js — the line above the watch list that says how the
// list stands against the connected WatchDesk account (WD-54): synced and
// when, or offline and showing the last-synced list.
//
// It is also the popup's one "last synced" indicator (WD-59). Two things
// are kept in step with the account and the line names both:
//   the watch list   "Watches synced with WatchDesk · 2m ago" — the last
//                    time this browser got the account's list;
//   the listings     "Listings last synced 2m ago" — the last check cycle
//                    whose listings all reached WatchDesk. When the latest
//                    attempt did not get through, the line says so and
//                    keeps the time of the last one that did.
//
// It only sees the status object the service worker sends (watch-sync.js's
// getWatchSyncStatus). Everything it writes into the page goes through
// textContent. With no account connected the line is hidden and the popup
// looks as it always did.

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
const listingsWord = (n) => (n === 1 ? "1 listing" : `${n} listings`);

// What the line shows for a status: null when there is nothing to show,
// else its tone and text. Pure, so the tests can check every state.
// `status.listings` is { lastIngestedAt, failed } (WD-59) plus { queued,
// dropped } (WD-60): how many listings are waiting to be sent again, and how
// many the full queue had to drop. Before any check has sent listings it
// adds nothing.
export function describeWatchSync(status, now = Date.now()) {
  if (!status || status.mode !== "account") return null;

  const synced = status.lastSyncedAt != null;
  const listingsAt = typeof status.listings?.lastIngestedAt === "number" ? status.listings.lastIngestedAt : null;
  const listingsFailed = Boolean(status.listings?.failed);
  const queued = count(status.listings?.queued);
  const dropped = count(status.listings?.dropped);
  let tone;
  let text;
  if (status.offline) {
    tone = "offline";
    text = synced
      ? `Offline — couldn't reach WatchDesk. Showing your watches as last synced ${formatAgo(status.lastSyncedAt, now)}.`
      : "Offline — couldn't reach WatchDesk. Showing the watches saved in this browser.";
    text += " They can't be changed until it's back.";
    // Offline already says why nothing is getting through.
    if (listingsAt != null) text += ` Listings last synced ${formatAgo(listingsAt, now)}.`;
    if (queued > 0) text += ` ${listingsWord(queued)} waiting to be sent.`;
  } else if (synced) {
    tone = listingsFailed ? "warning" : "ok";
    text = `Watches synced with WatchDesk · ${formatAgo(status.lastSyncedAt, now)}`;
    if (listingsFailed) {
      text += " · Listings couldn't be sent to WatchDesk last time";
      if (listingsAt != null) text += ` (last synced ${formatAgo(listingsAt, now)})`;
    } else if (listingsAt != null) {
      text += ` · Listings last synced ${formatAgo(listingsAt, now)}`;
    }
    if (queued > 0) text += ` · ${listingsWord(queued)} waiting to be sent`;
  } else {
    tone = "neutral";
    text = "Syncing your watches with WatchDesk…";
  }

  // WD-60: said in every state, because these listings are gone for good.
  if (dropped > 0) {
    if (tone !== "offline") tone = "warning";
    text += ` · WatchDesk was out of reach for too long: the ${
      dropped === 1 ? "oldest unsent listing was" : `${dropped} oldest unsent listings were`
    } dropped`;
  }

  if (status.localOnly > 0) {
    text +=
      status.localOnly === 1
        ? " · 1 watch is only in this browser, not on WatchDesk."
        : ` · ${status.localOnly} watches are only in this browser, not on WatchDesk.`;
  }
  return { tone, text };
}

export function renderWatchSync(status, doc = document) {
  const line = doc.getElementById("watch-sync-status");
  if (!line) return;
  const view = describeWatchSync(status);
  line.hidden = !view;
  line.dataset.tone = view ? view.tone : "";
  const text = view ? view.text : "";
  // Rewritten only when it changes, so the live region speaks once per
  // change rather than on every re-render.
  if (line.textContent !== text) line.textContent = text;
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
