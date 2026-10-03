// background.js routes the popup's account-* messages to
// account-connection.js and registers its listeners, without disturbing the
// job-check alarm or the existing message handling.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./helpers/chrome-mock.js";
import { installFakeWatchDesk, TEST_CODE, TEST_POLL_SECRET, TEST_TOKEN } from "./helpers/fake-watchdesk.js";
import { PAIRING_ALARM, TOKEN_KEY } from "../account-connection.js";

let env;
let api;

// Sends a message the way the popup does and waits for the answer.
function sendMessage(message) {
  return new Promise((resolve) => {
    for (const listener of env.chrome.runtime.onMessage.listeners) listener(message, {}, resolve);
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-10-02T09:00:00Z"));
  env = installChromeMock();
  api = installFakeWatchDesk();
  vi.resetModules();
  await import("../background.js");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("background.js wiring", () => {
  it("registers the account listeners at the top level", () => {
    expect(env.chrome.tabs.onRemoved.listeners).toHaveLength(1);
    // The job-check alarm listener plus the pairing backstop.
    expect(env.chrome.alarms.onAlarm.listeners).toHaveLength(2);
  });

  it("answers account-get-state and account-connect without the token or the poll secret", async () => {
    expect(await sendMessage({ type: "account-get-state" })).toEqual({ status: "not-connected", outcome: null });

    const pending = await sendMessage({ type: "account-connect" });
    expect(pending).toMatchObject({ status: "pending", code: TEST_CODE });
    expect(JSON.stringify(pending)).not.toContain(TEST_POLL_SECRET);

    api.queuePoll(api.approved);
    await vi.advanceTimersByTimeAsync(3000);
    const connected = await sendMessage({ type: "account-refresh" });
    expect(connected).toMatchObject({ status: "connected", email: "ada@example.com" });
    expect(JSON.stringify(connected)).not.toContain(TEST_TOKEN);
    expect(env.chrome.storage.local.dump()[TOKEN_KEY]).toBe(TEST_TOKEN);
  });

  it("answers account-cancel and account-show-tab", async () => {
    await sendMessage({ type: "account-connect" });
    expect(await sendMessage({ type: "account-show-tab" })).toMatchObject({ status: "pending" });
    expect(await sendMessage({ type: "account-cancel" })).toEqual({
      status: "not-connected",
      outcome: { reason: "cancelled" },
    });
  });

  it("does not run a job check when the pairing alarm fires", async () => {
    await env.chrome.alarms.onAlarm.dispatch({ name: PAIRING_ALARM, scheduledTime: Date.now() });
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("still answers unknown messages with the same error", async () => {
    expect(await sendMessage({ type: "no-such-message" })).toEqual({ ok: false, error: "Unknown message type" });
  });
});

describe("the job-check alarm also confirms the WatchDesk connection (WD-44)", () => {
  // One disabled watch, so a check cycle runs without fetching any job site
  // and its only visible effect is lastRunAt.
  beforeEach(async () => {
    await env.chrome.storage.sync.set({
      watches: [{ id: "w1", siteId: "linkedin", url: "https://www.linkedin.com/jobs/search/?keywords=x", enabled: false }],
    });
  });

  const checkAlarm = () => env.chrome.alarms.onAlarm.dispatch({ name: "check-jobs", scheduledTime: Date.now() });
  const currentCalls = () => api.requests.filter((r) => r.path === "/api/devices/current");

  it("asks /api/devices/current with the token on every check, and still runs the check", async () => {
    await env.chrome.storage.local.set({ [TOKEN_KEY]: TEST_TOKEN });
    await checkAlarm();
    expect(currentCalls()).toHaveLength(1);
    expect(currentCalls()[0].headers).toEqual({ Authorization: `Bearer ${TEST_TOKEN}` });
    expect(env.chrome.storage.local.dump().lastRunAt).toBe(Date.now());

    await checkAlarm();
    expect(currentCalls()).toHaveLength(2);
  });

  it("sends nothing to WatchDesk when no account is connected", async () => {
    await checkAlarm();
    expect(api.fetch).not.toHaveBeenCalled();
    expect(env.chrome.storage.local.dump().lastRunAt).toBe(Date.now());
  });

  it("does not hold up the job check while WatchDesk is slow", async () => {
    await env.chrome.storage.local.set({ [TOKEN_KEY]: TEST_TOKEN });
    // WatchDesk never answers; each attempt ends at the 15 s timeout.
    api.setCurrent(
      ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        ),
    );
    let done = false;
    const listener = checkAlarm().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(env.chrome.storage.local.dump().lastRunAt).toBeTypeOf("number");
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(120000);
    await listener;
    expect(done).toBe(true);
    // Gave up for this cycle, kept the token.
    expect(currentCalls()).toHaveLength(4);
    expect(env.chrome.storage.local.dump()[TOKEN_KEY]).toBe(TEST_TOKEN);
  });

  it("on a 401, discards the token and tells an open popup, and the check still runs", async () => {
    await env.chrome.storage.local.set({ [TOKEN_KEY]: TEST_TOKEN });
    api.setCurrent(() => api.json(401, { error: "Sign in to continue." }));
    env.chrome.runtime.sendMessage.mockResolvedValue(undefined);
    await checkAlarm();

    expect(env.chrome.storage.local.dump()[TOKEN_KEY]).toBeUndefined();
    expect(env.chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "account-state-changed",
      state: { status: "not-connected", outcome: { reason: "revoked" } },
    });
    expect(env.chrome.storage.local.dump().lastRunAt).toBe(Date.now());
    expect(await sendMessage({ type: "account-get-state" })).toEqual({
      status: "not-connected",
      outcome: { reason: "revoked" },
    });
  });
});
