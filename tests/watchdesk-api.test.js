// The WatchDesk API client (watchdesk-api.js) against a mocked fetch: what
// it sends, and how it reads every answer in the WD-41 / WD-45 contracts.
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestJson,
  startPairing,
  pollPairing,
  getCurrentDevice,
  authorizedRequest,
  configureAuth,
  backoffDelayMs,
  RETRY_POLICY,
} from "../watchdesk-api.js";
import { WATCHDESK_ORIGIN } from "../config.js";

const json = (status, body, headers = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const TOKEN = "wd_x.y";

let fetchMock;
let storedToken;
let onUnauthorized;
beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
  storedToken = TOKEN;
  onUnauthorized = vi.fn(async () => {
    storedToken = null;
  });
  configureAuth({ getToken: async () => storedToken, onUnauthorized });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("requestJson", () => {
  it("calls the configured origin without cookies or the HTTP cache", async () => {
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    const result = await requestJson("/api/x", { method: "POST", headers: { A: "b" } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${WATCHDESK_ORIGIN}/api/x`);
    expect(init).toMatchObject({ method: "POST", headers: { A: "b" }, credentials: "omit", cache: "no-store" });
    expect(result).toEqual({ status: 200, body: { ok: true }, retryAfterSeconds: null });
  });

  it("turns a network failure into status 0 without the error's text", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch secret-looking-thing"));
    expect(await requestJson("/api/x")).toEqual({ status: 0, body: null, retryAfterSeconds: null });
  });

  it("gives up after its timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fetchMock.mockImplementation(
      (_url, { signal }) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    );
    const pending = requestJson("/api/x", { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ status: 0, body: null, retryAfterSeconds: null });
  });

  it("reads a body that is not JSON as null", async () => {
    fetchMock.mockResolvedValue(new Response("<html>", { status: 502 }));
    expect(await requestJson("/api/x")).toEqual({ status: 502, body: null, retryAfterSeconds: null });
  });

  it("reads Retry-After in seconds", async () => {
    fetchMock.mockResolvedValue(json(429, { error: "slow down" }, { "Retry-After": "42" }));
    expect((await requestJson("/api/x")).retryAfterSeconds).toBe(42);
  });
});

describe("startPairing", () => {
  it("POSTs to /api/auth/device/start and returns the code, secret, expiry and interval", async () => {
    fetchMock.mockResolvedValue(
      json(200, { code: "WDJB-MJHT", pollSecret: "s3cret", expiresAt: "2026-10-02T08:50:30.036Z", pollIntervalSeconds: 3 }),
    );
    expect(await startPairing()).toEqual({
      kind: "ok",
      code: "WDJB-MJHT",
      pollSecret: "s3cret",
      expiresAt: Date.parse("2026-10-02T08:50:30.036Z"),
      pollIntervalMs: 3000,
    });
    expect(fetchMock.mock.calls[0][0]).toBe(`${WATCHDESK_ORIGIN}/api/auth/device/start`);
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
  });

  it("defaults the interval to 3 s when it is missing or nonsense", async () => {
    fetchMock.mockResolvedValue(json(200, { code: "C", pollSecret: "s", expiresAt: "2026-10-02T08:50:30Z", pollIntervalSeconds: -1 }));
    expect((await startPairing()).pollIntervalMs).toBe(3000);
  });

  it.each([
    ["no secret", { code: "C", expiresAt: "2026-10-02T08:50:30Z" }],
    ["no code", { pollSecret: "s", expiresAt: "2026-10-02T08:50:30Z" }],
    ["a bad date", { code: "C", pollSecret: "s", expiresAt: "soon" }],
  ])("refuses an answer with %s", async (_name, body) => {
    fetchMock.mockResolvedValue(json(200, body));
    expect(await startPairing()).toEqual({ kind: "error", status: 200 });
  });

  it("reports 429 with Retry-After, and an unreachable server", async () => {
    fetchMock.mockResolvedValueOnce(json(429, { error: "x" }, { "Retry-After": "600" }));
    expect(await startPairing()).toEqual({ kind: "rate-limited", retryAfterSeconds: 600 });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await startPairing()).toEqual({ kind: "unreachable" });
  });
});

describe("pollPairing", () => {
  it("sends the code in the query and the secret only in X-Pairing-Secret", async () => {
    fetchMock.mockResolvedValue(json(200, { status: "pending" }));
    expect(await pollPairing("WDJB-MJHT", "s3cret")).toEqual({ kind: "pending" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${WATCHDESK_ORIGIN}/api/auth/device/poll?code=WDJB-MJHT`);
    expect(url).not.toContain("s3cret");
    expect(init.headers).toEqual({ "X-Pairing-Secret": "s3cret" });
  });

  it.each([
    [{ status: "approved", token: "wd_x.y" }, { kind: "approved", token: "wd_x.y" }],
    [{ status: "denied" }, { kind: "denied" }],
    [{ status: "expired" }, { kind: "expired" }],
    [{ status: "approved" }, { kind: "error", status: 200 }],
    [{ status: "something-new" }, { kind: "error", status: 200 }],
  ])("reads %j", async (body, expected) => {
    fetchMock.mockResolvedValue(json(200, body));
    expect(await pollPairing("C", "s")).toEqual(expected);
  });

  it("reports 400, 429 and 5xx", async () => {
    fetchMock.mockResolvedValueOnce(json(400, { error: "bad", fieldErrors: { code: ["x"] } }));
    expect(await pollPairing("C", "s")).toEqual({ kind: "error", status: 400 });
    fetchMock.mockResolvedValueOnce(json(429, { error: "x" }, { "Retry-After": "5" }));
    expect(await pollPairing("C", "s")).toEqual({ kind: "rate-limited", retryAfterSeconds: 5 });
    fetchMock.mockResolvedValueOnce(json(503, {}));
    expect(await pollPairing("C", "s")).toEqual({ kind: "error", status: 503 });
  });
});

describe("getCurrentDevice", () => {
  it("sends the token as a Bearer header and returns the account and device", async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        account: { email: "ada@example.com", displayName: "Ada" },
        device: { id: "d1", label: "Chrome on my laptop" },
      }),
    );
    expect(await getCurrentDevice()).toEqual({
      kind: "ok",
      account: { email: "ada@example.com", displayName: "Ada" },
      device: { id: "d1", label: "Chrome on my laptop" },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${WATCHDESK_ORIGIN}/api/devices/current`);
    expect(init.headers).toEqual({ Authorization: "Bearer wd_x.y" });
  });

  it("passes null email and display name through as null", async () => {
    fetchMock.mockResolvedValue(json(200, { account: { email: null, displayName: null }, device: { id: "d1", label: "L" } }));
    expect((await getCurrentDevice()).account).toEqual({ email: null, displayName: null });
  });

  it("reads a 401 as unauthorized, after the shared handler was told", async () => {
    fetchMock.mockResolvedValue(json(401, { error: "Sign in to continue." }));
    expect(await getCurrentDevice()).toEqual({ kind: "unauthorized" });
    expect(onUnauthorized).toHaveBeenCalledWith(TOKEN);
  });

  it("is unauthorized without a request when no token is stored", async () => {
    storedToken = null;
    expect(await getCurrentDevice()).toEqual({ kind: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("reports what is left after the retries: unreachable, 5xx, rate-limited", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    let pending = getCurrentDevice();
    await vi.advanceTimersByTimeAsync(60000);
    expect(await pending).toEqual({ kind: "unreachable" });

    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => json(502, {}));
    pending = getCurrentDevice();
    await vi.advanceTimersByTimeAsync(60000);
    expect(await pending).toEqual({ kind: "error", status: 502 });

    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => json(429, {}, { "Retry-After": "600" }));
    expect(await getCurrentDevice()).toEqual({ kind: "rate-limited", retryAfterSeconds: 600 });
  });
});

describe("authorizedRequest", () => {
  // When each attempt was sent, on the fake clock.
  let sentAt;
  const answer = (...responses) => {
    fetchMock.mockReset();
    sentAt = [];
    for (const r of responses) {
      fetchMock.mockImplementationOnce(async () => {
        sentAt.push(Date.now());
        if (r === "network") throw new TypeError("Failed to fetch");
        return typeof r === "number" ? json(r, {}) : r;
      });
    }
  };
  const gaps = () => sentAt.slice(1).map((t, i) => t - sentAt[i]);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  it("attaches Authorization: Bearer <token>, keeps the other headers, and omits cookies", async () => {
    answer(200);
    const result = await authorizedRequest("/api/x", { headers: { "X-Thing": "1", Authorization: "Bearer forged" } });
    expect(result).toMatchObject({ status: 200, attempts: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${WATCHDESK_ORIGIN}/api/x`);
    expect(init).toMatchObject({
      method: "GET",
      headers: { "X-Thing": "1", Authorization: `Bearer ${TOKEN}` },
      credentials: "omit",
      cache: "no-store",
    });
  });

  it("retries a network error and a 5xx with growing delays, then succeeds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    answer("network", 503, 200);
    const pending = authorizedRequest("/api/x");
    await vi.advanceTimersByTimeAsync(10000);
    expect(await pending).toMatchObject({ status: 200, attempts: 3 });
    expect(gaps()).toEqual([750, 1500]);
  });

  it("gives up after maxAttempts and returns the last answer, keeping the token", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    answer(500, "network", 502, 504, 200);
    const pending = authorizedRequest("/api/x");
    await vi.advanceTimersByTimeAsync(60000);
    expect(await pending).toMatchObject({ status: 504, attempts: RETRY_POLICY.maxAttempts });
    expect(fetchMock).toHaveBeenCalledTimes(RETRY_POLICY.maxAttempts);
    expect(gaps()).toEqual([1000, 2000, 4000]);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(storedToken).toBe(TOKEN);
  });

  it.each([400, 403, 404, 409, 422])("does not retry a %i", async (status) => {
    answer(status, 200);
    expect(await authorizedRequest("/api/x")).toMatchObject({ status, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("hands a 401 to the shared handler with the refused token, once, without retrying", async () => {
    answer(401, 200);
    expect(await authorizedRequest("/api/x")).toMatchObject({ status: 401, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledWith(TOKEN);
  });

  it("waits Retry-After on a 429 or a 503 instead of the backoff", async () => {
    answer(json(429, {}, { "Retry-After": "7" }), json(503, {}, { "Retry-After": "3" }), 200);
    const pending = authorizedRequest("/api/x");
    await vi.advanceTimersByTimeAsync(20000);
    expect(await pending).toMatchObject({ status: 200, attempts: 3 });
    expect(gaps()).toEqual([7000, 3000]);
  });

  it("uses the backoff on a 429 without Retry-After", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    answer(429, 200);
    const pending = authorizedRequest("/api/x");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ status: 200, attempts: 2 });
    expect(gaps()).toEqual([500]);
  });

  it("gives up at once when Retry-After is longer than the worker can wait", async () => {
    answer(json(429, {}, { "Retry-After": String(RETRY_POLICY.maxRetryAfterMs / 1000 + 1) }), 200);
    expect(await authorizedRequest("/api/x")).toMatchObject({ status: 429, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends a non-idempotent request once, whatever the answer", async () => {
    answer("network", 200);
    expect(await authorizedRequest("/api/x", { method: "POST" })).toMatchObject({ status: 0, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    answer(503, 200);
    expect(await authorizedRequest("/api/x", { method: "PATCH" })).toMatchObject({ status: 503, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a POST the caller marks idempotent", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    answer(503, 201);
    const pending = authorizedRequest("/api/x", { method: "POST", idempotent: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ status: 201, attempts: 2 });
  });

  it("lets a GET opt out of retries", async () => {
    answer(503, 200);
    expect(await authorizedRequest("/api/x", { idempotent: false })).toMatchObject({ status: 503, attempts: 1 });
  });

  it("re-reads the token before every attempt, and stops if it was discarded meanwhile", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    answer(503, 503, 200);
    const pending = authorizedRequest("/api/x");
    await vi.advanceTimersByTimeAsync(0);
    storedToken = "wd_new.token";
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer wd_new.token");
    storedToken = null;
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ status: 401, body: null, retryAfterSeconds: null, attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never puts the token in its result", async () => {
    for (const r of [200, 401, 503, "network"]) {
      storedToken = TOKEN;
      answer(r);
      const result = await authorizedRequest("/api/x", { idempotent: false });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });
});

describe("backoffDelayMs", () => {
  it("stays between half and all of min(maxDelayMs, baseDelayMs · 2^(n-1))", () => {
    for (let retry = 1; retry <= 6; retry++) {
      const ceiling = Math.min(RETRY_POLICY.maxDelayMs, RETRY_POLICY.baseDelayMs * 2 ** (retry - 1));
      expect(backoffDelayMs(retry, RETRY_POLICY, () => 0)).toBe(ceiling / 2);
      expect(backoffDelayMs(retry, RETRY_POLICY, () => 0.999999)).toBeLessThanOrEqual(ceiling);
      for (let i = 0; i < 50; i++) {
        const delay = backoffDelayMs(retry);
        expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("caps the delay at maxDelayMs", () => {
    expect(backoffDelayMs(20, RETRY_POLICY, () => 1)).toBe(RETRY_POLICY.maxDelayMs);
  });

  // True for every retry the policy makes (its delays stay under the cap).
  it("never waits less than the previous retry could have", () => {
    for (let retry = 1; retry < RETRY_POLICY.maxAttempts - 1; retry++) {
      expect(backoffDelayMs(retry + 1, RETRY_POLICY, () => 0)).toBeGreaterThanOrEqual(
        backoffDelayMs(retry, RETRY_POLICY, () => 1),
      );
    }
  });
});

describe("one authenticated path", () => {
  it("builds the Bearer header in one place, inside watchdesk-api.js's one fetch", () => {
    const shipped = readdirSync(".").filter((name) => name.endsWith(".js") && !name.endsWith(".config.js"));
    const withBearer = shipped.filter((name) => /Bearer|Authorization/.test(readFileSync(name, "utf8")));
    expect(withBearer).toEqual(["watchdesk-api.js"]);
    const api = readFileSync("watchdesk-api.js", "utf8");
    expect(api.match(/\bfetch\(/g)).toHaveLength(1);
    expect(api.match(/Bearer \$\{/g)).toHaveLength(1);
  });
});

describe("the pairing calls stay off the authenticated path", () => {
  it("never send Authorization and are sent once, even on a 5xx, a network error or a 401", async () => {
    fetchMock.mockResolvedValueOnce(json(503, {}));
    expect(await startPairing()).toEqual({ kind: "error", status: 503 });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await pollPairing("C", "s")).toEqual({ kind: "unreachable" });
    fetchMock.mockResolvedValueOnce(json(401, {}));
    expect(await pollPairing("C", "s")).toEqual({ kind: "error", status: 401 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) expect(init.headers?.Authorization).toBeUndefined();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
