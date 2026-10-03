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
