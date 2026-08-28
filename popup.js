import { SOUND_OPTIONS } from "./sounds.js";
import { SITES, siteForUrl, pickWatchTabFromCandidates } from "./sites.js";

// Must match background.js's own ALARM_NAME — they're separate module
// graphs (background service worker vs. popup page) with no shared import,
// so this is intentionally duplicated rather than imported. Used to read
// the alarm's actual next-fire time straight from Chrome (via
// chrome.alarms.get), which the popup is allowed to call directly since
// the "alarms" permission applies extension-wide, not just to the
// background script.
const ALARM_NAME = "check-jobs";

// How many checks in a row a watch has to fail before the popup calls it
// out as "stuck" rather than just a fresh, possibly-transient error. Must
// stay in sync with what feels meaningful given the check interval — 3
// failures is "this isn't a fluke" without being so high it takes forever
// to notice.
const STUCK_THRESHOLD = 3;

function send(message) {
  return chrome.runtime.sendMessage(message);
}

// --- Tab reuse helpers --------------------------------------------------
//
// Some sites rewrite their own tab's URL a moment after it loads —
// LinkedIn is the worst offender, appending `?currentJobId=...` to any
// `/jobs/search/` tab via its own client-side routing within moments of
// load. Left unhandled, that means an exact-URL-match check against the
// tab we originally opened stops matching almost immediately, even though
// the tab itself is still sitting on a perfectly valid, on-topic search.
// Every "open a tab" affordance in this file used to just create a new
// tab whenever that exact match failed, which piles up duplicate tabs
// forever (each new tab drifts out of exact-match too, within moments) —
// eventually tripping background.js's own "multiple tabs open, ambiguous"
// error, which can then never self-resolve since retrying only adds more
// tabs. These helpers give every "open a tab" call site the same
// exact-match-then-broad-pattern-fallback logic that background.js's own
// fetchJobsViaTab() already uses for actually checking a site, so a
// drifted-but-still-valid tab is recognized as "already open" and reused
// instead of duplicated.
// `claimedTabIds`, when passed, is a Set of tab ids that a batch caller
// (see openRequiredTabs / the "Open all ↗" banner button) has already
// attributed to some OTHER watch earlier in the same batch. Without this,
// bulk-opening several watches on the same site breaks: watch #1 opens a
// real new tab; watch #2 (different search, same site) finds zero exact
// matches, falls through to the pattern-based fallback, sees exactly one
// candidate tab (the one just opened for watch #1), and — per the
// single-candidate "must be my drifted tab" heuristic below — wrongly
// reuses it instead of opening its own. Every subsequent watch on that
// site repeats the same mistake against that same first tab, so "open
// all" silently ends up opening only one tab per site no matter how many
// distinct searches are queued. Excluding already-claimed ids keeps the
// heuristic correct for the common single-watch case while stopping it
// from cannibalizing tabs a batch just opened for other watches.
async function findExistingSearchTab(watch, site, claimedTabIds) {
  let exact = [];
  try {
    exact = await chrome.tabs.query({ url: watch.url });
  } catch {
    exact = [];
  }
  if (claimedTabIds) exact = exact.filter((t) => !claimedTabIds.has(t.id));
  if (exact[0]) return { tab: exact[0], ambiguous: false };

  if (site?.tabQueryPattern) {
    let candidates = [];
    try {
      candidates = await chrome.tabs.query({ url: site.tabQueryPattern });
    } catch {
      candidates = [];
    }
    if (claimedTabIds) candidates = candidates.filter((t) => !claimedTabIds.has(t.id));
    // pickWatchTabFromCandidates (sites.js) first tries to match by
    // normalized search params — recognizes a drifted-but-still-correct
    // tab (e.g. LinkedIn's own currentJobId drift) even with several other
    // searches' tabs open on the same site — and only falls back to
    // "exactly one candidate total = must be mine" when that can't tell
    // anything apart. Same logic background.js uses for real checks, so
    // the popup's "already open?" detection agrees with what a check would
    // actually find.
    return pickWatchTabFromCandidates(watch, site, candidates);
  }

  return { tab: null, ambiguous: false };
}

async function focusTab(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // Best-effort only — even if we can't bring it to the front (e.g. the
    // windows API isn't available), we still found a usable tab, so the
    // caller shouldn't fall back to creating a duplicate over this.
  }
}

// Opens (or, if a matching one is already open, focuses) the tab for a
// single watch's search. This is the shared behavior behind every
// "Open Link"-style affordance in the popup, so they all reuse a
// drifted-but-valid tab the same way background.js's own checking logic
// does, instead of piling up duplicates. Returns "focused" | "opened" |
// "ambiguous" so callers can report back to the user; the ambiguous case
// deliberately does NOT open yet another tab, since that would only make
// an already-unresolvable "which tab is this?" situation worse.
//
// `active` defaults to true (a single explicit click should bring the
// tab to the front) but callers opening several tabs in bulk (see
// openRequiredTabs) pass `active: false` so it doesn't yank focus through
// each one in turn.
//
// `claimedTabIds`, when passed, is shared across every call in the same
// batch (see findExistingSearchTab above for why). Whichever tab this
// call ends up resolving to — reused or freshly created — gets recorded
// into it before returning, so the next watch in the batch can't
// mistakenly claim the same tab as its own.
async function openOrFocusWatchTab(watch, { active = true, claimedTabIds } = {}) {
  const site = SITES[watch.siteId] || siteForUrl(watch.url);
  const { tab, ambiguous } = await findExistingSearchTab(watch, site, claimedTabIds);

  if (ambiguous) return "ambiguous";

  if (tab) {
    if (active) await focusTab(tab);
    claimedTabIds?.add(tab.id);
    return "focused";
  }

  try {
    const created = await chrome.tabs.create({ url: watch.url, active });
    if (created?.id != null) claimedTabIds?.add(created.id);
  } catch {
    window.open(watch.url, "_blank", "noopener,noreferrer");
  }
  return "opened";
}

// Toggle a button between its normal label and a disabled, grayed-out
// "busy" state with a small spinning indicator — used for any action that
// takes a moment (checking now, opening required tabs) so it's obvious at
// a glance that something is happening, rather than the button just
// silently sitting there while the extension works.
function setButtonBusy(btn, isBusy, busyLabel = "Checking…") {
  if (isBusy) {
    if (btn.dataset.originalLabel === undefined) btn.dataset.originalLabel = btn.textContent;
    btn.disabled = true;
    btn.classList.add("is-busy");
    btn.innerHTML = "";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    btn.appendChild(spinner);
    btn.appendChild(document.createTextNode(busyLabel));
  } else {
    btn.disabled = false;
    btn.classList.remove("is-busy");
    if (btn.dataset.originalLabel !== undefined) btn.textContent = btn.dataset.originalLabel;
  }
}

// Cache of the last state we fetched from background.js, so purely local UI
// interactions (opening an edit box, changing feed page) can re-render
// instantly without a round trip.
let lastState = null;
let editingWatchId = null;

const FEED_PAGE_SIZE = 10;
let feedPage = 0; // 0-indexed
let feedSearch = "";
let feedPlatformFilter = "all";
let feedSort = "found-desc";

// Feed search/filter/sort are plain in-memory variables, which is fine
// while the popup stays open — but popup.html (and this whole script) gets
// torn down the moment it closes, so without persisting them anywhere,
// every reopen silently reset back to "no filters" even though the choice
// still looked applied a second ago. Storing the last-picked values in
// chrome.storage.local (small, local-only, no reason to sync across
// devices) and restoring them before the first render fixes that — the
// filter picks now survive a close/reopen just like the watch list does.
// Deliberately excludes feedPage: which page you were on is tied to
// whatever was in the feed at that moment, and the feed can easily have
// changed by the next time you open the popup, so starting back at page 1
// under the restored filters is the least surprising behavior.
const FEED_FILTERS_KEY = "feedFilters";

async function loadFeedFilters() {
  try {
    const { feedFilters } = await chrome.storage.local.get(FEED_FILTERS_KEY);
    if (!feedFilters) return;
    if (typeof feedFilters.search === "string") feedSearch = feedFilters.search;
    if (typeof feedFilters.platform === "string") feedPlatformFilter = feedFilters.platform;
    if (typeof feedFilters.sort === "string") feedSort = feedFilters.sort;
  } catch {
    // Best-effort — worst case the popup just falls back to no filters,
    // same as before this feature existed.
  }
}

function persistFeedFilters() {
  chrome.storage.local
    .set({ feedFilters: { search: feedSearch, platform: feedPlatformFilter, sort: feedSort } })
    .catch(() => {});
}

// Live "checked Xm ago / next check in ~Ym" status line — ticks on its own
// timer (see DOMContentLoaded) independent of the rest of the popup, so it
// stays accurate for as long as the popup happens to stay open without
// needing a full state refresh.
async function renderCheckStatus() {
  const statusEl = document.getElementById("check-status");
  const gapEl = document.getElementById("check-status-gap");
  if (!statusEl || !gapEl || !lastState) return;

  const { lastRunAt, lastGap } = lastState.runState;
  const intervalMinutes = lastState.settings?.intervalMinutes;

  let alarm = null;
  try {
    alarm = await chrome.alarms.get(ALARM_NAME);
  } catch {
    alarm = null;
  }

  const parts = [];
  parts.push(lastRunAt ? `Checked ${fmtRelative(lastRunAt)}` : "Not checked yet");
  if (alarm?.scheduledTime) {
    const minsLeft = Math.round((alarm.scheduledTime - Date.now()) / 60000);
    parts.push(minsLeft <= 0 ? "next check any moment" : `next check in ~${minsLeft}m`);
  }
  statusEl.innerHTML = "";
  const dot = document.createElement("span");
  dot.className = "check-status-dot";
  statusEl.appendChild(dot);
  statusEl.appendChild(document.createTextNode(parts.join(" · ")));

  // "Checked X ago" (from the run-state we last fetched) and "next check
  // in ~Ym" (a live read straight from Chrome's alarm scheduler) come from
  // two genuinely independent sources — the alarm can be firing right on
  // schedule while the actual check cycle it triggers keeps failing to
  // finish and save (e.g. the extension's background worker getting torn
  // down mid-check before it could persist anything — a real bug that
  // existed here and is now fixed, but this check stays as a safety net
  // for any other cause that could produce the same silent symptom). Left
  // alone, that combination reads as "everything's fine, check coming up
  // soon" right when it's actually stuck — so flag it explicitly instead
  // of just letting "Checked 4h ago" sit there looking unremarkable next
  // to a reassuring countdown.
  const STALE_MULTIPLIER = 3;
  const isStale =
    lastRunAt &&
    intervalMinutes &&
    Date.now() - lastRunAt > intervalMinutes * 60000 * STALE_MULTIPLIER &&
    alarm?.scheduledTime; // only flag this if the alarm itself looks healthy — a missing alarm is its own (self-healing) case, not this one

  // lateByMs is only meaningful the cycle it was recorded — background.js
  // clears it back to null the moment a later check runs on schedule, so
  // this naturally disappears again on its own rather than needing to be
  // dismissed by hand.
  if (lastGap && lastGap.lateByMs > 0) {
    const lateMin = Math.max(1, Math.round(lastGap.lateByMs / 60000));
    gapEl.textContent = `⚠ Catching up — the last check ran about ${lateMin}m later than scheduled, likely because Chrome was closed or your computer was asleep.`;
    gapEl.hidden = false;
  } else if (isStale) {
    const staleHours = (Date.now() - lastRunAt) / 3600000;
    const staleLabel = staleHours >= 1 ? `${Math.round(staleHours * 10) / 10}h` : `${Math.round((Date.now() - lastRunAt) / 60000)}m`;
    gapEl.textContent = `⚠ The last successful check was ${staleLabel} ago — longer than your ${intervalMinutes}-minute interval, even though a check is still scheduled soon. Checks may be failing silently in the background; try "Check now" above, or reopen this popup in a bit to see if it recovers on its own.`;
    gapEl.hidden = false;
  } else {
    gapEl.hidden = true;
  }
}

function fmtTime(ts) {
  if (!ts) return "never";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtRelative(ts) {
  if (!ts) return "unknown";
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 45) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  return `${diffDay}d ago`;
}

// Stable, deterministic color per watch (hash of its id into a fixed modern
// palette) so the same watch always reads the same color across the watch
// list and the feed — an easy visual grouping cue once you have 2+ watches.
const WATCH_COLORS = ["#7c3aed", "#2563eb", "#0891b2", "#d97706", "#db2777", "#4f46e5", "#059669"];
function colorForWatch(watchId) {
  let hash = 0;
  for (let i = 0; i < watchId.length; i++) {
    hash = (hash * 31 + watchId.charCodeAt(i)) >>> 0;
  }
  return WATCH_COLORS[hash % WATCH_COLORS.length];
}

function fmtPosted(entryOrJob) {
  const approxPrefix = entryOrJob.postedApprox ? "~" : "";
  if (entryOrJob.postedAt) {
    const d = new Date(entryOrJob.postedAt);
    if (!isNaN(d.getTime())) {
      const formatted = d.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      return `${approxPrefix}${formatted}${entryOrJob.postedApprox ? " (approx.)" : ""}`;
    }
  }
  return entryOrJob.postedRaw || "posted date unknown";
}

function statusPill(watch, lastResult) {
  const pill = document.createElement("span");
  if (lastResult?.error) {
    pill.className = "pill pill--error";
    pill.textContent = "Error";
  } else if (!watch.enabled) {
    pill.className = "pill pill--paused";
    pill.textContent = "Paused";
  } else {
    pill.className = "pill pill--active";
    pill.textContent = "Active";
  }
  return pill;
}

function renderWatchListBanner(erroredWatches) {
  const banner = document.getElementById("watch-list-banner");
  banner.innerHTML = "";
  if (erroredWatches.length === 0) return;

  const wrap = document.createElement("div");
  wrap.className = "watch-list-banner";

  const text = document.createElement("span");
  text.textContent =
    erroredWatches.length === 1
      ? "1 search needs attention"
      : `${erroredWatches.length} searches need attention`;
  wrap.appendChild(text);

  const openAllBtn = document.createElement("button");
  openAllBtn.className = "secondary";
  openAllBtn.textContent = "Open all ↗";
  openAllBtn.addEventListener("click", async () => {
    // De-dupe by watch URL first, in case two watches happen to share one
    // — no point opening (or focusing) the same tab twice. Each watch
    // goes through openOrFocusWatchTab so an already-open (even if
    // drifted, e.g. a LinkedIn tab that picked up a currentJobId) tab
    // gets reused instead of duplicated, and an ambiguous multi-tab
    // situation doesn't get made worse by piling on yet another tab.
    setButtonBusy(openAllBtn, true, "Opening…");
    const seenUrls = new Set();
    // Shared across every watch opened in this click — without it, once
    // watch #1 on a site gets a fresh tab, watch #2 on the SAME site
    // would see that one tab as its own "already open, drifted" match
    // and just refocus it instead of opening its own — so only the first
    // watch per site ever actually got a tab, silently. See the comment
    // on findExistingSearchTab for the full explanation.
    const claimedTabIds = new Set();
    let opened = 0;
    let alreadyOpen = 0;
    let ambiguous = 0;
    try {
      for (const watch of erroredWatches) {
        if (seenUrls.has(watch.url)) continue;
        seenUrls.add(watch.url);
        const result = await openOrFocusWatchTab(watch, { active: false, claimedTabIds });
        if (result === "opened") opened++;
        else if (result === "focused") alreadyOpen++;
        else if (result === "ambiguous") ambiguous++;
      }
    } finally {
      setButtonBusy(openAllBtn, false);
      // Report what actually happened rather than leaving the user to
      // guess why fewer tabs showed up than errors listed — an ambiguous
      // watch (multiple pre-existing tabs for that site, none matching)
      // is left alone on purpose and needs the user to close extras
      // themselves, same as the single "Open Link ↗" button explains.
      const parts = [];
      if (opened > 0) parts.push(`opened ${opened}`);
      if (alreadyOpen > 0) parts.push(`${alreadyOpen} already open`);
      if (ambiguous > 0) {
        parts.push(
          `${ambiguous} skipped (multiple tabs already open for that search — close extras down to one, then use that watch's own "Open Link ↗")`
        );
      }
      if (parts.length) {
        text.textContent = parts.join(", ") + ".";
        setTimeout(() => {
          text.textContent =
            erroredWatches.length === 1
              ? "1 search needs attention"
              : `${erroredWatches.length} searches need attention`;
        }, 4500);
      }
    }
  });
  wrap.appendChild(openAllBtn);

  banner.appendChild(wrap);
}

// Collapse state per platform group in the main watch list, keyed by
// siteId ("__other__" for watches whose site couldn't be determined).
// Kept in memory for the life of the popup (rebuilt from scratch every
// time it opens anyway) — `undefined` means "not decided yet," so the
// first render can pick a sensible default (collapsed once a group has
// enough watches to dominate the list) without fighting the user's own
// later clicks on the toggle, which is what actually decides it after
// that.
let watchGroupCollapsed = {};

function buildWatchItem(watch, runState) {
  const lastChecked = runState.lastChecked[watch.id];
  const lastResult = runState.lastResult[watch.id];

  const item = document.createElement("div");
  item.className = "watch-item";

  const row = document.createElement("div");
  row.className = "row";

  const labelGroup = document.createElement("div");
  labelGroup.className = "label-group";

  const dot = document.createElement("span");
  dot.className = "watch-dot";
  dot.style.background = colorForWatch(watch.id);
  labelGroup.appendChild(dot);

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = watch.label;
  label.title = watch.url;
  labelGroup.appendChild(label);
  labelGroup.appendChild(statusPill(watch, lastResult));
  row.appendChild(labelGroup);
  item.appendChild(row);

  const actions = document.createElement("div");
  actions.className = "actions-row";

  const editBtn = document.createElement("button");
  editBtn.className = "secondary";
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", () => {
    editingWatchId = editingWatchId === watch.id ? null : watch.id;
    renderAll();
  });
  actions.appendChild(editBtn);

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "secondary";
  toggleBtn.textContent = watch.enabled ? "Pause" : "Resume";
  toggleBtn.addEventListener("click", async () => {
    await send({ type: "toggle-watch", id: watch.id, enabled: !watch.enabled });
    await refresh();
  });
  actions.appendChild(toggleBtn);

  const removeBtn = document.createElement("button");
  removeBtn.className = "secondary danger-hover";
  removeBtn.textContent = "Remove";
  removeBtn.addEventListener("click", async () => {
    await send({ type: "remove-watch", id: watch.id });
    await refresh();
  });
  actions.appendChild(removeBtn);
  item.appendChild(actions);

  if (editingWatchId === watch.id) {
    const editRow = document.createElement("div");
    editRow.className = "edit-row";

    const input = document.createElement("input");
    input.type = "text";
    input.value = watch.label;
    input.maxLength = 80;
    editRow.appendChild(input);

    const errorSpan = document.createElement("span");
    errorSpan.className = "error";

    const saveBtn = document.createElement("button");
    saveBtn.textContent = "Save";
    const doSave = async () => {
      const newLabel = input.value.trim();
      if (!newLabel) {
        errorSpan.textContent = "Title can't be empty.";
        return;
      }
      const result = await send({ type: "rename-watch", id: watch.id, label: newLabel });
      if (!result?.ok) {
        errorSpan.textContent = result?.error || "Couldn't rename.";
        return;
      }
      editingWatchId = null;
      await refresh();
    };
    saveBtn.addEventListener("click", doSave);
    editRow.appendChild(saveBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "secondary";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      editingWatchId = null;
      renderAll();
    });
    editRow.appendChild(cancelBtn);

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doSave();
      if (e.key === "Escape") {
        editingWatchId = null;
        renderAll();
      }
    });

    item.appendChild(editRow);
    item.appendChild(errorSpan);

    // Focus + select the text so renaming is a single click + type + Enter.
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  if (lastResult?.error) {
    const errorSpan = document.createElement("span");
    errorSpan.className = "error";
    errorSpan.textContent = lastResult.error;
    meta.appendChild(errorSpan);

    const failStreak = runState.consecutiveErrors?.[watch.id] || 0;
    if (failStreak >= STUCK_THRESHOLD) {
      // A single error is often just a fluke (a tab got closed, a page
      // reload was mid-flight); a streak like this almost always means
      // the underlying cause (usually: no live tab open for this search)
      // hasn't been addressed yet, so it's worth a visually distinct nudge
      // rather than blending into every other one-off error.
      const stuckSpan = document.createElement("span");
      stuckSpan.className = "stuck-note";
      stuckSpan.textContent = `Failing for ${failStreak} checks in a row — this almost always means it needs its tab opened (or reopened).`;
      meta.appendChild(stuckSpan);
    }

    // Errors here are almost always "go open this search's tab yourself"
    // (no tab open, ambiguous multiple tabs, sign-in wall) — give a direct
    // one-click way to do that instead of making the user hunt for or
    // retype the URL. A plain <a target="_blank"> used to sit here, but
    // that always opened a brand-new tab with no awareness of one that
    // might already be open (even a drifted one, e.g. LinkedIn appending
    // currentJobId) — repeated clicks piled up duplicate tabs and could
    // never actually resolve the underlying error. This button routes
    // through openOrFocusWatchTab so it reuses an existing tab when it
    // can, and refuses to open yet another tab when the situation is
    // already ambiguous (multiple candidate tabs open).
    const openLink = document.createElement("button");
    openLink.type = "button";
    openLink.className = "open-search-link";
    openLink.textContent = "Open Link ↗";
    openLink.addEventListener("click", async () => {
      openLink.disabled = true;
      const original = openLink.textContent;
      try {
        const result = await openOrFocusWatchTab(watch);
        if (result === "ambiguous") {
          openLink.textContent = "Multiple tabs open — close extras ↗";
        } else if (result === "focused") {
          openLink.textContent = "Switched to open tab ✓";
        } else {
          openLink.textContent = "Opened ✓";
        }
      } catch {
        openLink.textContent = "Couldn't open — try again";
      } finally {
        setTimeout(() => {
          openLink.textContent = original;
          openLink.disabled = false;
        }, 2500);
      }
    });
    meta.appendChild(openLink);
  } else {
    const count = lastResult?.count;
    meta.textContent = `Last checked ${fmtTime(lastChecked)} · ${
      count != null ? count + " jobs seen" : "not checked yet"
    }`;
  }
  item.appendChild(meta);

  return item;
}

// Builds one collapsible platform group — a header (site name, live
// active/paused counts, a collapse toggle, and its own Pause/Resume-all
// buttons) plus a body holding that platform's watch-item cards. Mirrors
// the same collapse pattern as the Settings panel's per-platform list
// (collapsed by default past a handful of watches, otherwise open, and
// only the user's own clicks change it after that), but as a fully
// separate bit of state — collapsing a group in the main list and in
// Settings are independent, since they're different views of the same
// data.
function buildWatchGroup(groupKey, siteId, siteName, watchesForSite, runState) {
  const activeCount = watchesForSite.filter((w) => w.enabled).length;
  const pausedCount = watchesForSite.length - activeCount;
  // Errored is its own axis, not a third bucket alongside active/paused —
  // an errored watch is still counted in "active" or "paused" above (same
  // rule the watch-list-banner uses: `runState.lastResult[id]?.error`,
  // regardless of `enabled`), so this can overlap with either count rather
  // than needing to add up to the group's total.
  const errorCount = watchesForSite.filter((w) => runState.lastResult[w.id]?.error).length;

  if (!(groupKey in watchGroupCollapsed)) {
    watchGroupCollapsed[groupKey] = watchesForSite.length > 3;
  }
  const collapsed = watchGroupCollapsed[groupKey];

  const group = document.createElement("div");
  group.className = "watch-group";

  const header = document.createElement("div");
  header.className = "watch-group-header";

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "watch-group-toggle";
  toggleBtn.setAttribute("aria-expanded", String(!collapsed));

  const info = document.createElement("span");
  info.className = "watch-group-info";
  const nameEl = document.createElement("span");
  nameEl.className = "watch-group-name";
  nameEl.textContent = siteName;
  info.appendChild(nameEl);
  const countsEl = document.createElement("span");
  countsEl.className = "watch-group-counts";
  countsEl.textContent = `${activeCount} active · ${pausedCount} paused`;
  if (errorCount > 0) {
    // Nested inline span (not a sibling) so it renders on the same line
    // as the active/paused text — `.watch-group-info` is a column flex
    // container, so a sibling span would drop to its own row instead.
    const errorSpan = document.createElement("span");
    errorSpan.className = "watch-group-counts-error";
    errorSpan.textContent = ` · ${errorCount} error${errorCount === 1 ? "" : "s"}`;
    countsEl.appendChild(errorSpan);
  }
  info.appendChild(countsEl);
  toggleBtn.appendChild(info);

  const chevron = document.createElement("span");
  chevron.className = "watch-group-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = "⌄";
  toggleBtn.appendChild(chevron);

  toggleBtn.addEventListener("click", () => {
    watchGroupCollapsed[groupKey] = !watchGroupCollapsed[groupKey];
    if (lastState) renderWatchList(lastState.settings, lastState.runState);
  });
  header.appendChild(toggleBtn);

  const groupActions = document.createElement("div");
  groupActions.className = "watch-group-actions";

  const pauseBtn = document.createElement("button");
  pauseBtn.className = "secondary";
  pauseBtn.textContent = "Pause";
  pauseBtn.disabled = activeCount === 0;
  pauseBtn.addEventListener("click", async () => {
    await send({ type: "set-site-enabled", siteId, enabled: false });
    await refresh();
  });
  groupActions.appendChild(pauseBtn);

  const resumeBtn = document.createElement("button");
  resumeBtn.className = "secondary";
  resumeBtn.textContent = "Resume";
  resumeBtn.disabled = pausedCount === 0;
  resumeBtn.addEventListener("click", async () => {
    await send({ type: "set-site-enabled", siteId, enabled: true });
    await refresh();
  });
  groupActions.appendChild(resumeBtn);

  header.appendChild(groupActions);
  group.appendChild(header);

  const body = document.createElement("div");
  body.className = "watch-group-body";
  if (collapsed) body.classList.add("collapsed");
  for (const watch of watchesForSite) {
    body.appendChild(buildWatchItem(watch, runState));
  }
  group.appendChild(body);

  return group;
}

// Site display order is fixed (matches SITES' own definition order)
// rather than "whichever site's watch was added first," so the list
// doesn't reshuffle itself as you add/remove watches across sites. A
// watch whose site couldn't be determined (see the "Unsupported site"
// edge case in the add-watch handler) still needs somewhere to render,
// so those fall into a trailing "Other" bucket rather than being dropped.
function renderWatchList(settings, runState) {
  const list = document.getElementById("watch-list");
  list.innerHTML = "";

  const erroredWatches = settings.watches.filter((w) => runState.lastResult[w.id]?.error);
  renderWatchListBanner(erroredWatches);

  const bySite = new Map();
  for (const watch of settings.watches) {
    const key = watch.siteId || "__other__";
    if (!bySite.has(key)) bySite.set(key, []);
    bySite.get(key).push(watch);
  }

  const orderedKeys = [...Object.keys(SITES), "__other__"].filter((key) => bySite.has(key));

  for (const key of orderedKeys) {
    const siteId = key === "__other__" ? null : key;
    const siteName = key === "__other__" ? "Other" : SITES[key]?.name || key;
    list.appendChild(buildWatchGroup(key, siteId, siteName, bySite.get(key), runState));
  }
}

function renderFeedPagination(totalPages) {
  const paginationEl = document.getElementById("feed-pagination");
  paginationEl.innerHTML = "";
  if (totalPages <= 1) return;

  const prevBtn = document.createElement("button");
  prevBtn.className = "secondary";
  prevBtn.textContent = "‹ Prev";
  prevBtn.disabled = feedPage === 0;
  prevBtn.addEventListener("click", () => {
    feedPage = Math.max(0, feedPage - 1);
    renderFeed(lastState.runState);
  });
  paginationEl.appendChild(prevBtn);

  const info = document.createElement("span");
  info.className = "page-info";
  info.textContent = `Page ${feedPage + 1} of ${totalPages}`;
  paginationEl.appendChild(info);

  const nextBtn = document.createElement("button");
  nextBtn.className = "secondary";
  nextBtn.textContent = "Next ›";
  nextBtn.disabled = feedPage >= totalPages - 1;
  nextBtn.addEventListener("click", () => {
    feedPage = Math.min(totalPages - 1, feedPage + 1);
    renderFeed(lastState.runState);
  });
  paginationEl.appendChild(nextBtn);
}

// Derives a feed entry's platform straight from its own URL (via
// siteForUrl), rather than looking up its watchId against the current
// settings.watches — a feed entry needs to stay filterable by platform
// even after the watch that originally found it has since been renamed,
// paused, or removed entirely.
function getFeedPlatform(entry) {
  const site = siteForUrl(entry.url);
  return site ? site.id : "__other__";
}

function sortFeedEntries(list, sortKey) {
  const arr = [...list];
  switch (sortKey) {
    case "posted-desc":
      // Entries with no known posted date sink to the bottom either way,
      // rather than clumping at the top of one particular sort direction.
      arr.sort((a, b) => (b.postedAt ? new Date(b.postedAt).getTime() : -Infinity) - (a.postedAt ? new Date(a.postedAt).getTime() : -Infinity));
      break;
    case "posted-asc":
      arr.sort((a, b) => (a.postedAt ? new Date(a.postedAt).getTime() : Infinity) - (b.postedAt ? new Date(b.postedAt).getTime() : Infinity));
      break;
    case "found-asc":
      arr.sort((a, b) => a.detectedAt - b.detectedAt);
      break;
    case "found-desc":
    default:
      arr.sort((a, b) => b.detectedAt - a.detectedAt);
  }
  return arr;
}

// Rebuilds the platform-filter dropdown's options from whatever platforms
// are actually present in the feed right now (not every site the
// extension supports — no point offering to filter to "Upwork" if nothing
// Upwork has ever turned up). Selection state lives in feedPlatformFilter,
// not in the DOM, so rebuilding the options on every render doesn't lose
// the user's current choice — unless that platform's postings are all
// gone now, in which case it falls back to "All" rather than pointing at
// an option that no longer exists.
function populateFeedPlatformOptions(feed) {
  const select = document.getElementById("feed-platform-filter");
  const presentIds = new Set(feed.map(getFeedPlatform));
  const orderedIds = [...Object.keys(SITES), "__other__"].filter((id) => presentIds.has(id));

  select.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "all";
  allOpt.textContent = "All platforms";
  select.appendChild(allOpt);
  for (const id of orderedIds) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id === "__other__" ? "Other" : SITES[id]?.name || id;
    select.appendChild(opt);
  }

  if (feedPlatformFilter !== "all" && !orderedIds.includes(feedPlatformFilter)) {
    feedPlatformFilter = "all";
  }
  select.value = feedPlatformFilter;
}

function appendClearFiltersLink(container) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "clear-filters";
  btn.textContent = "Clear filters";
  btn.addEventListener("click", () => {
    feedSearch = "";
    feedPlatformFilter = "all";
    const searchInput = document.getElementById("feed-search");
    if (searchInput) searchInput.value = "";
    feedPage = 0;
    persistFeedFilters();
    renderFeed(lastState.runState);
  });
  container.appendChild(btn);
}

function renderFeed(runState) {
  const container = document.getElementById("feed-list");
  const summaryEl = document.getElementById("feed-summary");
  const allFeed = runState.feed || [];
  container.innerHTML = "";
  summaryEl.innerHTML = "";

  populateFeedPlatformOptions(allFeed);

  if (allFeed.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No new postings detected yet.";
    container.appendChild(empty);
    document.getElementById("feed-pagination").innerHTML = "";
    return;
  }

  let feed = allFeed;
  const query = feedSearch.trim().toLowerCase();
  if (query) {
    feed = feed.filter(
      (e) => e.title.toLowerCase().includes(query) || e.watchLabel.toLowerCase().includes(query)
    );
  }
  if (feedPlatformFilter !== "all") {
    feed = feed.filter((e) => getFeedPlatform(e) === feedPlatformFilter);
  }
  feed = sortFeedEntries(feed, feedSort);

  const hasFilters = Boolean(query) || feedPlatformFilter !== "all";

  if (feed.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No postings match your search/filter.";
    container.appendChild(empty);
    document.getElementById("feed-pagination").innerHTML = "";
    summaryEl.appendChild(document.createTextNode(`Showing 0 of ${allFeed.length}.`));
    appendClearFiltersLink(summaryEl);
    return;
  }

  if (hasFilters) {
    summaryEl.appendChild(document.createTextNode(`Showing ${feed.length} of ${allFeed.length}.`));
    appendClearFiltersLink(summaryEl);
  }

  const totalPages = Math.max(1, Math.ceil(feed.length / FEED_PAGE_SIZE));
  if (feedPage > totalPages - 1) feedPage = totalPages - 1;
  if (feedPage < 0) feedPage = 0;
  const start = feedPage * FEED_PAGE_SIZE;
  const pageItems = feed.slice(start, start + FEED_PAGE_SIZE);

  for (const entry of pageItems) {
    const item = document.createElement("div");
    item.className = "feed-item";

    const top = document.createElement("div");
    top.className = "feed-top";

    const dot = document.createElement("span");
    dot.className = "watch-dot";
    dot.style.background = colorForWatch(entry.watchId);
    dot.title = entry.watchLabel;
    top.appendChild(dot);

    const link = document.createElement("a");
    link.href = entry.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = entry.title;
    link.title = entry.url;
    top.appendChild(link);

    // Best-effort — most postings on most sites won't have one (LinkedIn
    // especially rarely lists a figure at all), so this only shows up when
    // the listing itself actually displayed a salary/rate.
    if (entry.salaryRaw) {
      const salaryPill = document.createElement("span");
      salaryPill.className = "salary-pill";
      salaryPill.textContent = entry.salaryRaw;
      salaryPill.title = "Salary/rate as shown on the listing";
      top.appendChild(salaryPill);
    }

    const badge = document.createElement("span");
    top.appendChild(badge);
    updateFeedBadge(badge, entry);

    link.addEventListener("click", () => {
      if (entry.visited) return;
      entry.visited = true; // same object reference as lastState.runState.feed[i]
      updateFeedBadge(badge, entry);
      send({ type: "mark-visited", id: entry.id }).catch(() => {});
    });

    item.appendChild(top);

    const meta = document.createElement("div");
    meta.className = "feed-meta";
    meta.textContent = `${entry.watchLabel} · Posted ${fmtPosted(entry)} · found ${fmtRelative(entry.detectedAt)}`;
    meta.title = `Found at ${fmtTime(entry.detectedAt)}`;
    item.appendChild(meta);

    container.appendChild(item);
  }

  renderFeedPagination(totalPages);
}

function updateFeedBadge(badge, entry) {
  if (entry.visited) {
    badge.className = "badge badge--visited";
    badge.textContent = "✓ Visited";
  } else {
    badge.className = "badge badge--new";
    badge.textContent = "New";
  }
}

function syncControls(settings) {
  document.getElementById("interval").value = String(settings.intervalMinutes);
  document.getElementById("sound").value = settings.soundId;
}

// Collapse state for the per-platform list, kept in memory for the life
// of the popup (it's rebuilt from scratch every time the popup opens
// anyway, so there's no need to persist this to storage). `null` means
// "not decided yet" — the first render picks a sensible default based on
// how many sites there are; after that, only the user's own clicks on
// the toggle change it, so it doesn't fight with the panel re-rendering
// on every action (pause/resume, mute, etc.).
let perSiteCollapsed = null;

function setPerSiteCollapsed(collapsed) {
  perSiteCollapsed = collapsed;
  const list = document.getElementById("settings-per-site");
  const toggle = document.getElementById("settings-per-site-toggle");
  list.classList.toggle("collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));
}

// One row per site actually in use (not every possible site — no point
// showing a "Pause LinkedIn" row if you have no LinkedIn watches), with a
// quick active/paused count and its own Pause all / Resume all pair, so
// you don't have to pause five Glassdoor watches one at a time. The whole
// list collapses behind a "Per-platform (N)" toggle so it doesn't crowd
// out the rest of Settings once you're tracking several sites — closed by
// default past a handful of sites, open by default below that, and
// always overridable with a click either way.
function renderSettingsPerSite(settings) {
  const container = document.getElementById("settings-per-site");
  const section = document.getElementById("settings-per-site-section");
  const countEl = document.getElementById("settings-per-site-count");
  container.innerHTML = "";

  const siteIds = [...new Set(settings.watches.map((w) => w.siteId).filter(Boolean))];
  section.hidden = siteIds.length === 0;
  if (siteIds.length === 0) return;

  countEl.textContent = `(${siteIds.length})`;
  if (perSiteCollapsed === null) {
    setPerSiteCollapsed(siteIds.length > 3);
  }

  for (const siteId of siteIds) {
    const site = SITES[siteId];
    const watchesForSite = settings.watches.filter((w) => w.siteId === siteId);
    const activeCount = watchesForSite.filter((w) => w.enabled).length;
    const pausedCount = watchesForSite.length - activeCount;

    const row = document.createElement("div");
    row.className = "settings-site-row";

    const info = document.createElement("div");
    info.className = "settings-site-info";
    const name = document.createElement("span");
    name.className = "settings-site-name";
    name.textContent = site ? site.name : siteId;
    info.appendChild(name);
    const counts = document.createElement("span");
    counts.className = "settings-site-counts";
    counts.textContent = `${activeCount} active · ${pausedCount} paused`;
    info.appendChild(counts);
    row.appendChild(info);

    const actions = document.createElement("div");
    actions.className = "settings-row-actions";

    const pauseBtn = document.createElement("button");
    pauseBtn.className = "secondary";
    pauseBtn.textContent = "Pause";
    pauseBtn.disabled = activeCount === 0;
    pauseBtn.addEventListener("click", async () => {
      await send({ type: "set-site-enabled", siteId, enabled: false });
      await refresh();
    });
    actions.appendChild(pauseBtn);

    const resumeBtn = document.createElement("button");
    resumeBtn.className = "secondary";
    resumeBtn.textContent = "Resume";
    resumeBtn.disabled = pausedCount === 0;
    resumeBtn.addEventListener("click", async () => {
      await send({ type: "set-site-enabled", siteId, enabled: true });
      await refresh();
    });
    actions.appendChild(resumeBtn);

    row.appendChild(actions);
    container.appendChild(row);
  }
}

function renderSettingsPanel(settings) {
  renderSettingsPerSite(settings);
  document.getElementById("mute-notifications").checked = Boolean(settings.notificationsMuted);

  const anyActive = settings.watches.some((w) => w.enabled);
  const anyPaused = settings.watches.some((w) => !w.enabled);
  document.getElementById("pause-all").disabled = !anyActive;
  document.getElementById("resume-all").disabled = !anyPaused;
}

function renderAll() {
  if (!lastState) return;
  renderWatchList(lastState.settings, lastState.runState);
  renderFeed(lastState.runState);
  syncControls(lastState.settings);
  renderSettingsPanel(lastState.settings);
  renderCheckStatus().catch(() => {});
}

async function refresh() {
  lastState = await send({ type: "get-state" });
  renderAll();
}

// One-click setup: some sites (currently Glassdoor — anything whose adapter
// is fetchMode "content-script") can't be checked in the background at all
// and need their own live tab open per distinct search. Rather than making
// the user discover that one error at a time and open each tab by hand,
// this opens everything that's currently missing in one go. Sites that run
// fully in the background (OnlineJobs.ph) never need a tab, so they're
// skipped — this only ever opens tabs for watches that actually require one.
async function openRequiredTabs() {
  const statusEl = document.getElementById("status");
  const watches = (lastState?.settings?.watches || []).filter((w) => w.enabled);

  // One watch per needed tab, not one entry per unique URL — the "already
  // open?" check now needs each watch's site (for its tabQueryPattern
  // fallback), and de-duping by exact URL up front would just re-hide the
  // same problem this whole fix is for: a tab can already exist for a
  // watch without matching its URL exactly (e.g. LinkedIn appending
  // currentJobId), so it has to be checked per watch, not per raw string.
  const seenUrls = new Set();
  const needed = [];
  for (const watch of watches) {
    const site = SITES[watch.siteId] || siteForUrl(watch.url);
    if (site?.fetchMode !== "content-script") continue;
    if (seenUrls.has(watch.url)) continue;
    seenUrls.add(watch.url);
    needed.push(watch);
  }

  if (needed.length === 0) {
    statusEl.textContent = "No open tabs are needed right now.";
    setTimeout(() => (statusEl.textContent = ""), 2000);
    return;
  }

  statusEl.textContent = "Opening tabs…";
  let opened = 0;
  let alreadyOpen = 0;
  let ambiguous = 0;
  // Shared across every watch in this batch — see the comment on
  // findExistingSearchTab for why a tab this loop just opened for one
  // watch must not get silently reused for the next watch on the same
  // site too.
  const claimedTabIds = new Set();
  for (const watch of needed) {
    const result = await openOrFocusWatchTab(watch, { active: false, claimedTabIds });
    if (result === "opened") opened++;
    else if (result === "focused") alreadyOpen++;
    else if (result === "ambiguous") ambiguous++;
  }

  const parts = [];
  if (opened > 0) parts.push(`opened ${opened} tab${opened === 1 ? "" : "s"}`);
  if (alreadyOpen > 0) parts.push(`${alreadyOpen} already open`);
  if (ambiguous > 0) {
    parts.push(
      `${ambiguous} ambiguous (multiple tabs already open — close extras down to one)`
    );
  }
  statusEl.textContent = parts.length ? parts.join(", ") + "." : "Done.";
  setTimeout(() => (statusEl.textContent = ""), 3500);
}

function populateSoundOptions() {
  const select = document.getElementById("sound");
  select.innerHTML = "";
  for (const opt of SOUND_OPTIONS) {
    const el = document.createElement("option");
    el.value = opt.id;
    el.textContent = opt.label;
    select.appendChild(el);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  populateSoundOptions();

  // Restore the last search/filter/sort choice before the first render, so
  // reopening the popup shows the feed the way it was left instead of
  // flashing "no filters" for a moment and then re-applying.
  await loadFeedFilters();
  const feedSearchInput = document.getElementById("feed-search");
  if (feedSearchInput) feedSearchInput.value = feedSearch;
  const feedSortSelect = document.getElementById("feed-sort");
  if (feedSortSelect) feedSortSelect.value = feedSort;
  // feed-platform-filter's <select> is rebuilt from the feed's actual
  // contents every render (see populateFeedPlatformOptions), which already
  // sets its value from feedPlatformFilter each time — nothing extra needed
  // here.

  await send({ type: "clear-badge" });
  await refresh();

  // Keeps "checked Xm ago / next check in ~Ym" accurate for as long as the
  // popup stays open, without re-fetching or re-rendering everything else.
  setInterval(() => renderCheckStatus().catch(() => {}), 30000);

  document.getElementById("open-required-tabs").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    setButtonBusy(btn, true, "Opening…");
    try {
      await openRequiredTabs();
    } finally {
      setButtonBusy(btn, false);
    }
  });

  // --- Settings panel ---
  const settingsPanel = document.getElementById("settings-panel");
  document.getElementById("settings-toggle").addEventListener("click", () => {
    settingsPanel.classList.toggle("open");
  });
  document.getElementById("settings-close").addEventListener("click", () => {
    settingsPanel.classList.remove("open");
  });

  document.getElementById("settings-per-site-toggle").addEventListener("click", () => {
    setPerSiteCollapsed(!perSiteCollapsed);
  });

  document.getElementById("pause-all").addEventListener("click", async () => {
    await send({ type: "pause-all" });
    await refresh();
  });
  document.getElementById("resume-all").addEventListener("click", async () => {
    await send({ type: "resume-all" });
    await refresh();
  });

  document.getElementById("mute-notifications").addEventListener("change", async (e) => {
    await send({ type: "set-notifications-muted", muted: e.target.checked });
  });

  const settingsStatusMsg = document.getElementById("settings-status-msg");
  const showSettingsStatus = (text, kind) => {
    settingsStatusMsg.textContent = text;
    settingsStatusMsg.className = `settings-status${kind ? ` ${kind}` : ""}`;
  };

  document.getElementById("export-settings").addEventListener("click", () => {
    const settings = lastState?.settings;
    if (!settings) return;
    const payload = {
      watches: settings.watches,
      intervalMinutes: settings.intervalMinutes,
      soundId: settings.soundId,
      notificationsMuted: Boolean(settings.notificationsMuted),
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "job-alert-notifier-backup.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showSettingsStatus("Backup downloaded.", "success");
  });

  const importFileInput = document.getElementById("import-settings-file");
  document.getElementById("import-settings-btn").addEventListener("click", () => {
    importFileInput.click();
  });
  importFileInput.addEventListener("change", async () => {
    const file = importFileInput.files?.[0];
    importFileInput.value = ""; // allow re-selecting the same file later
    if (!file) return;

    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      showSettingsStatus("That file isn't valid JSON.", "error");
      return;
    }

    const result = await send({ type: "import-settings", data });
    if (!result?.ok) {
      showSettingsStatus(result?.error || "Couldn't import that file.", "error");
      return;
    }
    let msg = `Imported ${result.imported} watch${result.imported === 1 ? "" : "es"}.`;
    if (result.skipped) msg += ` Skipped ${result.skipped} unrecognized.`;
    showSettingsStatus(msg, "success");
    await refresh();
  });

  document.getElementById("reset-extension").addEventListener("click", async () => {
    const confirmed = confirm(
      "Reset Job Alert Notifier? This clears every watch, the whole feed, and all settings back to defaults. This can't be undone — export a backup first if you want to keep any of it."
    );
    if (!confirmed) return;
    await send({ type: "reset-extension" });
    // "Reset to defaults" should mean defaults — clear the saved feed
    // filter/sort choice too, not just the watches/settings background.js
    // owns, otherwise an old filter would silently linger and keep hiding
    // postings after a reset.
    feedSearch = "";
    feedPlatformFilter = "all";
    feedSort = "found-desc";
    feedPage = 0;
    const searchInput = document.getElementById("feed-search");
    if (searchInput) searchInput.value = "";
    const sortSelect = document.getElementById("feed-sort");
    if (sortSelect) sortSelect.value = feedSort;
    persistFeedFilters();
    showSettingsStatus("Extension reset to defaults.", "success");
    await refresh();
  });

  document.getElementById("check-now").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const statusEl = document.getElementById("status");
    setButtonBusy(btn, true, "Checking…");
    statusEl.textContent = "Checking…";
    try {
      lastState = await send({ type: "check-now" });
      renderAll();
      statusEl.textContent = "Done.";
    } catch (err) {
      statusEl.textContent = "Check failed — try again.";
    } finally {
      setButtonBusy(btn, false);
      setTimeout(() => (statusEl.textContent = ""), 1500);
    }
  });

  document.getElementById("interval").addEventListener("change", async (e) => {
    await send({ type: "set-interval", minutes: Number(e.target.value) });
  });

  document.getElementById("sound").addEventListener("change", async (e) => {
    await send({ type: "set-sound", soundId: e.target.value });
  });

  document.getElementById("test-sound").addEventListener("click", async () => {
    const soundId = document.getElementById("sound").value;
    await send({ type: "test-sound", soundId });
  });

  document.getElementById("clear-feed").addEventListener("click", async () => {
    const feed = lastState?.runState?.feed || [];
    if (feed.length && !confirm(`Clear all ${feed.length} logged postings? This can't be undone.`)) {
      return;
    }
    await send({ type: "clear-feed" });
    await refresh();
  });

  document.getElementById("mark-all-visited").addEventListener("click", async () => {
    await send({ type: "mark-all-visited" });
    await refresh();
  });

  // --- Feed search / filter / sort ---
  let feedSearchDebounce = null;
  document.getElementById("feed-search").addEventListener("input", (e) => {
    const value = e.target.value;
    clearTimeout(feedSearchDebounce);
    // A short debounce so fast typing doesn't re-render the list on every
    // keystroke — the feed can hold up to 100 entries, which is cheap to
    // filter, but there's no reason to redo it more than a few times a
    // second while someone's still typing.
    feedSearchDebounce = setTimeout(() => {
      feedSearch = value;
      feedPage = 0;
      persistFeedFilters();
      if (lastState) renderFeed(lastState.runState);
    }, 200);
  });

  document.getElementById("feed-platform-filter").addEventListener("change", (e) => {
    feedPlatformFilter = e.target.value;
    feedPage = 0;
    persistFeedFilters();
    if (lastState) renderFeed(lastState.runState);
  });

  document.getElementById("feed-sort").addEventListener("change", (e) => {
    feedSort = e.target.value;
    feedPage = 0;
    persistFeedFilters();
    if (lastState) renderFeed(lastState.runState);
  });

  document.getElementById("add-watch").addEventListener("click", async () => {
    const urlInput = document.getElementById("new-url");
    const labelInput = document.getElementById("new-label");
    const errorEl = document.getElementById("add-error");
    errorEl.textContent = "";

    const url = urlInput.value.trim();
    const label = labelInput.value.trim();
    if (!url) {
      errorEl.textContent = "Paste a search URL first.";
      return;
    }
    try {
      new URL(url);
    } catch {
      errorEl.textContent = "That doesn't look like a valid URL.";
      return;
    }

    const result = await send({ type: "add-watch", url, label });
    if (!result.ok) {
      errorEl.textContent = result.error || "Couldn't add that watch.";
      return;
    }
    urlInput.value = "";
    labelInput.value = "";
    await refresh();
  });
});
