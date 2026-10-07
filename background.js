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
//     With a WatchDesk account connected (WD-54), `watches` is the
//     last-synced copy of the account's list and every change to it goes
//     through watch-sync.js — see that file.
//     After each cycle a connected browser also posts what the cycle read
//     to WatchDesk (WD-59) — see listing-ingest.js.
//   chrome.storage.local -> { seenIds: {watchId: [ids]}, lastChecked: {},
//                              lastResult: {}, badgeCount, feed: [...] }
//     (larger / more frequently written run-state, kept local only)
//     Also `watcherState` (WD-71): "paused" while the user has paused
//     watching, and then there is no check alarm — see watcher-state.js.
//   With a WatchDesk account connected (WD-79), intervalMinutes, soundId,
//   notificationsMuted and titleFilter in chrome.storage.sync are the
//   last-synced copy of the account's settings: getSettings() reads them as
//   it always has, and every change to them goes through
//   account-settings.js — see that file.
//   A browser that has just been paired (WD-81) is not working with the
//   account yet: until the user has answered the popup's "Import your
//   existing data" question, everything above is as with no account
//   connected — see local-import.js.

import { SITES, siteForUrl, pickWatchTabFromCandidates } from "./sites.js";
import {
  registerAccountConnection,
  getConnectionState,
  startConnecting,
  showPairingTab,
  cancelConnecting,
  refreshAccount,
} from "./account-connection.js";
import {
  configureWatchSync,
  syncWatches,
  getWatchSyncStatus,
  hasSyncedAccountWatches,
  usesAccountWatches,
  addAccountWatch,
  updateAccountWatch,
  setAccountWatchesEnabled,
  removeAccountWatch,
  importAccountWatches,
} from "./watch-sync.js";
import { ingestCheckedListings, getListingSyncStatus, acknowledgeDroppedListings } from "./listing-ingest.js";
import {
  getWatcherState,
  isWatcherState,
  isWatchingPaused,
  saveWatcherState,
  reflectWatcherState,
  getWatcherSyncStatus,
} from "./watcher-state.js";
import {
  configureAccountSettings,
  usesAccountSettings,
  syncAccountSettings,
  saveAccountSettings,
  getSettingsSyncStatus,
} from "./account-settings.js";
import {
  registerLocalImport,
  prepareImportOffer,
  getImportStatus,
  acceptImport,
  declineImport,
  offerImportAgain,
  dismissImport,
  runImport,
} from "./local-import.js";

const ALARM_NAME = "check-jobs";
const OFFSCREEN_URL = "offscreen.html";

// Map of notificationId -> { watchId, jobs } so we know what to open
// when the user clicks a notification. Lives only in memory; that's fine,
// since notifications don't need to survive a service worker restart.
const notificationJobs = new Map();

// How many feed entries to keep PER PLATFORM, not as one shared total.
// Reported bug: a single high-volume platform (LinkedIn routinely turns up
// far more new postings per cycle than OnlineJobs.ph, Glassdoor, or Upwork
// — "the linkedin gets sometimes around more than 100") could fill up the
// old shared cap entirely, silently pushing every other platform's entries
// out of the feed ("sometimes I can't see any data like for onlinejobs").
// Giving each platform its own reserved slice means no platform can ever
// evict another one's entries, no matter how lopsided the volume gets —
// worst case with today's four site adapters is 4 × 20 = 80 entries kept
// total, which is also less than the old flat 100 ever was.
const FEED_LIMIT_PER_PLATFORM = 20;

// Groups the merged (new + existing) feed entries by platform and keeps
// only the newest FEED_LIMIT_PER_PLATFORM from each group, instead of one
// shared slice(0, N) across the whole array. Entries arrive already
// newest-first within their own platform (new ones are always prepended to
// the existing array before this runs), so a plain slice per group is
// enough — no need to re-sort each group first.
//
// entry.siteId is the authoritative source (set directly from watch.siteId
// when the entry was created); sourceKey (`${siteId}:${jobId}`) is the
// fallback for any entry stored before that field existed, so upgrading
// doesn't lose track of older entries' platform.
function trimFeedPerPlatform(feed) {
  const bySite = new Map();
  for (const entry of feed) {
    const siteId = entry.siteId || entry.sourceKey?.split(":")[0] || "__other__";
    if (!bySite.has(siteId)) bySite.set(siteId, []);
    bySite.get(siteId).push(entry);
  }
  const trimmed = [];
  for (const entries of bySite.values()) {
    trimmed.push(...entries.slice(0, FEED_LIMIT_PER_PLATFORM));
  }
  // Re-sort by detectedAt desc so the stored array stays meaningful on its
  // own merit after reassembling multiple platforms' slices — the popup
  // re-sorts per the user's own chosen sort option at render time anyway,
  // but there's no reason to leave the stored order interleaved oddly.
  trimmed.sort((a, b) => b.detectedAt - a.detectedAt);
  return trimmed;
}

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

// ---------- title relevance filter (Settings-configurable) --------------
//
// Reported bug: LinkedIn's own job search isn't a strict "must contain
// this phrase" match — it's relevance-ranked and pads results with jobs it
// considers loosely related (recommended-for-you, sponsored, or just
// filling out a thin result set for a niche query), which is how titles
// like "Food Safety Manager" or "Learning & Enablement Consultant -
// Podcasts" end up in a feed meant for developer/engineering roles.
// Forcing "Most recent" sort (see normalizeLinkedInUrl in sites.js) makes
// this worse, since date-sorting turns off LinkedIn's own relevance
// ranking entirely.
//
// This is a user-configurable safety net, not a hardcoded "tech jobs"
// filter: a posting's title only reaches the feed if it contains at least
// one of the keywords/phrases the user has listed in Settings. Anyone can
// repoint this at their own field by editing the list — it isn't tied to
// software/dev roles specifically, that's just this user's starting
// default. An empty keyword list means "no filtering" (fail open), so
// clearing the list can never make everything silently disappear.
//
// Which sites this applies to: originally LinkedIn only (see
// TITLE_FILTER_SITE_IDS below) — Glassdoor and Upwork are plain
// keyword-search listings without LinkedIn's "recommended for you"
// padding, so filtering them too would just be unnecessary risk of
// dropping a genuine match. OnlineJobs.ph was added to the scope on
// request, even though it doesn't have LinkedIn's relevance-drift problem
// — a broad OnlineJobs.ph search (e.g. "wordpress") can still turn up
// postings whose title only mentions it in passing, so the same
// title-must-match-a-keyword safety net is still useful there.
const TITLE_FILTER_SITE_IDS = new Set(["linkedin", "onlinejobsph"]);
const DEFAULT_TITLE_FILTER_KEYWORDS = [
  "full stack",
  "full-stack",
  "fullstack",
  "software engineer",
  "software developer",
  "web developer",
  "web development",
  "app developer",
  "application developer",
  "developer",
  "engineer",
  "engineering",
  "frontend",
  "front-end",
  "front end",
  "backend",
  "back-end",
  "back end",
  "ai automation",
  "automation engineer",
  "ai engineer",
  "machine learning",
  "wordpress",
  "elementor",
  "php",
];

// Seeds sensible defaults on first run (no stored value at all), but
// respects a user's explicit empty list — clearing every keyword means
// "stop filtering," not "fall back to the defaults." Array.isArray is what
// tells those two cases apart: an object with no `keywords` field at all
// (never configured) vs. one with `keywords: []` (deliberately cleared).
function normalizeTitleFilter(raw) {
  const enabled = typeof raw?.enabled === "boolean" ? raw.enabled : true;
  const keywords = Array.isArray(raw?.keywords)
    ? raw.keywords.filter((k) => typeof k === "string" && k.trim().length > 0)
    : DEFAULT_TITLE_FILTER_KEYWORDS;
  return { enabled, keywords };
}

// Case-insensitive substring match, OR'd across every configured keyword.
// An empty keyword list always matches everything (fail open) — this is
// the one place that behavior is enforced, so every caller gets it for
// free regardless of how the empty-list state was reached.
function jobTitleMatchesFilter(title, keywords) {
  if (!Array.isArray(keywords) || keywords.length === 0) return true;
  const t = (title || "").toLowerCase();
  return keywords.some((k) => t.includes(String(k).toLowerCase()));
}

// One-time-per-entry self-heal, same pattern as cleanStoredFeedTitle above:
// a watch's stored url was normalized (via its site's normalizeUrl) once,
// at the moment it was added — so a rule added to normalizeUrl AFTER a
// watch already exists (e.g. LinkedIn's sortBy=DD "most recent" fix, added
// to stop old-but-relevant postings from crowding out brand-new ones) never
// reaches that already-saved watch on its own. Re-running normalizeUrl on
// every read and persisting the result when it changes means an existing
// watch picks up new normalization rules the moment this version loads,
// with no need to delete and re-add it.
function migrateWatchUrls(watches) {
  let changed = false;
  const migrated = watches.map((w) => {
    const site = SITES[w.siteId];
    if (!site?.normalizeUrl) return w;
    let normalized;
    try {
      normalized = site.normalizeUrl(w.url);
    } catch {
      return w;
    }
    if (normalized === w.url) return w;
    changed = true;
    return { ...w, url: normalized };
  });
  return { migrated, changed };
}

async function getSettings() {
  const { watches, intervalMinutes, soundId, notificationsMuted, titleFilter } = await chrome.storage.sync.get([
    "watches",
    "intervalMinutes",
    "soundId",
    "notificationsMuted",
    "titleFilter",
  ]);
  // WD-54: an empty list normally means "show the default watch", but once
  // a connected account's list has been synced, empty means the account
  // has no watches.
  const storedWatches =
    watches && watches.length ? watches : (await hasSyncedAccountWatches()) ? [] : [defaultWatch()];
  // WD-111: a connected account's URLs are WatchDesk's, which normalises
  // them when a watch is saved; they are used as stored. Rewriting them here
  // would be a write to the copy behind watch-sync.js's back, undone by the
  // next sync and made again on the next read.
  const { migrated: migratedWatches, changed } = (await usesAccountWatches())
    ? { migrated: storedWatches, changed: false }
    : migrateWatchUrls(storedWatches);
  if (changed) {
    // Fire-and-forget persist — no need to make the caller wait on this.
    chrome.storage.sync.set({ watches: migratedWatches }).catch((err) =>
      console.error("[job-alert] failed to persist migrated watch urls", err)
    );
  }
  return {
    watches: migratedWatches,
    intervalMinutes: intervalMinutes || 5,
    soundId: soundId || "chime",
    // Muting still checks and updates the feed/badge as normal — it only
    // skips the OS notification popup and alert tone, e.g. for quiet hours.
    notificationsMuted: Boolean(notificationsMuted),
    titleFilter: normalizeTitleFilter(titleFilter),
  };
}

async function saveSettings(partial) {
  await chrome.storage.sync.set(partial);
}

// WD-79: what the worker answers a settings change, or a settings sync, of
// a connected browser with: the outcome, the settings as they now stand in
// the copy (what the popup's controls show, and go back to after a refused
// change), and where they live.
async function settingsAnswer(result = {}) {
  const { intervalMinutes, soundId, notificationsMuted, titleFilter } = await getSettings();
  return {
    ...result,
    settings: { intervalMinutes, soundId, notificationsMuted, titleFilter },
    settingsSync: await getSettingsSyncStatus(),
  };
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

// The extension's own installed version (always current, straight from
// manifest.json — never a second place to remember to keep in sync), plus
// a one-time "you just got updated" marker set by onInstalled above when
// Chrome reports this load replaced an older version. justUpdated is
// cleared by the "ack-update" message once the popup has shown it, so it's
// null on every subsequent open until the next actual update.
async function getVersionInfo() {
  const { justUpdated } = await chrome.storage.local.get(["justUpdated"]);
  return {
    current: chrome.runtime.getManifest().version,
    justUpdated: justUpdated || null,
  };
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

// Resolves once tabId finishes loading (status "complete"), or after
// timeoutMs, whichever comes first — never rejects, since a slow/oddly-
// behaving page shouldn't block a check indefinitely; the caller just
// scans whatever's there once this returns.
function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
  });
}

// Reported bug this fixes: LinkedIn (and, by the same architecture,
// Glassdoor/Upwork) checks kept working right after the user manually
// opened/refreshed the tab and hit "Check now," but periodic background
// checks never picked up genuinely new postings on their own — the watch
// just looked permanently stuck. Root cause: content-linkedin.js (and its
// Glassdoor/Upwork siblings) read whatever's CURRENTLY rendered in the
// tab's live DOM — that's the whole point of the content-script approach,
// since these sites can't be fetched fresh in the background. But nothing
// was ever telling that open tab to actually re-fetch its results. A tab
// left sitting on the search page keeps showing the exact same list it
// loaded once and never updates on its own (LinkedIn's client-side app
// doesn't silently re-poll its own results), so every periodic check was
// re-scanning an increasingly stale snapshot — it could never see a
// posting that appeared after the tab was last loaded. Only a manual
// reload (which is effectively what "open the link" does right before
// "check now") ever produced a fresh result.
// Fix: navigate the tab back to the watch's own canonical, saved (already
// site.normalizeUrl-normalized) search url and wait for it to finish
// loading before asking its content script to rescan, so every check —
// scheduled or manual — reads an actually-current page instead of whatever
// was there whenever the tab happened to last load. This runs before EVERY
// scan, not just the first, which also matches this project's own existing
// note elsewhere that a freshly-loaded tab is what keeps these sites from
// flagging the check as bot activity in the first place.
//
// Deliberately navigates to targetUrl rather than just calling
// chrome.tabs.reload(tabId): a plain reload only re-fetches whatever url
// the tab has already drifted onto — which, for LinkedIn, is exactly the
// problem reported after the first version of this fix shipped: a tab left
// open long enough drifts (via LinkedIn's own client-side routing) onto a
// url carrying a stale sort/job-focus state, so reloading it in place kept
// re-reading the same relevance-sorted, weeks-old-postings-included page
// forever. Explicitly navigating back to the watch's canonical url on every
// single check self-heals that drift each time — including picking up
// normalizeLinkedInUrl's sortBy=DD ("most recent") rule for a watch that
// was added before that rule existed (see migrateWatchUrls above for the
// matching storage-side migration).
async function refreshTabBeforeScan(tabId, targetUrl) {
  try {
    if (targetUrl) {
      await chrome.tabs.update(tabId, { url: targetUrl });
    } else {
      await chrome.tabs.reload(tabId);
    }
  } catch {
    // Tab may have closed/navigated away between being found and reloaded
    // — let the subsequent sendMessage below fail on its own and report
    // its own clear "lost the connection" error rather than duplicating
    // that handling here.
    return;
  }
  await waitForTabLoad(tabId);
  // "complete" fires once the page's own resources have loaded, but these
  // sites' actual job list is populated a moment later by client-side JS
  // on top of that — a short fixed buffer is a simple, good-enough way to
  // let that finish without needing to know each site's exact render
  // timing (mirrors how offscreen.js already waits after DOMContentLoaded
  // for OnlineJobs.ph's own client rendering, elsewhere in this project).
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

// Sites whose fetchMode is "content-script" (Glassdoor, LinkedIn, Upwork)
// can't be checked with a background fetch() — either because the page
// needs JS to render (never fully solved here) or, in Glassdoor's and
// Upwork's case, because an anti-bot layer blocks an anonymous background
// request even though the page itself is server-rendered once a real tab
// clears it. Instead we ping an actual open tab on that site and ask its
// content script (content-glassdoor.js, content-linkedin.js, or
// content-upwork.js, injected there via manifest content_scripts) to read
// whatever is currently in its DOM — after first reloading that tab (see
// refreshTabBeforeScan above) so "currently in its DOM" actually means
// something current, not just whatever was there from whenever the tab
// happened to last load.
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

  // Navigate the tab back to this watch's own canonical, saved search url
  // and wait for it to finish loading before scanning its DOM — see
  // refreshTabBeforeScan's own comment for why this (rather than a plain
  // in-place reload) is what's required for real-time detection on
  // content-script sites. Best-effort: if the navigation itself fails
  // (e.g. the tab was closed a moment ago), fall through to sendMessage
  // anyway, which will surface its own clear "lost the connection" error
  // below rather than silently swallowing it.
  await refreshTabBeforeScan(tab.id, watch.url);

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
async function checkWatch(watch, { isFirstRun, previousIds, titleFilter }) {
  let jobs = await fetchJobs(watch);

  // See TITLE_FILTER_SITE_IDS above for which sites this applies to and why.
  if (TITLE_FILTER_SITE_IDS.has(watch.siteId) && titleFilter?.enabled) {
    jobs = jobs.filter((j) => jobTitleMatchesFilter(j.title, titleFilter.keywords));
  }

  const currentIds = jobs.map((j) => j.id);

  // Establish a baseline on the very first check for this watch so we
  // don't blast the user with notifications for jobs that were already
  // posted before they set this up.
  const newJobs = isFirstRun ? [] : jobs.filter((j) => !previousIds.has(j.id));

  return {
    // WD-59: everything this check read off the page (after the title
    // filter), new or not — what a connected browser sends to WatchDesk.
    jobs,
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
  const { watches, soundId, notificationsMuted, titleFilter } = await getSettings();
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
          const { jobs, newJobs, currentIds, result } = await checkWatch(watch, { isFirstRun, previousIds, titleFilter });
          return { watch, jobs, newJobs, currentIds, result, error: null };
        } catch (err) {
          return {
            watch,
            jobs: null,
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

  // Cross-watch dedup: the exact same real-world posting can legitimately
  // match more than one of the user's own watches — e.g. a "Job Automation
  // Specialist" watch and a separate "Software Engineer" watch both
  // matching one actual posting titled "Software Engineer - Automation."
  // Each watch's own seenIds tracking (above) has no idea the OTHER watch
  // already surfaced this same job, so without this step it would show up
  // as two separate "new" feed entries/notifications for what is, to the
  // user, one single listing from one hirer.
  //
  // sourceKey (the site + that site's own stable per-posting id, e.g.
  // LinkedIn's numeric /jobs/view/<id>, Glassdoor's jl= id) — NOT watch.id
  // — is what identifies "the same job" here, since two different watches
  // finding the identical posting is exactly the case being collapsed.
  // Crucially, this only merges genuine repeats: two DIFFERENT companies
  // both posting a job titled "Software Engineer" get two different
  // sourceKeys (each site assigns its own id per posting, per hirer), so
  // they correctly stay as separate entries — "5 different companies
  // hiring for the same title" is never treated as a duplicate.
  //
  // existingSourceKeys also checks the already-persisted feed (not just
  // this cycle), so a job one watch surfaced in an earlier check doesn't
  // get re-added a second time later just because a different watch's
  // search only started matching it afterward.
  const existingSourceKeys = new Set(state.feed.map((e) => e.sourceKey).filter(Boolean));
  const claimedThisCycle = new Set();
  const withNewJobs = [];
  for (const r of results) {
    if (r.newJobs.length === 0) continue;
    const dedupedJobs = r.newJobs.filter((j) => {
      const sourceKey = `${r.watch.siteId}:${j.id}`;
      if (existingSourceKeys.has(sourceKey) || claimedThisCycle.has(sourceKey)) return false;
      claimedThisCycle.add(sourceKey);
      return true;
    });
    if (dedupedJobs.length > 0) withNewJobs.push({ ...r, newJobs: dedupedJobs });
  }
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
        // The site + that site's own stable per-posting id — see the big
        // comment above existingSourceKeys for why this (not watch.id) is
        // what identifies "the same job" across different watches, both
        // within one check cycle and across every future one.
        sourceKey: `${watch.siteId}:${j.id}`,
        // Stored directly (not re-derived from the URL later) so the
        // per-platform feed cap below has an authoritative, always-correct
        // answer to "which platform is this" even if a URL ever turned out
        // to be ambiguous.
        siteId: watch.siteId,
        watchId: watch.id,
        watchLabel: watch.label,
        title: j.title,
        url: j.url,
        postedRaw: j.postedRaw || null,
        postedAt: j.postedAt || null,
        postedApprox: j.postedApprox || false,
        salaryRaw: j.salaryRaw || null,
        // Only ever set true by LinkedIn's adapter — every other site's
        // extractJobs() simply never includes this field, so `|| false`
        // here also naturally covers "not LinkedIn," not just "LinkedIn
        // but not Easy Apply."
        easyApply: Boolean(j.easyApply),
        // Only ever set (to "Remote"/"Hybrid"/"On-site") by LinkedIn's and
        // Glassdoor's adapters — OnlineJobs.ph's and Upwork's extractJobs()
        // never include this field, so `|| null` here also naturally
        // covers those two sites.
        workplaceType: j.workplaceType || null,
        detectedAt: now,
        visited: false,
        // "Applied" is a separate, user-driven flag from "visited" — visited
        // just means the title was clicked/opened; applied means the user
        // told the popup they actually submitted an application for this
        // one (see the "toggle-applied" message handler below). Kept right
        // on the feed entry (storage.local, not exported/imported settings)
        // for the same reason "visited" already is: it's per-device run
        // state, not something you'd want silently overwritten by an
        // Import.
        applied: false,
        appliedAt: null,
      }))
    );

    const totalNew = newFeedEntries.length;
    state.feed = trimFeedPerPlatform([...newFeedEntries, ...state.feed]);
    state.badgeCount = (state.badgeCount || 0) + totalNew;
  }

  await saveRunState(state);
  if (withNewJobs.length > 0) {
    await updateBadge(state.badgeCount);
    if (!notificationsMuted) {
      await playAlertSound(soundId); // one alert tone per check cycle, not per watch
    }
  }

  // WD-59: what each watch that was read this cycle had on its page. The
  // callers hand it to sendCheckedListings() once everything above is done;
  // a watch whose check failed read nothing and is left out.
  return results.filter((r) => r.jobs).map((r) => ({ watchId: r.watch.id, jobs: r.jobs }));
}

// WD-59: sends a finished check cycle's listings to the connected WatchDesk
// account (listing-ingest.js), then tells an open popup so its "last synced"
// line is current. Always called after runAllChecks() has saved its state
// and raised its notifications, badge and sound, so it cannot delay or fail
// a check; it never throws. With no account connected it sends nothing.
async function sendCheckedListings(checked) {
  const outcome = await ingestCheckedListings(checked);
  if (outcome.status !== "ok" && outcome.status !== "failed") return;
  try {
    await chrome.runtime.sendMessage({ type: "watch-sync-changed", watchSync: await getSyncStatus() });
  } catch {
    // No popup open.
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
  // WD-54: with an account connected the watches are the account's, not
  // this browser's, so a reset leaves them alone (it does not delete them
  // on WatchDesk, and the next sync would bring them back anyway).
  // WD-79: the same goes for the account's settings: a reset of this
  // browser does not put them back to the defaults for the web app and
  // every other browser, and the copy of them here is left as it is.
  const keepWatches = await usesAccountWatches();
  const keepSettings = await usesAccountSettings();
  const defaults = {
    ...(keepWatches ? {} : { watches: [defaultWatch()] }),
    ...(keepSettings
      ? {}
      : { intervalMinutes: 5, soundId: "chime", notificationsMuted: false, titleFilter: normalizeTitleFilter(null) }),
  };
  if (Object.keys(defaults).length > 0) await saveSettings(defaults);
  await saveRunState({ seenIds: {}, lastChecked: {}, lastResult: {}, badgeCount: 0, feed: [], consecutiveErrors: {}, lastRunAt: null, lastGap: null });
  await updateBadge(0);
  // WD-71: running is the default, like everything else a reset puts back.
  await saveWatcherState("running");
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

  // WD-54, WD-111: with an account connected the file's watches are added
  // to it, and that comes first. Each one is matched to the account's by URL
  // or uploaded, and the account's other watches stay in the list. If
  // WatchDesk cannot say what the account has, nothing is imported: not the
  // watches, which would be shown as the list without being saved, and not
  // the settings or the fresh run state either, so the file can simply be
  // imported again later.
  const accountWatches = await usesAccountWatches();
  if (accountWatches) {
    const added = await importAccountWatches(importedWatches);
    if (!added.ok) {
      // The sync line now says why (offline), if a popup is open.
      try {
        await chrome.runtime.sendMessage({ type: "watch-sync-changed", watchSync: await getSyncStatus() });
      } catch {
        // No popup open.
      }
      return added;
    }
  }

  const intervalMinutes = [1, 5, 15, 30].includes(data.intervalMinutes) ? data.intervalMinutes : 5;
  const soundId = typeof data.soundId === "string" ? data.soundId : "chime";
  const notificationsMuted = Boolean(data.notificationsMuted);

  const settingsToSave = { ...(accountWatches ? {} : { watches: importedWatches }), intervalMinutes, soundId, notificationsMuted };
  // Only touch the title filter if the imported file actually has one — an
  // older backup (from before this feature existed) shouldn't silently wipe
  // out a filter the user has since configured.
  if (data.titleFilter) {
    settingsToSave.titleFilter = normalizeTitleFilter(data.titleFilter);
  }
  // WD-79: with an account connected the file's settings are the account's
  // to take, like any other change to them. The watches are in by now, so a
  // refusal here is reported beside them rather than undoing the import.
  let settingsError = null;
  if (await usesAccountSettings()) {
    const saved = await saveAccountSettings(settingsToSave);
    if (!saved.ok) settingsError = saved.error;
  } else {
    await saveSettings(settingsToSave);
  }
  // The imported watches are new to this browser's run-state even if they
  // existed before (possibly on another machine) — reset run-state so they
  // establish a fresh baseline instead of either replaying old seenIds
  // that no longer make sense here, or instantly "discovering" every
  // current posting as new.
  await saveRunState({ seenIds: {}, lastChecked: {}, lastResult: {}, badgeCount: 0, feed: [], consecutiveErrors: {}, lastRunAt: null, lastGap: null });
  await updateBadge(0);
  await scheduleAlarm();

  return { ok: true, imported: importedWatches.length, skipped, ...(settingsError ? { settingsError } : {}) };
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

// `firstCheckInMinutes` is when the first check comes: a few seconds later,
// unless a caller that is itself part of a check says otherwise.
async function scheduleAlarm({ firstCheckInMinutes = 0.1 } = {}) {
  const { intervalMinutes } = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);
  // WD-71: while the user has paused watching there is no alarm. Every
  // path that creates it comes through here (install, update, browser
  // start, a changed interval, reset, import, the self-heal below), so
  // none of them can start the checks again behind a pause.
  if (await isWatchingPaused()) return;
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
    delayInMinutes: firstCheckInMinutes,
    periodInMinutes: intervalMinutes,
  });
}

// WD-79: the copy of a connected account's settings has just been written
// with different values. If the interval is one of them (changed on the
// web, or on another browser), the alarm is re-armed on it. The first check
// then comes a whole interval later, not a few seconds later: this runs
// during a sync, which is often the start of a check, and a second check
// must not start on top of that one. Paused, there is no alarm and none is
// made.
async function followSyncedInterval() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) return;
  const { intervalMinutes } = await getSettings();
  if (existing.periodInMinutes !== intervalMinutes) await scheduleAlarm({ firstCheckInMinutes: intervalMinutes });
}

// Self-heals a dropped alarm. Cheap (one chrome.alarms.get call) enough to
// run on every popup open and every manual "Check now", so the extension
// recovers on its own the next time the user touches it, rather than
// silently sitting there until the browser itself restarts.
async function ensureAlarmScheduled() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  // WD-71: paused, a missing alarm is how it should be — and one that is
  // still there (a worker stopped between saving the pause and clearing the
  // alarm) is cleared rather than left to fire.
  if (await isWatchingPaused()) {
    if (existing) await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  if (!existing) {
    console.warn("[job-alert] periodic alarm was missing — re-arming it");
    await scheduleAlarm();
  }
}

// WD-71: Pause Watching / Start Watching. The state is saved first, so a
// worker stopped right after still knows it; scheduleAlarm() then clears
// the alarm and, unless paused, creates it again on the user's interval
// (first check a few seconds later, as after any other re-arm). Asking for
// the state it is already in changes nothing, so a second click does not
// restart the countdown.
async function setWatcherState(state) {
  if ((await getWatcherState()) === state) {
    await ensureAlarmScheduled();
    return;
  }
  await saveWatcherState(state);
  await scheduleAlarm();
}

// WD-71: tells the connected WatchDesk account whether watching is running
// or paused (watcher-state.js), then tells an open popup if its sync line
// has something new to say. Always called after the alarm has been dealt
// with and the popup answered, so it cannot delay or undo a pause or a
// start; it never throws. With no account connected it sends nothing.
async function sendWatcherState() {
  try {
    if (!(await reflectWatcherState())) return;
    await chrome.runtime.sendMessage({ type: "watch-sync-changed", watchSync: await getSyncStatus() });
  } catch {
    // No popup open.
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
  // WD-71: a tick that was already on its way when the user paused checks
  // nothing, and takes the alarm with it.
  if (await isWatchingPaused()) {
    await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  // alarm.scheduledTime is Chrome's own record of when this alarm was
  // meant to fire — comparing it to right now is a much more honest way
  // to detect "this ran late" than trying to track our own expected
  // times, since it accounts for anything that could have delayed it
  // (service worker wake-up time, system load, etc.), not just the
  // browser/computer being off.
  const lateByMs = Math.max(0, Date.now() - alarm.scheduledTime);
  // WD-44: confirm the WatchDesk connection on the same schedule, so a
  // revoked device is noticed without opening the popup. Started alongside
  // the job checks, never ahead of them, and it cannot throw into them; it
  // is awaited only at the end, to keep the worker alive until it is done.
  // With no account connected it sends nothing.
  const accountCheck = refreshAccount().catch(() => {});
  // WD-81: a browser paired since the last tick is settled first: asked
  // about its own data (and then checked on its own list, below, with
  // nothing synced), or found to have nothing to ask about.
  await prepareImportOffer();
  // WD-54: bring the watch list in step with the connected account before
  // checking, so a watch added, paused or deleted on WatchDesk takes
  // effect on this very check. One request with a 10 s timeout, never a
  // retry loop, and it cannot throw; when WatchDesk is unreachable the
  // check runs on the last-synced list. With no account connected it sends
  // nothing.
  // WD-79: and the settings, the same way and at the same time, so the two
  // requests cost the check one wait and not two: an interval, a sound, mute
  // or a keyword changed on WatchDesk applies to this check.
  await Promise.all([syncWatches().catch(() => {}), syncAccountSettings().catch(() => {})]);
  let checked = [];
  try {
    checked = await runAllChecks({ lateByMs });
  } catch (err) {
    console.error("[job-alert] check failed", err);
  }
  // WD-59: the check is over and saved; now send what it read to WatchDesk.
  // Awaited, so the worker stays alive until the requests are done.
  await sendCheckedListings(checked);
  // WD-71: and, if WatchDesk has not got it yet, whether watching is
  // running or paused.
  await sendWatcherState();
  await accountCheck;
  // WD-81: the account may have been named just now, which settles a browser
  // that was waiting for it; and an import that was stopped is carried on,
  // if its wait is over.
  await prepareImportOffer();
  await runImport();
});

chrome.runtime.onInstalled.addListener(async (details) => {
  // WD-111: this used to read the settings and write them straight back,
  // which stored the defaults on a fresh install. Anything written to
  // chrome.storage.sync between that read and that write (the user's first
  // change, Chrome sync delivering another computer's settings, a connected
  // account's watch list) was overwritten with what had been read. Nothing
  // needs the defaults stored: getSettings() supplies them on every read.
  await scheduleAlarm();

  // Chrome's own reliable signal that this load is a reload of an EXISTING
  // install onto a different manifest version — not the popup guessing by
  // comparing version strings itself (which it can't do on its own anyway,
  // since it only ever sees "whatever's running right now"). Recorded here
  // so the popup can show a one-time "Updated to vX.Y.Z" banner the next
  // time it's opened, directly answering "how do I know it actually
  // updated" without the user having to dig into Settings and remember
  // what the old version number was. See the "ack-update" message handler
  // below for how this gets cleared so it only shows once.
  if (details.reason === "update") {
    await chrome.storage.local.set({
      justUpdated: {
        toVersion: chrome.runtime.getManifest().version,
        fromVersion: details.previousVersion || null,
      },
    });
  }
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
  // WD-71: a paused browser has no alarm tick to do this on, so a state
  // WatchDesk has not got yet is sent again here.
  await sendWatcherState();
  // WD-81: likewise an import that was under way when the browser closed.
  await prepareImportOffer();
  await runImport();
});

// WatchDesk account connection (WD-42): its own tab and alarm listeners,
// and it resumes a pairing that was in progress when the worker stopped.
// Must run at the top level, like the listeners above.
registerAccountConnection();

// Watch sync (WD-54): a browser that never stored a list is showing the
// default watch, so that is what its first sync has to account for.
configureWatchSync({ unsyncedFallback: () => [defaultWatch()] });

// Settings sync (WD-79): the check alarm follows an interval that changed
// on WatchDesk.
configureAccountSettings({ onCopyChanged: followSyncedInterval });

// Import of this browser's own data (WD-81): its alarm listener, and it
// carries on an import that was under way when the worker stopped. Must run
// at the top level, like the listeners above.
registerLocalImport();

// How this browser stands against the connected account: the watch list
// (WD-54), with it when listings last reached WatchDesk (WD-59), and the
// watcher state WatchDesk could not be given, if any (WD-71).
// { mode: "local" } with no account connected.
async function getSyncStatus() {
  const watchSync = await getWatchSyncStatus();
  if (watchSync.mode !== "account") return watchSync;
  return { ...watchSync, listings: await getListingSyncStatus(), watcherUnsent: await getWatcherSyncStatus() };
}

// What the popup renders: settings, run state, version, whether watching
// is running or paused (WD-71), (WD-54, WD-59) how the watch list and the
// listings stand against the connected account, and (WD-79) whether the
// settings are this browser's own or the account's, and (WD-81) where the
// import of this browser's own data stands: null when there is nothing to
// say about it.
async function getPopupState() {
  const settings = await getSettings();
  const runState = await getRunState();
  const version = await getVersionInfo();
  const watcher = { state: await getWatcherState() };
  const watchSync = await getSyncStatus();
  const settingsSync = await getSettingsSyncStatus();
  const localImport = await getImportStatus();
  return { settings, runState, version, watcher, watchSync, settingsSync, localImport };
}

// ---------- messages from popup.js ----------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "get-state": {
        await ensureAlarmScheduled();
        // WD-81: a browser paired since the popup was last open is settled
        // here, so the popup that opens shows the question (or none).
        await prepareImportOffer();
        sendResponse(await getPopupState());
        break;
      }
      case "check-now": {
        await ensureAlarmScheduled();
        await prepareImportOffer();
        // WD-54: same as the alarm — check the account's current list,
        // with (WD-79) its current settings.
        await Promise.all([syncWatches().catch(() => {}), syncAccountSettings().catch(() => {})]);
        const checked = await runAllChecks();
        sendResponse(await getPopupState());
        // WD-59: after the answer, so the popup is not kept on "Checking…"
        // while the listings go to WatchDesk; it hears "watch-sync-changed"
        // when they have.
        await sendCheckedListings(checked);
        await sendWatcherState();
        break;
      }
      case "sync-watches": {
        // WD-54: the popup asks for this when it opens, then re-reads the
        // state. Answers { mode: "local" } and sends nothing when no
        // account is connected, and (WD-81) while the import question is
        // unanswered.
        await prepareImportOffer();
        sendResponse(await syncWatches());
        // WD-71: after the answer, a watcher state WatchDesk has not got
        // yet is sent again.
        await sendWatcherState();
        break;
      }
      case "sync-settings": {
        // WD-79: the popup asks for this when it opens and when its settings
        // panel is opened: one GET of the account's settings into the copy,
        // answered with the settings as they then stand. Sends nothing, and
        // answers with this browser's own settings, when no account is
        // connected, and (WD-81) while the import question is unanswered.
        await prepareImportOffer();
        await syncAccountSettings();
        sendResponse(await settingsAnswer());
        break;
      }
      // Import of this browser's own data (WD-81; local-import.js). An
      // answer to the question changes whose the watch list and the settings
      // are, so each is answered with the whole popup state, which also
      // holds where the import stands.
      case "local-import-accept": {
        // Answered once the import has been recorded, not once it is done:
        // the popup shows its progress from "local-import-changed".
        await acceptImport();
        sendResponse(await getPopupState());
        await runImport({ force: true });
        break;
      }
      case "local-import-decline": {
        await declineImport();
        sendResponse(await getPopupState());
        break;
      }
      case "local-import-retry": {
        sendResponse(await getPopupState());
        await runImport({ force: true });
        break;
      }
      case "local-import-again": {
        await offerImportAgain();
        sendResponse(await getPopupState());
        break;
      }
      case "local-import-dismiss": {
        await dismissImport();
        sendResponse(await getPopupState());
        break;
      }
      case "set-watcher-state": {
        // WD-71: Pause Watching / Start Watching. The alarm is dealt with
        // and the popup answered before WatchDesk is told, so an
        // unreachable WatchDesk never holds the click up.
        if (!isWatcherState(message.state)) {
          sendResponse({ ok: false, error: "Unknown watcher state" });
          break;
        }
        await setWatcherState(message.state);
        sendResponse(await getPopupState());
        await sendWatcherState();
        break;
      }
      case "listing-drops-seen": {
        // WD-60: the popup has shown how many queued listings were dropped.
        // Answered first: this waits its turn behind a cycle that is
        // sending.
        sendResponse({ ok: true });
        await acknowledgeDroppedListings();
        break;
      }
      case "ack-update": {
        // Popup calls this right after showing the one-time "Updated to
        // vX.Y.Z" banner, so it doesn't show again on every subsequent open
        // until the NEXT actual version bump re-sets justUpdated via
        // onInstalled above.
        await chrome.storage.local.remove("justUpdated");
        sendResponse({ ok: true });
        break;
      }
      // The watch cases below (WD-54): with a WatchDesk account connected,
      // the change is a call to WatchDesk (watch-sync.js) and can be
      // refused — { ok: false, error } — for example while offline. With
      // none connected they are exactly what they were.
      case "add-watch": {
        if (await usesAccountWatches()) {
          sendResponse(await addAccountWatch({ url: message.url, label: message.label }));
          break;
        }
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
        if (await usesAccountWatches()) {
          const result = await removeAccountWatch(message.id);
          if (!result.ok) {
            sendResponse(result);
            break;
          }
        } else {
          const settings = await getSettings();
          settings.watches = settings.watches.filter((w) => w.id !== message.id);
          await saveSettings({ watches: settings.watches });
        }
        const state = await getRunState();
        delete state.seenIds[message.id];
        delete state.lastChecked[message.id];
        delete state.lastResult[message.id];
        await saveRunState(state);
        sendResponse({ ok: true });
        break;
      }
      case "toggle-watch": {
        if (await usesAccountWatches()) {
          sendResponse(await updateAccountWatch(message.id, { enabled: Boolean(message.enabled) }));
          break;
        }
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
        if (await usesAccountWatches()) {
          const result = await updateAccountWatch(message.id, { label });
          sendResponse(result.ok ? { ok: true, label } : result);
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
      // The settings cases below (WD-79): with a WatchDesk account
      // connected, the change is saved in the account first
      // (account-settings.js) and can be refused — { ok: false, error } —
      // for example while offline; either way the answer carries the
      // settings as they now stand. With none connected they are exactly
      // what they were.
      case "set-interval": {
        if (await usesAccountSettings()) {
          const result = await saveAccountSettings({ intervalMinutes: message.minutes });
          // As when not connected: the first check on a newly chosen
          // interval comes a few seconds later.
          if (result.ok) await scheduleAlarm();
          sendResponse(await settingsAnswer(result));
          break;
        }
        await saveSettings({ intervalMinutes: message.minutes });
        await scheduleAlarm();
        sendResponse({ ok: true });
        break;
      }
      case "set-sound": {
        if (await usesAccountSettings()) {
          sendResponse(await settingsAnswer(await saveAccountSettings({ soundId: message.soundId })));
          break;
        }
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
      case "toggle-applied": {
        // A toggle rather than separate mark/unmark messages, so a misclick
        // is a single click to undo — same request either way, popup.js
        // just reads the flipped state back off the response.
        const state = await getRunState();
        const entry = state.feed.find((f) => f.id === message.id);
        if (!entry) {
          sendResponse({ ok: false, error: "Feed entry not found." });
          break;
        }
        entry.applied = !entry.applied;
        entry.appliedAt = entry.applied ? Date.now() : null;
        await saveRunState({ feed: state.feed });
        sendResponse({ ok: true, applied: entry.applied, appliedAt: entry.appliedAt });
        break;
      }
      case "pause-all": {
        if (await usesAccountWatches()) {
          sendResponse(await setAccountWatchesEnabled(false));
          break;
        }
        const settings = await getSettings();
        setAllWatchesEnabled(settings.watches, false);
        await saveSettings({ watches: settings.watches });
        sendResponse({ ok: true });
        break;
      }
      case "resume-all": {
        if (await usesAccountWatches()) {
          sendResponse(await setAccountWatchesEnabled(true));
          break;
        }
        const settings = await getSettings();
        setAllWatchesEnabled(settings.watches, true);
        await saveSettings({ watches: settings.watches });
        sendResponse({ ok: true });
        break;
      }
      case "set-site-enabled": {
        if (await usesAccountWatches()) {
          sendResponse(await setAccountWatchesEnabled(Boolean(message.enabled), message.siteId));
          break;
        }
        const settings = await getSettings();
        setSiteWatchesEnabled(settings.watches, message.siteId, Boolean(message.enabled));
        await saveSettings({ watches: settings.watches });
        sendResponse({ ok: true });
        break;
      }
      case "set-notifications-muted": {
        if (await usesAccountSettings()) {
          const result = await saveAccountSettings({ notificationsMuted: Boolean(message.muted) });
          sendResponse(await settingsAnswer(result));
          break;
        }
        await saveSettings({ notificationsMuted: Boolean(message.muted) });
        sendResponse({ ok: true });
        break;
      }
      case "update-title-filter": {
        // popup.js sends the whole replacement {enabled, keywords} object
        // (it keeps its own working copy for add/remove/toggle) rather
        // than piecemeal add/remove messages — one code path here,
        // normalized the same way getSettings()/importSettings() already
        // normalize it.
        const titleFilter = normalizeTitleFilter(message.titleFilter);
        if (await usesAccountSettings()) {
          // WatchDesk trims the keywords and drops repeats; the filter
          // answered is the one it kept, or after a refusal the one it has.
          const answer = await settingsAnswer(await saveAccountSettings({ titleFilter }));
          sendResponse({ ...answer, titleFilter: answer.settings.titleFilter });
          break;
        }
        await saveSettings({ titleFilter });
        sendResponse({ ok: true, titleFilter });
        break;
      }
      case "reset-extension": {
        await resetExtension();
        sendResponse({ ok: true });
        // WD-71: a reset starts watching again; WatchDesk is told.
        await sendWatcherState();
        break;
      }
      case "import-settings": {
        const result = await importSettings(message.data);
        sendResponse(result);
        break;
      }
      // WatchDesk account (WD-42). Each answers with the connection state
      // from account-connection.js, which never includes the token.
      case "account-get-state": {
        sendResponse(await getConnectionState());
        break;
      }
      case "account-refresh": {
        const state = await refreshAccount();
        // WD-81: WatchDesk may just have said whose the token is, which is
        // what the import question was waiting for.
        await prepareImportOffer();
        sendResponse(state);
        break;
      }
      case "account-connect": {
        sendResponse(await startConnecting());
        break;
      }
      case "account-show-tab": {
        sendResponse(await showPairingTab());
        break;
      }
      case "account-cancel": {
        sendResponse(await cancelConnecting());
        break;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message type" });
    }
  })();
  return true; // async sendResponse
});
