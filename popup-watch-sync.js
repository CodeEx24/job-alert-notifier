// popup-watch-sync.js — the line above the watch list that says how the
// list stands against the connected WatchDesk account (WD-54): synced and
// when, or offline and showing the last-synced list.
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

// What the line shows for a status: null when there is nothing to show,
// else its tone and text. Pure, so the tests can check every state.
export function describeWatchSync(status, now = Date.now()) {
  if (!status || status.mode !== "account") return null;

  const synced = status.lastSyncedAt != null;
  let tone;
  let text;
  if (status.offline) {
    tone = "offline";
    text = synced
      ? `Offline — couldn't reach WatchDesk. Showing your watches as last synced ${formatAgo(status.lastSyncedAt, now)}.`
      : "Offline — couldn't reach WatchDesk. Showing the watches saved in this browser.";
    text += " They can't be changed until it's back.";
  } else if (synced) {
    tone = "ok";
    text = `Watches synced with WatchDesk · ${formatAgo(status.lastSyncedAt, now)}`;
  } else {
    tone = "neutral";
    text = "Syncing your watches with WatchDesk…";
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
