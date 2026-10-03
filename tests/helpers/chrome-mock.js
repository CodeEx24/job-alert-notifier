// An in-memory stand-in for the parts of the chrome.* API the extension
// uses, installed as globalThis.chrome. Storage areas keep their data
// across vi.resetModules(), the way chrome.storage outlives a service
// worker restart; event listeners are dropped with dropListeners(), the way
// a restarted worker registers its own again.
import { vi } from "vitest";

function createStorageArea() {
  let data = {};
  const pick = (keys) => {
    if (keys == null) return { ...data };
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const key of list) {
      if (key in data) out[key] = structuredClone(data[key]);
      else if (keys && typeof keys === "object" && !Array.isArray(keys)) out[key] = keys[key];
    }
    return out;
  };
  return {
    get: vi.fn(async (keys) => pick(keys)),
    set: vi.fn(async (items) => {
      data = { ...data, ...structuredClone(items) };
    }),
    remove: vi.fn(async (keys) => {
      for (const key of typeof keys === "string" ? [keys] : keys) delete data[key];
    }),
    clear: vi.fn(async () => {
      data = {};
    }),
    // Test-only: the raw contents, and a way to wipe them (browser restart).
    dump: () => structuredClone(data),
    wipe: () => {
      data = {};
    },
  };
}

function createEvent() {
  const listeners = [];
  return {
    addListener: vi.fn((fn) => listeners.push(fn)),
    removeListener: vi.fn((fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    }),
    listeners,
    // Calls every listener, like Chrome dispatching the event; returns what
    // they returned so a test can await an async listener.
    dispatch: (...args) => Promise.all(listeners.map((fn) => fn(...args))),
  };
}

export function installChromeMock() {
  let nextTabId = 100;
  const openTabs = new Map();
  const alarms = new Map();

  const chrome = {
    storage: {
      local: createStorageArea(),
      sync: createStorageArea(),
      session: createStorageArea(),
    },
    tabs: {
      create: vi.fn(async ({ url, active = true }) => {
        const tab = { id: nextTabId++, windowId: 1, url, active };
        openTabs.set(tab.id, tab);
        return tab;
      }),
      update: vi.fn(async (tabId, props) => {
        const tab = openTabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        Object.assign(tab, props);
        return tab;
      }),
      query: vi.fn(async () => []),
      onRemoved: createEvent(),
    },
    windows: {
      update: vi.fn(async () => ({})),
    },
    alarms: {
      create: vi.fn(async (name, info) => {
        alarms.set(name, { name, ...info });
      }),
      clear: vi.fn(async (name) => alarms.delete(name)),
      get: vi.fn(async (name) => alarms.get(name)),
      onAlarm: createEvent(),
    },
    runtime: {
      onMessage: createEvent(),
      onInstalled: createEvent(),
      onStartup: createEvent(),
      getManifest: () => ({ version: "1.1.0" }),
    },
    notifications: {
      onClicked: createEvent(),
      onClosed: createEvent(),
      create: vi.fn(async () => "n"),
    },
    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
    },
  };

  const helpers = {
    openTabs,
    alarms,
    // The user closes a tab.
    closeTab: async (tabId) => {
      openTabs.delete(tabId);
      await chrome.tabs.onRemoved.dispatch(tabId, { windowId: 1, isWindowClosing: false });
    },
    // A new service worker: same storage, no listeners yet.
    dropListeners: () => {
      for (const event of [
        chrome.tabs.onRemoved,
        chrome.alarms.onAlarm,
        chrome.runtime.onMessage,
        chrome.runtime.onInstalled,
        chrome.runtime.onStartup,
        chrome.notifications.onClicked,
        chrome.notifications.onClosed,
      ]) {
        event.listeners.length = 0;
      }
    },
  };

  globalThis.chrome = chrome;
  return { chrome, ...helpers };
}
