// popup-local-import.js — the popup's "Import your existing data" card
// (WD-81), under the account card: the question a freshly connected browser
// asks about its own watches, feed and settings, the progress while they
// are uploaded, and how it ended. Also the settings panel's way back to the
// question after it was answered "Not now".
//
// It only sees the status the service worker sends (local-import.js's
// getImportStatus: counts and words, never a token, a listing or a URL) and
// sends five messages. The worker answers each with the whole popup state,
// because an answer changes whose the watch list and the settings are.
// Everything written into the page goes through textContent.

const plural = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
const watchesWord = (n) => plural(n, "watch", "watches");
const listingsWord = (n) => plural(n, "listing", "listings");

// "3 watches, 41 listings and your settings", leaving out what there is
// none of.
function whatThereIs({ watches, listings, settings }) {
  const parts = [];
  if (watches > 0) parts.push(watchesWord(watches));
  if (listings > 0) parts.push(listingsWord(listings));
  if (settings) parts.push("your settings");
  if (parts.length === 0) return "nothing";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

const SETTING_NAMES = {
  intervalMinutes: "The check interval",
  soundId: "The alert sound",
  notificationsMuted: "Mute",
  titleFilter: "The keyword filter",
};

const STEP_NAMES = {
  watches: "uploading your watches",
  listings: "uploading your listings",
  applied: "marking the listings you applied to",
  settings: "saving your settings",
};

function progressText(status) {
  switch (status.step) {
    case "listings":
      return status.listingsTotal === null
        ? "Uploading your listings…"
        : `Uploading your listings: ${status.listingsDone} of ${status.listingsTotal}…`;
    case "applied":
      return status.appliedTotal
        ? `Marking the listings you applied to: ${status.appliedDone} of ${status.appliedTotal}…`
        : "Saving your settings…";
    case "settings":
      return "Saving your settings…";
    default:
      return "Uploading your watches…";
  }
}

// What an import that has ended did, and what it left out.
function describeResult(counts) {
  const done = [];
  if (counts.watchesUploaded > 0) done.push(`${watchesWord(counts.watchesUploaded)} uploaded`);
  if (counts.watchesMatched > 0) {
    done.push(
      counts.watchesMatched === 1
        ? "1 watch was already in your account"
        : `${counts.watchesMatched} watches were already in your account`,
    );
  }
  if (counts.listingsUploaded > 0) done.push(`${listingsWord(counts.listingsUploaded)} uploaded`);
  if (counts.appliedMarked > 0) done.push(`${counts.appliedMarked} marked applied`);
  if (counts.settingsSaved.length > 0) done.push("your settings saved");

  const left = [];
  if (counts.watchesRefused > 0) {
    left.push(
      counts.watchesRefused === 1
        ? "WatchDesk didn't accept 1 watch. It stays in this browser."
        : `WatchDesk didn't accept ${counts.watchesRefused} watches. They stay in this browser.`,
    );
  }
  const noWatch = counts.listingsNoWatch + counts.listingsWatchGone;
  if (noWatch > 0) {
    left.push(
      `${listingsWord(noWatch)} not uploaded: ${noWatch === 1 ? "its" : "their"} watch isn't on WatchDesk. ${
        noWatch === 1 ? "It stays" : "They stay"
      } in this browser.`,
    );
  }
  const unstorable = counts.listingsInvalid + counts.listingsRefused;
  if (unstorable > 0) left.push(`WatchDesk couldn't store ${listingsWord(unstorable)}.`);
  if (counts.appliedNotCarried > 0) {
    left.push(
      `${plural(counts.appliedNotCarried, "applied mark", "applied marks")} not carried over: WatchDesk already had ${
        counts.appliedNotCarried === 1 ? "that listing" : "those listings"
      }, and its own status was left as it is.`,
    );
  }
  for (const { setting, reason } of counts.settingsRefused) {
    left.push(`${SETTING_NAMES[setting] || "A setting"} wasn't imported: ${reason}`);
  }

  const details = [...left];
  // Said whenever a listing went up: WatchDesk dates it itself.
  if (counts.listingsNew > 0) {
    details.push("WatchDesk shows imported listings as found today: it doesn't take the date this browser found them.");
  }
  details.push("Everything is still in this browser too.");
  return {
    partial: left.length > 0,
    text: done.length > 0 ? `${done.join(", ")}.` : "There was nothing WatchDesk didn't already have.",
    details,
  };
}

const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// Said before the user chooses, not only afterwards: WatchDesk stamps a
// listing with the day it receives it.
const DATED_TODAY =
  "Imported listings will be dated the day of the import on WatchDesk, not the day this browser found them. The date each job was posted is kept.";

// What the card shows for a status: null when it is hidden, else { tone,
// title, text, details, buttons }. Pure, so the tests can check every state.
export function describeImport(status) {
  if (!status) return null;
  if (status.phase === "offered") {
    const what = whatThereIs(status);
    if (status.again) {
      return {
        tone: "neutral",
        title: "Import this browser's earlier data",
        text: `This browser kept ${what} from before it was connected. Import them into your WatchDesk account? It can take a minute.`,
        details: [
          "Import uploads them to your account. A watch whose address the account already has is not added twice, and your settings from then replace the account's.",
          ...(status.listings > 0 ? [DATED_TODAY] : []),
          "Not now leaves everything as it is.",
        ],
        buttons: ["accept", "decline"],
      };
    }
    return {
      tone: "neutral",
      title: "Import your existing data",
      text: `This browser has ${what} of its own. Import them into your WatchDesk account? It can take a minute.`,
      details: [
        "Import uploads them to your account. They stay in this browser too.",
        ...(status.listings > 0 ? [DATED_TODAY] : []),
        "Not now keeps everything in this browser and starts the account without it. The watch list here then shows your account's watches; this browser's own are kept, and you can import them later from Settings.",
        "Until you choose, nothing is sent to WatchDesk and this browser keeps checking its own watches.",
      ],
      buttons: ["accept", "decline"],
    };
  }
  if (status.phase === "importing") {
    if (status.problem) {
      return {
        tone: "problem",
        title: "The import has stopped for now",
        text: `${status.problem.message} It stopped while ${STEP_NAMES[status.step] || STEP_NAMES.watches}, and will be tried again automatically. Nothing is lost.`,
        details: [],
        buttons: ["retry"],
      };
    }
    return { tone: "neutral", title: "Importing your data…", text: progressText(status), details: [], buttons: [] };
  }
  if (status.phase === "done") {
    const result = describeResult(status.counts);
    return {
      tone: result.partial ? "problem" : "ok",
      title: result.partial ? "Your data was imported, with some left out" : "Your data was imported",
      text: sentence(result.text),
      details: result.details,
      buttons: ["dismiss"],
    };
  }
  return null;
}

// The settings panel's row: shown after "Not now", while there is something
// an import could still upload. Null when hidden.
export function describeImportAgain(status) {
  if (status?.phase !== "declined" || !status.available) return null;
  return `This browser kept ${whatThereIs(status)} from before it was connected. Nothing of it was uploaded.`;
}

const BUTTONS = ["accept", "decline", "retry", "dismiss"];

export function renderLocalImport(status, doc = document) {
  const card = doc.getElementById("local-import");
  if (card) {
    const view = describeImport(status);
    card.hidden = !view;
    card.dataset.tone = view ? view.tone : "";
    const title = doc.getElementById("local-import-title");
    const text = doc.getElementById("local-import-text");
    const details = doc.getElementById("local-import-details");
    title.textContent = view ? view.title : "";
    // Rewritten only when it changes, so the live region speaks once per
    // change rather than on every re-render.
    const words = view ? view.text : "";
    if (text.textContent !== words) text.textContent = words;
    const lines = view ? view.details : [];
    if ([...details.children].map((item) => item.textContent).join("\n") !== lines.join("\n")) {
      details.replaceChildren(
        ...lines.map((line) => {
          const item = doc.createElement("li");
          item.textContent = line;
          return item;
        }),
      );
    }
    const focused = doc.activeElement;
    const buttons = BUTTONS.map((name) => doc.getElementById(`local-import-${name}`));
    buttons.forEach((button, index) => {
      button.hidden = !view || !view.buttons.includes(BUTTONS[index]);
    });
    // The button that was pressed is usually gone from the next state. The
    // focus goes to the card's first button, or to the card itself while it
    // has none (and from there to the next button to appear), so a keyboard
    // user is not dropped at the top of the popup.
    const lostItsButton = buttons.includes(focused) && focused.hidden;
    if (view && (lostItsButton || focused === card)) (buttons.find((button) => !button.hidden) || card).focus();
  }

  const group = doc.getElementById("local-import-again-group");
  if (group) {
    const hint = describeImportAgain(status);
    group.hidden = !hint;
    doc.getElementById("local-import-again-hint").textContent = hint || "";
  }
}

// Wires the card's buttons and the settings panel's. `send(message)` asks
// the service worker; `onState(state, type)` is given the popup state it
// answers with and the message that was answered.
export function initLocalImport({ send, onState }, doc = document) {
  const wire = (id, type) => {
    const button = doc.getElementById(id);
    if (!button) return;
    button.addEventListener("click", async () => {
      // No second answer while the first is on its way. Not `disabled`: a
      // browser takes the focus away from a button the moment it is
      // disabled, and the focus is what renderLocalImport() hands on.
      if (button.dataset.busy === "true") return;
      button.dataset.busy = "true";
      try {
        const state = await send({ type });
        if (state?.settings) onState(state, type);
      } catch {
        // The worker did not answer; nothing changed.
      } finally {
        delete button.dataset.busy;
      }
    });
  };
  wire("local-import-accept", "local-import-accept");
  wire("local-import-decline", "local-import-decline");
  wire("local-import-retry", "local-import-retry");
  wire("local-import-dismiss", "local-import-dismiss");
  wire("local-import-again", "local-import-again");
}
