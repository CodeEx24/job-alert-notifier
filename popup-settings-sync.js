// popup-settings-sync.js — where the popup's settings are saved (WD-79): one
// plain line at the top of the settings panel, and the reason a change to a
// setting was refused.
//
// The check interval, the alert sound, mute and the keyword filter are this
// browser's own until a WatchDesk account is connected; from then on they
// are the account's, loaded when the popup and the panel open and saved
// there when one is changed. The line says which it is, and what is in the
// way when WatchDesk cannot be asked.
//
// It only sees the status object the service worker sends
// (account-settings.js's getSettingsSyncStatus) and the answer to a change
// ({ ok, error }). Everything it writes into the page goes through
// textContent.

const SETTINGS = "the check interval, alert sound, mute and keyword filter";
const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// What the line shows: null before the worker has said which mode it is,
// else { tone, text }. `loading` is true while the popup is waiting for the
// account's settings. Pure, so the tests can check every state.
// `awaitingImport` (WD-81) is true while a freshly connected browser is
// waiting for the user's answer to the import question: an account is
// connected, and the settings are still this browser's.
export function describeSettingsSync(status, { loading = false, awaitingImport = false } = {}) {
  if (!status) return null;
  if (status.mode !== "account" && awaitingImport) {
    return {
      tone: "local",
      text: `${sentence(SETTINGS)} stay in this browser only until you answer "Import your existing data" at the top of this popup.`,
    };
  }
  if (status.mode !== "account") {
    return {
      tone: "local",
      text: `No WatchDesk account is connected, so ${SETTINGS} are saved in this browser only. Connect an account at the top of this popup to keep them in WatchDesk.`,
    };
  }
  const loaded = status.lastSyncedAt != null;
  const shown = loaded ? "shown as last loaded" : "the ones saved in this browser";
  if (status.problem === "offline") {
    return {
      tone: "offline",
      text: `Can't reach WatchDesk. ${sentence(SETTINGS)} are ${shown}, and can't be changed until it's back.`,
    };
  }
  if (status.problem === "unavailable") {
    return {
      tone: "warning",
      text: `WatchDesk couldn't give your settings just now. ${sentence(SETTINGS)} are ${shown}.`,
    };
  }
  if (!loaded) return { tone: "neutral", text: "Loading your settings from WatchDesk…" };
  return {
    tone: "ok",
    text: `${sentence(SETTINGS)} are saved in your WatchDesk account.${loading ? " Checking it for changes…" : ""}`,
  };
}

export function renderSettingsSync(status, options, doc = document) {
  const line = doc.getElementById("settings-sync-note");
  if (!line) return;
  const view = describeSettingsSync(status, options);
  line.dataset.tone = view ? view.tone : "";
  const text = view ? view.text : "";
  // Rewritten only when it changes, so the live region speaks once per
  // change rather than on every re-render.
  if (line.textContent !== text) line.textContent = text;
}

// Shows why a change to a setting was refused (the worker's
// { ok: false, error }), or clears the message after one that worked.
// Returns whether the change went through.
export function renderSettingsChange(result, doc = document) {
  const refused = Boolean(result) && result.ok === false;
  const line = doc.getElementById("settings-change-error");
  if (line) line.textContent = refused ? result.error || "Couldn't save that setting." : "";
  return !refused;
}
