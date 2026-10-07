// watchdesk-api.js — the calls the extension makes to the WatchDesk API.
//
// Imported by the service worker only (via account-connection.js). The
// popup never calls the API itself, so the device token and the pairing
// poll secret never leave the service worker.
//
// Every function returns a plain result object with a `kind` instead of
// throwing, so callers can switch on it. Two paths, one fetch:
//
//   requestJson()        one attempt, no credentials. The pairing calls use
//                        it directly: they are unauthenticated and the poll
//                        loop in account-connection.js has its own cadence
//                        and Retry-After handling, so retrying here as well
//                        would double up.
//   authorizedRequest()  (WD-44) THE authenticated path. Every call that
//                        carries the device token goes through it: it adds
//                        `Authorization: Bearer <token>`, retries with
//                        backoff (RETRY_POLICY), and hands a 401 to the one
//                        handler that discards the token. Do not build a
//                        Bearer header anywhere else.
//
// The token itself is stored by account-connection.js, which plugs
// `getToken` and `onUnauthorized` in with configureAuth() when it loads.
//
// Secrets: the token and the poll secret go into request headers only.
// Nothing here logs, and no result carries a request header or a raw error
// message, so neither can end up in a log line or in the popup by accident.
//
// Contracts (WatchDesk repo): POST /api/auth/device/start and
// GET /api/auth/device/poll — docs/tickets/WD-41.md; GET
// /api/devices/current — docs/tickets/WD-45.md; GET and POST /api/watches,
// PATCH and DELETE /api/watches/[id] — docs/tickets/WD-52.md; POST
// /api/listings/ingest — docs/tickets/WD-57.md; PATCH /api/listings/[id] —
// docs/tickets/WD-67.md; GET and PUT /api/settings — docs/tickets/WD-56.md
// and WD-71.md.

import { WATCHDESK_ORIGIN } from "./config.js";

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_POLL_INTERVAL_SECONDS = 3;

// Retry-After is in seconds on every WatchDesk 429 (WD-41). The HTTP-date
// form is never sent, so anything that is not a non-negative number is
// treated as absent.
function parseRetryAfter(value) {
  if (value == null) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

// Returns { status, body, retryAfterSeconds }. A network failure, a timeout
// or a refused connection is status 0 with a null body. `body`, when given,
// is sent as JSON.
export async function requestJson(path, { method = "GET", headers = {}, body, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${WATCHDESK_ORIGIN}${path}`, {
      method,
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // The extension authenticates with its own headers, never with the
      // web app's session cookie (ADR 0002 §9).
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    let answer = null;
    try {
      answer = await response.json();
    } catch {
      answer = null;
    }
    return {
      status: response.status,
      body: answer,
      retryAfterSeconds: parseRetryAfter(response.headers.get("Retry-After")),
    };
  } catch {
    return { status: 0, body: null, retryAfterSeconds: null };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- the authenticated path (WD-44) ----------

// How authorizedRequest() retries. Attempts include the first one, so a
// call makes at most 4 requests. The delay before retry n (1, 2, 3) is
// min(maxDelayMs, baseDelayMs * 2^(n-1)) with "equal jitter": a random
// point between half of that and all of it, i.e. 0.5–1 s, 1–2 s, 2–4 s. A
// lower bound is never below the previous upper bound, so the waits grow.
//
// A Retry-After on a 429 or 503 replaces the computed delay. One longer
// than maxRetryAfterMs ends the call at once instead: sleeping through it
// would outlive an MV3 service worker (stopped after ~30 s without an
// extension API call), and the next check cycle asks again anyway.
//
// Worst case: four 15 s timeouts plus ~7 s of waiting, about 67 s. The
// token is read from storage before every attempt, and that read is an
// extension API call, so the worker's idle timer is reset at least every
// request (≤ 15 s) + wait (≤ 10 s) = 25 s, under its 30 s limit.
export const RETRY_POLICY = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  maxRetryAfterMs: 10000,
});

// Methods that are safe to send twice. Anything else (POST, PATCH, …) is
// sent once unless the caller passes `idempotent: true`, which it should
// only do when the server dedupes repeats (for example an ingestion POST
// carrying its own idempotency key).
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The delay before retry number `retry` (1-based), without Retry-After.
export function backoffDelayMs(retry, policy = RETRY_POLICY, random = Math.random) {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

// Network failures (status 0), 5xx and 429 may succeed if asked again.
// Every other 4xx means the request itself is refused; asking again cannot
// help.
function isRetryable(status) {
  return status === 0 || status === 429 || status >= 500;
}

let auth = {
  getToken: async () => null,
  onUnauthorized: async () => {},
};

// account-connection.js calls this once, at load. `getToken()` returns the
// stored device token or null; `onUnauthorized(token)` is told which token
// WatchDesk refused, so it can discard it if it is still the stored one.
// `getToken(connection)` (WD-110) returns the stored token only while it is
// still the one that connection was captured with, else null.
export function configureAuth({ getToken, onUnauthorized }) {
  auth = { getToken, onUnauthorized };
}

// Sends a request with the device token, retrying per RETRY_POLICY.
// Returns requestJson()'s { status, body, retryAfterSeconds } plus
// `attempts`. When it gives up, that is the last answer it got (status 0,
// a 5xx or a 429); the caller reports it and the next check cycle tries
// again. With no token stored it sends nothing and answers 401.
// A 401 calls onUnauthorized() before returning, and is never retried.
//
// `connection` (WD-110; account-connection.js's captureConnection()) binds
// the call to one connection: every attempt goes out with that connection's
// token or not at all. Once the stored token is another one, or none, the
// call sends nothing more and answers status 0 with `connectionChanged:
// true`. For a caller whose request was read for one account, this is what
// keeps it from reaching the account that connected next. Without
// `connection` nothing changes.
export async function authorizedRequest(
  path,
  { method = "GET", headers = {}, body, idempotent, timeoutMs, connection } = {},
) {
  const canRetry = idempotent ?? IDEMPOTENT_METHODS.has(method.toUpperCase());
  const maxAttempts = canRetry ? RETRY_POLICY.maxAttempts : 1;

  for (let attempt = 1; ; attempt++) {
    // Read again on every attempt: the token may have been discarded (a
    // 401 elsewhere) or replaced (a new pairing) while this call waited.
    const token = await auth.getToken(connection);
    if (!token) {
      const unsent = { body: null, retryAfterSeconds: null, attempts: attempt - 1 };
      return connection === undefined ? { status: 401, ...unsent } : { status: 0, ...unsent, connectionChanged: true };
    }

    const response = await requestJson(path, {
      method,
      headers: { ...headers, Authorization: `Bearer ${token}` },
      body,
      timeoutMs,
    });
    const result = { ...response, attempts: attempt };

    if (response.status === 401) {
      await auth.onUnauthorized(token);
      return result;
    }
    if (!isRetryable(response.status) || attempt >= maxAttempts) return result;

    let delayMs = backoffDelayMs(attempt);
    if ((response.status === 429 || response.status === 503) && response.retryAfterSeconds != null) {
      delayMs = response.retryAfterSeconds * 1000;
      if (delayMs > RETRY_POLICY.maxRetryAfterMs) return result;
    }
    await sleep(delayMs);
  }
}

// Maps the answers every call shares. Returns null when the caller has to
// look at the response itself.
function commonFailure({ status, retryAfterSeconds }) {
  if (status === 0) return { kind: "unreachable" };
  if (status === 429) return { kind: "rate-limited", retryAfterSeconds };
  return null;
}

// POST /api/auth/device/start →
//   { kind: "ok", code, pollSecret, expiresAt (epoch ms), pollIntervalMs }
//   | { kind: "rate-limited", retryAfterSeconds } | { kind: "unreachable" }
//   | { kind: "error", status }
export async function startPairing() {
  const response = await requestJson("/api/auth/device/start", { method: "POST" });
  const failure = commonFailure(response);
  if (failure) return failure;

  const body = response.body;
  const expiresAt = Date.parse(body?.expiresAt);
  if (
    response.status !== 200 ||
    typeof body?.code !== "string" ||
    !body.code ||
    typeof body?.pollSecret !== "string" ||
    !body.pollSecret ||
    !Number.isFinite(expiresAt)
  ) {
    return { kind: "error", status: response.status };
  }

  const intervalSeconds = Number(body.pollIntervalSeconds);
  return {
    kind: "ok",
    code: body.code,
    pollSecret: body.pollSecret,
    expiresAt,
    pollIntervalMs:
      (Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : DEFAULT_POLL_INTERVAL_SECONDS) *
      1000,
  };
}

// GET /api/auth/device/poll?code=… with X-Pairing-Secret →
//   { kind: "pending" } | { kind: "approved", token } | { kind: "denied" }
//   | { kind: "expired" } | { kind: "rate-limited", retryAfterSeconds }
//   | { kind: "unreachable" } | { kind: "error", status }
export async function pollPairing(code, pollSecret) {
  const response = await requestJson(`/api/auth/device/poll?code=${encodeURIComponent(code)}`, {
    headers: { "X-Pairing-Secret": pollSecret },
  });
  const failure = commonFailure(response);
  if (failure) return failure;
  if (response.status !== 200) return { kind: "error", status: response.status };

  const { status, token } = response.body || {};
  if (status === "approved") {
    return typeof token === "string" && token ? { kind: "approved", token } : { kind: "error", status: 200 };
  }
  if (status === "pending" || status === "denied" || status === "expired") return { kind: status };
  return { kind: "error", status: 200 };
}

// GET /api/devices/current with the device token →
//   { kind: "ok", account: { email, displayName }, device: { id, label } }
//   | { kind: "unauthorized" } (no token, or an unknown or revoked one,
//     which authorizedRequest() has already handed to onUnauthorized)
//   | { kind: "rate-limited", retryAfterSeconds } | { kind: "unreachable" }
//   | { kind: "error", status }
//   | { kind: "connection-changed" } (only with `connection`: the token is
//     no longer that connection's, so nothing was, or went on being, sent)
// The three before it are what is left after the retries. `connection`
// (WD-110) binds the call to one token, so the answer is that token's
// account and no other's.
export async function getCurrentDevice(connection) {
  const response = await authorizedRequest("/api/devices/current", { connection });
  if (response.connectionChanged) return { kind: "connection-changed" };
  const failure = commonFailure(response);
  if (failure) return failure;
  if (response.status === 401) return { kind: "unauthorized" };
  if (response.status !== 200) return { kind: "error", status: response.status };

  const account = response.body?.account || {};
  const device = response.body?.device || {};
  return {
    kind: "ok",
    account: {
      email: typeof account.email === "string" ? account.email : null,
      displayName: typeof account.displayName === "string" ? account.displayName : null,
    },
    device: {
      id: typeof device.id === "string" ? device.id : null,
      label: typeof device.label === "string" ? device.label : null,
    },
  };
}

// ---------- watches (WD-54; contract in WD-52) ----------
//
// A watch as the extension keeps it: { id, siteId, url, label, enabled }.
// The server's createdAt / updatedAt are dropped: nothing here uses them.
//
// Every call is one attempt. The list is asked again on every check and
// every popup open, so a retry loop here would only hold the check up; and
// the writes come from a click in the popup, which should hear "offline" at
// once rather than after the backoff.

// How long the list may take. Shorter than the default because the job
// check waits for it.
const WATCH_LIST_TIMEOUT_MS = 10000;

function readWatch(raw) {
  if (!raw || typeof raw.id !== "string" || !raw.id || typeof raw.url !== "string" || !raw.url) return null;
  return {
    id: raw.id,
    siteId: typeof raw.siteId === "string" && raw.siteId ? raw.siteId : null,
    url: raw.url,
    label: typeof raw.label === "string" && raw.label ? raw.label : raw.url,
    enabled: raw.enabled !== false,
  };
}

// The first message of a 400: a field error if there is one, else the
// body's own. Both are WatchDesk's user-facing text.
function validationMessage(body) {
  const fieldErrors = body?.fieldErrors;
  if (fieldErrors && typeof fieldErrors === "object") {
    for (const field of ["url", "label", "enabled", "form"]) {
      const first = Array.isArray(fieldErrors[field]) ? fieldErrors[field][0] : null;
      if (typeof first === "string" && first) return first;
    }
  }
  return typeof body?.error === "string" && body.error ? body.error : null;
}

// What a watch call can answer besides its own success:
//   { kind: "unauthorized" } (authorizedRequest() has already discarded the
//   token) | { kind: "invalid", message } (400) | { kind: "forbidden" } (403:
//   the account's email is not verified) | { kind: "not-found" } (404: no
//   such watch, or not this account's) | { kind: "rate-limited",
//   retryAfterSeconds } | { kind: "unreachable" } | { kind: "error", status }
//   | { kind: "connection-changed" } (only for a call bound to a
//   `connection`: the token is no longer that connection's, nothing was sent)
function watchFailure(response) {
  if (response.connectionChanged) return { kind: "connection-changed" };
  const failure = commonFailure(response);
  if (failure) return failure;
  if (response.status === 401) return { kind: "unauthorized" };
  if (response.status === 400) return { kind: "invalid", message: validationMessage(response.body) };
  if (response.status === 403) return { kind: "forbidden" };
  if (response.status === 404) return { kind: "not-found" };
  return { kind: "error", status: response.status };
}

function watchResult(response, successStatus) {
  if (response.status !== successStatus) return watchFailure(response);
  const watch = readWatch(response.body);
  return watch ? { kind: "ok", watch } : { kind: "error", status: response.status };
}

// GET /api/watches → { kind: "ok", watches } (oldest first) or a failure.
// A list holding anything that is not a watch is an error as a whole: the
// caller removes what the list leaves out, so it must not act on a broken
// one.
// `connection` (WD-81), here and in createWatch(), binds the call to one
// token: the import of a browser's own watches must not go on into an
// account that connected after it began.
export async function listWatches(connection) {
  const response = await authorizedRequest("/api/watches", {
    idempotent: false,
    timeoutMs: WATCH_LIST_TIMEOUT_MS,
    connection,
  });
  if (response.status !== 200) return watchFailure(response);
  const raw = response.body?.watches;
  if (!Array.isArray(raw)) return { kind: "error", status: 200 };
  const watches = raw.map(readWatch);
  if (watches.includes(null)) return { kind: "error", status: 200 };
  return { kind: "ok", watches };
}

// POST /api/watches → { kind: "ok", watch } or a failure. The server derives
// the site from the URL and may rewrite the URL (LinkedIn).
export async function createWatch({ url, label, enabled }, connection) {
  const body = { url };
  if (label) body.label = label;
  if (typeof enabled === "boolean") body.enabled = enabled;
  return watchResult(await authorizedRequest("/api/watches", { method: "POST", body, connection }), 201);
}

// PATCH /api/watches/[id] with any of { label, enabled } →
// { kind: "ok", watch } or a failure.
export async function updateWatch(id, patch) {
  const response = await authorizedRequest(`/api/watches/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
  return watchResult(response, 200);
}

// DELETE /api/watches/[id] → { kind: "ok" } or a failure.
export async function deleteWatch(id) {
  const response = await authorizedRequest(`/api/watches/${encodeURIComponent(id)}`, { method: "DELETE" });
  return response.status === 200 ? { kind: "ok" } : watchFailure(response);
}

// ---------- settings (WD-71; contract in WD-56 and WD-71) ----------
//
// The account's settings, as WatchDesk keeps them: { intervalMinutes,
// soundId, notificationsMuted, titleFilter: { enabled, keywords },
// watcherState }. Only account-settings.js calls these (WD-79): it keeps
// this browser's copy of them, and is the one place a PUT body is built,
// for a setting changed in the popup and for watcher-state.js's report of
// whether watching is running or paused.
//
// PUT replaces every setting (one left out is a 400), so a caller changes
// one by reading them all and sending them all back. Each call is one
// attempt, like the watch calls: the read runs again on every sync, and a
// write comes from a click in the popup, which should hear "offline" at
// once rather than after the backoff.
//
// `connection` binds both calls to one token (WD-110), so settings read
// from one account are never written to the account that connected next.

const SETTINGS_TIMEOUT_MS = 10000;

// The first message of a settings 400. Its field errors are keyed by path
// ("intervalMinutes", "titleFilter.keywords.3"), so the first one of any
// field is taken, else the body's own. Both are WatchDesk's user-facing text.
function settingsValidationMessage(body) {
  const fieldErrors = body?.fieldErrors;
  if (fieldErrors && typeof fieldErrors === "object") {
    for (const messages of Object.values(fieldErrors)) {
      const first = Array.isArray(messages) ? messages[0] : null;
      if (typeof first === "string" && first) return first;
    }
  }
  return typeof body?.error === "string" && body.error ? body.error : null;
}

// { kind: "ok", settings } — the answer without its `updatedAt`, ready to be
// sent back — or a failure, the same kinds as a watch call, or
// { kind: "connection-changed" }.
function settingsResult(response) {
  if (response.connectionChanged) return { kind: "connection-changed" };
  if (response.status === 400) return { kind: "invalid", message: settingsValidationMessage(response.body) };
  if (response.status !== 200) return watchFailure(response);
  const body = response.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return { kind: "error", status: 200 };
  const settings = { ...body };
  delete settings.updatedAt;
  return { kind: "ok", settings };
}

// GET /api/settings. 404 ("not-found") is an account with no settings row.
export async function readSettings(connection) {
  const response = await authorizedRequest("/api/settings", {
    idempotent: false,
    timeoutMs: SETTINGS_TIMEOUT_MS,
    connection,
  });
  return settingsResult(response);
}

// PUT /api/settings with the whole settings object → the settings as they
// now are.
export async function replaceSettings(settings, connection) {
  const response = await authorizedRequest("/api/settings", {
    method: "PUT",
    body: settings,
    timeoutMs: SETTINGS_TIMEOUT_MS,
    connection,
  });
  return settingsResult(response);
}

// ---------- listings (WD-59; contract in WD-57) ----------

// The most listings WatchDesk takes in one request (its INGEST_MAX_LISTINGS).
// One more and the whole request is refused.
export const INGEST_MAX_LISTINGS = 200;

// POST /api/listings/ingest: the postings one check found for one watch →
//   { kind: "ok", received, inserted: [{ id, jobId }] } or a failure, the
//   same kinds as a watch call. `watchId` is the watch's id on WatchDesk;
//   404 ("not-found") is a watch the account no longer has. A 400
//   ("invalid") refuses the whole batch and stores nothing.
//
// Unlike the watch calls this one retries (RETRY_POLICY): WatchDesk keeps
// one row per posting however often it is sent, so a repeat is harmless, and
// it runs after the job check has finished, so nothing waits on it.
//
// `connection` (WD-110) is the connection the listings were read for. The
// request goes out with that connection's token only; if it is no longer
// the stored one, nothing is sent and the answer is
// { kind: "connection-changed" }.
//
// WD-117: a listing may carry `detectedAt`, when it was first found, as an
// ISO 8601 string. Only the import of a browser's own feed sends one
// (local-import.js); a check cycle never does. WatchDesk then says what
// became of each time, and the answer has
//   detectedTimes: [{ jobId, detectedAt, outcome }]
// with `outcome` "used", "out-of-range" (stored with WatchDesk's own clock)
// or "kept" (the account already had the listing). The key is there only
// when WatchDesk sent it, so the answer to a check is what it always was.
export async function ingestListings(watchId, listings, connection) {
  const response = await authorizedRequest("/api/listings/ingest", {
    method: "POST",
    body: { watchId, listings },
    idempotent: true,
    connection,
  });
  if (response.connectionChanged) return { kind: "connection-changed" };
  if (response.status !== 200) return watchFailure(response);
  const inserted = Array.isArray(response.body?.inserted) ? response.body.inserted : [];
  return {
    kind: "ok",
    received: typeof response.body?.received === "number" ? response.body.received : listings.length,
    inserted: inserted.filter((row) => typeof row?.id === "string" && typeof row?.jobId === "string"),
    ...(Array.isArray(response.body?.detectedTimes)
      ? {
          detectedTimes: response.body.detectedTimes.filter(
            (row) => typeof row?.jobId === "string" && typeof row?.outcome === "string",
          ),
        }
      : {}),
  };
}

// ---------- a listing's status (WD-81; contract in WD-67) ----------

// PATCH /api/listings/[id] with { status } → { kind: "ok" } or a failure,
// the same kinds as a watch call. `listingId` is WatchDesk's id for the
// listing (ingestListings()'s `inserted[].id`); 404 ("not-found") is a
// listing the account does not have. Only the import of a browser's own feed
// calls it, to carry an "applied" mark over.
//
// It retries (RETRY_POLICY): giving a listing the status it already has
// changes nothing on WatchDesk, so a repeat is harmless. `connection` binds
// it to one token, like ingestListings().
export async function setListingStatus(listingId, status, connection) {
  const response = await authorizedRequest(`/api/listings/${encodeURIComponent(listingId)}`, {
    method: "PATCH",
    body: { status },
    idempotent: true,
    connection,
  });
  return response.status === 200 ? { kind: "ok" } : watchFailure(response);
}
