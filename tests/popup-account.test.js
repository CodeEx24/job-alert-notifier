// The popup's account card (popup-account.js), rendered into the real
// popup.html with jsdom and driven with a mocked message channel.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeConnection, renderAccountCard, initAccountCard } from "../popup-account.js";

let doc;

function card() {
  const $ = (id) => doc.getElementById(id);
  return {
    state: $("account-card").dataset.state,
    tone: $("account-card").dataset.tone,
    title: $("account-title").textContent,
    detail: $("account-detail").textContent,
    connect: !$("account-connect").hidden,
    showTab: !$("account-show-tab").hidden,
    cancel: !$("account-cancel").hidden,
  };
}

beforeEach(() => {
  // The real markup, without its script tag.
  const html = readFileSync("popup.html", "utf8").replace(/<script[^>]*><\/script>/g, "");
  doc = new JSDOM(html).window.document;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("describeConnection", () => {
  it("not connected, nothing tried yet: the Connect Account button", () => {
    expect(describeConnection({ status: "not-connected", outcome: null })).toMatchObject({
      mode: "not-connected",
      tone: "neutral",
      title: "Not connected to WatchDesk",
      buttons: ["connect"],
    });
  });

  it.each([
    ["tab-closed", "The WatchDesk tab was closed before the code was approved."],
    ["cancelled", "Connecting was cancelled."],
    ["denied", "The connection was denied on WatchDesk."],
    ["expired", "The code expired before it was approved."],
    ["revoked", "This browser was disconnected from your WatchDesk account."],
    ["unreachable", "Couldn't reach WatchDesk. Check your connection and try again."],
    ["error", "Something went wrong while connecting. Try again."],
    ["something-new", "Something went wrong while connecting. Try again."],
  ])("not connected after %s says why and offers Connect Account again", (reason, detail) => {
    expect(describeConnection({ status: "not-connected", outcome: { reason } })).toMatchObject({
      mode: "not-connected",
      tone: "problem",
      title: "Not connected to WatchDesk",
      detail,
      buttons: ["connect"],
    });
  });

  it("a rate-limited start says how long to wait", () => {
    expect(describeConnection({ status: "not-connected", outcome: { reason: "rate-limited", retryAfterSeconds: 300 } }).detail).toBe(
      "WatchDesk is busy. Try again in 5 min.",
    );
  });

  it("pending shows the code, the time left, Show tab and Cancel", () => {
    const now = Date.UTC(2026, 9, 2, 9, 0, 0);
    expect(describeConnection({ status: "pending", code: "WDJB-MJHT", expiresAt: now + 9 * 60000 + 5000 }, now)).toEqual({
      mode: "pending",
      tone: "neutral",
      title: "Waiting for approval…",
      detail: "Approve code WDJB-MJHT in the WatchDesk tab",
      countdown: " · 9:05 left",
      buttons: ["show-tab", "cancel"],
    });
  });

  it("connected shows the account's email and the device name", () => {
    expect(
      describeConnection({ status: "connected", email: "ada@example.com", displayName: "Ada", deviceLabel: "Chrome on my laptop" }),
    ).toEqual({
      mode: "connected",
      tone: "ok",
      title: "Connected to WatchDesk",
      detail: "ada@example.com · Chrome on my laptop",
      buttons: [],
    });
  });

  it("connected falls back to the display name, then to a plain line", () => {
    expect(describeConnection({ status: "connected", email: null, displayName: "Ada", deviceLabel: null }).detail).toBe("Ada");
    expect(describeConnection({ status: "connected", email: null, displayName: null, deviceLabel: null }).detail).toBe("Connected");
    expect(
      describeConnection({ status: "connected", email: null, displayName: null, deviceLabel: null, accountCheckFailed: true }).detail,
    ).toBe("Couldn't load the account details right now.");
  });

  it("no answer from the worker reads as not connected", () => {
    expect(describeConnection(undefined)).toMatchObject({ mode: "not-connected", buttons: ["connect"] });
  });
});

describe("renderAccountCard", () => {
  it("renders into popup.html's card and toggles the buttons", () => {
    renderAccountCard({ status: "not-connected", outcome: null }, doc);
    expect(card()).toMatchObject({ state: "not-connected", connect: true, showTab: false, cancel: false });

    renderAccountCard({ status: "pending", code: "WDJB-MJHT", expiresAt: Date.now() + 60000 }, doc);
    expect(card()).toMatchObject({ state: "pending", connect: false, showTab: true, cancel: true });

    renderAccountCard({ status: "connected", email: "ada@example.com", deviceLabel: null }, doc);
    expect(card()).toMatchObject({ state: "connected", tone: "ok", detail: "ada@example.com", connect: false });
  });

  it("keeps the ticking countdown out of the live region", () => {
    const expiresAt = Date.now() + 65000;
    renderAccountCard({ status: "pending", code: "WDJB-MJHT", expiresAt }, doc);
    const countdown = doc.getElementById("account-countdown");
    expect(countdown.getAttribute("aria-hidden")).toBe("true");
    expect(countdown.textContent).toMatch(/ · 1:0\d left/);
    expect(doc.getElementById("account-detail").textContent).toBe("Approve code WDJB-MJHT in the WatchDesk tab");

    renderAccountCard({ status: "not-connected", outcome: null }, doc);
    expect(countdown.textContent).toBe("");
  });

  it("writes text, never markup", () => {
    renderAccountCard({ status: "connected", email: '<img src=x onerror="alert(1)">', deviceLabel: null }, doc);
    expect(doc.getElementById("account-detail").children).toHaveLength(0);
    expect(doc.querySelector("#account-card img")).toBeNull();
  });
});

describe("initAccountCard", () => {
  const setButtonBusy = vi.fn();

  it("shows the state on open and starts connecting on click", async () => {
    const send = vi.fn(async ({ type }) =>
      type === "account-connect"
        ? { status: "pending", code: "WDJB-MJHT", expiresAt: Date.now() + 600000 }
        : { status: "not-connected", outcome: null },
    );
    await initAccountCard({ send, setButtonBusy, doc });
    expect(send).toHaveBeenCalledWith({ type: "account-get-state" });
    expect(card().connect).toBe(true);

    doc.getElementById("account-connect").click();
    await vi.waitFor(() => expect(card().state).toBe("pending"));
    expect(send).toHaveBeenCalledWith({ type: "account-connect" });
    expect(setButtonBusy).toHaveBeenCalledWith(doc.getElementById("account-connect"), true, "Opening…");
  });

  it("refreshes a connected account when the popup opens", async () => {
    const send = vi.fn(async ({ type }) =>
      type === "account-refresh"
        ? { status: "connected", email: "new@example.com", deviceLabel: "Edge" }
        : { status: "connected", email: "old@example.com", deviceLabel: "Edge" },
    );
    await initAccountCard({ send, setButtonBusy, doc });
    expect(send).toHaveBeenCalledWith({ type: "account-refresh" });
    expect(card().detail).toBe("new@example.com · Edge");
  });

  it("shows not connected when the refresh finds the token revoked", async () => {
    const send = vi.fn(async ({ type }) =>
      type === "account-refresh"
        ? { status: "not-connected", outcome: { reason: "revoked" } }
        : { status: "connected", email: "ada@example.com", deviceLabel: null },
    );
    await initAccountCard({ send, setButtonBusy, doc });
    expect(card()).toMatchObject({ state: "not-connected", connect: true });
  });

  it("while pending, re-reads the state every second until it is connected", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const states = [
      { status: "pending", code: "WDJB-MJHT", expiresAt: Date.now() + 600000 },
      { status: "pending", code: "WDJB-MJHT", expiresAt: Date.now() + 600000 },
      { status: "connected", email: "ada@example.com", deviceLabel: null },
    ];
    const send = vi.fn(async () => states.shift() ?? { status: "connected", email: "ada@example.com", deviceLabel: null });
    await initAccountCard({ send, setButtonBusy, doc });
    expect(card().state).toBe("pending");

    await vi.advanceTimersByTimeAsync(2000);
    expect(card()).toMatchObject({ state: "connected", detail: "ada@example.com" });
    const calls = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(send.mock.calls.length).toBe(calls);
  });

  // A stand-in for chrome.runtime.onMessage.
  const messageEvent = () => {
    const listeners = [];
    return { addListener: (fn) => listeners.push(fn), emit: (message) => listeners.map((fn) => fn(message, {}, () => {})) };
  };

  it("flips to not connected while open when the worker reports a lost connection", async () => {
    const messages = messageEvent();
    const send = vi.fn(async () => ({ status: "connected", email: "ada@example.com", deviceLabel: null }));
    await initAccountCard({ send, setButtonBusy, doc, messages });
    expect(card().state).toBe("connected");

    const returned = messages.emit({
      type: "account-state-changed",
      state: { status: "not-connected", outcome: { reason: "revoked" } },
    });
    expect(card()).toMatchObject({
      state: "not-connected",
      connect: true,
      detail: "This browser was disconnected from your WatchDesk account.",
    });
    // It does not answer, so it never holds a message channel open.
    expect(returned).toEqual([undefined]);
  });

  it("ignores other runtime messages", async () => {
    const messages = messageEvent();
    const send = vi.fn(async () => ({ status: "connected", email: "ada@example.com", deviceLabel: null }));
    await initAccountCard({ send, setButtonBusy, doc, messages });
    messages.emit({ type: "play-sound", soundId: "x" });
    messages.emit(undefined);
    expect(card().state).toBe("connected");
  });

  it("Cancel asks the worker to cancel", async () => {
    const send = vi.fn(async ({ type }) =>
      type === "account-cancel"
        ? { status: "not-connected", outcome: { reason: "cancelled" } }
        : { status: "pending", code: "WDJB-MJHT", expiresAt: Date.now() + 600000 },
    );
    await initAccountCard({ send, setButtonBusy, doc });
    doc.getElementById("account-cancel").click();
    await vi.waitFor(() => expect(card().detail).toBe("Connecting was cancelled."));
  });
});
