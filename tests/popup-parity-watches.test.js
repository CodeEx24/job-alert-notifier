// WD-72: the popup's watch list, "Watch a search" form, Check now and check
// status line behave as in the shipped extension (baseline §5, §7), with no
// account connected and with one connected. Connected, a change to the list
// is a call to WatchDesk (WD-54); the control, the message it sends and what
// the user ends up seeing are the same.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startExtension,
  TESTED_MODES,
  REFERENCE_ROOT,
  NOW,
  WATCHES,
  LINKEDIN_REACT_URL,
  UPWORK_URL,
} from "./helpers/popup-harness.js";

const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCAL_ID = /^w_\d+_[a-z0-9]{1,5}$/;
const NEW_URL = "https://www.upwork.com/nx/search/jobs/?q=laravel&sort=recency";

let ext;
afterEach(() => ext?.dispose());

describe.each(TESTED_MODES)("the popup's watch list $mode", ({ connected }) => {
  const start = async (options = {}) => {
    ext = await startExtension({ connected, ...options });
    return ext.openPopup();
  };
  const group = (popup, name) =>
    [...popup.document.querySelectorAll(".watch-group")].find((el) => el.querySelector(".watch-group-name").textContent === name);
  // What went to WatchDesk because of `act`, as [method, path, body].
  const watchdesk = async (act) => {
    const calls = ext.watchdeskCalls().length;
    await act();
    return ext
      .watchdeskCalls()
      .slice(calls)
      .map((r) => [r.method, r.path, r.body]);
  };

  it("lists every watch under its platform, in the platforms' fixed order, with its state", async () => {
    const popup = await start();

    expect(
      [...popup.document.querySelectorAll(".watch-group")].map((el) => [
        el.querySelector(".watch-group-name").textContent,
        el.querySelector(".watch-group-counts").textContent,
        [...el.querySelectorAll(".watch-item")].map((item) => `${item.querySelector(".label").textContent}: ${item.querySelector(".pill").textContent}`),
      ]),
    ).toEqual([
      ["OnlineJobs.ph", "1 active · 0 paused", ["All OnlineJobs.ph postings: Active"]],
      ["Glassdoor", "1 active · 0 paused", ["Glassdoor React: Active"]],
      ["LinkedIn", "1 active · 1 paused", ["LinkedIn React: Active", "LinkedIn Vue: Paused"]],
      ["Upwork", "1 active · 0 paused", ["Upwork React: Active"]],
    ]);

    const item = popup.watchItem("LinkedIn Vue");
    expect(item.querySelector(".label").title).toBe(WATCHES[3].url);
    expect([...item.querySelectorAll(".actions-row button")].map((b) => b.textContent)).toEqual(["Edit", "Resume", "Remove"]);
    expect(item.querySelector(".meta").textContent).toBe("Last checked never · not checked yet");
    expect([...popup.watchItem("LinkedIn React").querySelectorAll(".actions-row button")].map((b) => b.textContent)).toEqual([
      "Edit",
      "Pause",
      "Remove",
    ]);
  });

  it.skipIf(REFERENCE_ROOT)("the ids are this browser's, or the account's once connected", async () => {
    await start();
    for (const watch of ext.watches()) {
      if (connected) expect(watch.id).toMatch(SERVER_ID);
    }
    if (!connected) expect(ext.watches()).toEqual(WATCHES);
  });

  describe("Pause / Resume", () => {
    it("pauses a watch and resumes it", async () => {
      const popup = await start();
      const { id } = ext.watch("Upwork React");
      ext.take();

      const sentToWatchDesk = await watchdesk(() => popup.click(popup.button(popup.watchItem("Upwork React"), "Pause")));
      expect(ext.take()).toEqual([{ type: "toggle-watch", id, enabled: false }, { type: "get-state" }]);
      expect(ext.watch("Upwork React").enabled).toBe(false);
      expect(popup.watchItem("Upwork React").querySelector(".pill").textContent).toBe("Paused");
      expect(sentToWatchDesk).toEqual(connected ? [["PATCH", `/api/watches/${id}`, { enabled: false }]] : []);

      await popup.click(popup.button(popup.watchItem("Upwork React"), "Resume"));
      expect(ext.take()).toEqual([{ type: "toggle-watch", id, enabled: true }, { type: "get-state" }]);
      expect(ext.watch("Upwork React").enabled).toBe(true);
      expect(popup.watchItem("Upwork React").querySelector(".pill").textContent).toBe("Active");
    });

    it("a platform's own Pause and Resume cover its watches only", async () => {
      const popup = await start();
      ext.take();
      expect(popup.button(group(popup, "Glassdoor"), "Resume").disabled).toBe(true);

      await popup.click(popup.button(group(popup, "LinkedIn").querySelector(".watch-group-actions"), "Pause"));
      expect(ext.take()).toEqual([{ type: "set-site-enabled", siteId: "linkedin", enabled: false }, { type: "get-state" }]);
      expect(ext.watches().map((w) => w.enabled)).toEqual([true, true, false, false, true]);
      expect(group(popup, "LinkedIn").querySelector(".watch-group-counts").textContent).toBe("0 active · 2 paused");

      await popup.click(popup.button(group(popup, "LinkedIn").querySelector(".watch-group-actions"), "Resume"));
      expect(ext.take()).toEqual([{ type: "set-site-enabled", siteId: "linkedin", enabled: true }, { type: "get-state" }]);
      expect(ext.watches().map((w) => w.enabled)).toEqual([true, true, true, true, true]);
    });
  });

  describe("Remove", () => {
    it("removes the watch and what was remembered about its page", async () => {
      ext = await startExtension({ connected });
      const { id } = ext.watch("Upwork React");
      const kept = ext.watch("Glassdoor React").id;
      await ext.chrome.storage.local.set({
        seenIds: { [id]: ["a"], [kept]: ["b"] },
        lastChecked: { [id]: NOW, [kept]: NOW },
        lastResult: { [id]: { count: 1, newCount: 0, error: null } },
      });
      const popup = await ext.openPopup();
      ext.take();

      const sentToWatchDesk = await watchdesk(() => popup.click(popup.button(popup.watchItem("Upwork React"), "Remove")));
      expect(ext.take()).toEqual([{ type: "remove-watch", id }, { type: "get-state" }]);
      expect(ext.watches().map((w) => w.label)).toEqual(WATCHES.slice(0, 4).map((w) => w.label));
      expect(popup.labels()).not.toContain("Upwork React");
      expect(group(popup, "Upwork")).toBeUndefined();
      expect(ext.local()).toMatchObject({ seenIds: { [kept]: ["b"] }, lastChecked: { [kept]: NOW }, lastResult: {} });
      expect(sentToWatchDesk).toEqual(connected ? [["DELETE", `/api/watches/${id}`, undefined]] : []);
    });
  });

  describe("Edit (rename)", () => {
    const editing = async (popup, label) => {
      await popup.click(popup.button(popup.watchItem(label), "Edit"));
      return popup.watchItem(label).querySelector(".edit-row input");
    };

    it("opens a box holding the title, at most 80 characters, and closes it again", async () => {
      const popup = await start();
      ext.take();
      const input = await editing(popup, "Glassdoor React");
      expect(input.value).toBe("Glassdoor React");
      expect(input.maxLength).toBe(80);
      expect([...popup.watchItem("Glassdoor React").querySelectorAll(".edit-row button")].map((b) => b.textContent)).toEqual(["Save", "Cancel"]);

      await popup.click(popup.button(popup.watchItem("Glassdoor React"), "Edit"));
      expect(popup.watchItem("Glassdoor React").querySelector(".edit-row")).toBeNull();
      expect(ext.take()).toEqual([]);
    });

    it.each(["Save", "Enter"])("%s renames the watch", async (how) => {
      const popup = await start();
      const { id } = ext.watch("Glassdoor React");
      const input = await editing(popup, "Glassdoor React");
      ext.take();
      input.value = "  Remote React  ";

      const sentToWatchDesk = await watchdesk(() =>
        how === "Save" ? popup.click(popup.button(popup.watchItem("Glassdoor React"), "Save")) : popup.key(input, "Enter"),
      );
      expect(ext.take()).toEqual([{ type: "rename-watch", id, label: "Remote React" }, { type: "get-state" }]);
      expect(ext.watches().find((w) => w.id === id).label).toBe("Remote React");
      expect(popup.labels()).toContain("Remote React");
      expect(popup.document.querySelector(".edit-row")).toBeNull();
      expect(sentToWatchDesk).toEqual(connected ? [["PATCH", `/api/watches/${id}`, { label: "Remote React" }]] : []);
    });

    it.each(["Cancel", "Escape"])("%s leaves the title as it was", async (how) => {
      const popup = await start();
      const input = await editing(popup, "Glassdoor React");
      ext.take();
      input.value = "Something else";
      if (how === "Cancel") await popup.click(popup.button(popup.watchItem("Glassdoor React"), "Cancel"));
      else await popup.key(input, "Escape");

      expect(ext.take()).toEqual([]);
      expect(popup.document.querySelector(".edit-row")).toBeNull();
      expect(popup.labels()).toContain("Glassdoor React");
    });

    it("refuses an empty title without asking the worker", async () => {
      const popup = await start();
      const input = await editing(popup, "Glassdoor React");
      ext.take();
      input.value = "   ";
      await popup.click(popup.button(popup.watchItem("Glassdoor React"), "Save"));

      expect(ext.take()).toEqual([]);
      expect(popup.watchItem("Glassdoor React").querySelector(":scope > .error").textContent).toBe("Title can't be empty.");
      expect(popup.watchItem("Glassdoor React").querySelector(".edit-row")).not.toBeNull();
    });
  });

  describe("collapsing a platform", () => {
    it("its header folds and unfolds its watches", async () => {
      const popup = await start();
      const toggle = () => group(popup, "LinkedIn").querySelector(".watch-group-toggle");
      const body = () => group(popup, "LinkedIn").querySelector(".watch-group-body");
      expect(toggle().getAttribute("aria-expanded")).toBe("true");
      expect(body().classList.contains("collapsed")).toBe(false);

      await popup.click(toggle());
      expect(toggle().getAttribute("aria-expanded")).toBe("false");
      expect(body().classList.contains("collapsed")).toBe(true);
      await popup.click(toggle());
      expect(body().classList.contains("collapsed")).toBe(false);
    });

    it("starts folded once a platform has more than three watches", async () => {
      const extra = ["angular", "svelte"].map((q, i) => ({
        id: `w_175900000001${i}_lixxx`,
        siteId: "linkedin",
        url: `https://www.linkedin.com/jobs/search/?keywords=${q}&sortBy=DD`,
        label: `LinkedIn ${q}`,
        enabled: true,
      }));
      const popup = await start({ watches: [...WATCHES, ...extra] });
      expect(group(popup, "LinkedIn").querySelector(".watch-group-body").classList.contains("collapsed")).toBe(true);
      expect(group(popup, "Glassdoor").querySelector(".watch-group-body").classList.contains("collapsed")).toBe(false);
    });
  });

  describe("Watch a search", () => {
    const add = async (popup, url, label = "") => {
      popup.$("new-url").value = url;
      popup.$("new-label").value = label;
      ext.take();
      await popup.click(popup.$("add-watch"));
    };

    it.each([
      ["", "Paste a search URL first."],
      ["   ", "Paste a search URL first."],
      ["not a url", "That doesn't look like a valid URL."],
    ])("refuses %j itself: %s", async (url, message) => {
      const popup = await start();
      await add(popup, url, "Mine");
      expect(ext.take()).toEqual([]);
      expect(popup.text("add-error")).toBe(message);
      expect(ext.watches()).toHaveLength(5);
    });

    it("adds a watch on a supported site, shows it, and empties the form", async () => {
      const popup = await start();
      const sentToWatchDesk = await watchdesk(() => add(popup, `  ${NEW_URL} `, " Laravel gigs "));

      expect(ext.take()).toEqual([{ type: "add-watch", url: NEW_URL, label: "Laravel gigs" }, { type: "get-state" }]);
      expect(ext.watch("Laravel gigs")).toMatchObject({ siteId: "upwork", url: NEW_URL, label: "Laravel gigs", enabled: true });
      expect(ext.watch("Laravel gigs").id).toMatch(connected ? SERVER_ID : LOCAL_ID);
      expect(ext.watches()).toHaveLength(6);
      expect([...group(popup, "Upwork").querySelectorAll(".label")].map((el) => el.textContent)).toEqual(["Upwork React", "Laravel gigs"]);
      expect(popup.$("new-url").value).toBe("");
      expect(popup.$("new-label").value).toBe("");
      expect(popup.text("add-error")).toBe("");
      expect(sentToWatchDesk).toEqual(connected ? [["POST", "/api/watches", { url: NEW_URL, label: "Laravel gigs" }]] : []);
    });

    it("names an unlabelled watch after its site", async () => {
      const popup = await start();
      await add(popup, NEW_URL);
      expect(ext.take()[0]).toEqual({ type: "add-watch", url: NEW_URL, label: "" });
      expect(ext.watches().at(-1)).toMatchObject({ siteId: "upwork", label: "Upwork" });
    });

    it("stores a LinkedIn search in its canonical, newest-first form", async () => {
      const popup = await start();
      await add(popup, "https://www.linkedin.com/jobs/search-results/?keywords=go&currentJobId=4242", "Go");
      expect(ext.watch("Go")).toMatchObject({ siteId: "linkedin", url: "https://www.linkedin.com/jobs/search/?keywords=go&sortBy=DD" });
    });

    // Baseline §9.7, left as it is: the shipped extension saves the watch
    // before saying the site is unsupported.
    it.skipIf(connected)("says an unsupported site is unsupported, and keeps the watch under Other", async () => {
      const popup = await start();
      await add(popup, "https://example.com/jobs", "Elsewhere");

      expect(ext.take()).toEqual([{ type: "add-watch", url: "https://example.com/jobs", label: "Elsewhere" }]);
      expect(popup.text("add-error")).toMatch(/^Unsupported site/);
      expect(popup.$("new-url").value).toBe("https://example.com/jobs");
      expect(ext.watch("Elsewhere")).toMatchObject({ siteId: null, url: "https://example.com/jobs", enabled: true });
      expect([...group(await ext.openPopup(), "Other").querySelectorAll(".label")].map((el) => el.textContent)).toEqual(["Elsewhere"]);
    });

    // WD-54, decision 11: WatchDesk refuses the URL and nothing is saved.
    it.skipIf(!connected)("shows WatchDesk's refusal of an unsupported site and saves nothing", async () => {
      const popup = await start();
      await add(popup, "https://example.com/jobs", "Elsewhere");

      expect(ext.take()).toEqual([{ type: "add-watch", url: "https://example.com/jobs", label: "Elsewhere" }, { type: "get-state" }]);
      expect(popup.text("add-error")).toBe("Enter a search URL on OnlineJobs.ph, Glassdoor, LinkedIn or Upwork");
      expect(popup.$("new-url").value).toBe("https://example.com/jobs");
      expect(ext.watches()).toHaveLength(5);
    });
  });

  describe("Check now and the status line", () => {
    const job = (n) => ({
      id: `13100${n}`,
      title: `PHP Developer ${n}`,
      url: `https://www.onlinejobs.ph/jobseekers/job/13100${n}`,
      postedRaw: "2026-10-05 09:15:00",
      postedAt: "2026-10-05T01:15:00.000Z",
      salaryRaw: null,
    });

    it("checks every active watch, shows it is working, and shows the results", async () => {
      const popup = await start();
      ext.api.setSite(() => new Response("<html></html>", { status: 200 }));
      ext.pages.onlinejobsph = [job(1), job(2)];
      expect(popup.text("check-status")).toBe("Not checked yet");
      ext.take();

      const button = popup.$("check-now");
      button.click();
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe("Checking…");
      expect(popup.text("status")).toBe("Checking…");
      await popup.settle();

      expect(ext.take()).toEqual([{ type: "check-now" }]);
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe("Check now");
      expect(popup.text("status")).toBe("Done.");
      expect(popup.text("check-status")).toBe("Checked just now");
      expect(ext.local().lastRunAt).toBe(NOW);
      expect(ext.api.requests.filter((r) => r.origin === "https://www.onlinejobs.ph").map((r) => r.url)).toEqual([WATCHES[0].url]);
      expect(popup.watchItem("All OnlineJobs.ph postings").querySelector(".meta").textContent).toMatch(/ · 2 jobs seen$/);
      // The three active watches that need a tab have none open.
      expect(popup.document.querySelector(".watch-list-banner span").textContent).toBe("3 searches need attention");
      expect(popup.watchItem("LinkedIn React").querySelector(".meta .error").textContent).toMatch(/^No open LinkedIn tab found for this search\./);
      expect(popup.watchItem("LinkedIn Vue").querySelector(".pill").textContent).toBe("Paused");

      await vi.advanceTimersByTimeAsync(1500);
      expect(popup.text("status")).toBe("");
    });

    it("reads a tab-only watch from its open tab", async () => {
      ext = await startExtension({ connected, watches: WATCHES.filter((w) => w.label === "LinkedIn React") });
      const tab = ext.openTab(LINKEDIN_REACT_URL);
      ext.chrome.tabs.onUpdated = { addListener: vi.fn(), removeListener: vi.fn() };
      ext.chrome.tabs.sendMessage = vi.fn(async () => ({
        ok: true,
        jobs: [{ id: "77", title: "React Engineer", url: "https://www.linkedin.com/jobs/view/77" }],
      }));
      const popup = await ext.openPopup();

      popup.$("check-now").click();
      // The worker reloads the tab, then waits for it (15 s at most) and
      // for the page to render (1.5 s).
      await vi.advanceTimersByTimeAsync(16500);
      await popup.settle();

      expect(ext.chrome.tabs.update).toHaveBeenCalledWith(tab.id, { url: LINKEDIN_REACT_URL });
      expect(ext.chrome.tabs.sendMessage).toHaveBeenCalledWith(tab.id, { type: "rescan", siteId: "linkedin" });
      expect(popup.watchItem("LinkedIn React").querySelector(".meta").textContent).toMatch(/ · 1 jobs seen$/);
      expect(popup.$("watch-list-banner").children).toHaveLength(0);
    });

    it("says when the last check ran and when the next one is due", async () => {
      ext = await startExtension({ connected, local: { lastRunAt: NOW - 2 * 60000 } });
      ext.chrome.alarms.get.mockResolvedValue({ name: "check-jobs", scheduledTime: NOW + 3 * 60000 });
      const popup = await ext.openPopup();
      expect(popup.text("check-status")).toBe("Checked 2m ago · next check in ~3m");
      expect(popup.$("check-status-gap").hidden).toBe(true);
    });

    it("says when the last check ran late", async () => {
      const popup = await start({ local: { lastRunAt: NOW, lastGap: { lateByMs: 10 * 60000, at: NOW } } });
      expect(popup.$("check-status-gap").hidden).toBe(false);
      expect(popup.text("check-status-gap")).toMatch(/^⚠ Catching up — the last check ran about 10m later than scheduled/);
    });

    it("warns when checks have stopped although one is still scheduled", async () => {
      ext = await startExtension({ connected, local: { lastRunAt: NOW - 4 * 3600000 } });
      ext.chrome.alarms.get.mockResolvedValue({ name: "check-jobs", scheduledTime: NOW + 60000 });
      const popup = await ext.openPopup();
      expect(popup.text("check-status-gap")).toMatch(/^⚠ The last successful check was 4h ago — longer than your 5-minute interval/);
    });
  });

  it.skipIf(!connected)("shows why a change was refused while WatchDesk is unreachable, and changes nothing", async () => {
    const popup = await start();
    ext.api.setWatchRoute(ext.api.networkError);
    await popup.click(popup.button(popup.watchItem("Upwork React"), "Pause"));

    expect(popup.text("watch-change-error")).toBe(
      "Can't reach WatchDesk, so your watches can't be changed right now. The list shown is the last one synced.",
    );
    expect(ext.watch("Upwork React").enabled).toBe(true);
    expect(popup.watchItem("Upwork React").querySelector(".pill").textContent).toBe("Active");
    expect(popup.labels()).toEqual(WATCHES.map((w) => w.label));
  });

  it.skipIf(connected || REFERENCE_ROOT)("shows no sync line and no refusal, and offers to connect an account", async () => {
    const popup = await start();
    expect(popup.$("watch-sync-status").hidden).toBe(true);
    expect(popup.text("watch-change-error")).toBe("");
    expect(popup.$("account-connect").hidden).toBe(false);
    expect(ext.api.fetch).not.toHaveBeenCalled();
  });

  // What the sync line says is popup-watch-sync.js's business (WD-73).
  it.skipIf(!connected)("shows the sync line, and the list as it was before connecting", async () => {
    const popup = await start();
    expect(popup.$("watch-sync-status").hidden).toBe(false);
    expect(popup.text("watch-sync-status")).not.toBe("");
    expect(popup.labels()).toEqual(WATCHES.map((w) => w.label));
    expect(UPWORK_URL).toBe(ext.watch("Upwork React").url);
  });
});
