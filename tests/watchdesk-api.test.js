// The WatchDesk API client (watchdesk-api.js) against a mocked fetch: what
// it sends, and how it reads every answer in the WD-41 / WD-45 contracts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestJson, startPairing, pollPairing, getCurrentDevice } from "../watchdesk-api.js";
import { WATCHDESK_ORIGIN } from "../config.js";

const json = (status, body, headers = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});
afterEach(() => {
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
    expect(await getCurrentDevice("wd_x.y")).toEqual({
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
    expect((await getCurrentDevice("t")).account).toEqual({ email: null, displayName: null });
  });

  it("reads a 401 as unauthorized", async () => {
    fetchMock.mockResolvedValue(json(401, { error: "Sign in to continue." }));
    expect(await getCurrentDevice("t")).toEqual({ kind: "unauthorized" });
  });
});
