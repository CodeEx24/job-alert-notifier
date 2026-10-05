// listing-ingest.js — sends what a check cycle read to the connected
// WatchDesk account (WD-59). Runs in the service worker; background.js calls
// it once a cycle is over.
//
// The job check itself is untouched and comes first: fetching, diffing, the
// local feed, notifications, the badge and the sound are all done and saved
// before anything here runs. So this can be slow, or fail, without a check
// being late or lost. With no account connected it sends nothing at all.
//
// What is sent: for each watch read this cycle, every posting on its page
// (not only the new ones — WatchDesk keeps one row per posting however often
// it is sent, and says which were new), in requests of at most
// INGEST_MAX_LISTINGS, one watch per request, one request at a time.
//
// A watch is named by its id on WatchDesk and by nothing else. A watch this
// browser has not uploaded yet, or that WatchDesk refused (watch-sync.js),
// has only a local id: it is left out this cycle and joins in once a sync has
// given it a server id.
//
// When a request fails:
//   401          the token is gone (authorizedRequest() discarded it); stop.
//   404          the watch was deleted on WatchDesk since the last sync; its
//                listings are dropped and the next sync removes the watch.
//   400          WatchDesk refused the batch; sending it again would be
//                refused again, so it is dropped.
//   anything else (unreachable, rate limited, a 5xx — after the retries of
//                RETRY_POLICY): WatchDesk is not taking listings right now.
//                The rest of the cycle's batches are not attempted.
// In this ticket a batch that was not stored is recorded as a failure for
// the popup and dropped; the next cycle sends the page as it is then. WD-60
// adds the queue that retries them — see "WD-60" below for where it plugs in.
//
// Storage:
//   chrome.storage.local -> watchdeskListingSync { lastIngestedAt, failed }
//     lastIngestedAt  epoch ms of the last cycle whose listings all reached
//                     WatchDesk, or null.
//     failed          the last cycle that had something to send could not
//                     send all of it.
//   Nothing is kept in memory between cycles: the worker may be stopped at
//   any point. account-connection.js removes the key whenever a token is
//   stored or dropped.
//
// Nothing here sees the device token, and nothing here logs: a listing's
// title and URL say what the user is searching for.

import { isConnected, LISTING_SYNC_KEY } from "./account-connection.js";
import { getServerWatchIds } from "./watch-sync.js";
import { ingestListings, INGEST_MAX_LISTINGS } from "./watchdesk-api.js";

// WatchDesk's limits (lib/validation/listings.ts in its repository). One
// listing over a limit refuses the whole batch, so a listing that cannot
// pass is fitted or left out here instead.
const JOB_ID_MAX_LENGTH = 200;
const TITLE_MAX_LENGTH = 500;
const URL_MAX_LENGTH = 2048;
const POSTED_RAW_MAX_LENGTH = 100;
const SALARY_RAW_MAX_LENGTH = 200;
const WORKPLACE_TYPES = ["Remote", "Hybrid", "On-site"];

// A text field, trimmed; null when it is missing, empty or too long. For an
// optional field null is "the page did not show it".
function textOrNull(value, maxLength) {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  return text && text.length <= maxLength ? text : null;
}

function isWebUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Every adapter writes postedAt with toISOString(); anything else that is
// still a date is rewritten that way, and anything that is not is left out.
function isoDate(value) {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

// One posting as an adapter returned it → the listing WD-57's schema names,
// field for field, or null when WatchDesk could not store it (no id, no
// title, or a URL that is not a web address). Nothing else is added: whose
// it is and which site it is on come from the watch, and WatchDesk sets the
// detection time itself.
export function toListing(job) {
  const id = textOrNull(job?.id, JOB_ID_MAX_LENGTH);
  const title = textOrNull(job?.title, TITLE_MAX_LENGTH);
  const url = textOrNull(job?.url, URL_MAX_LENGTH);
  if (!id || !title || !url || !isWebUrl(url)) return null;
  return {
    id,
    title,
    url,
    postedRaw: textOrNull(job.postedRaw, POSTED_RAW_MAX_LENGTH),
    postedAt: isoDate(job.postedAt),
    postedApprox: job.postedApprox === true,
    salaryRaw: textOrNull(job.salaryRaw, SALARY_RAW_MAX_LENGTH),
    easyApply: job.easyApply === true,
    workplaceType: WORKPLACE_TYPES.includes(job.workplaceType) ? job.workplaceType : null,
  };
}

// ---------- storage ----------

async function readState() {
  const { [LISTING_SYNC_KEY]: state } = await chrome.storage.local.get(LISTING_SYNC_KEY);
  return {
    lastIngestedAt: typeof state?.lastIngestedAt === "number" ? state.lastIngestedAt : null,
    failed: Boolean(state?.failed),
  };
}

// Not written once the token is gone: the state belongs to a connection.
async function recordCycle(allStored) {
  if (!(await isConnected())) return;
  const state = await readState();
  await chrome.storage.local.set({
    [LISTING_SYNC_KEY]: { lastIngestedAt: allStored ? Date.now() : state.lastIngestedAt, failed: !allStored },
  });
}

// What the popup shows about listings, beside the watch list's own status:
// { lastIngestedAt, failed }. No token, no listing.
export function getListingSyncStatus() {
  return readState();
}

// ---------- one cycle ----------

// The requests a cycle makes: one watch each, at most INGEST_MAX_LISTINGS
// listings each, in the order the watches were checked.
function toBatches(checked, serverIds) {
  const batches = [];
  for (const entry of Array.isArray(checked) ? checked : []) {
    if (!serverIds.has(entry?.watchId) || !Array.isArray(entry.jobs)) continue;
    const listings = entry.jobs.map(toListing).filter(Boolean);
    for (let start = 0; start < listings.length; start += INGEST_MAX_LISTINGS) {
      batches.push({ watchId: entry.watchId, listings: listings.slice(start, start + INGEST_MAX_LISTINGS) });
    }
  }
  return batches;
}

async function runCycle(checked) {
  if (!(await isConnected())) return { status: "not-connected", sent: 0, unsent: 0 };

  const batches = toBatches(checked, new Set(await getServerWatchIds()));
  if (batches.length === 0) return { status: "nothing-to-send", sent: 0, unsent: 0 };

  const deleted = new Set(); // watches WatchDesk no longer has
  let sent = 0;
  let refused = 0;
  let unsent = []; // batches WatchDesk may still take later
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    if (deleted.has(batch.watchId)) continue;
    const result = await ingestListings(batch.watchId, batch.listings);
    if (result.kind === "ok") sent += 1;
    else if (result.kind === "unauthorized") return { status: "not-connected", sent, unsent: 0 };
    else if (result.kind === "not-found") deleted.add(batch.watchId);
    else if (result.kind === "invalid") refused += 1;
    else {
      unsent = batches.slice(index).filter((left) => !deleted.has(left.watchId));
      break;
    }
  }

  // WD-60: `unsent` is what its queue takes — the batches that failed for a
  // reason that may pass (and the ones not attempted after that), each
  // { watchId, listings } and ready to send as it is. Until then they are
  // dropped here. A refused batch (400) never belongs in a queue.
  const allStored = unsent.length === 0 && refused === 0;
  await recordCycle(allStored);
  return { status: allStored ? "ok" : "failed", sent, unsent: unsent.length };
}

// Sends one finished check cycle's listings. `checked` is what
// background.js's runAllChecks() returns: [{ watchId, jobs }] for every
// watch it read. Resolves to { status, sent, unsent } where status is
//   "not-connected"    nothing was (or could go on being) sent
//   "nothing-to-send"  no watch with a server id had a listing
//   "ok"               every batch reached WatchDesk
//   "failed"           at least one did not
// and `sent` / `unsent` count requests. Never throws.
export async function ingestCheckedListings(checked) {
  try {
    return await runCycle(checked);
  } catch {
    await recordCycle(false).catch(() => {});
    return { status: "failed", sent: 0, unsent: 0 };
  }
}
