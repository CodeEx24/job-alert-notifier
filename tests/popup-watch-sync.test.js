// The popup's watch sync line (popup-watch-sync.js), rendered into the real
// popup.html with jsdom.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it } from "vitest";
import { describeWatchSync, renderWatchSync, renderWatchChange } from "../popup-watch-sync.js";

const NOW = Date.parse("2026-10-03T09:00:00Z");
const minutesAgo = (minutes) => NOW - minutes * 60000;

let doc;
beforeEach(() => {
  // The real markup, without its script tag.
  const html = readFileSync("popup.html", "utf8").replace(/<script[^>]*><\/script>/g, "");
  doc = new JSDOM(html).window.document;
});

describe("describeWatchSync", () => {
  it("shows nothing when no account is connected, or before the state arrives", () => {
    expect(describeWatchSync({ mode: "local" }, NOW)).toBeNull();
    expect(describeWatchSync(undefined, NOW)).toBeNull();
    expect(describeWatchSync(null, NOW)).toBeNull();
  });

  it.each([
    [0, "just now"],
    [1, "1m ago"],
    [59, "59m ago"],
    [60, "1h ago"],
    [60 * 23, "23h ago"],
    [60 * 49, "2d ago"],
  ])("synced %i minutes ago reads %s", (minutes, ago) => {
    expect(
      describeWatchSync({ mode: "account", offline: false, lastSyncedAt: minutesAgo(minutes), localOnly: 0 }, NOW),
    ).toEqual({ tone: "ok", text: `Watches synced with WatchDesk · ${ago}` });
  });

  it("offline says so, says the list is the last-synced one, and that it cannot be changed", () => {
    expect(describeWatchSync({ mode: "account", offline: true, lastSyncedAt: minutesAgo(12), localOnly: 0 }, NOW)).toEqual({
      tone: "offline",
      text: "Offline — couldn't reach WatchDesk. Showing your watches as last synced 12m ago. They can't be changed until it's back.",
    });
  });

  it("offline before any sync says the list is this browser's", () => {
    expect(describeWatchSync({ mode: "account", offline: true, lastSyncedAt: null, localOnly: 0 }, NOW)).toEqual({
      tone: "offline",
      text: "Offline — couldn't reach WatchDesk. Showing the watches saved in this browser. They can't be changed until it's back.",
    });
  });

  it("connected but not synced yet says it is syncing", () => {
    expect(describeWatchSync({ mode: "account", offline: false, lastSyncedAt: null, localOnly: 0 }, NOW)).toEqual({
      tone: "neutral",
      text: "Syncing your watches with WatchDesk…",
    });
  });

  it("counts watches that are only in this browser", () => {
    const status = { mode: "account", offline: false, lastSyncedAt: NOW, localOnly: 1 };
    expect(describeWatchSync(status, NOW).text).toBe(
      "Watches synced with WatchDesk · just now · 1 watch is only in this browser, not on WatchDesk.",
    );
    expect(describeWatchSync({ ...status, localOnly: 3 }, NOW).text).toContain(
      "3 watches are only in this browser, not on WatchDesk.",
    );
  });
});

describe("describeWatchSync: when listings last reached WatchDesk (WD-59)", () => {
  const synced = (listings) => ({ mode: "account", offline: false, lastSyncedAt: minutesAgo(2), localOnly: 0, listings });

  it("adds nothing before any check has sent listings, or when the state has none", () => {
    const plain = { tone: "ok", text: "Watches synced with WatchDesk · 2m ago" };
    expect(describeWatchSync(synced({ lastIngestedAt: null, failed: false }), NOW)).toEqual(plain);
    expect(describeWatchSync(synced(undefined), NOW)).toEqual(plain);
  });

  it.each([
    [0, "just now"],
    [7, "7m ago"],
    [60 * 3, "3h ago"],
  ])("a successful send %i minutes ago reads 'Listings last synced %s'", (minutes, ago) => {
    expect(describeWatchSync(synced({ lastIngestedAt: minutesAgo(minutes), failed: false }), NOW)).toEqual({
      tone: "ok",
      text: `Watches synced with WatchDesk · 2m ago · Listings last synced ${ago}`,
    });
  });

  it("a send that did not get through is a warning, and keeps the time of the last one that did", () => {
    expect(describeWatchSync(synced({ lastIngestedAt: minutesAgo(65), failed: true }), NOW)).toEqual({
      tone: "warning",
      text: "Watches synced with WatchDesk · 2m ago · Listings couldn't be sent to WatchDesk last time (last synced 1h ago)",
    });
    expect(describeWatchSync(synced({ lastIngestedAt: null, failed: true }), NOW)).toEqual({
      tone: "warning",
      text: "Watches synced with WatchDesk · 2m ago · Listings couldn't be sent to WatchDesk last time",
    });
  });

  it("offline keeps its own wording and adds when listings last got through", () => {
    const offline = { mode: "account", offline: true, lastSyncedAt: minutesAgo(12), localOnly: 0 };
    expect(describeWatchSync({ ...offline, listings: { lastIngestedAt: minutesAgo(12), failed: true } }, NOW)).toEqual({
      tone: "offline",
      text: "Offline — couldn't reach WatchDesk. Showing your watches as last synced 12m ago. They can't be changed until it's back. Listings last synced 12m ago.",
    });
    expect(describeWatchSync({ ...offline, listings: { lastIngestedAt: null, failed: true } }, NOW).text).toBe(
      "Offline — couldn't reach WatchDesk. Showing your watches as last synced 12m ago. They can't be changed until it's back.",
    );
  });

  it("says nothing about listings while the first watch sync is still to come", () => {
    const status = { mode: "account", offline: false, lastSyncedAt: null, localOnly: 0, listings: { lastIngestedAt: null, failed: false } };
    expect(describeWatchSync(status, NOW)).toEqual({ tone: "neutral", text: "Syncing your watches with WatchDesk…" });
  });

  it("comes before the count of watches that are only in this browser", () => {
    expect(describeWatchSync({ ...synced({ lastIngestedAt: NOW, failed: false }), localOnly: 1 }, NOW).text).toBe(
      "Watches synced with WatchDesk · 2m ago · Listings last synced just now · 1 watch is only in this browser, not on WatchDesk.",
    );
  });

  it("shows nothing with no account connected, whatever else the state holds", () => {
    expect(describeWatchSync({ mode: "local", listings: { lastIngestedAt: NOW, failed: false } }, NOW)).toBeNull();
  });
});

describe("renderWatchSync", () => {
  const line = () => doc.getElementById("watch-sync-status");

  it("is hidden in the markup, and stays hidden with no account connected", () => {
    expect(line().hidden).toBe(true);
    renderWatchSync({ mode: "local" }, doc);
    expect(line().hidden).toBe(true);
    expect(line().textContent).toBe("");
  });

  it("shows a visible offline indicator above the watch list", () => {
    renderWatchSync({ mode: "account", offline: true, lastSyncedAt: Date.now() - 180000, localOnly: 0 }, doc);
    expect(line().hidden).toBe(false);
    expect(line().dataset.tone).toBe("offline");
    expect(line().textContent).toMatch(/^Offline — couldn't reach WatchDesk\. Showing your watches as last synced 3m ago\./);
    expect(line().getAttribute("role")).toBe("status");
    // Above the list, not below it.
    expect(line().compareDocumentPosition(doc.getElementById("watch-list")) & 4).toBe(4);
  });

  it("shows the synced line, then hides again when the account is disconnected", () => {
    renderWatchSync({ mode: "account", offline: false, lastSyncedAt: Date.now(), localOnly: 0 }, doc);
    expect(line().hidden).toBe(false);
    expect(line().dataset.tone).toBe("ok");
    expect(line().textContent).toBe("Watches synced with WatchDesk · just now");

    renderWatchSync({ mode: "local" }, doc);
    expect(line().hidden).toBe(true);
    expect(line().textContent).toBe("");
  });

  it("shows when listings last synced in the same line, and warns when they could not be sent (WD-59)", () => {
    const status = { mode: "account", offline: false, lastSyncedAt: Date.now(), localOnly: 0 };
    renderWatchSync({ ...status, listings: { lastIngestedAt: Date.now() - 240000, failed: false } }, doc);
    expect(line().hidden).toBe(false);
    expect(line().dataset.tone).toBe("ok");
    expect(line().textContent).toBe("Watches synced with WatchDesk · just now · Listings last synced 4m ago");
    // One indicator: the page has no second "last synced" element.
    expect(doc.querySelectorAll('[role="status"].watch-sync-status')).toHaveLength(1);

    renderWatchSync({ ...status, listings: { lastIngestedAt: Date.now() - 240000, failed: true } }, doc);
    expect(line().dataset.tone).toBe("warning");
    expect(line().textContent).toContain("Listings couldn't be sent to WatchDesk last time (last synced 4m ago)");
  });

  it("styles the warning like the offline line", () => {
    const css = readFileSync("popup.css", "utf8");
    expect(css).toMatch(/\.watch-sync-status\[data-tone="offline"\],\s*\.watch-sync-status\[data-tone="warning"\]\s*\{/);
  });

  it("does nothing on a page without the line", () => {
    const empty = new JSDOM("<body></body>").window.document;
    expect(() => renderWatchSync({ mode: "account", offline: true, lastSyncedAt: null, localOnly: 0 }, empty)).not.toThrow();
  });
});

describe("renderWatchChange", () => {
  const line = () => doc.getElementById("watch-change-error");

  it("shows why a change was refused, as text", () => {
    const refused = { ok: false, error: "Can't reach <b>WatchDesk</b>." };
    expect(renderWatchChange(refused, doc)).toBe(false);
    expect(line().textContent).toBe("Can't reach <b>WatchDesk</b>.");
    expect(line().querySelector("b")).toBeNull();
    expect(line().getAttribute("role")).toBe("alert");
  });

  it("falls back to a plain message when the worker gave none", () => {
    renderWatchChange({ ok: false }, doc);
    expect(line().textContent).toBe("Couldn't change that watch.");
  });

  it("clears the message after a change that worked, or an answer with no verdict", () => {
    renderWatchChange({ ok: false, error: "No." }, doc);
    expect(renderWatchChange({ ok: true }, doc)).toBe(true);
    expect(line().textContent).toBe("");
    expect(renderWatchChange(undefined, doc)).toBe(true);
  });
});
