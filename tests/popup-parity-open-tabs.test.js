// WD-72: "Open all tabs my watches need" and the two controls that share its
// code (a watch's "Open Link ↗" and the banner's "Open all ↗") behave as in
// the shipped extension (baseline §8.1), with no account connected and with
// one connected, where the watches carry WatchDesk's ids.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startExtension,
  TESTED_MODES,
  REFERENCE_ROOT,
  WATCHES,
  OJ_URL,
  GLASSDOOR_URL,
  LINKEDIN_REACT_URL,
  LINKEDIN_VUE_URL,
  UPWORK_URL,
} from "./helpers/popup-harness.js";

const BUTTON_LABEL = "Open all tabs my watches need ↗";
const background = (url) => ({ url, active: false });
const withEnabled = (label, enabled) => WATCHES.map((w) => (w.label === label ? { ...w, enabled } : w));

let ext;
afterEach(() => ext?.dispose());

async function openAll(options = {}) {
  ext = await startExtension(options);
  const popup = await ext.openPopup();
  return popup;
}

describe.each(TESTED_MODES)("Open All Tabs $mode", ({ connected }) => {
  it("opens one background tab per enabled watch that needs a tab, in list order", async () => {
    const popup = await openAll({ connected });
    await popup.click(popup.$("open-required-tabs"));

    // Not OnlineJobs.ph (checked in the background), not the paused watch.
    expect(ext.createdTabs()).toEqual([background(GLASSDOOR_URL), background(LINKEDIN_REACT_URL), background(UPWORK_URL)]);
    expect(popup.text("status")).toBe("opened 3 tabs.");
    expect(popup.window.open).not.toHaveBeenCalled();
  });

  it("is a button that says what it does, shows it is working, and comes back", async () => {
    const popup = await openAll({ connected });
    const button = popup.$("open-required-tabs");
    expect(button.textContent.trim()).toBe(BUTTON_LABEL);
    expect(button.title).toMatch(/^Opens a tab for every watch that needs one open/);

    let finishFirst;
    ext.chrome.tabs.create.mockImplementationOnce(
      ({ url, active }) => new Promise((done) => (finishFirst = () => done({ id: 500, windowId: 1, url, active }))),
    );
    await popup.click(button);
    expect(button.disabled).toBe(true);
    expect(button.classList.contains("is-busy")).toBe(true);
    expect(button.textContent).toBe("Opening…");
    expect(popup.text("status")).toBe("Opening tabs…");

    finishFirst();
    await popup.settle();
    expect(button.disabled).toBe(false);
    expect(button.classList.contains("is-busy")).toBe(false);
    expect(button.textContent.trim()).toBe(BUTTON_LABEL);
    expect(ext.createdTabs()).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(3500);
    expect(popup.text("status")).toBe("");
  });

  it("opens nothing for a paused watch, and says so when no watch needs a tab", async () => {
    const popup = await openAll({
      connected,
      watches: WATCHES.map((w) => ({ ...w, enabled: w.siteId === "onlinejobsph" })),
    });
    await popup.click(popup.$("open-required-tabs"));

    expect(ext.createdTabs()).toEqual([]);
    expect(popup.text("status")).toBe("No open tabs are needed right now.");
    await vi.advanceTimersByTimeAsync(2000);
    expect(popup.text("status")).toBe("");
  });

  it("says 'tab' for one", async () => {
    const popup = await openAll({ connected, watches: WATCHES.filter((w) => w.siteId !== "linkedin" && w.siteId !== "upwork") });
    await popup.click(popup.$("open-required-tabs"));
    expect(ext.createdTabs()).toEqual([background(GLASSDOOR_URL)]);
    expect(popup.text("status")).toBe("opened 1 tab.");
  });

  it("leaves a tab that is already on the watch's search alone, without focusing it", async () => {
    ext = await startExtension({ connected });
    ext.openTab(LINKEDIN_REACT_URL);
    const popup = await ext.openPopup();
    await popup.click(popup.$("open-required-tabs"));

    expect(ext.createdTabs()).toEqual([background(GLASSDOOR_URL), background(UPWORK_URL)]);
    expect(popup.text("status")).toBe("opened 2 tabs, 1 already open.");
    expect(ext.chrome.tabs.update).not.toHaveBeenCalled();
    expect(ext.chrome.windows.update).not.toHaveBeenCalled();
  });

  it("reuses a LinkedIn tab whose URL has drifted, and the one open tab of a site", async () => {
    ext = await startExtension({ connected });
    ext.openTab("https://www.linkedin.com/jobs/search/?currentJobId=4242&keywords=react&sortBy=DD");
    ext.openTab("https://www.upwork.com/nx/search/jobs/?q=react&sort=recency&page=2");
    const popup = await ext.openPopup();
    await popup.click(popup.$("open-required-tabs"));

    expect(ext.createdTabs()).toEqual([background(GLASSDOOR_URL)]);
    expect(popup.text("status")).toBe("opened 1 tab, 2 already open.");
  });

  it("opens a tab for each of two watches on one site: the first one's new tab is not taken for the second's", async () => {
    const popup = await openAll({ connected, watches: withEnabled("LinkedIn Vue", true) });
    await popup.click(popup.$("open-required-tabs"));

    expect(ext.createdTabs()).toEqual([
      background(GLASSDOOR_URL),
      background(LINKEDIN_REACT_URL),
      background(LINKEDIN_VUE_URL),
      background(UPWORK_URL),
    ]);
    expect(popup.text("status")).toBe("opened 4 tabs.");
  });

  it("one open tab on a site goes to the first watch that could own it, and the next gets its own", async () => {
    ext = await startExtension({ connected, watches: withEnabled("LinkedIn Vue", true) });
    ext.openTab("https://www.linkedin.com/jobs/search/?keywords=angular&sortBy=DD");
    const popup = await ext.openPopup();
    await popup.click(popup.$("open-required-tabs"));

    expect(ext.createdTabs()).toEqual([background(GLASSDOOR_URL), background(LINKEDIN_VUE_URL), background(UPWORK_URL)]);
    expect(popup.text("status")).toBe("opened 3 tabs, 1 already open.");
  });

  it("opens no tab where several are open and none is the watch's, and says how many", async () => {
    ext = await startExtension({ connected });
    ext.openTab("https://www.linkedin.com/jobs/search/?keywords=angular&sortBy=DD");
    ext.openTab("https://www.linkedin.com/jobs/search/?keywords=svelte&sortBy=DD");
    const popup = await ext.openPopup();
    await popup.click(popup.$("open-required-tabs"));

    expect(ext.createdTabs()).toEqual([background(GLASSDOOR_URL), background(UPWORK_URL)]);
    expect(popup.text("status")).toBe(
      "opened 2 tabs, 1 ambiguous (multiple tabs already open — close extras down to one).",
    );
  });

  it("opens one tab for two watches on the same search", async () => {
    const twin = { id: "w_1759000000005_gdbbb", siteId: "glassdoor", url: GLASSDOOR_URL, label: "Glassdoor again", enabled: true };
    // Connected, the first sync makes the two one watch (WD-54), so the
    // twin is added on WatchDesk, where two watches may share a URL.
    ext = await startExtension({ connected, watches: connected ? WATCHES : [...WATCHES, twin] });
    if (connected) ext.api.addWatch({ url: GLASSDOOR_URL, label: "Glassdoor again" });
    const popup = await ext.openPopup();
    expect(popup.labels()).toContain("Glassdoor again");
    await popup.click(popup.$("open-required-tabs"));

    expect(ext.createdTabs()).toEqual([background(GLASSDOOR_URL), background(LINKEDIN_REACT_URL), background(UPWORK_URL)]);
  });

  it("falls back to window.open when the tab cannot be created, and still counts it", async () => {
    const popup = await openAll({ connected, watches: WATCHES.filter((w) => w.siteId === "upwork") });
    ext.chrome.tabs.create.mockRejectedValueOnce(new Error("No current window"));
    await popup.click(popup.$("open-required-tabs"));

    expect(popup.window.open).toHaveBeenCalledWith(UPWORK_URL, "_blank", "noopener,noreferrer");
    expect(popup.text("status")).toBe("opened 1 tab.");
  });

  it("asks the worker for nothing and sends nothing to WatchDesk", async () => {
    const popup = await openAll({ connected });
    const calls = ext.api.requests.length;
    const stored = JSON.stringify([ext.sync(), ext.local()]);
    await popup.click(popup.$("open-required-tabs"));

    expect(ext.take()).toEqual([]);
    expect(ext.api.requests).toHaveLength(calls);
    expect(JSON.stringify([ext.sync(), ext.local()])).toBe(stored);
  });
});

describe.each(TESTED_MODES)("a watch's Open Link ↗ $mode", ({ connected }) => {
  const NO_TAB = "No open LinkedIn tab found for this search.";

  // The LinkedIn watch failed its last check. Connected, run state is kept
  // under the account's id for the watch.
  async function withFailedWatch() {
    ext = await startExtension({ connected });
    const { id } = ext.watch("LinkedIn React");
    await ext.chrome.storage.local.set({
      lastResult: { [id]: { count: null, newCount: 0, error: NO_TAB } },
      consecutiveErrors: { [id]: 3 },
    });
  }
  const openLink = (popup) => popup.watchItem("LinkedIn React").querySelector(".open-search-link");

  it("is offered under the error, with the stuck note after three failures", async () => {
    await withFailedWatch();
    const popup = await ext.openPopup();
    const item = popup.watchItem("LinkedIn React");

    expect(item.querySelector(".pill").textContent).toBe("Error");
    expect(item.querySelector(".meta .error").textContent).toBe(NO_TAB);
    expect(item.querySelector(".stuck-note").textContent).toMatch(/^Failing for 3 checks in a row/);
    expect(openLink(popup).textContent).toBe("Open Link ↗");
    expect(popup.watchItem("Upwork React").querySelector(".open-search-link")).toBeNull();
  });

  it("opens the search in a tab in front", async () => {
    await withFailedWatch();
    const popup = await ext.openPopup();
    await popup.click(openLink(popup));

    expect(ext.createdTabs()).toEqual([{ url: LINKEDIN_REACT_URL, active: true }]);
    expect(openLink(popup).textContent).toBe("Opened ✓");
    expect(openLink(popup).disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(2500);
    expect(openLink(popup).textContent).toBe("Open Link ↗");
    expect(openLink(popup).disabled).toBe(false);
  });

  it("switches to the tab when one is already open, drifted or not", async () => {
    await withFailedWatch();
    const tab = ext.openTab("https://www.linkedin.com/jobs/search/?currentJobId=4242&keywords=react&sortBy=DD");
    const popup = await ext.openPopup();
    await popup.click(openLink(popup));

    expect(ext.createdTabs()).toEqual([]);
    expect(ext.chrome.tabs.update).toHaveBeenCalledWith(tab.id, { active: true });
    expect(ext.chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    expect(openLink(popup).textContent).toBe("Switched to open tab ✓");
  });

  it("opens nothing when it cannot tell which open tab is the watch's", async () => {
    await withFailedWatch();
    ext.openTab("https://www.linkedin.com/jobs/search/?keywords=angular&sortBy=DD");
    ext.openTab("https://www.linkedin.com/jobs/search/?keywords=svelte&sortBy=DD");
    const popup = await ext.openPopup();
    await popup.click(openLink(popup));

    expect(ext.createdTabs()).toEqual([]);
    expect(openLink(popup).textContent).toBe("Multiple tabs open — close extras ↗");
  });
});

describe.each(TESTED_MODES)("the banner's Open all ↗ $mode", ({ connected }) => {
  it("opens the searches that need attention, paused ones included, and reports it", async () => {
    ext = await startExtension({ connected });
    const failed = { count: null, newCount: 0, error: "No open LinkedIn tab found for this search." };
    await ext.chrome.storage.local.set({
      lastResult: { [ext.watch("LinkedIn React").id]: failed, [ext.watch("LinkedIn Vue").id]: failed },
    });
    const popup = await ext.openPopup();
    const banner = popup.document.querySelector(".watch-list-banner");
    expect(banner.querySelector("span").textContent).toBe("2 searches need attention");

    await popup.click(popup.button(banner, "Open all ↗"));
    expect(ext.createdTabs()).toEqual([background(LINKEDIN_REACT_URL), background(LINKEDIN_VUE_URL)]);
    expect(banner.querySelector("span").textContent).toBe("opened 2.");
    await vi.advanceTimersByTimeAsync(4500);
    expect(banner.querySelector("span").textContent).toBe("2 searches need attention");
  });

  it("is not shown when no watch has an error", async () => {
    const popup = await openAll({ connected });
    expect(popup.$("watch-list-banner").children).toHaveLength(0);
  });
});

describe.skipIf(REFERENCE_ROOT)("Open All Tabs once the watches are the account's (WD-54 ids)", () => {
  const opened = async (options) => {
    const popup = await openAll(options);
    await popup.click(popup.$("open-required-tabs"));
    const result = { tabs: ext.createdTabs(), status: popup.text("status"), ids: ext.watches().map((w) => w.id) };
    ext.dispose();
    return result;
  };

  it("opens exactly the tabs it opened before the account was connected", async () => {
    const before = await opened({ connected: false });
    const after = await opened({ connected: true });

    expect(before.ids).toEqual(WATCHES.map((w) => w.id));
    for (const id of after.ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(after.tabs).toEqual(before.tabs);
    expect(after.status).toBe(before.status);
  });

  it("follows the account: no tab for a watch paused on the web, one for a watch added there", async () => {
    ext = await startExtension({ connected: true });
    ext.api.watches.find((w) => w.label === "Upwork React").enabled = false;
    const added = ext.api.addWatch({ url: "https://www.glassdoor.com/Job/remote-vue-jobs-SRCH_IL.0,6_IS11047_KO7,10.htm" });
    // The popup syncs the list when it opens.
    const popup = await ext.openPopup();
    await popup.click(popup.$("open-required-tabs"));

    expect(ext.createdTabs()).toEqual([background(GLASSDOOR_URL), background(LINKEDIN_REACT_URL), background(added.url)]);
  });

  it("works from the last-synced list while WatchDesk is unreachable", async () => {
    ext = await startExtension({ connected: true });
    ext.api.setWatchRoute(ext.api.networkError);
    const popup = await ext.openPopup();
    expect(popup.$("watch-sync-status").dataset.tone).toBe("offline");

    const calls = ext.api.requests.length;
    await popup.click(popup.$("open-required-tabs"));
    expect(ext.createdTabs()).toEqual([background(GLASSDOOR_URL), background(LINKEDIN_REACT_URL), background(UPWORK_URL)]);
    expect(ext.api.requests).toHaveLength(calls);
  });

  it("has nothing to open for an account with only background watches", async () => {
    ext = await startExtension({ connected: true, watches: [{ ...WATCHES[0], url: OJ_URL }] });
    const popup = await ext.openPopup();
    await popup.click(popup.$("open-required-tabs"));
    expect(ext.createdTabs()).toEqual([]);
    expect(popup.text("status")).toBe("No open tabs are needed right now.");
  });
});
