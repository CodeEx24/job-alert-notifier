// popup-account.js — the WatchDesk account card at the top of the popup
// (WD-42).
//
// It only ever sees the connection state the service worker chooses to
// send (account-connection.js's getConnectionState): never the device token
// and never the pairing poll secret. Everything it writes into the page
// goes through textContent.

const PENDING_REFRESH_MS = 1000;

const OUTCOME_MESSAGES = {
  "tab-closed": "The WatchDesk tab was closed before the code was approved.",
  cancelled: "Connecting was cancelled.",
  denied: "The connection was denied on WatchDesk.",
  expired: "The code expired before it was approved.",
  revoked: "This browser was disconnected from your WatchDesk account.",
  unreachable: "Couldn't reach WatchDesk. Check your connection and try again.",
  error: "Something went wrong while connecting. Try again.",
};

function formatRemaining(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function outcomeMessage(outcome) {
  if (!outcome) return "Link this extension to your WatchDesk account.";
  if (outcome.reason === "rate-limited") {
    const wait = outcome.retryAfterSeconds;
    return wait
      ? `WatchDesk is busy. Try again in ${Math.ceil(wait / 60)} min.`
      : "WatchDesk is busy. Try again in a few minutes.";
  }
  return OUTCOME_MESSAGES[outcome.reason] || OUTCOME_MESSAGES.error;
}

// What the card shows for a state: its title, detail line, tone, and which
// buttons are visible. Pure, so the tests can check every state.
export function describeConnection(state, now = Date.now()) {
  if (!state || !state.status) {
    return { mode: "not-connected", tone: "problem", title: "Not connected to WatchDesk", detail: OUTCOME_MESSAGES.error, buttons: ["connect"] };
  }
  if (state.status === "connected") {
    const who = state.email || state.displayName;
    let detail;
    if (who) detail = state.deviceLabel ? `${who} · ${state.deviceLabel}` : who;
    else detail = state.accountCheckFailed ? "Couldn't load the account details right now." : "Connected";
    return { mode: "connected", tone: "ok", title: "Connected to WatchDesk", detail, buttons: [] };
  }
  if (state.status === "pending") {
    return {
      mode: "pending",
      tone: "neutral",
      title: "Waiting for approval…",
      detail: `Approve code ${state.code} in the WatchDesk tab`,
      // Kept apart from `detail` so the card's live region is not
      // re-announced every second (it is aria-hidden in popup.html).
      countdown: ` · ${formatRemaining(state.expiresAt - now)} left`,
      buttons: ["show-tab", "cancel"],
    };
  }
  return {
    mode: "not-connected",
    tone: state.outcome ? "problem" : "neutral",
    title: "Not connected to WatchDesk",
    detail: outcomeMessage(state.outcome),
    buttons: ["connect"],
  };
}

export function renderAccountCard(state, doc = document) {
  const card = doc.getElementById("account-card");
  if (!card) return;
  const view = describeConnection(state);
  card.dataset.state = view.mode;
  card.dataset.tone = view.tone;
  doc.getElementById("account-title").textContent = view.title;
  const detail = doc.getElementById("account-detail");
  // Rewritten only when it changes, so the live region speaks once per
  // state change.
  if (detail.textContent !== view.detail) detail.textContent = view.detail;
  doc.getElementById("account-countdown").textContent = view.countdown || "";
  doc.getElementById("account-connect").hidden = !view.buttons.includes("connect");
  doc.getElementById("account-show-tab").hidden = !view.buttons.includes("show-tab");
  doc.getElementById("account-cancel").hidden = !view.buttons.includes("cancel");
}

// Wires the card. `send` is popup.js's chrome.runtime.sendMessage wrapper,
// `setButtonBusy` its spinner helper, `messages` the event the worker's
// broadcasts arrive on.
export async function initAccountCard({
  send,
  setButtonBusy,
  doc = document,
  messages = globalThis.chrome?.runtime?.onMessage,
}) {
  if (!doc.getElementById("account-card")) return;

  let pendingTimer = null;
  const render = (state) => {
    renderAccountCard(state, doc);
    // While a pairing is pending, re-read the state every second: it keeps
    // the countdown moving and shows "connected" as soon as the worker has
    // collected the token, without the user reopening the popup.
    if (state?.status === "pending" && !pendingTimer) {
      pendingTimer = setInterval(async () => {
        try {
          render(await send({ type: "account-get-state" }));
        } catch {
          // The worker restarts; the next tick tries again.
        }
      }, PENDING_REFRESH_MS);
    } else if (state?.status !== "pending" && pendingTimer) {
      clearInterval(pendingTimer);
      pendingTimer = null;
    }
  };

  const runAction = async (button, type, busyLabel) => {
    setButtonBusy(button, true, busyLabel);
    try {
      // Opening the approval tab usually closes the popup before this
      // resolves; polling carries on in the service worker regardless.
      render(await send({ type }));
    } catch {
      render(null);
    } finally {
      setButtonBusy(button, false);
    }
  };

  const connectBtn = doc.getElementById("account-connect");
  connectBtn.addEventListener("click", () => runAction(connectBtn, "account-connect", "Opening…"));
  const showTabBtn = doc.getElementById("account-show-tab");
  showTabBtn.addEventListener("click", () => runAction(showTabBtn, "account-show-tab", "Opening…"));
  const cancelBtn = doc.getElementById("account-cancel");
  cancelBtn.addEventListener("click", () => runAction(cancelBtn, "account-cancel", "Cancelling…"));

  // The worker announces a lost connection (a 401 on any WatchDesk call,
  // WD-44) while the popup is open. Nothing is sent back: returning
  // undefined leaves the message to its other receivers.
  messages?.addListener((message) => {
    if (message?.type === "account-state-changed") render(message.state);
  });

  const state = await send({ type: "account-get-state" });
  render(state);
  // Confirm the stored token still works and refresh the email shown; a
  // revoked device comes back as "not connected".
  if (state?.status === "connected") render(await send({ type: "account-refresh" }));
}
