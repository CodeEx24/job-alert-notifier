// popup-watcher.js — the popup's Start Watching / Pause Watching control
// (WD-71): one button, and a line that always says in words whether the
// periodic check is running or paused.
//
// It only sees `{ state }` from the service worker's popup state
// (watcher-state.js) and sends one message, "set-watcher-state". The worker
// changes the alarm and answers with the whole popup state; telling
// WatchDesk happens after that and shows up in the watch sync line
// (popup-watch-sync.js), never here. Everything written into the page goes
// through textContent.
//
// Pausing here stops the automatic checks only. It changes no watch (that
// is Pause All, in Settings), and "Check now" still works.

const VIEWS = {
  running: {
    state: "running",
    status: "Watching is running",
    detail: "Your watches are checked automatically.",
    action: "Pause Watching",
    busy: "Pausing…",
    next: "paused",
  },
  paused: {
    state: "paused",
    status: "Watching is paused",
    detail: "No automatic checks until you start watching again. “Check now” still works.",
    action: "Start Watching",
    busy: "Starting…",
    next: "running",
  },
};

// What the control shows for a watcher state: null before the worker has
// said which it is, else the words and the state the button asks for. Pure,
// so the tests can check both states.
export function describeWatcher(watcher) {
  if (!watcher) return null;
  return watcher.state === "paused" ? VIEWS.paused : VIEWS.running;
}

export function renderWatcher(watcher, doc = document) {
  const section = doc.getElementById("watcher-control");
  const status = doc.getElementById("watcher-status");
  const detail = doc.getElementById("watcher-detail");
  const button = doc.getElementById("watcher-toggle");
  if (!section || !status || !detail || !button) return;

  const view = describeWatcher(watcher);
  section.hidden = !view;
  if (!view) return;
  section.dataset.state = view.state;
  // Rewritten only when it changes, so the live region speaks once per
  // change rather than on every re-render.
  if (status.textContent !== view.status) status.textContent = view.status;
  detail.textContent = view.detail;
  button.textContent = view.action;
  button.dataset.next = view.next;
  button.dataset.busyLabel = view.busy;
  // Starting is the thing to do while paused; pausing is the quieter one.
  button.classList.toggle("secondary", view.state === "running");
  button.disabled = false;
}

// Wires the button. `send(message)` asks the service worker; `onState` is
// given the popup state it answers with, to re-render the whole popup (the
// status line and its countdown change too).
export function initWatcherControl({ send, onState }, doc = document) {
  const button = doc.getElementById("watcher-toggle");
  if (!button) return;
  button.addEventListener("click", async () => {
    const next = button.dataset.next;
    if (!next || button.disabled) return;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = button.dataset.busyLabel || label;
    try {
      const state = await send({ type: "set-watcher-state", state: next });
      if (state?.watcher) {
        onState(state);
        return;
      }
    } catch {
      // The worker did not answer; nothing changed.
    }
    // No new state to render: put the button back as it was.
    button.textContent = label;
    button.disabled = false;
  });
}
