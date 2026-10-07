// Runs the real popup (popup.html + popup.js, in jsdom) against the real
// service worker (background.js), joined by the mocked chrome.* API and the
// scripted WatchDesk of fake-watchdesk.js (WD-72).
//
// A test clicks a control and then checks two things: the message the popup
// sent, and what the worker wrote to storage because of it. Both are what
// "works as shipped" means for a control.
//
// What is approximated:
//   - one chrome object serves both sides, so a message is routed by its
//     type: the four the worker sends go to the popup (or the offscreen
//     document, which is stubbed), every other one goes to the worker;
//   - chrome.tabs.query({ url }) treats the pattern as a glob over the whole
//     URL, which is what a match pattern is for the URLs used here;
//   - closing a popup clears every pending timer, the worker's included.
//
// POPUP_PARITY_ROOT points the harness at another copy of the extension (the
// shipped one, for example) so the tests that describe shipped behaviour can
// be run against it unchanged. Unset, it is this repository.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { JSDOM, VirtualConsole } from "jsdom";
import { vi } from "vitest";
import { installChromeMock } from "./chrome-mock.js";
import { installFakeWatchDesk, TEST_TOKEN } from "./fake-watchdesk.js";
import { WATCHDESK_ORIGIN } from "../../config.js";
import { TOKEN_KEY } from "../../account-connection.js";

export const REFERENCE_ROOT = process.env.POPUP_PARITY_ROOT || null;
const ROOT = resolve(REFERENCE_ROOT || ".");
const moduleUrl = (file) => pathToFileURL(resolve(ROOT, file)).href;

export const NOW = Date.parse("2026-10-05T09:00:00Z");

// Sent by the worker; everything else comes from the popup.
const FROM_WORKER = new Set([
  "parse-html",
  "play-sound",
  "watch-sync-changed",
  "account-state-changed",
  "local-import-changed",
  "settings-changed",
]);

export const OJ_URL = "https://www.onlinejobs.ph/jobseekers/jobsearch";
export const GLASSDOOR_URL = "https://www.glassdoor.com/Job/remote-react-jobs-SRCH_IL.0,6_IS11047_KO7,12.htm";
export const LINKEDIN_REACT_URL = "https://www.linkedin.com/jobs/search/?keywords=react&sortBy=DD";
export const LINKEDIN_VUE_URL = "https://www.linkedin.com/jobs/search/?keywords=vue&sortBy=DD";
export const UPWORK_URL = "https://www.upwork.com/nx/search/jobs/?q=react&sort=recency";

// A browser that has been in use: a background site, the three sites that
// need a tab, and one paused watch.
export const WATCHES = [
  { id: "default", siteId: "onlinejobsph", url: OJ_URL, label: "All OnlineJobs.ph postings", enabled: true },
  { id: "w_1759000000001_gdaaa", siteId: "glassdoor", url: GLASSDOOR_URL, label: "Glassdoor React", enabled: true },
  { id: "w_1759000000002_liaaa", siteId: "linkedin", url: LINKEDIN_REACT_URL, label: "LinkedIn React", enabled: true },
  { id: "w_1759000000003_libbb", siteId: "linkedin", url: LINKEDIN_VUE_URL, label: "LinkedIn Vue", enabled: false },
  { id: "w_1759000000004_upaaa", siteId: "upwork", url: UPWORK_URL, label: "Upwork React", enabled: true },
];

// Both ways a browser can be running. Connected, the same watches have been
// uploaded to the account by the first sync and carry its ids.
export const MODES = [
  { mode: "with no account connected", connected: false },
  { mode: "with a WatchDesk account connected", connected: true },
];
// Against another copy of the extension there is only the first.
export const TESTED_MODES = REFERENCE_ROOT ? MODES.slice(0, 1) : MODES;

// How WatchDesk stores the URL of a watch it is sent (WD-111): its own copy
// of the LinkedIn rule, `normalizeLinkedInUrl` in the WatchDesk repository's
// lib/sites.ts, written out here because that is the server's code, not the
// extension's. Connected, the canonical form of a watch's URL is WatchDesk's
// doing; the extension stores what WatchDesk answers.
export function asWatchDeskSaves(rawUrl) {
  if (!URL.canParse(rawUrl)) return rawUrl;
  const url = new URL(rawUrl);
  if (url.hostname !== "linkedin.com" && !url.hostname.endsWith(".linkedin.com")) return rawUrl;
  url.pathname = url.pathname.replace(/\/jobs\/search-results\/?/, "/jobs/search/");
  if (!url.pathname.startsWith("/jobs/search")) return rawUrl;
  for (const param of ["currentJobId", "origin", "referralSearchId"]) url.searchParams.delete(param);
  url.searchParams.set("sortBy", "DD");
  return url.toString();
}

function matchesPattern(pattern, url) {
  const glob = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${glob}$`).test(String(url).split("#")[0]);
}

// One real turn of the event loop: every promise chain that can finish
// without a (faked) timer has finished.
const turn = () => new Promise((done) => setImmediate(done));

// Starts the service worker on a browser with `watches` stored.
//   connected  a device token is stored, and (unless synced: false) the
//              first sync has already run
//   sync/local extra chrome.storage contents
export async function startExtension({ connected = false, synced = true, watches = WATCHES, sync = {}, local = {} } = {}) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date(NOW));

  const env = installChromeMock();
  const api = installFakeWatchDesk({ saveUrl: asWatchDeskSaves });
  const { chrome } = env;
  let pending = 0;
  let workerListeners = [];
  let popup = null;

  const ext = {
    chrome,
    api,
    connected,
    // Every message the popup has sent since the last take().
    sent: [],
    take: () => ext.sent.splice(0),
    // Tones the offscreen document was asked to play.
    sounds: [],
    // What each background-fetched site's page parses to, by site id.
    pages: {},
    sync: () => chrome.storage.sync.dump(),
    local: () => chrome.storage.local.dump(),
    watches: () => chrome.storage.sync.dump().watches,
    // A watch as stored now: connected, its id is the account's.
    watch: (label) => ext.watches().find((w) => w.label === label),
    watchdeskCalls: () => api.requests.filter((r) => r.origin === WATCHDESK_ORIGIN),
    // A tab the user already has open.
    openTab: (url) => {
      const tab = { id: 900 + env.openTabs.size, windowId: 1, url, active: false };
      env.openTabs.set(tab.id, tab);
      return tab;
    },
    createdTabs: () => chrome.tabs.create.mock.calls.map(([options]) => options),
    // Sends a message the way the popup does, without a popup.
    send: (message) => chrome.runtime.sendMessage(message),
    settle: async () => {
      let turns = 0;
      do {
        await turn();
        turns += 1;
      } while (pending > 0 && turns < 50);
      await turn();
    },
  };

  chrome.runtime.getContexts = vi.fn(async () => [{}]);
  chrome.tabs.query = vi.fn(async ({ url } = {}) =>
    [...env.openTabs.values()].filter((tab) => !url || matchesPattern(url, tab.url)).map((tab) => ({ ...tab })),
  );
  chrome.runtime.sendMessage = vi.fn(async (message) => {
    const type = message?.type;
    if (type === "parse-html") return { ok: true, jobs: structuredClone(ext.pages[message.siteId] ?? []) };
    if (type === "play-sound") {
      ext.sounds.push(message.soundId);
      return { ok: true };
    }
    if (FROM_WORKER.has(type)) {
      const pageListeners = chrome.runtime.onMessage.listeners.filter((fn) => !workerListeners.includes(fn));
      if (pageListeners.length === 0) throw new Error("Could not establish connection. Receiving end does not exist.");
      for (const listener of pageListeners) listener(structuredClone(message), {}, () => {});
      return undefined;
    }
    ext.sent.push(structuredClone(message));
    pending += 1;
    try {
      const answer = await new Promise((answered) => {
        for (const listener of workerListeners) listener(structuredClone(message), {}, answered);
      });
      return answer === undefined ? undefined : structuredClone(answer);
    } finally {
      pending -= 1;
    }
  });

  await chrome.storage.sync.set({ ...(watches ? { watches } : {}), ...sync });
  await chrome.storage.local.set({ ...local, ...(connected ? { [TOKEN_KEY]: TEST_TOKEN } : {}) });

  vi.resetModules();
  await import(/* @vite-ignore */ moduleUrl("background.js"));
  workerListeners = [...chrome.runtime.onMessage.listeners];

  if (connected) {
    // WD-79: connected, the account's settings are the ones this browser
    // has, as its watches are the ones this browser had: a test starts from
    // the same settings in both modes.
    const { intervalMinutes, soundId, notificationsMuted, titleFilter } = (await ext.send({ type: "get-state" })).settings;
    api.setSettings({ intervalMinutes, soundId, notificationsMuted, titleFilter });
    if (synced) {
      await ext.send({ type: "sync-watches" });
      await ext.send({ type: "sync-settings" });
    }
    ext.take();
  }

  // WD-81: pairs the browser for real: "Connect Account", the approval on
  // WatchDesk, the poll that collects the token, and WatchDesk naming the
  // account. What a browser that was already in use does next is the import
  // question.
  ext.pair = async () => {
    await ext.send({ type: "account-connect" });
    api.queuePoll(api.approved);
    await vi.advanceTimersByTimeAsync(3000);
    await ext.settle();
    ext.take();
  };

  // WD-81: a new service worker on the same storage, as after Chrome stops
  // one. Whatever the old one was in the middle of is never finished by it
  // if the request it was waiting on never answers.
  ext.restartWorker = async () => {
    const { listeners } = chrome.runtime.onMessage;
    for (let i = listeners.length - 1; i >= 0; i -= 1) {
      if (workerListeners.includes(listeners[i])) listeners.splice(i, 1);
    }
    for (const event of [chrome.alarms.onAlarm, chrome.tabs.onRemoved, chrome.runtime.onInstalled, chrome.runtime.onStartup]) {
      event.listeners.length = 0;
    }
    const pageListeners = [...chrome.runtime.onMessage.listeners];
    vi.resetModules();
    await import(/* @vite-ignore */ moduleUrl("background.js"));
    workerListeners = chrome.runtime.onMessage.listeners.filter((fn) => !pageListeners.includes(fn));
    await ext.settle();
  };

  // Opens the popup and waits for its first render (and, connected, for the
  // sync it asks for). The messages it sent while opening are in `opening`.
  ext.openPopup = async ({ confirm = true } = {}) => {
    if (popup) popup.close();
    const html = readFileSync(resolve(ROOT, "popup.html"), "utf8").replace(/<script[^>]*><\/script>/g, "");
    const dom = new JSDOM(html, { url: "https://popup.invalid/popup.html", virtualConsole: new VirtualConsole() });
    const { window } = dom;
    const { document } = window;
    window.open = vi.fn();
    // Export clicks a link it has just made; jsdom would try to navigate.
    const downloads = [];
    window.HTMLAnchorElement.prototype.click = function click() {
      downloads.push({ href: this.href, download: this.download });
    };
    globalThis.window = window;
    globalThis.document = document;
    globalThis.confirm = vi.fn(() => confirm);

    const $ = (id) => document.getElementById(id);
    const fire = (el, type, init = {}) => el.dispatchEvent(new window.Event(type, { bubbles: true, ...init }));
    const page = {
      window,
      document,
      $,
      downloads,
      confirm: globalThis.confirm,
      settle: ext.settle,
      text: (id) => $(id).textContent.replace(/\s+/g, " ").trim(),
      click: async (el) => {
        el.click();
        await ext.settle();
      },
      // Picks a value in a select or a text input and fires "change".
      choose: async (el, value) => {
        el.value = value;
        fire(el, "change");
        await ext.settle();
      },
      check: async (el, checked) => {
        el.checked = checked;
        fire(el, "change");
        await ext.settle();
      },
      type: (el, value) => {
        el.value = value;
        fire(el, "input");
      },
      key: async (el, key) => {
        el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        await ext.settle();
      },
      // The buttons of the watch whose label is `label`.
      watchItem: (label) =>
        [...document.querySelectorAll(".watch-item")].find((item) => item.querySelector(".label").textContent === label),
      button: (root, text) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === text),
      labels: () => [...document.querySelectorAll(".watch-item .label")].map((el) => el.textContent),
      close: () => {
        if (popup !== page) return;
        popup = null;
        const { listeners } = chrome.runtime.onMessage;
        for (let i = listeners.length - 1; i >= 0; i -= 1) {
          if (!workerListeners.includes(listeners[i])) listeners.splice(i, 1);
        }
        vi.clearAllTimers();
        window.close();
        delete globalThis.window;
        delete globalThis.document;
        delete globalThis.confirm;
      },
    };
    popup = page;

    ext.take();
    vi.resetModules();
    await import(/* @vite-ignore */ moduleUrl("popup.js"));
    document.dispatchEvent(new window.Event("DOMContentLoaded"));
    await ext.settle();
    page.opening = ext.take();
    return page;
  };

  ext.dispose = () => {
    if (popup) popup.close();
    vi.clearAllTimers();
    vi.useRealTimers();
  };

  return ext;
}
