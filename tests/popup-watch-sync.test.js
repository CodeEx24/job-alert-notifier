// The popup's sync status (popup-watch-sync.js), rendered into the real
// popup.html with jsdom. Every test passes its own clock (NOW): nothing here
// reads the real time.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it } from "vitest";
import { describeWatchSync, renderWatchSync, renderWatchChange } from "../popup-watch-sync.js";
import { renderAccountCard } from "../popup-account.js";

const NOW = Date.parse("2026-10-03T09:00:00Z");
const minutesAgo = (minutes) => NOW - minutes * 60000;
const DROPPED_120 = "WatchDesk was out of reach for too long: the 120 oldest unsent listings were dropped";

let doc;
beforeEach(() => {
  // The real markup, without its script tag.
  const html = readFileSync("popup.html", "utf8").replace(/<script[^>]*><\/script>/g, "");
  doc = new JSDOM(html).window.document;
});

describe("describeWatchSync", () => {
  it("shows nothing when no account is connected, or before the state arrives", () => {
    expect(describeWatchSync({ mode: "local" }, NOW)).toBeNull();
    expect(describeWatchSync({ mode: "local", listings: { lastIngestedAt: NOW, failed: false, queued: 5, dropped: 5 } }, NOW)).toBeNull();
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
  ])("connected and current, synced %i minutes ago, reads 'Last synced %s' and that nothing is waiting", (minutes, ago) => {
    expect(
      describeWatchSync({ mode: "account", offline: false, lastSyncedAt: minutesAgo(minutes), localOnly: 0 }, NOW),
    ).toEqual({ tone: "ok", lastSynced: `Last synced ${ago}`, text: "Nothing waiting to be sent" });
  });

  it("offline says so, says the list is the last-synced one, and that it cannot be changed", () => {
    expect(describeWatchSync({ mode: "account", offline: true, lastSyncedAt: minutesAgo(12), localOnly: 0 }, NOW)).toEqual({
      tone: "offline",
      lastSynced: "Last synced 12m ago",
      text: "Offline — couldn't reach WatchDesk. Your watches are shown as last synced. They can't be changed until it's back.",
    });
  });

  it("offline before any sync says the list is this browser's, and that it never synced", () => {
    expect(describeWatchSync({ mode: "account", offline: true, lastSyncedAt: null, localOnly: 0 }, NOW)).toEqual({
      tone: "offline",
      lastSynced: "Never synced",
      text: "Offline — couldn't reach WatchDesk. Showing the watches saved in this browser. They can't be changed until it's back.",
    });
  });

  it("connected but not synced yet says it is syncing, and 'Never synced'", () => {
    const status = { mode: "account", offline: false, lastSyncedAt: null, localOnly: 0 };
    const view = { tone: "neutral", lastSynced: "Never synced", text: "Syncing your watches with WatchDesk…" };
    expect(describeWatchSync(status, NOW)).toEqual(view);
    expect(describeWatchSync({ ...status, listings: { lastIngestedAt: null, failed: false, queued: 0, dropped: 0 } }, NOW)).toEqual(view);
  });

  it("counts watches that are only in this browser", () => {
    const status = { mode: "account", offline: false, lastSyncedAt: NOW, localOnly: 1 };
    expect(describeWatchSync(status, NOW).text).toBe(
      "Nothing waiting to be sent · 1 watch is only in this browser, not on WatchDesk.",
    );
    expect(describeWatchSync({ ...status, localOnly: 3 }, NOW).text).toBe(
      "Nothing waiting to be sent · 3 watches are only in this browser, not on WatchDesk.",
    );
  });
});

describe("describeWatchSync: 'last synced' is the later of the watch sync and the listing upload (WD-73)", () => {
  const status = (watchesAt, listingsAt, more = {}) => ({
    mode: "account",
    offline: false,
    lastSyncedAt: watchesAt,
    localOnly: 0,
    listings: { lastIngestedAt: listingsAt, failed: false, queued: 0, dropped: 0 },
    ...more,
  });

  it.each([
    ["the watch sync when it is the later", minutesAgo(2), minutesAgo(7), "Last synced 2m ago"],
    ["the listing upload when it is the later", minutesAgo(30), minutesAgo(4), "Last synced 4m ago"],
    ["the watch sync before any listing was sent", minutesAgo(9), null, "Last synced 9m ago"],
    ["the listing upload when the watch list never synced", null, minutesAgo(3), "Last synced 3m ago"],
    ["never, when neither happened", null, null, "Never synced"],
  ])("takes %s", (_name, watchesAt, listingsAt, label) => {
    expect(describeWatchSync(status(watchesAt, listingsAt), NOW).lastSynced).toBe(label);
  });

  it("ignores a time that is not a time", () => {
    expect(describeWatchSync(status(minutesAgo(5), "yesterday"), NOW).lastSynced).toBe("Last synced 5m ago");
    expect(describeWatchSync(status(minutesAgo(5), NaN), NOW).lastSynced).toBe("Last synced 5m ago");
  });

  it("a time ahead of this computer's clock reads 'just now'", () => {
    expect(describeWatchSync(status(NOW + 60000, null), NOW).lastSynced).toBe("Last synced just now");
  });

  it("follows the clock it is given, and the state text does not change with it", () => {
    const synced = status(NOW, NOW, { listings: { lastIngestedAt: NOW, failed: true, queued: 4, dropped: 0 } });
    const first = describeWatchSync(synced, NOW);
    const later = describeWatchSync(synced, NOW + 5 * 60000);
    expect(first.lastSynced).toBe("Last synced just now");
    expect(later.lastSynced).toBe("Last synced 5m ago");
    expect(later.text).toBe(first.text);
    expect(later.text).not.toMatch(/ago|just now/);
  });
});

describe("describeWatchSync: listings waiting to be sent, and listings dropped (WD-60)", () => {
  const base = { mode: "account", offline: false, lastSyncedAt: minutesAgo(2), localOnly: 0 };
  const withListings = (listings, more = {}) => ({
    ...base,
    ...more,
    listings: { lastIngestedAt: null, failed: false, queued: 0, dropped: 0, ...listings },
  });

  it("says nothing is waiting while the queue is empty", () => {
    expect(describeWatchSync(withListings({ lastIngestedAt: minutesAgo(7) }), NOW)).toEqual({
      tone: "ok",
      lastSynced: "Last synced 2m ago",
      text: "Nothing waiting to be sent",
    });
  });

  it("says how many listings are waiting after a send that failed, as a warning", () => {
    expect(describeWatchSync(withListings({ lastIngestedAt: minutesAgo(65), failed: true, queued: 42 }), NOW)).toEqual({
      tone: "warning",
      lastSynced: "Last synced 2m ago",
      text: "Listings couldn't be sent to WatchDesk last time · 42 listings waiting to be sent",
    });
    expect(describeWatchSync(withListings({ failed: true, queued: 1 }), NOW).text).toBe(
      "Listings couldn't be sent to WatchDesk last time · 1 listing waiting to be sent",
    );
  });

  it("a failed send with nothing left queued still warns", () => {
    expect(describeWatchSync(withListings({ failed: true }), NOW)).toMatchObject({
      tone: "warning",
      text: "Listings couldn't be sent to WatchDesk last time · Nothing waiting to be sent",
    });
  });

  it("says so too while a long queue is still going out, without calling it a failure", () => {
    expect(describeWatchSync(withListings({ lastIngestedAt: minutesAgo(65), queued: 400 }), NOW)).toEqual({
      tone: "ok",
      lastSynced: "Last synced 2m ago",
      text: "400 listings waiting to be sent",
    });
  });

  it("an account WatchDesk refuses (403) says what to do, and how many are waiting (WD-110)", () => {
    expect(describeWatchSync(withListings({ failed: true, reason: "forbidden", queued: 3 }), NOW)).toEqual({
      tone: "warning",
      lastSynced: "Last synced 2m ago",
      text: "WatchDesk isn't accepting listings from this account. Verify your email address on WatchDesk · 3 listings waiting to be sent",
    });
    // The reason belongs to a failure: once the listings got through it says nothing.
    expect(describeWatchSync(withListings({ failed: false, reason: "forbidden" }), NOW).text).toBe("Nothing waiting to be sent");
  });

  it("offline with a queue keeps its own wording and adds how many are waiting", () => {
    expect(
      describeWatchSync(withListings({ lastIngestedAt: minutesAgo(12), failed: true, queued: 3 }, { offline: true }), NOW),
    ).toEqual({
      tone: "offline",
      lastSynced: "Last synced 2m ago",
      text: "Offline — couldn't reach WatchDesk. Your watches are shown as last synced. They can't be changed until it's back. 3 listings waiting to be sent.",
    });
  });

  it("counts what is waiting while the first watch sync is still to come", () => {
    expect(describeWatchSync(withListings({ queued: 2 }, { lastSyncedAt: null }), NOW).text).toBe(
      "Syncing your watches with WatchDesk… · 2 listings waiting to be sent",
    );
  });

  it("warns that listings were dropped, and how many, even after everything else got through", () => {
    expect(describeWatchSync(withListings({ lastIngestedAt: NOW, dropped: 120 }), NOW)).toEqual({
      tone: "warning",
      lastSynced: "Last synced just now",
      text: `Nothing waiting to be sent · ${DROPPED_120}`,
    });
    expect(describeWatchSync(withListings({ lastIngestedAt: NOW, dropped: 1 }), NOW).text).toContain(
      "the oldest unsent listing was dropped",
    );
  });

  it("shows the dropped warning in every connected state", () => {
    const failing = describeWatchSync(withListings({ failed: true, queued: 2000, dropped: 120 }), NOW);
    expect(failing.tone).toBe("warning");
    expect(failing.text).toContain("2000 listings waiting to be sent");
    expect(failing.text).toContain(DROPPED_120);

    const refused = describeWatchSync(withListings({ failed: true, reason: "forbidden", queued: 2000, dropped: 120 }), NOW);
    expect(refused.text).toContain("Verify your email address on WatchDesk");
    expect(refused.text).toContain(DROPPED_120);

    const offline = describeWatchSync(withListings({ queued: 2000, dropped: 120 }, { offline: true }), NOW);
    expect(offline.tone).toBe("offline");
    expect(offline.text).toContain(DROPPED_120);

    const syncing = describeWatchSync(withListings({ dropped: 120 }, { lastSyncedAt: null }), NOW);
    expect(syncing).toMatchObject({ tone: "warning", text: `Syncing your watches with WatchDesk… · ${DROPPED_120}` });
  });

  it("comes before the count of watches that are only in this browser", () => {
    expect(describeWatchSync(withListings({ queued: 5 }, { localOnly: 1 }), NOW).text).toBe(
      "5 listings waiting to be sent · 1 watch is only in this browser, not on WatchDesk.",
    );
  });

  it("ignores counts that are not counts", () => {
    expect(describeWatchSync(withListings({ queued: "many", dropped: -3 }), NOW)).toEqual({
      tone: "ok",
      lastSynced: "Last synced 2m ago",
      text: "Nothing waiting to be sent",
    });
  });
});

describe("describeWatchSync: a watcher state WatchDesk has not been given (WD-71)", () => {
  const base = { mode: "account", offline: false, lastSyncedAt: minutesAgo(2), localOnly: 0 };
  const listings = { lastIngestedAt: null, failed: false, queued: 0, dropped: 0 };

  it("says nothing about it while WatchDesk has the state", () => {
    for (const watcherUnsent of [null, undefined, false, "stopped"]) {
      expect(describeWatchSync({ ...base, listings, watcherUnsent }, NOW)).toEqual({
        tone: "ok",
        lastSynced: "Last synced 2m ago",
        text: "Nothing waiting to be sent",
      });
    }
  });

  it.each(["paused", "running"])("warns that WatchDesk has not been told watching is %s, and that it will be", (state) => {
    expect(describeWatchSync({ ...base, listings, watcherUnsent: state }, NOW)).toEqual({
      tone: "warning",
      lastSynced: "Last synced 2m ago",
      text: `Nothing waiting to be sent · WatchDesk hasn't been told that watching is ${state} yet; it will be sent again`,
    });
  });

  it("offline stays offline and says it too", () => {
    const view = describeWatchSync({ ...base, offline: true, listings, watcherUnsent: "paused" }, NOW);
    expect(view.tone).toBe("offline");
    expect(view.text).toMatch(/^Offline — couldn't reach WatchDesk\./);
    expect(view.text).toContain("WatchDesk hasn't been told that watching is paused yet; it will be sent again");
  });

  it("holds no time, so the live region is not rewritten as the minutes pass", () => {
    const status = { ...base, listings, watcherUnsent: "paused" };
    expect(describeWatchSync(status, NOW + 5 * 60000).text).toBe(describeWatchSync(status, NOW).text);
  });
});

describe("renderWatchSync", () => {
  const line = () => doc.getElementById("watch-sync-status");
  const last = () => doc.getElementById("watch-sync-last").textContent;
  const text = () => doc.getElementById("watch-sync-text").textContent;
  const synced = (listings, more = {}) => ({
    mode: "account",
    offline: false,
    lastSyncedAt: minutesAgo(4),
    localOnly: 0,
    listings: { lastIngestedAt: null, failed: false, queued: 0, dropped: 0, ...listings },
    ...more,
  });

  it("is hidden in the markup, and stays hidden with no account connected", () => {
    expect(line().hidden).toBe(true);
    renderWatchSync({ mode: "local" }, doc, NOW);
    expect(line().hidden).toBe(true);
    expect(line().textContent.trim()).toBe("");
  });

  it("shows 'last synced' and the pending count for a connected account", () => {
    renderWatchSync(synced({ lastIngestedAt: minutesAgo(9), queued: 12 }), doc, NOW);
    expect(line().hidden).toBe(false);
    expect(line().dataset.tone).toBe("ok");
    expect(last()).toBe("Last synced 4m ago");
    expect(text()).toBe("12 listings waiting to be sent");
  });

  it("then hides again when the account is disconnected", () => {
    renderWatchSync(synced(), doc, NOW);
    renderWatchSync({ mode: "local" }, doc, NOW);
    expect(line().hidden).toBe(true);
    expect(last()).toBe("");
    expect(text()).toBe("");
  });

  it("is one status area: inside the account card, above the watch list, with no second indicator (WD-73)", () => {
    renderWatchSync(synced(), doc, NOW);
    expect(doc.getElementById("account-card").contains(line())).toBe(true);
    expect(doc.querySelectorAll(".watch-sync-status")).toHaveLength(1);
    expect(doc.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(line().compareDocumentPosition(doc.getElementById("watch-list")) & 4).toBe(4);
    // The card comes before everything but the title bar and the update banner.
    expect(doc.getElementById("account-card").compareDocumentPosition(doc.getElementById("settings-panel")) & 4).toBe(4);
  });

  it("announces the state politely and leaves the ticking time out of the live region", () => {
    const state = doc.getElementById("watch-sync-text");
    const time = doc.getElementById("watch-sync-last");
    expect(state.getAttribute("role")).toBe("status");
    // No live region around the time: not on it, and on nothing above it.
    for (let el = time; el; el = el.parentElement) {
      expect(el.hasAttribute("aria-live")).toBe(false);
      expect(el.hasAttribute("role")).toBe(false);
    }
    // Still there to be read: the time is not hidden from a screen reader.
    expect(time.hasAttribute("aria-hidden")).toBe(false);
  });

  it("as the minutes pass, moves the time and does not rewrite the state", () => {
    const status = synced({ queued: 3 });
    renderWatchSync(status, doc, NOW);
    const state = doc.getElementById("watch-sync-text");
    const written = state.firstChild;

    let rewrites = 0;
    const observer = new doc.defaultView.MutationObserver((records) => (rewrites += records.length));
    observer.observe(state, { childList: true, characterData: true, subtree: true });
    for (let tick = 1; tick <= 20; tick++) renderWatchSync(status, doc, NOW + tick * 30000);
    rewrites += observer.takeRecords().length;
    observer.disconnect();

    expect(last()).toBe("Last synced 14m ago");
    expect(rewrites).toBe(0);
    expect(state.firstChild).toBe(written);

    // A change of state is written.
    renderWatchSync(synced({ queued: 4 }), doc, NOW + 20 * 30000);
    expect(text()).toBe("4 listings waiting to be sent");
  });

  it("shows an offline indicator with what is waiting", () => {
    renderWatchSync(synced({ failed: true, queued: 7 }, { offline: true }), doc, NOW);
    expect(line().dataset.tone).toBe("offline");
    expect(last()).toBe("Last synced 4m ago");
    expect(text()).toMatch(/^Offline — couldn't reach WatchDesk\./);
    expect(text()).toContain("7 listings waiting to be sent.");
  });

  it("shows what to do when WatchDesk refuses the account (403)", () => {
    renderWatchSync(synced({ failed: true, reason: "forbidden", queued: 7 }), doc, NOW);
    expect(line().dataset.tone).toBe("warning");
    expect(text()).toBe(
      "WatchDesk isn't accepting listings from this account. Verify your email address on WatchDesk · 7 listings waiting to be sent",
    );
  });

  it("shows dropped listings as a warning in the same line (WD-60)", () => {
    renderWatchSync(synced({ lastIngestedAt: NOW, dropped: 37 }), doc, NOW);
    expect(line().hidden).toBe(false);
    expect(line().dataset.tone).toBe("warning");
    expect(text()).toContain("the 37 oldest unsent listings were dropped");
  });

  it("says every state in words, so the tone's colour is never the only signal", () => {
    const views = [
      synced(),
      synced({ queued: 3 }),
      synced({ failed: true }),
      synced({ failed: true, reason: "forbidden" }),
      synced({ dropped: 2 }),
      synced({}, { offline: true }),
      synced({}, { lastSyncedAt: null }),
    ].map((status) => describeWatchSync(status, NOW));
    expect(new Set(views.map((view) => view.text)).size).toBe(views.length);
    for (const view of views) expect(view.text).not.toBe("");
  });

  it("writes text, never markup", () => {
    renderWatchSync(synced({}, { localOnly: "<img src=x>" }), doc, NOW);
    expect(line().querySelector("img")).toBeNull();
  });

  it("is shown only while the card says connected: a revoked token (401) leaves 'not connected' and no sync line", () => {
    renderAccountCard({ status: "connected", email: "ada@example.com", deviceLabel: null }, doc);
    renderWatchSync(synced({ queued: 3 }), doc, NOW);
    expect(doc.getElementById("account-title").textContent).toBe("ada@example.com");

    // The worker's broadcast reaches the card first; the sync state follows.
    renderAccountCard({ status: "not-connected", outcome: { reason: "revoked" } }, doc);
    expect(doc.getElementById("account-card").dataset.state).toBe("not-connected");
    expect(doc.getElementById("account-title").textContent).toBe("Not connected to WatchDesk");
    const css = readFileSync("popup.css", "utf8");
    expect(css).toMatch(/\.account-card:not\(\[data-state="connected"\]\) \.watch-sync-status\s*\{\s*display: none;/);

    renderWatchSync({ mode: "local" }, doc, NOW);
    expect(line().hidden).toBe(true);
  });

  it("styles the warning like the offline line", () => {
    const css = readFileSync("popup.css", "utf8");
    expect(css).toMatch(/\.watch-sync-status\[data-tone="offline"\],\s*\.watch-sync-status\[data-tone="warning"\]\s*\{/);
  });

  it("does nothing on a page without the line", () => {
    const empty = new JSDOM("<body></body>").window.document;
    expect(() => renderWatchSync({ mode: "account", offline: true, lastSyncedAt: null, localOnly: 0 }, empty, NOW)).not.toThrow();
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
