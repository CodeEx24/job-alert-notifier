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
//                What was not sent is kept (see the queue).
//   404          the watch was deleted on WatchDesk since the last sync, or
//                is not this account's; its listings are dropped, queued
//                ones included, and the next sync removes the watch.
//   400          WatchDesk refused the batch; sending it again would be
//                refused again, so it is dropped and recorded, never queued.
//   anything else (unreachable, rate limited, a 5xx — after the retries of
//                RETRY_POLICY): WatchDesk is not taking listings right now.
//                The rest of the cycle's batches are not attempted, and
//                they are queued.
//
// The queue (WD-60): listings that could not be sent wait in
// chrome.storage.local and go out on the next cycle (the next alarm tick or
// "Check now"), oldest first and before that cycle's own.
//   - Each listing is held once per watch: queueing a newer reading of a
//     posting replaces the older copy.
//   - A listing leaves the queue only after WatchDesk answered 2xx for it
//     (or 400 / 404, which no retry can change). A worker stopped mid-cycle
//     therefore sends some again; WatchDesk keeps one row per posting.
//   - At most QUEUE_MAX_REQUESTS_PER_CYCLE queued requests a cycle, and the
//     first one that fails ends the cycle, so a long queue cannot come near
//     WatchDesk's 120 requests a minute per device.
//   - It is capped (QUEUE_MAX_LISTINGS, QUEUE_MAX_BYTES). Over the cap the
//     oldest listings are dropped and counted, and the popup says so until
//     the user has seen it and everything has since got through.
//   - It belongs to one account, named by the account's email address. It
//     is sent only while that account is the connected one, so it survives
//     a refused token and a reconnection to the same account;
//     account-connection.js removes it when a different account connects.
//     While the account's email is not known nothing is queued or retried.
//   - Cycles run one at a time (an alarm and "Check now" can overlap).
//
// Storage:
//   chrome.storage.local -> watchdeskListingSync { lastIngestedAt, failed }
//     lastIngestedAt  epoch ms of the last cycle after which nothing was
//                     left to send, or null.
//     failed          the last cycle that had something to send could not
//                     send all of it.
//     account-connection.js removes the key whenever a token is stored or
//     dropped.
//   chrome.storage.local -> watchdeskListingQueue
//                           { owner, items, dropped, droppedSeen }
//     owner        the account's email, trimmed and lower-cased.
//     items        [{ watchId, listing }], oldest first.
//     dropped      how many listings the cap has dropped and the user has
//                  not yet been told about.
//     droppedSeen  the popup has shown that count.
//     Absent while there is nothing queued and nothing to tell.
//   Nothing is kept in memory between cycles: the worker may be stopped at
//   any point.
//
// Nothing here sees the device token, and nothing here logs: a listing's
// title and URL say what the user is searching for.

import { getAccountOwner, isConnected, LISTING_QUEUE_KEY, LISTING_SYNC_KEY } from "./account-connection.js";
import { getServerWatchIds } from "./watch-sync.js";
import { ingestListings, INGEST_MAX_LISTINGS } from "./watchdesk-api.js";

// The most the queue holds. chrome.storage.local allows this extension about
// 10 MB in all (no "unlimitedStorage" permission) and the feed and the seen
// ids live there too, so the queue gets a fifth of it. A listing is about
// 400 bytes and at most about 3.4 KB (the length limits below), so the
// count is the limit that normally applies (some 0.8 MB) and the bytes are
// there for a queue of unusually long listings.
export const QUEUE_MAX_LISTINGS = 2000;
export const QUEUE_MAX_BYTES = 2 * 1024 * 1024;
// Queued requests sent per cycle, before the cycle's own. Ten requests carry
// up to 2,000 listings, the whole cap; with one request per watch for the
// cycle itself and three retries of a request that fails, a cycle stays far
// below WatchDesk's 120 requests a minute per device.
export const QUEUE_MAX_REQUESTS_PER_CYCLE = 10;

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

// ---------- the queue ----------

// The stored queue if it is this account's, else an empty one.
async function readQueue(owner) {
  const { [LISTING_QUEUE_KEY]: stored } = await chrome.storage.local.get(LISTING_QUEUE_KEY);
  if (!owner || stored?.owner !== owner) return { owner, items: [], dropped: 0, droppedSeen: false };
  return {
    owner,
    items: Array.isArray(stored.items)
      ? stored.items.filter((item) => typeof item?.watchId === "string" && typeof item.listing?.id === "string")
      : [],
    dropped: Number.isInteger(stored.dropped) && stored.dropped > 0 ? stored.dropped : 0,
    droppedSeen: Boolean(stored.droppedSeen),
  };
}

// Changes this account's queue. `change(queue)` edits it in place and says
// whether it did. Read afresh every time, and left alone once a different
// account is the connected one, so a cycle that was under way when the
// accounts changed cannot bring the old account's queue back.
async function updateQueue(owner, change) {
  if (!owner) return;
  const connectedAs = await getAccountOwner();
  if (connectedAs && connectedAs !== owner) return;
  const queue = await readQueue(owner);
  if (!change(queue)) return;
  if (queue.items.length === 0 && queue.dropped === 0) await chrome.storage.local.remove(LISTING_QUEUE_KEY);
  else await chrome.storage.local.set({ [LISTING_QUEUE_KEY]: queue });
}

const itemKey = (watchId, listingId) => `${watchId}\n${listingId}`;

// Takes listings out of the queue: WatchDesk has them, or will never take
// them.
function forget(owner, batch) {
  const gone = new Set(batch.listings.map((listing) => itemKey(batch.watchId, listing.id)));
  return updateQueue(owner, (queue) => {
    const before = queue.items.length;
    queue.items = queue.items.filter((item) => !gone.has(itemKey(item.watchId, item.listing.id)));
    return queue.items.length !== before;
  });
}

function forgetWatch(owner, watchId) {
  return updateQueue(owner, (queue) => {
    const before = queue.items.length;
    queue.items = queue.items.filter((item) => item.watchId !== watchId);
    return queue.items.length !== before;
  });
}

// Drops the oldest listings until the queue is within its cap, and counts
// them for the popup.
function trimToCap(queue) {
  const encoder = new TextEncoder();
  const sizes = queue.items.map((item) => encoder.encode(JSON.stringify(item)).length + 1);
  let bytes = sizes.reduce((sum, size) => sum + size, 0);
  let over = 0;
  while (queue.items.length - over > QUEUE_MAX_LISTINGS || bytes > QUEUE_MAX_BYTES) {
    bytes -= sizes[over];
    over += 1;
  }
  if (over === 0) return;
  queue.items.splice(0, over);
  queue.dropped += over;
  queue.droppedSeen = false;
}

// Adds batches that could not be sent, newest last. A listing already
// queued for the same watch is replaced by this newer reading of it.
function enqueue(owner, batches) {
  return updateQueue(owner, (queue) => {
    const items = new Map(queue.items.map((item) => [itemKey(item.watchId, item.listing.id), item]));
    for (const { watchId, listings } of batches) {
      for (const listing of listings) {
        const key = itemKey(watchId, listing.id);
        items.delete(key);
        items.set(key, { watchId, listing });
      }
    }
    queue.items = [...items.values()];
    trimToCap(queue);
    return true;
  });
}

// The queue as requests: one watch each, at most INGEST_MAX_LISTINGS
// listings each, the watch with the oldest listing first, and no more than
// a cycle may send.
function queuedBatches(queue) {
  const byWatch = new Map();
  for (const { watchId, listing } of queue.items) {
    if (!byWatch.has(watchId)) byWatch.set(watchId, []);
    byWatch.get(watchId).push(listing);
  }
  const batches = [];
  for (const [watchId, listings] of byWatch) {
    for (let start = 0; start < listings.length; start += INGEST_MAX_LISTINGS) {
      batches.push({ watchId, listings: listings.slice(start, start + INGEST_MAX_LISTINGS), queued: true });
    }
  }
  return batches.slice(0, QUEUE_MAX_REQUESTS_PER_CYCLE);
}

// ---------- what the popup sees ----------

// Not written once the token is gone: the state belongs to a connection.
// After a cycle that left nothing to send, a dropped-listings count the user
// has already seen is cleared too.
async function recordCycle(owner, failed) {
  if (!(await isConnected())) return;
  const state = await readState();
  const allStored = !failed && (await readQueue(owner)).items.length === 0;
  await chrome.storage.local.set({
    [LISTING_SYNC_KEY]: { lastIngestedAt: allStored ? Date.now() : state.lastIngestedAt, failed },
  });
  if (!allStored) return;
  await updateQueue(owner, (queue) => {
    if (!queue.droppedSeen) return false;
    queue.dropped = 0;
    return true;
  });
}

// What the popup shows about listings, beside the watch list's own status:
// { lastIngestedAt, failed, queued, dropped }, where `queued` is how many
// listings are waiting to be sent and `dropped` how many the cap has
// dropped. No token, no listing.
export async function getListingSyncStatus() {
  const queue = await readQueue(await getAccountOwner());
  return { ...(await readState()), queued: queue.items.length, dropped: queue.dropped };
}

// ---------- one cycle ----------

// The requests a cycle makes for what it read: one watch each, at most
// INGEST_MAX_LISTINGS listings each, in the order the watches were checked.
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

  // Whose listings these are. Null while the account's email is not known:
  // the cycle's own listings are still sent, but nothing is queued or
  // retried.
  const owner = await getAccountOwner();
  const queued = queuedBatches(await readQueue(owner));
  const batches = [...queued, ...toBatches(checked, new Set(await getServerWatchIds()))];
  if (batches.length === 0) return { status: "nothing-to-send", sent: 0, unsent: 0 };

  const deleted = new Set(); // watches WatchDesk no longer has
  let sent = 0;
  let refused = 0;
  let unauthorized = false;
  let unsent = []; // batches WatchDesk may still take later
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    if (deleted.has(batch.watchId)) continue;
    // Another account was connected while this cycle was sending: what is
    // left was read for the old one.
    if (owner && (await isConnected()) && (await getAccountOwner()) !== owner) {
      return { status: "not-connected", sent, unsent: 0 };
    }
    const result = await ingestListings(batch.watchId, batch.listings);
    if (result.kind === "ok") {
      sent += 1;
      // Also takes out an older queued copy of what the cycle just sent.
      await forget(owner, batch);
    } else if (result.kind === "not-found") {
      deleted.add(batch.watchId);
      await forgetWatch(owner, batch.watchId);
    } else if (result.kind === "invalid") {
      refused += 1;
      await forget(owner, batch);
    } else {
      unauthorized = result.kind === "unauthorized";
      unsent = batches.slice(index).filter((left) => !deleted.has(left.watchId));
      break;
    }
  }

  // What was queued already is still there; the cycle's own joins it.
  const fresh = unsent.filter((batch) => !batch.queued);
  if (fresh.length > 0) await enqueue(owner, fresh);
  if (unauthorized) return { status: "not-connected", sent, unsent: 0 };

  const failed = unsent.length > 0 || refused > 0;
  await recordCycle(owner, failed);
  return { status: failed ? "failed" : "ok", sent, unsent: unsent.length };
}

// One cycle at a time: an alarm's cycle and "Check now" can overlap, and two
// of them sending the same queue would send it twice.
let lastCycle = Promise.resolve();
function inTurn(run) {
  const result = lastCycle.then(run, run);
  lastCycle = result.catch(() => {});
  return result;
}

// Sends one finished check cycle's listings, after whatever earlier cycles
// left in the queue. `checked` is what background.js's runAllChecks()
// returns: [{ watchId, jobs }] for every watch it read. Resolves to
// { status, sent, unsent } where status is
//   "not-connected"    nothing was (or could go on being) sent
//   "nothing-to-send"  no watch with a server id had a listing, and nothing
//                      was queued
//   "ok"               every request reached WatchDesk
//   "failed"           at least one did not
// and `sent` / `unsent` count requests. Never throws.
export function ingestCheckedListings(checked) {
  return inTurn(async () => {
    try {
      return await runCycle(checked);
    } catch {
      await recordCycle(null, true).catch(() => {});
      return { status: "failed", sent: 0, unsent: 0 };
    }
  });
}

// The popup has shown the dropped-listings count. It is cleared now if
// everything has got through since, and otherwise by the first cycle that
// leaves nothing to send. Never throws.
export function acknowledgeDroppedListings() {
  return inTurn(async () => {
    try {
      const owner = await getAccountOwner();
      const { failed } = await readState();
      await updateQueue(owner, (queue) => {
        if (queue.dropped === 0) return false;
        if (queue.items.length === 0 && !failed) queue.dropped = 0;
        else if (queue.droppedSeen) return false;
        else queue.droppedSeen = true;
        return true;
      });
    } catch {
      // Still shown next time.
    }
  });
}
