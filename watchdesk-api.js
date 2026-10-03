// watchdesk-api.js — the calls the extension makes to the WatchDesk API.
//
// Imported by the service worker only (via account-connection.js). The
// popup never calls the API itself, so the device token and the pairing
// poll secret never leave the service worker.
//
// Every function returns a plain result object with a `kind` instead of
// throwing, so callers can switch on it. `requestJson` is the one place a
// request is made; WD-44 grows it (retries, a shared 401 handler) rather
// than adding a second fetch path.
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
//   | { kind: "unauthorized" } (missing, unknown or revoked token)
//   | { kind: "rate-limited", retryAfterSeconds } | { kind: "unreachable" }
//   | { kind: "error", status }
export async function getCurrentDevice(token) {
  const response = await requestJson("/api/devices/current", {
    headers: { Authorization: `Bearer ${token}` },
  });
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
