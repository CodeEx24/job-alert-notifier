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
// /api/devices/current — docs/tickets/WD-45.md.

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
// or a refused connection is status 0 with a null body.
export async function requestJson(path, { method = "GET", headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${WATCHDESK_ORIGIN}${path}`, {
      method,
      headers,
      // The extension authenticates with its own headers, never with the
      // web app's session cookie (ADR 0002 §9).
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return {
      status: response.status,
      body,
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
export function configureAuth({ getToken, onUnauthorized }) {
  auth = { getToken, onUnauthorized };
}

// Sends a request with the device token, retrying per RETRY_POLICY.
// Returns requestJson()'s { status, body, retryAfterSeconds } plus
// `attempts`. When it gives up, that is the last answer it got (status 0,
// a 5xx or a 429); the caller reports it and the next check cycle tries
// again. With no token stored it sends nothing and answers 401.
// A 401 calls onUnauthorized() before returning, and is never retried.
export async function authorizedRequest(path, { method = "GET", headers = {}, idempotent, timeoutMs } = {}) {
  const canRetry = idempotent ?? IDEMPOTENT_METHODS.has(method.toUpperCase());
  const maxAttempts = canRetry ? RETRY_POLICY.maxAttempts : 1;

  for (let attempt = 1; ; attempt++) {
    // Read again on every attempt: the token may have been discarded (a
    // 401 elsewhere) or replaced (a new pairing) while this call waited.
    const token = await auth.getToken();
    if (!token) return { status: 401, body: null, retryAfterSeconds: null, attempts: attempt - 1 };

    const response = await requestJson(path, {
      method,
      headers: { ...headers, Authorization: `Bearer ${token}` },
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
// The last three are what is left after the retries.
export async function getCurrentDevice() {
  const response = await authorizedRequest("/api/devices/current");
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
