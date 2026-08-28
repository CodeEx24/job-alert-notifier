// background.js — MV3 service worker
//
// Responsibilities:
//   1. On a timer (chrome.alarms), fetch each watched search URL.
//   2. Parse out the current job postings (via the offscreen document,
//      since service workers have no DOMParser) — title, link, and the
//      "Posted on ..." timestamp for each.
//   3. Diff against the job IDs we saw last time.
//   4. Pop a native desktop notification (with a chosen tone) for anything
//      new, set a badge count on the toolbar icon, and log the new jobs to
//      a running feed the popup displays.
//
// Storage:
//   chrome.storage.sync  -> { watches: [...], intervalMinutes, soundId }
//     (small, user-configured settings — syncs across the user's Chrome
//      profiles if they're signed in)
//   chrome.storage.local -> { seenIds: {watchId: [ids]}, lastChecked: {},
//                              lastResult: {}, badgeCount, feed: [...] }
//     (larger / more frequently written run-state, kept local only)

import { SITES, siteForUrl, pickWatchTabFromCandidates } from "./sites.js";

const ALARM_NAME = "check-jobs";
const OFFSCREEN_URL = "offscreen.html";
const FEED_LIMIT = 100; // cap how many "new job" entries we keep around

// Map of notificationId -> { watchId, jobs } so we know what to open
// when the user clicks a notification. Lives only in memory; that's fine,
// since notifications don't need to survive a service worker restart.
const notificationJobs = new Map();

// ---------- settings / defaults ----------

function defaultWatch() {
  const site = SITES.onlinejobsph;
  return {
    id: "default",
    siteId: site.id,
    url: site.defaultUrl,
    label: "All OnlineJobs.ph postings",
    enabled: true,
  };
}

async function getSettings() {
  const { watches, intervalMinutes, soundId, notificationsMuted } = await chrome.storage.sync.get([
    "watches",
    "intervalMinutes",
    "soundId",
    "notificationsMuted",
  ]);
  return {
    watches: watches && watches.length ? watches : [defaultWatch()],
    intervalMinutes: intervalMinutes || 5,
    soundId: soundId || "chime",
    // Muting still checks and updates the feed/badge as normal — it only
    // skips the OS notification popup and alert tone, e.g. for quiet hours.
    notificationsMuted: Boolean(notificationsMuted),
  };
}

async function saveSettings(partial) {
  await chrome.storage.sync.set(partial);
}

// One-time-per-entry self-heal for a real bug: before cleanTitle() existed
// in sites.js, a posting's title could get saved with the "Posted on ..."
// timestamp and/or salary baked right into the title text itself (see the
// big comment above cleanTitle() for the root cause). Fixing the
// extraction logic only cleans titles for postings detected AFTER the fix
// — it does nothing for entries that were already written to the feed
// with the polluted title. Those entries already have postedRaw/salaryRaw
// stored correctly (only the title was ever wrong), so this strips those
// same values back out of an already-saved title, exactly like a fresh
// check now does at extraction time. Runs here (not gated behind
// onInstalled) so it takes effect the moment the fixed extension is
// reloaded and the popup is next opened, regardless of exactly how the
// reload happened — and it's a no-op (returns the title unchanged) for
// any entry that's already clean, so it's safe to run on every read.
function cleanStoredFeedTitle(entry) {
  let t = entry.title || "";
  if (entry.postedRaw) {
    // OnlineJobs.ph stores just the bare timestamp in postedRaw, but a
    // polluted title has the full "Posted on <timestamp>" phrase — strip
    // that exact phrase first...
    t = t.split(`Posted on ${entry.postedRaw}`).join(" ");
    // ...then the bare value too, since the other three sites store their
    // already-final label (e.g. "6d ago", "3 days ago") which — if it
    // leaked into the title — appears there as-is, with no extra prefix.
    t = t.split(entry.postedRaw).join(" ");
  }
  if (entry.salaryRaw) {
    t = t.split(entry.salaryRaw).join(" ");
  }
  t = t.replace(/\s+/g, " ").trim();
  return t || entry.title;
}

function cleanStoredFeed(feed) {
  let changed = false;
  const cleaned = feed.map((entry) => {
    const title = cleanStoredFeedTitle(entry);
    if (title === entry.title) return entry;
    changed = true;
    return { ...entry, title };
  });
  return { cleaned, changed };
}

async function getRunState() {
  const { seenIds, lastChecked, lastResult, badgeCount, feed, consecutiveErrors, lastRunAt, lastGap } =
    await chrome.storage.local.get([
      "seenIds",
      "lastChecked",
      "lastResult",
      "badgeCount",
      "feed",
      "consecutiveErrors",
      "lastRunAt",
      "lastGap",
    ]);
  const { cleaned: cleanedFeed, changed } = cleanStoredFeed(feed || []);
  if (changed) {
    // Fire-and-forget persist — no need to make the caller wait on this.
    chrome.storage.local.set({ feed: cleanedFeed }).catch((err) =>
      console.error("[job-alert] failed to persist cleaned feed titles", err)
    );
  }
  return {
    seenIds: seenIds || {},
    lastChecked: lastChecked || {},
    lastResult: lastResult || {},
    badgeCount: badgeCount || 0,
    feed: cleanedFeed,
    // How many checks in a row each watch has failed, back-to-back — reset
    // to 0 the moment a check for that watch succeeds. Lets the popup call
    // out a watch that's been silently failing for a while (almost always
    // one of the three sites that need a live tab open) instead of it just
    // sitting as a small, easy-to-miss red pill.
    consecutiveErrors: consecutiveErrors || {},
    // When the most recent full check cycle finished, and — if the alarm
    // that triggered it fired noticeably later than scheduled (Chrome was
    // closed, the computer was asleep, etc.) — how late it was. Both feed
    // the popup's "checked Xm ago / next check in ~Ym" status line and its
    // one-time "catching up" notice.
    lastRunAt: lastRunAt || null,
    lastGap: lastGap || null,
  };
}

async function saveRunState(partial) {
  await chrome.storage.local.set(partial);
}

// ---------- offscreen document (DOM parsing + sound for the service worker) ----------

let creatingOffscreen; // guards against concurrent createDocument calls

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["DOM_PARSER", "AUDIO_PLAYBACK"],
    justification:
      "Parse fetched job-search HTML to find job listings, and play the chosen notification tone (service workers can't do either directly).",
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = undefined;
  }
}

async function parseHtml(siteId, html, baseUrl) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    type: "parse-html",
    siteId,
    html,
    baseUrl,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Failed to parse HTML");
  }
  return response.jobs;
}

async function playAlertSound(soundId) {
  if (!soundId || soundId === "none" || soundId === "default") return;
  try {
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({ type: "play-sound", soundId });
  } catch (err) {
    console.error("[job-alert] failed to play sound", err);
  }
}

// ---------- fetch + diff one watch ----------

// Sites whose fetchMode is "content-script" (Glassdoor, LinkedIn, Upwork)
// can't be checked with a background fetch() — either because the page
// needs JS to render (never fully solved here) or, in Glassdoor's and
// Upwork's case, because an anti-bot layer blocks an anonymous background
// request even though the page itself is server-rendered once a real tab
// clears it. Instead we ping an actual open tab on that site and ask its
// content script (content-glassdoor.js, content-linkedin.js, or
// content-upwork.js, injected there via manifest content_scripts) to read
// whatever is currently in its DOM.
async function fetchJobsViaTab(watch, site) {
  // Prefer a tab that's open to this exact saved search.
  const exactTabs = await chrome.tabs.query({ url: watch.url });
  let tab = exactTabs[0];

  if (!tab && site.tabQueryPattern) {
    // No exact match — see what else is open on this site's job-search
    // section. pickWatchTabFromCandidates (sites.js) first tries to match
    // by normalized search params (recognizes a drifted-but-still-correct
    // tab even with several other searches' tabs open on the same site —
    // see the big comment above it for why that matters); only if that
    // can't tell anything apart does it fall back to "exactly one tab open
    // = must be mine," and refuses to guess when it's genuinely ambiguous.
    const candidates = await chrome.tabs.query({ url: site.tabQueryPattern });
    const picked = pickWatchTabFromCandidates(watch, site, candidates);
    if (picked.tab) {
      tab = picked.tab;
    } else if (picked.ambiguous) {
      throw new Error(
        `Multiple ${site.name} tabs are open, but none matches this watch's search exactly, so it's not safe to guess which one to scan. Use the "Open Link ↗" button below to open this watch's exact search in its own tab (one tab per distinct ${site.name} search you're tracking) and leave it there.`
      );
    }
  }

  if (!tab) {
    // Not every content-script site actually requires you to be signed in
    // (confirmed live: Upwork's search results render fully for a signed-
    // out session) — only claim that when the adapter says so, so the
    // message doesn't send someone to log in for no reason.
    const signedInPhrase = site.requiresSignIn ? ", signed-in" : "";
    throw new Error(
      `No open ${site.name} tab found for this search. ${site.name} needs a live${signedInPhrase} tab open — background checking gets blocked by its bot protection. Use the "Open Link ↗" button below to open it in a tab and leave it there.`
    );
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: "rescan", siteId: site.id });
  } catch (err) {
    throw new Error(
      `Lost the connection to your open ${site.name} tab. This usually just means that tab was already open before you installed or reloaded the extension, so its page-reading script never loaded — or the tab drifted off the search page. Use the "Open Link ↗" button below to open a fresh tab (or reload the existing one) and leave it sitting on the search results; a live, freshly-loaded tab is also what keeps ${site.name} from flagging the check as bot activity.`
    );
  }
  if (!response?.ok) {
    throw new Error(response?.error || `Failed to scan the open ${site.name} tab.`);
  }
  return response.jobs;
}

async function fetchJobs(watch) {
  const site = SITES[watch.siteId] || siteForUrl(watch.url);
  if (!site) throw new Error(`No adapter found for URL: ${watch.url}`);

  if (site.fetchMode === "content-script") {
    return fetchJobsViaTab(watch, site);
  }
  if (site.fetchMode !== "background") {
    throw new Error(`${site.name}: unsupported fetch mode "${site.fetchMode}".`);
  }
  const res = await fetch(watch.url, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${watch.url}`);
  }
  const html = await res.text();
  return parseHtml(site.id, html, watch.url);
}

// Fetches + diffs a single watch and returns what changed, WITHOUT touching
// storage itself. Used to be a self-contained read-modify-write against the
// whole run-state, but that meant every watch in a check cycle (they all
// run concurrently, see runAllChecks) was reading and writing the same
// storage object independently — whichever watch finished last would win
// and silently overwrite the others' updates from that same cycle (a
// classic lost-update race). Returning plain data instead lets
// runAllChecks merge every watch's outcome into one in-memory state object
// and persist it with a single write per cycle, so nothing gets clobbered.
async function checkWatch(watch, { isFirstRun, previousIds }) {
  const jobs = await fetchJobs(watch);
  const currentIds = jobs.map((j) => j.id);

  // Establish a baseline on the very first check for this watch so we
  // don't blast the user with notifications for jobs that were already
  // posted before they set this up.
  const newJobs = isFirstRun ? [] : jobs.filter((j) => !previousIds.has(j.id));

  return {
    newJobs,
    // Replace (not union) the seen set with the current page's ids. The
    // job board's search-results page is a rotating window (newest
    // first), so this naturally self-limits storage size and still
    // catches anything new that appears above the fold on the next check.
    currentIds,
    result: { count: jobs.length, newCount: newJobs.length, error: null },
  };
}

// `lateByMs` is how much later than its own scheduled time the alarm that
// triggered this run actually fired (0 for a manual "check now" from the
// popup, which isn't on any schedule to be late against). Chrome's alarms
// API is reliable about eventually firing, but if the browser was fully
// closed or the computer was asleep, "eventually" can be well past the
// interval you configured — this is how that shows up as a one-time
// "catching up" notice in the popup instead of just looking like nothing
// happened.
async function runAllChecks({ lateByMs = 0 } = {}) {
  const { watches, soundId, notificationsMuted } = await getSettings();
  // Single read for the whole cycle — every watch's outcome below gets
  // merged into this same in-memory object, then it's written back once.
  const state = await getRunState();
  const now = Date.now();

  const results = await Promise.all(
    watches
      .filter((w) => w.enabled)
      .map(async (watch) => {
        const isFirstRun = !(watch.id in state.seenIds);
        const previousIds = new Set(state.seenIds[watch.id] || []);
        try {
          const { newJobs, currentIds, result } = await checkWatch(watch, { isFirstRun, previousIds });
          return { watch, newJobs, currentIds, result, error: null };
        } catch (err) {
          return {
            watch,
            newJobs: [],
            currentIds: null,
            result: {
              count: state.lastResult[watch.id]?.count || 0,
              newCount: 0,
              error: String(err?.message || err),
            },
            error: err,
          };
        }
      })
  );

  for (const r of results) {
    state.lastChecked[r.watch.id] = now;
    state.lastResult[r.watch.id] = r.result;
    if (r.currentIds) state.seenIds[r.watch.id] = r.currentIds;
    // Consecutive-failure streak, per watch — resets the instant a check
    // succeeds. This is what lets the popup flag "this one's been failing
    // for a while" instead of every fresh, one-off error looking the same
    // as a watch that's needed attention for the last hour.
    state.consecutiveErrors[r.watch.id] = r.error ? (state.consecutiveErrors[r.watch.id] || 0) + 1 : 0;
  }

  // A little scheduling jitter (a few seconds) is normal and not worth
  // flagging — only surface a gap that's clearly "something interrupted
  // this" (browser closed, machine asleep), not routine alarm noise.
  const LATE_THRESHOLD_MS = 90_000;
  state.lastGap = lateByMs > LATE_THRESHOLD_MS ? { lateByMs, at: now } : null;
  state.lastRunAt = now;

  const withNewJobs = results.filter((r) => r.newJobs.length > 0);
  if (withNewJobs.length > 0) {
    // Muted just means "don't pop a desktop notification or play a sound
    // right now" — the feed and badge below still update normally either
    // way, so nothing is silently missed once you unmute.
    if (!notificationsMuted) {
      for (const { watch, newJobs } of withNewJobs) {
        await notifyNewJobs(watch, newJobs, soundId);
      }
    }

    const newFeedEntries = withNewJobs.flatMap(({ watch, newJobs }) =>
      newJobs.map((j) => ({
        id: `${watch.id}:${j.id}`,
        watchId: watch.id,
        watchLabel: watch.label,
        title: j.title,
        url: j.url,
        postedRaw: j.postedRaw || null,
        postedAt: j.postedAt || null,
        postedApprox: j.postedApprox || false,
        salaryRaw: j.salaryRaw || null,
        detectedAt: now,
        visited: false,
      }))
    );

    const totalNew = newFeedEntries.length;
    state.feed = [...newFeedEntries, ...state.feed].slice(0, FEED_LIMIT);
    state.badgeCount = (state.badgeCount || 0) + totalNew;
  }

  await saveRunState(state);
  if (withNewJobs.length > 0) {
    await updateBadge(state.badgeCount);
    if (!notificationsMuted) {
      await playAlertSound(soundId); // one alert tone per check cycle, not per watch
    }
  }
}

// ---------- bulk watch actions (Settings panel) ----------

function setAllWatchesEnabled(watches, enabled) {
  watches.forEach((w) => (w.enabled = enabled));
}

function setSiteWatchesEnabled(watches, siteId, enabled) {
  watches.forEach((w) => {
    if (w.siteId === siteId) w.enabled = enabled;
  });
}

async function resetExtension() {
  await saveSettings({
    watches: [defaultWatch()],
    intervalMinutes: 5,
    soundId: "chime",
    notificationsMuted: false,
  });
  await saveRunState({ seenIds: {}, lastChecked: {}, lastResult: {}, badgeCount: 0, feed: [], consecutiveErrors: {}, lastRunAt: null, lastGap: null });
  await updateBadge(0);
  await scheduleAlarm();
}

// Restores watches + settings from a previously exported JSON file (see
// popup.js's "Export…" button). Deliberately re-derives each watch's
// siteId from its URL rather than trusting whatever siteId is in the file,
// so a hand-edited or corrupted file can't silently point a watch at the
// wrong adapter; any watch whose URL doesn't match a known site is dropped
// and reported back rather than silently kept in a broken state.
async function importSettings(data) {
  if (!data || !Array.isArray(data.watches)) {
    return { ok: false, error: "That file doesn't look like a Job Alert Notifier backup." };
  }

  const importedWatches = [];
  let skipped = 0;
  for (const raw of data.watches) {
    const url = typeof raw?.url === "string" ? raw.url : null;
    // Trust the URL, not the claimed siteId — re-derive which adapter it
    // actually belongs to (falling back from a claimed siteId that turns
    // out not to match the URL at all).
    const claimedSite = url && SITES[raw?.siteId];
    const site = claimedSite && claimedSite.hostMatch(url) ? claimedSite : url ? siteForUrl(url) : null;
    if (!url || !site) {
      skipped++;
      continue;
    }
    importedWatches.push({
      id: typeof raw.id === "string" && raw.id ? raw.id : `w_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      siteId: site.id,
      url: site.normalizeUrl ? site.normalizeUrl(url) : url,
      label: typeof raw.label === "string" && raw.label ? raw.label : site.name,
      enabled: raw.enabled !== false,
    });
  }

  if (importedWatches.length === 0) {
    return { ok: false, error: "No valid watches found in that file." };
  }

  const intervalMinutes = [1, 5, 15, 30].includes(data.intervalMinutes) ? data.intervalMinutes : 5;
  const soundId = typeof data.soundId === "string" ? data.soundId : "chime";
  const notificationsMuted = Boolean(data.notificationsMuted);

  await saveSettings({ watches: importedWatches, intervalMinutes, soundId, notificationsMuted });
  // The imported watches are new to this browser's run-state even if they
  // existed before (possibly on another machine) — reset run-state so they
  // establish a fresh baseline instead of either replaying old seenIds
  // that no longer make sense here, or instantly "discovering" every
  // current posting as new.
  await saveRunState({ seenIds: {}, lastChecked: {}, lastResult: {}, badgeCount: 0, feed: [], consecutiveErrors: {}, lastRunAt: null, lastGap: null });
  await updateBadge(0);
  await scheduleAlarm();

  return { ok: true, imported: importedWatches.length, skipped };
}

// ---------- notifications ----------

async function notifyNewJobs(watch, newJobs, soundId) {
  const notifId = `${watch.id}:${Date.now()}`;
  const first = newJobs[0];

  const lineFor = (j) => `• ${j.title}${j.postedRaw ? ` — Posted ${j.postedRaw}` : ""}`;

  const title =
    newJobs.length === 1
      ? first.title
      : `${newJobs.length} new jobs on ${watch.label}`;
  const messageLines =
    newJobs.length === 1
      ? `${watch.label}${first.postedRaw ? ` · Posted ${first.postedRaw}` : ""}`
      : newJobs.slice(0, 3).map(lineFor).join("\n") +
        (newJobs.length > 3 ? `\n…and ${newJobs.length - 3} more` : "");

  notificationJobs.set(notifId, { watchId: watch.id, jobs: newJobs });

  // We play our own synthesized tone (via the offscreen doc) once per check
  // cycle in runAllChecks(), so mark the OS notification itself silent
  // unless the user picked "System default" — otherwise they'd hear both.
  const silent = soundId !== "default";

  await chrome.notifications.create(notifId, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message: messageLines,
    priority: 2,
    requireInteraction: false,
    silent,
  });
}

chrome.notifications.onClicked.addListener(async (notifId) => {
  const entry = notificationJobs.get(notifId);
  if (entry?.jobs?.length) {
    // Open the first new job; if there were several, also open the
    // search page itself so the user can see the rest in context.
    await chrome.tabs.create({ url: entry.jobs[0].url });
  }
  chrome.notifications.clear(notifId);
  notificationJobs.delete(notifId);
});

chrome.notifications.onClosed.addListener((notifId) => {
  notificationJobs.delete(notifId);
});

// ---------- badge ----------

async function updateBadge(count) {
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
}

async function clearBadge() {
  await saveRunState({ badgeCount: 0 });
  await updateBadge(0);
}

// ---------- alarm scheduling ----------

async function scheduleAlarm() {
  const { intervalMinutes } = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  // IMPORTANT: this must be awaited. chrome.alarms.create() is itself
  // async (it round-trips to the browser process to persist the alarm).
  // A service worker is allowed to be torn down the instant it has no
  // more pending work — if this call weren't awaited, scheduleAlarm()
  // could return (and its caller, e.g. the onInstalled handler, could
  // finish) before the alarm actually finished being registered, letting
  // Chrome kill the worker mid-registration. When that race loses, NO
  // periodic alarm ends up persisted at all: chrome.alarms is otherwise
  // very durable (a successfully-created alarm keeps firing forever,
  // independent of watch count or how long checks take), so the only
  // realistic way recurring checks stop dead while "Check now" keeps
  // working is that the alarm was never actually created in the first
  // place. See ensureAlarmScheduled() below for a belt-and-suspenders
  // self-heal in case this — or any other transient cause — ever drops it.
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 0.1,
    periodInMinutes: intervalMinutes,
  });
}

// Self-heals a dropped alarm. Cheap (one chrome.alarms.get call) enough to
// run on every popup open and every manual "Check now", so the extension
// recovers on its own the next time the user touches it, rather than
// silently sitting there until the browser itself restarts.
async function ensureAlarmScheduled() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    console.warn("[job-alert] periodic alarm was missing — re-arming it");
    await scheduleAlarm();
  }
}

// IMPORTANT: this listener must be `async` and must `await runAllChecks()`
// itself, not just fire it off and `.catch()` the result. A plain
// (synchronous) listener that kicks off an un-awaited async chain returns
// `undefined` the instant it's called — and per Chrome's MV3 lifecycle, a
// service worker is free to be torn down the moment its current listener
// invocation returns with nothing telling the runtime to keep it alive.
// runAllChecks() does several real awaits in sequence (reading storage,
// fetching/messaging every watch's tab, then a final storage write) — if
// the worker gets killed partway through that chain, the whole cycle is
// silently truncated before `state.lastRunAt` ever gets persisted. The
// alarm itself is completely unaffected by this (chrome.alarms is
// browser-scheduled, independent of the service worker's lifetime), so it
// keeps firing again right on schedule every interval — which is exactly
// how this bug shows up in the popup: "next check in ~3m" ticking along
// normally while "Checked 4h ago" sits frozen, because every cycle in
// between silently lost the race and never got the chance to save
// anything. Returning the listener's own promise (by making it `async`
// and awaiting the work directly, the same fix already applied to
// scheduleAlarm() below — see its comment) tells the runtime there's
// pending work, keeping the worker alive until the cycle actually finishes
// saving.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  // alarm.scheduledTime is Chrome's own record of when this alarm was
  // meant to fire — comparing it to right now is a much more honest way
  // to detect "this ran late" than trying to track our own expected
  // times, since it accounts for anything that could have delayed it
  // (service worker wake-up time, system load, etc.), not just the
  // browser/computer being off.
  const lateByMs = Math.max(0, Date.now() - alarm.scheduledTime);
  try {
    await runAllChecks({ lateByMs });
  } catch (err) {
    console.error("[job-alert] check failed", err);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const { watches, intervalMinutes, soundId, notificationsMuted } = await getSettings();
  await saveSettings({ watches, intervalMinutes, soundId, notificationsMuted });
  await scheduleAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  // Same reasoning as the onAlarm listener above — return the listener's
  // own promise (via `async` + `await`) rather than firing scheduleAlarm()
  // off unawaited, so the worker isn't eligible for teardown before the
  // (awaited, per its own comment) chrome.alarms.create() call actually
  // finishes.
  try {
    await scheduleAlarm();
  } catch (err) {
    console.error("[job-alert] schedule failed", err);
  }
});

// ---------- messages from popup.js ----------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "get-state": {
        await ensureAlarmScheduled();
        const settings = await getSettings();
        const runState = await getRunState();
        sendResponse({ settings, runState });
        break;
      }
      case "check-now": {
        await ensureAlarmScheduled();
        await runAllChecks();
        const settings = await getSettings();
        const runState = await getRunState();
        sendResponse({ settings, runState });
        break;
      }
      case "add-watch": {
        const settings = await getSettings();
        const site = siteForUrl(message.url);
        // Some sites need their watch URL rewritten before it's usable —
        // e.g. LinkedIn's "single job open" URL shape can't be read
        // reliably, so it gets normalized onto the shape that can be (see
        // normalizeLinkedInUrl in sites.js). Sites without this quirk just
        // pass the URL through unchanged.
        const url = site?.normalizeUrl ? site.normalizeUrl(message.url) : message.url;
        const watch = {
          id: `w_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          siteId: site ? site.id : null,
          url,
          label: message.label || (site ? site.name : message.url),
          enabled: true,
        };
        settings.watches.push(watch);
        await saveSettings({ watches: settings.watches });
        sendResponse({ ok: !!site, error: site ? null : "Unsupported site (only OnlineJobs.ph, Glassdoor, LinkedIn, and Upwork are supported right now)" });
        break;
      }
      case "remove-watch": {
        const settings = await getSettings();
        settings.watches = settings.watches.filter((w) => w.id !== message.id);
        await saveSettings({ watches: settings.watches });
        const state = await getRunState();
        delete state.seenIds[message.id];
        delete state.lastChecked[message.id];
        delete state.lastResult[message.id];
        await saveRunState(state);
        sendResponse({ ok: true });
        break;
      }
      case "toggle-watch": {
        const settings = await getSettings();
        const w = settings.watches.find((x) => x.id === message.id);
        if (w) w.enabled = message.enabled;
        await saveSettings({ watches: settings.watches });
        sendResponse({ ok: true });
        break;
      }
      case "rename-watch": {
        const label = (message.label || "").trim();
        if (!label) {
          sendResponse({ ok: false, error: "Title can't be empty." });
          break;
        }
        const settings = await getSettings();
        const w = settings.watches.find((x) => x.id === message.id);
        if (!w) {
          sendResponse({ ok: false, error: "Watch not found." });
          break;
        }
        w.label = label;
        await saveSettings({ watches: settings.watches });
        sendResponse({ ok: true, label });
        break;
      }
      case "set-interval": {
        await saveSettings({ intervalMinutes: message.minutes });
        await scheduleAlarm();
        sendResponse({ ok: true });
        break;
      }
      case "set-sound": {
        await saveSettings({ soundId: message.soundId });
        sendResponse({ ok: true });
        break;
      }
      case "test-sound": {
        await playAlertSound(message.soundId);
        sendResponse({ ok: true });
        break;
      }
      case "clear-badge": {
        await clearBadge();
        sendResponse({ ok: true });
        break;
      }
      case "clear-feed": {
        await saveRunState({ feed: [] });
        sendResponse({ ok: true });
        break;
      }
      case "mark-visited": {
        const state = await getRunState();
        const entry = state.feed.find((f) => f.id === message.id);
        if (entry) entry.visited = true;
        await saveRunState({ feed: state.feed });
        sendResponse({ ok: true });
        break;
      }
      case "mark-all-visited": {
        const state = await getRunState();
        state.feed.forEach((f) => (f.visited = true));
        await saveRunState({ feed: state.feed });
        sendResponse({ ok: true });
        break;
      }
      case "pause-all": {
        const settings = await getSettings();
        setAllWatchesEnabled(settings.watches, false);
        await saveSettings({ watches: settings.watches });
        sendResponse({ ok: true });
        break;
      }
      case "resume-all": {
        const settings = await getSettings();
        setAllWatchesEnabled(settings.watches, true);
        await saveSettings({ watches: settings.watches });
        sendResponse({ ok: true });
        break;
      }
      case "set-site-enabled": {
        const settings = await getSettings();
        setSiteWatchesEnabled(settings.watches, message.siteId, Boolean(message.enabled));
        await saveSettings({ watches: settings.watches });
        sendResponse({ ok: true });
        break;
      }
      case "set-notifications-muted": {
        await saveSettings({ notificationsMuted: Boolean(message.muted) });
        sendResponse({ ok: true });
        break;
      }
      case "reset-extension": {
        await resetExtension();
        sendResponse({ ok: true });
        break;
      }
      case "import-settings": {
        const result = await importSettings(message.data);
        sendResponse(result);
        break;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message type" });
    }
  })();
  return true; // async sendResponse
});
