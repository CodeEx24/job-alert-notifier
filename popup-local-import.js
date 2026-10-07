// popup-local-import.js — the popup's "Import your existing data" card
// (WD-81), under the account card: the question a freshly connected browser
// asks about its own watches, feed and settings, the progress while they
// are uploaded, and how it ended. Also the settings panel's way back to the
// question after it was answered "Not now".
//
// How it ended is a report (WD-83): what was added, what the account already
// had and what was left out, for each site, in a table whose totals are the
// sums of its rows; then what became of the applied marks and the settings,
// and what this browser still keeps. "Close" puts the report away and the
// settings panel shows it again. Nothing in this browser is removed until
// the user asks for it here, in two steps: "Remove the earlier copies…",
// which only says what would go and what stays, and then "Remove the
// copies". The second step is there because the removal cannot be undone
// and its button sits beside "Close"; the focus lands on "Keep them".
//
// It only sees the status the service worker sends (local-import.js's
// getImportStatus: counts and words, never a token, a listing or a URL) and
// sends seven messages. The worker answers each with the whole popup state,
// because an answer changes whose the watch list and the settings are.
// Everything written into the page goes through textContent.

import { SITES } from "./sites.js";

const plural = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
const watchesWord = (n) => plural(n, "watch", "watches");
const listingsWord = (n) => plural(n, "listing", "listings");
const list = (parts) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);

// "3 watches, 41 listings and your settings", leaving out what there is
// none of.
function whatThereIs({ watches, listings, settings }) {
  const parts = [];
  if (watches > 0) parts.push(watchesWord(watches));
  if (listings > 0) parts.push(listingsWord(listings));
  if (settings) parts.push("your settings");
  return parts.length === 0 ? "nothing" : list(parts);
}

const SETTING_NAMES = {
  intervalMinutes: "The check interval",
  soundId: "The alert sound",
  notificationsMuted: "Mute",
  titleFilter: "The keyword filter",
};
const settingWords = (names) => list(names.map((name) => (SETTING_NAMES[name] || "A setting").toLowerCase()));

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

// ---------- the report, by site (WD-83) ----------

// The sites in the order the report lists them. All four are always there,
// with zeros where nothing happened.
const SITE_ORDER = ["linkedin", "glassdoor", "upwork", "onlinejobsph"];
const OTHER_SITE = "other";
const siteName = (id) => (id === OTHER_SITE ? "Other sites" : SITES[id]?.name || id);

const WATCH_COUNTS = ["watchesUploaded", "watchesMatched", "watchesRefused"];
// Why a listing was left out, in the order the lines are written.
const LEFT_OUT = ["listingsNoWatch", "listingsWatchGone", "listingsRefused", "listingsInvalid"];
const LISTING_COUNTS = ["listingsNew", "listingsExisting", ...LEFT_OUT];
const EVERY_COUNT = [...WATCH_COUNTS, ...LISTING_COUNTS];

const whole = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
const leftOut = (row) => LEFT_OUT.reduce((sum, name) => sum + row[name], 0);
const cellsOf = (row) => [
  row.watchesUploaded,
  row.watchesMatched,
  row.watchesRefused,
  row.listingsNew,
  row.listingsExisting,
  leftOut(row),
];

export const REPORT_COLUMNS = {
  groups: ["Watches", "Listings"],
  columns: ["Added", "Already in your account", "Left out"],
};

// The table for `counts`: { rows, total }, each row { site, name, cells }
// with `cells` the six numbers of REPORT_COLUMNS (three for the watches,
// three for the listings) and the reasons behind "left out" beside them.
// `total` is the sum of the rows, by construction. What the counts hold in
// all but not for any site (an import finished before the counts were kept
// by site) gets a row of its own, so the total is still the import's.
export function describeReport(counts) {
  const watches = counts.watchesBySite || {};
  const listings = counts.bySite || {};
  const others = [...new Set([...Object.keys(watches), ...Object.keys(listings)])]
    .filter((id) => !SITE_ORDER.includes(id))
    .sort((a, b) => (a === OTHER_SITE) - (b === OTHER_SITE) || a.localeCompare(b));

  const rows = [...SITE_ORDER, ...others].map((id) => {
    const held = { ...watches[id], ...listings[id] };
    const row = { site: id, name: siteName(id) };
    for (const name of EVERY_COUNT) row[name] = whole(held[name]);
    return row;
  });

  const rest = { site: null, name: "Site not recorded" };
  for (const name of EVERY_COUNT) rest[name] = Math.max(0, whole(counts[name]) - rows.reduce((sum, row) => sum + row[name], 0));
  if (EVERY_COUNT.some((name) => rest[name] > 0)) rows.push(rest);

  for (const row of rows) row.cells = cellsOf(row);
  return { rows, total: rows.reduce((sums, row) => sums.map((sum, i) => sum + row.cells[i]), [0, 0, 0, 0, 0, 0]) };
}

const LEFT_OUT_REASONS = {
  listingsNoWatch: (n) => `${n === 1 ? "its" : "their"} watch isn't in your account`,
  listingsWatchGone: (n) => `${n === 1 ? "its" : "their"} watch was deleted on WatchDesk during the import`,
  listingsRefused: (n) => `WatchDesk didn't accept ${n === 1 ? "it" : "them"}`,
  listingsInvalid: (n) => `${n === 1 ? "it isn't" : "they aren't"} complete enough to store`,
};

// What the "Left out" columns stand for: one line for each site and reason.
function leftOutLines(rows) {
  const lines = [];
  for (const row of rows) {
    if (row.watchesRefused > 0) {
      lines.push(
        `${row.name}: WatchDesk didn't accept ${watchesWord(row.watchesRefused)}. ${
          row.watchesRefused === 1 ? "It stays" : "They stay"
        } in this browser.`,
      );
    }
    for (const reason of LEFT_OUT) {
      const n = row[reason];
      if (n > 0) lines.push(`${row.name}: ${listingsWord(n)} left out, because ${LEFT_OUT_REASONS[reason](n)}.`);
    }
  }
  if (rows.some((row) => leftOut(row) > 0)) lines.push("Listings that were left out are still in this browser's feed.");
  return lines;
}

// "3 watches and your settings (the check interval and the alert sound)".
function copyWords(watches, settings) {
  const parts = [];
  if (watches > 0) parts.push(`the ${watchesWord(watches)}`);
  if (settings.length > 0) parts.push(`your settings (${settingWords(settings)})`);
  return list(parts);
}

// What an import that has ended did, and what it left out.
function describeResult(status) {
  const { counts } = status;
  const done = [];
  if (counts.watchesUploaded > 0) done.push(`${watchesWord(counts.watchesUploaded)} uploaded`);
  if (counts.watchesMatched > 0) {
    done.push(
      counts.watchesMatched === 1
        ? "1 watch was already in your account"
        : `${counts.watchesMatched} watches were already in your account`,
    );
  }
  // Added and already there are told apart (WD-82): a listing the account
  // had was skipped, not uploaded.
  if (counts.listingsNew > 0) done.push(`${listingsWord(counts.listingsNew)} uploaded`);
  if (counts.listingsExisting > 0) {
    done.push(
      counts.listingsExisting === 1
        ? "1 listing was already in your account"
        : `${counts.listingsExisting} listings were already in your account`,
    );
  }
  if (counts.appliedMarked > 0) done.push(`${counts.appliedMarked} marked applied`);
  if (counts.settingsSaved.length > 0) done.push("your settings saved");

  const report = describeReport(counts);
  const left = leftOutLines(report.rows);
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
  if (counts.appliedMarked > 0) {
    details.push(`${plural(counts.appliedMarked, "applied mark", "applied marks")} carried over.`);
  }
  if (counts.settingsSaved.length > 0) details.push(`Settings imported: ${settingWords(counts.settingsSaved)}.`);
  else if (counts.settingsRefused.length === 0) {
    details.push("No settings were imported: none had been changed in this browser.");
  }
  // Not something left out, but something the user may not expect (WD-82):
  // the watch here was named or paused differently, and the account's stays.
  if (counts.watchesMatchedDiffer > 0) {
    details.push(
      counts.watchesMatchedDiffer === 1
        ? "1 watch your account already had has a different name or paused state there. The account's was kept."
        : `${counts.watchesMatchedDiffer} watches your account already had have a different name or paused state there. The account's were kept.`,
    );
  }
  // Said whenever a listing went up: WatchDesk dates it itself.
  if (counts.listingsNew > 0) {
    details.push("WatchDesk shows imported listings as found today: it doesn't take the date this browser found them.");
  }
  return {
    partial: left.length > 0,
    text: done.length > 0 ? `${done.join(", ")}.` : "There was nothing WatchDesk didn't already have.",
    report,
    details,
  };
}

// What this browser still has after the import, where its copies are, and
// what can be done when the import looks wrong (WD-83).
function stillHereLines(status) {
  const copies = status.copies || { watches: 0, settings: [] };
  const lines = [
    status.listingsHere > 0
      ? `Nothing was removed from this browser. Its feed still has ${
          status.listingsHere === 1 ? "its 1 listing" : `all ${status.listingsHere} listings`
        }.`
      : "Nothing was removed from this browser.",
  ];
  const kept = copyWords(copies.watches, copies.settings);
  if (kept) {
    lines.push(
      `It also keeps a copy of ${kept} from before it was connected, inside this extension and in this browser only. ${
        status.confirmable ? "The copy stays until you remove it below." : "The copy stays where it is."
      }`,
    );
  }
  lines.push(
    `If the import looks wrong, you can leave everything as it is${
      status.confirmable && status.redo ? ", or import again: what your account already has is not added twice" : ""
    }. The extension can't undo an import or delete anything from your account; that is done on WatchDesk.`,
  );
  return lines;
}

// The copies "Remove…" would remove, and the ones it would leave.
function sortCopies(copies) {
  const held = copies || { watches: 0, settings: [] };
  return {
    removable: copyWords(held.watchesRemovable ? held.watches : 0, held.settingsRemovable ? held.settings : []),
    kept: copyWords(held.watchesRemovable ? 0 : held.watches, held.settingsRemovable ? [] : held.settings),
  };
}

const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// Said before the user chooses, not only afterwards: WatchDesk stamps a
// listing with the day it receives it.
const DATED_TODAY =
  "Imported listings will be dated the day of the import on WatchDesk, not the day this browser found them. The date each job was posted is kept.";

// Said before the user chooses too (WD-82): an import adds to an account, it
// does not overwrite what is there.
const ALREADY_THERE =
  "A watch or a listing your account already has is not added twice: the account keeps its own, with its name, paused state and status.";

// What the card shows for a status: null when it is hidden, else { tone,
// title, text, report, details, buttons, labels }. `report` is the table of
// describeReport(), or null; `labels` the words of the buttons that change.
// `step` is "confirm" while the user is asked whether to remove the earlier
// copies; `removed` what the worker said it removed, once it has. Pure, so
// the tests can check every state.
export function describeImport(status, { step = null, removed = null } = {}) {
  if (!status) {
    if (!removed) return null;
    const what = copyWords(removed.watches, removed.settings);
    return {
      tone: "ok",
      title: what ? "The earlier copies were removed" : "The report was removed",
      text: what
        ? `Removed from this browser: its copy of ${what} from before it was connected, and the report. Your account has what was imported, and this browser goes on checking as before.`
        : "Nothing else was removed from this browser.",
      report: null,
      details: [],
      buttons: ["dismiss"],
      labels: {},
    };
  }
  if (status.phase === "offered") {
    const what = whatThereIs(status);
    if (status.redo) {
      return {
        tone: "neutral",
        title: "Import this browser's data again",
        text: `This sends ${what} from this browser to your WatchDesk account again. It can take a minute.`,
        report: null,
        details: [
          "What your account already has is not added twice, so importing again can only add what the first import missed.",
          ...(status.settings ? ["Your settings from before this browser was connected replace the account's."] : []),
          ...(status.listings > 0 ? [DATED_TODAY] : []),
          "Not now goes back to the report and changes nothing.",
        ],
        buttons: ["accept", "decline"],
        labels: {},
      };
    }
    if (status.again) {
      return {
        tone: "neutral",
        title: "Import this browser's earlier data",
        text: `This browser kept ${what} from before it was connected. Import them into your WatchDesk account? It can take a minute.`,
        report: null,
        details: [
          "Import uploads them to your account. Your settings from then replace the account's.",
          ALREADY_THERE,
          ...(status.listings > 0 ? [DATED_TODAY] : []),
          "Not now leaves everything as it is.",
        ],
        buttons: ["accept", "decline"],
        labels: {},
      };
    }
    return {
      tone: "neutral",
      title: "Import your existing data",
      text: `This browser has ${what} of its own. Import them into your WatchDesk account? It can take a minute.`,
      report: null,
      details: [
        "Import uploads them to your account. They stay in this browser too.",
        ALREADY_THERE,
        ...(status.listings > 0 ? [DATED_TODAY] : []),
        "Not now keeps everything in this browser and starts the account without it. The watch list here then shows your account's watches; this browser's own are kept, and you can import them later from Settings.",
        "Until you choose, nothing is sent to WatchDesk and this browser keeps checking its own watches.",
      ],
      buttons: ["accept", "decline"],
      labels: {},
    };
  }
  if (status.phase === "importing") {
    if (status.problem) {
      // WD-83: what did get in so far, by site, and that it is not all of it.
      const report = describeReport(status.counts);
      return {
        tone: "problem",
        title: "The import has stopped for now",
        text: `${status.problem.message} It stopped while ${STEP_NAMES[status.step] || STEP_NAMES.watches}, and will be tried again automatically. Nothing is lost.`,
        report: { ...report, caption: "Imported so far, by site" },
        details: [
          "The import is not finished: the table shows only what has reached your account so far.",
          ...leftOutLines(report.rows),
        ],
        buttons: ["retry"],
        labels: {},
      };
    }
    return {
      tone: "neutral",
      title: "Importing your data…",
      text: progressText(status),
      report: null,
      details: [],
      buttons: [],
      labels: {},
    };
  }
  if (status.phase === "done") {
    if (status.closed) return null;
    const copies = sortCopies(status.copies);
    if (step === "confirm" && status.confirmable) {
      return {
        tone: "problem",
        title: copies.removable ? "Remove the earlier copies from this browser?" : "Remove this report?",
        text: copies.removable
          ? `This removes, from this browser only, its copy of ${copies.removable} from before it was connected, and this report.`
          : "This removes this report from this browser. Nothing else is removed.",
        report: null,
        details: [
          "Your WatchDesk account keeps everything that was imported: that is the copy that remains.",
          "This browser keeps its feed, its watch list and everything it needs to go on checking.",
          ...(copies.kept
            ? [`Its copy of ${copies.kept} is kept: this import did not put all of it into your account.`]
            : []),
          "This can't be undone.",
        ],
        buttons: ["keep", "remove"],
        labels: copies.removable
          ? { keep: "Keep them", remove: "Remove the copies" }
          : { keep: "Keep it", remove: "Remove the report" },
      };
    }
    const result = describeResult(status);
    return {
      tone: result.partial ? "problem" : "ok",
      title: result.partial ? "Your data was imported, with some left out" : "Your data was imported",
      text: sentence(result.text),
      report: { ...result.report, caption: "What was imported, by site" },
      details: [...result.details, ...stillHereLines(status)],
      buttons: ["dismiss", ...(status.confirmable && status.redo ? ["redo"] : []), ...(status.confirmable ? ["confirm"] : [])],
      labels: { confirm: copies.removable ? "Remove the earlier copies…" : "Remove this report…" },
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

// The settings panel's way back to a report that was closed (WD-83). Null
// when hidden.
export function describeImportReview(status) {
  if (status?.phase !== "done" || !status.closed) return null;
  const kept = copyWords(status.copies?.watches || 0, status.copies?.settings || []);
  return kept
    ? `What was imported into your account, by site. This browser still keeps a copy of ${kept} from before it was connected.`
    : "What was imported into your account, by site.";
}

// In the order they are read, which is also the order the focus looks for
// one in: "Close" before "Remove…", and "Keep them" before "Remove the
// copies", so that the button that removes something is never the one the
// focus is handed to.
const BUTTONS = ["accept", "decline", "retry", "dismiss", "redo", "confirm", "keep", "remove"];

const el = (doc, tag, text, attributes = {}) => {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
};

// The report as a table a screen reader can read: a caption, a header for
// each column and each row, and every number tied to its row, its group
// ("Watches" / "Listings") and its column by `headers`.
function reportTable(report, doc) {
  const id = (name) => `local-import-h-${name}`;
  const table = el(doc, "table", undefined, { class: "local-import-table" });
  table.append(el(doc, "caption", report.caption));

  const head = el(doc, "thead");
  const groups = el(doc, "tr");
  groups.append(el(doc, "td"));
  REPORT_COLUMNS.groups.forEach((group, g) => {
    groups.append(el(doc, "th", group, { id: id(`g${g}`), scope: "colgroup", colspan: String(REPORT_COLUMNS.columns.length) }));
  });
  const columns = el(doc, "tr");
  columns.append(el(doc, "th", "Site", { id: id("site"), scope: "col" }));
  REPORT_COLUMNS.groups.forEach((_group, g) => {
    REPORT_COLUMNS.columns.forEach((column, c) => {
      columns.append(el(doc, "th", column, { id: id(`g${g}c${c}`), scope: "col", headers: id(`g${g}`) }));
    });
  });
  head.append(groups, columns);

  const line = (name, cells, rowId) => {
    const row = el(doc, "tr");
    row.append(el(doc, "th", name, { id: id(rowId), scope: "row", headers: id("site") }));
    cells.forEach((value, i) => {
      const g = Math.floor(i / REPORT_COLUMNS.columns.length);
      const c = i % REPORT_COLUMNS.columns.length;
      row.append(el(doc, "td", String(value), { headers: `${id(rowId)} ${id(`g${g}`)} ${id(`g${g}c${c}`)}` }));
    });
    return row;
  };
  const body = el(doc, "tbody");
  report.rows.forEach((row, i) => body.append(line(row.name, row.cells, `r${i}`)));
  const foot = el(doc, "tfoot");
  foot.append(line("Total", report.total, "total"));

  table.append(head, body, foot);
  return table;
}

// What only the open popup knows (WD-83): whether the user is on the second
// step of removing the copies, and what the worker then said it removed.
// Neither is the report, which is in storage; a popup opened again starts
// from the report, not from the second step.
let step = null;
let removed = null;
let shown = null;

export function renderLocalImport(status, doc = document) {
  shown = status || null;
  if (status?.phase !== "done" || status.closed) step = null;
  if (status) removed = null;

  const card = doc.getElementById("local-import");
  if (card) {
    const view = describeImport(status, { step, removed });
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

    const report = doc.getElementById("local-import-report");
    if (report) {
      const table = view?.report || null;
      const key = table ? JSON.stringify(table) : "";
      if (report.dataset.shown !== key) {
        report.dataset.shown = key;
        report.replaceChildren(...(table ? [reportTable(table, doc)] : []));
      }
      report.hidden = !table;
    }

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
      if (!button) return;
      const name = BUTTONS[index];
      button.hidden = !view || !view.buttons.includes(name);
      if (view?.labels[name] && button.textContent !== view.labels[name]) button.textContent = view.labels[name];
    });
    // The button that was pressed is usually gone from the next state. The
    // focus goes to the card's first button, or to the card itself while it
    // has none (and from there to the next button to appear), so a keyboard
    // user is not dropped at the top of the popup.
    const lostItsButton = buttons.includes(focused) && focused.hidden;
    if (view && (lostItsButton || focused === card)) (buttons.find((button) => button && !button.hidden) || card).focus();
  }

  const group = doc.getElementById("local-import-again-group");
  if (group) {
    const hint = describeImportAgain(status);
    group.hidden = !hint;
    doc.getElementById("local-import-again-hint").textContent = hint || "";
  }

  const review = doc.getElementById("local-import-review-group");
  if (review) {
    const hint = describeImportReview(status);
    review.hidden = !hint;
    doc.getElementById("local-import-review-hint").textContent = hint || "";
  }
}

// Wires the card's buttons and the settings panel's. `send(message)` asks
// the service worker; `onState(state, type)` is given the popup state it
// answers with and the message that was answered.
export function initLocalImport({ send, onState }, doc = document) {
  // `message()` is asked for at the click, and may answer null: the click
  // was dealt with here and nothing is sent. `after(state)` runs once the
  // popup has rendered the answer.
  const wire = (id, message, after) => {
    const button = doc.getElementById(id);
    if (!button) return;
    button.addEventListener("click", async () => {
      // No second answer while the first is on its way. Not `disabled`: a
      // browser takes the focus away from a button the moment it is
      // disabled, and the focus is what renderLocalImport() hands on.
      if (button.dataset.busy === "true") return;
      const asked = message();
      if (!asked) return;
      button.dataset.busy = "true";
      try {
        const state = await send(asked);
        if (state?.settings) {
          if (asked.type === "local-import-confirm") removed = state.localImportConfirmed || null;
          onState(state, asked.type);
          if (after) after(state);
        }
      } catch {
        // The worker did not answer; nothing changed.
      } finally {
        delete button.dataset.busy;
      }
    });
  };
  // A step that is the popup's own: nothing is sent, the card is drawn again.
  const local = (change) => () => {
    change();
    renderLocalImport(shown, doc);
    return null;
  };

  wire("local-import-accept", () => ({ type: "local-import-accept" }));
  wire("local-import-decline", () => ({ type: "local-import-decline" }));
  wire("local-import-retry", () => ({ type: "local-import-retry" }));
  // "Close" on the line that says the copies were removed has no report
  // left to put away.
  wire("local-import-dismiss", () =>
    shown
      ? { type: "local-import-dismiss" }
      : local(() => {
          removed = null;
        })(),
  );
  wire("local-import-again", () => ({ type: "local-import-again" }));
  // WD-83. "Import again" asks WD-81's second question about the same data.
  wire("local-import-redo", () => ({ type: "local-import-again" }));
  // The first step removes nothing and sends nothing: it says what the
  // second would remove.
  wire(
    "local-import-confirm",
    local(() => {
      step = "confirm";
    }),
  );
  wire(
    "local-import-keep",
    local(() => {
      step = null;
    }),
  );
  // The second step: the one click that removes anything, and only for the
  // report on show.
  wire("local-import-remove", () => {
    if (step !== "confirm" || shown?.phase !== "done" || !shown.confirmable) return null;
    return { type: "local-import-confirm", finishedAt: shown.finishedAt };
  });
  // The settings panel's way back: the report is on the main page, so the
  // panel is closed and the focus taken to it.
  wire(
    "local-import-review",
    () => ({ type: "local-import-review" }),
    () => {
      doc.getElementById("settings-panel")?.classList.remove("open");
      doc.getElementById("local-import")?.focus();
      // From the card to its first button, "Close".
      renderLocalImport(shown, doc);
    },
  );
}
