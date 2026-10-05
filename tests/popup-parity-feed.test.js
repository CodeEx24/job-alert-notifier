// WD-72: the popup's feed ("New postings found") behaves as in the shipped
// extension (baseline §7, §8.4): what an entry shows, visited and applied,
// Mark all read, Clear, and the search / filter / sort controls with their
// saved choice. The feed is this browser's in both modes: nothing here goes
// to WatchDesk.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startExtension, TESTED_MODES, NOW } from "./helpers/popup-harness.js";

const DEFAULT_FILTERS = { search: "", platform: "all", workplace: "all", status: "all", sort: "found-desc" };

// A feed entry as the check cycle stores it. Found `n` minutes ago.
const entry = (n, title, over = {}) => ({
  id: `default:${n}`,
  sourceKey: `onlinejobsph:${n}`,
  siteId: "onlinejobsph",
  watchId: "default",
  watchLabel: "All OnlineJobs.ph postings",
  title,
  url: `https://www.onlinejobs.ph/jobseekers/job/${n}`,
  postedRaw: null,
  postedAt: null,
  postedApprox: false,
  salaryRaw: null,
  easyApply: false,
  workplaceType: null,
  detectedAt: NOW - n * 60000,
  visited: false,
  applied: false,
  appliedAt: null,
  ...over,
});
const linkedin = (n, label) => ({
  id: `w_1759000000002_liaaa:${n}`,
  sourceKey: `linkedin:${n}`,
  siteId: "linkedin",
  watchId: "w_1759000000002_liaaa",
  watchLabel: label,
  url: `https://www.linkedin.com/jobs/view/${n}`,
});

const FEED = [
  entry(1, "PHP Developer", { postedAt: "2026-10-05T08:00:00.000Z" }),
  entry(2, "React Engineer", { ...linkedin(2, "LinkedIn React"), postedAt: "2026-10-04T08:00:00.000Z", workplaceType: "Remote", easyApply: true }),
  entry(3, "Vue Engineer", {
    ...linkedin(3, "LinkedIn Vue"),
    postedAt: "2026-10-03T08:00:00.000Z",
    workplaceType: "On-site",
    applied: true,
    appliedAt: NOW - 3600000,
  }),
  entry(4, "Node Developer", {
    id: "w_1759000000001_gdaaa:4",
    sourceKey: "glassdoor:4",
    siteId: "glassdoor",
    watchId: "w_1759000000001_gdaaa",
    watchLabel: "Glassdoor React",
    url: "https://www.glassdoor.com/job-listing/node-developer?jl=4",
    workplaceType: "Hybrid",
    salaryRaw: "$90K",
    visited: true,
  }),
  entry(5, "Laravel build", {
    id: "w_1759000000004_upaaa:5",
    sourceKey: "upwork:5",
    siteId: "upwork",
    watchId: "w_1759000000004_upaaa",
    watchLabel: "Upwork React",
    url: "https://www.upwork.com/jobs/~015",
  }),
];

let ext;
afterEach(() => ext?.dispose());

describe.each(TESTED_MODES)("the popup's feed $mode", ({ connected }) => {
  const start = async ({ feed = FEED, feedFilters, confirm } = {}) => {
    ext = await startExtension({ connected, local: { feed, ...(feedFilters ? { feedFilters } : {}) } });
    const popup = await ext.openPopup({ confirm });
    ext.take();
    return popup;
  };
  const titles = (popup) => [...popup.document.querySelectorAll(".feed-item a")].map((a) => a.textContent);
  const item = (popup, title) => [...popup.document.querySelectorAll(".feed-item")].find((el) => el.querySelector("a").textContent === title);
  const stored = (title) => ext.local().feed.find((e) => e.title === title);
  // Runs `act` and fails if the worker or WatchDesk heard of it.
  const quietly = async (act) => {
    const calls = ext.api.requests.length;
    await act();
    expect(ext.take()).toEqual([]);
    expect(ext.api.requests).toHaveLength(calls);
  };

  it("lists the postings newest found first, with what each listing showed", async () => {
    const popup = await start();
    expect(titles(popup)).toEqual(["PHP Developer", "React Engineer", "Vue Engineer", "Node Developer", "Laravel build"]);

    const react = item(popup, "React Engineer");
    expect(react.querySelector("a").href).toBe("https://www.linkedin.com/jobs/view/2");
    expect(react.querySelector("a").target).toBe("_blank");
    expect(react.querySelector(".easy-apply-pill").textContent).toBe("Easy Apply");
    expect(react.querySelector(".workplace-pill--remote").textContent).toBe("Remote");
    expect(react.querySelector(".badge").textContent).toBe("New");
    expect(react.querySelector(".applied-btn").textContent).toBe("Mark applied");
    expect(react.querySelector(".feed-meta").textContent).toMatch(/^LinkedIn React · Posted .+ · found 2m ago$/);

    const node = item(popup, "Node Developer");
    expect(node.querySelector(".salary-pill").textContent).toBe("$90K");
    expect(node.querySelector(".workplace-pill--hybrid").textContent).toBe("Hybrid");
    expect(node.querySelector(".badge").textContent).toBe("✓ Visited");
    expect(node.querySelector(".feed-meta").textContent).toBe("Glassdoor React · Posted posted date unknown · found 4m ago");
    expect(item(popup, "PHP Developer").querySelector(".workplace-pill")).toBeNull();
    expect(item(popup, "Vue Engineer").querySelector(".applied-btn").textContent).toBe("✓ Applied");
    expect(popup.text("feed-applied-count")).toBe("· 1 applied");
    expect(popup.text("feed-summary")).toBe("");
    expect(popup.$("feed-pagination").children).toHaveLength(0);
  });

  it("says so when there is nothing yet", async () => {
    const popup = await start({ feed: [] });
    expect(popup.text("feed-list")).toBe("No new postings detected yet.");
    expect(popup.text("feed-applied-count")).toBe("");
  });

  describe("visited and applied", () => {
    it("opening a posting marks it visited, once", async () => {
      const popup = await start();
      const link = item(popup, "React Engineer").querySelector("a");
      const open = async () => {
        link.dispatchEvent(new popup.window.MouseEvent("click", { bubbles: true, cancelable: true }));
        await popup.settle();
      };

      await open();
      expect(ext.take()).toEqual([{ type: "mark-visited", id: stored("React Engineer").id }]);
      expect(stored("React Engineer").visited).toBe(true);
      expect(item(popup, "React Engineer").querySelector(".badge").textContent).toBe("✓ Visited");

      await quietly(open);
    });

    it("Mark applied flips, counts, and flips back", async () => {
      const popup = await start();
      const button = item(popup, "React Engineer").querySelector(".applied-btn");

      await popup.click(button);
      expect(ext.take()).toEqual([{ type: "toggle-applied", id: stored("React Engineer").id }]);
      expect(stored("React Engineer")).toMatchObject({ applied: true, appliedAt: NOW });
      expect(button.textContent).toBe("✓ Applied");
      expect(button.classList.contains("is-applied")).toBe(true);
      expect(popup.text("feed-applied-count")).toBe("· 2 applied");

      await popup.click(button);
      expect(stored("React Engineer")).toMatchObject({ applied: false, appliedAt: null });
      expect(button.textContent).toBe("Mark applied");
      expect(popup.text("feed-applied-count")).toBe("· 1 applied");
    });

    it("Mark all read marks every posting visited", async () => {
      const popup = await start();
      await popup.click(popup.$("mark-all-visited"));

      expect(ext.take()).toEqual([{ type: "mark-all-visited" }, { type: "get-state" }]);
      expect(ext.local().feed.every((e) => e.visited)).toBe(true);
      expect([...popup.document.querySelectorAll(".feed-item .badge")].map((b) => b.textContent)).toEqual(Array(5).fill("✓ Visited"));
      // Applied is kept.
      expect(stored("Vue Engineer").applied).toBe(true);
    });
  });

  describe("Clear", () => {
    it("asks first, and does nothing when declined", async () => {
      const popup = await start({ confirm: false });
      await quietly(() => popup.click(popup.$("clear-feed")));
      expect(popup.confirm).toHaveBeenCalledWith("Clear all 5 logged postings? This can't be undone.");
      expect(ext.local().feed).toHaveLength(5);
    });

    it("empties the feed when confirmed", async () => {
      const popup = await start();
      await popup.click(popup.$("clear-feed"));

      expect(ext.take()).toEqual([{ type: "clear-feed" }, { type: "get-state" }]);
      expect(ext.local().feed).toEqual([]);
      expect(popup.text("feed-list")).toBe("No new postings detected yet.");
    });

    it("does not ask when the feed is already empty", async () => {
      const popup = await start({ feed: [] });
      await popup.click(popup.$("clear-feed"));
      expect(popup.confirm).not.toHaveBeenCalled();
      expect(ext.take()).toEqual([{ type: "clear-feed" }, { type: "get-state" }]);
    });
  });

  describe("search, filters and sort", () => {
    const search = async (popup, text) => {
      popup.type(popup.$("feed-search"), text);
      await vi.advanceTimersByTimeAsync(200);
      await popup.settle();
    };

    it("searches titles and watch labels, a moment after typing stops", async () => {
      const popup = await start();
      await quietly(async () => {
        popup.type(popup.$("feed-search"), "LINKED");
        await vi.advanceTimersByTimeAsync(199);
        expect(titles(popup)).toHaveLength(5);
        await vi.advanceTimersByTimeAsync(1);
        await popup.settle();
      });

      expect(titles(popup)).toEqual(["React Engineer", "Vue Engineer"]);
      expect(popup.$("feed-summary").firstChild.textContent).toBe("Showing 2 of 5.");
      expect(ext.local().feedFilters).toEqual({ ...DEFAULT_FILTERS, search: "LINKED" });

      await search(popup, "developer");
      expect(titles(popup)).toEqual(["PHP Developer", "Node Developer"]);
    });

    it("offers only the platforms that have postings, in the platforms' order", async () => {
      const popup = await start({ feed: FEED.filter((e) => e.siteId !== "glassdoor") });
      expect([...popup.$("feed-platform-filter").options].map((o) => [o.value, o.textContent])).toEqual([
        ["all", "All platforms"],
        ["onlinejobsph", "OnlineJobs.ph"],
        ["linkedin", "LinkedIn"],
        ["upwork", "Upwork"],
      ]);
    });

    it("filters by platform", async () => {
      const popup = await start();
      await quietly(() => popup.choose(popup.$("feed-platform-filter"), "linkedin"));
      expect(titles(popup)).toEqual(["React Engineer", "Vue Engineer"]);
      expect(ext.local().feedFilters).toEqual({ ...DEFAULT_FILTERS, platform: "linkedin" });
    });

    // Baseline §8.4: a posting with no workplace type is never hidden.
    it.each([
      ["Remote", ["PHP Developer", "React Engineer", "Laravel build"]],
      ["Hybrid", ["PHP Developer", "Node Developer", "Laravel build"]],
      ["On-site", ["PHP Developer", "Vue Engineer", "Laravel build"]],
    ])("the %s filter keeps postings of that type and every posting with none", async (workplace, expected) => {
      const popup = await start();
      await quietly(() => popup.choose(popup.$("feed-workplace-filter"), workplace));
      expect(titles(popup)).toEqual(expected);
      expect(ext.local().feedFilters).toEqual({ ...DEFAULT_FILTERS, workplace });
    });

    it("filters by applied or not", async () => {
      const popup = await start();
      await quietly(() => popup.choose(popup.$("feed-status-filter"), "applied"));
      expect(titles(popup)).toEqual(["Vue Engineer"]);
      await quietly(() => popup.choose(popup.$("feed-status-filter"), "not-applied"));
      expect(titles(popup)).toEqual(["PHP Developer", "React Engineer", "Node Developer", "Laravel build"]);
      expect(ext.local().feedFilters).toEqual({ ...DEFAULT_FILTERS, status: "not-applied" });
    });

    it.each([
      ["found-desc", ["PHP Developer", "React Engineer", "Vue Engineer", "Node Developer", "Laravel build"]],
      ["found-asc", ["Laravel build", "Node Developer", "Vue Engineer", "React Engineer", "PHP Developer"]],
      ["posted-desc", ["PHP Developer", "React Engineer", "Vue Engineer", "Node Developer", "Laravel build"]],
      ["posted-asc", ["Vue Engineer", "React Engineer", "PHP Developer", "Node Developer", "Laravel build"]],
    ])("sorts %s, postings with no date last", async (sort, expected) => {
      const popup = await start({ feedFilters: { ...DEFAULT_FILTERS, sort: sort === "found-desc" ? "found-asc" : "found-desc" } });
      await quietly(() => popup.choose(popup.$("feed-sort"), sort));
      expect(titles(popup)).toEqual(expected);
      expect(ext.local().feedFilters).toEqual({ ...DEFAULT_FILTERS, sort });
    });

    it("combines them, and Clear filters undoes all but the sort", async () => {
      const popup = await start();
      await search(popup, "engineer");
      await popup.choose(popup.$("feed-platform-filter"), "linkedin");
      await popup.choose(popup.$("feed-workplace-filter"), "Remote");
      await popup.choose(popup.$("feed-status-filter"), "applied");
      await popup.choose(popup.$("feed-sort"), "found-asc");

      expect(ext.local().feedFilters).toEqual({ search: "engineer", platform: "linkedin", workplace: "Remote", status: "applied", sort: "found-asc" });
      expect(popup.text("feed-list")).toBe("No postings match your search/filter.");
      expect(popup.$("feed-summary").firstChild.textContent).toBe("Showing 0 of 5.");

      await quietly(() => popup.click(popup.document.querySelector(".clear-filters")));
      expect(titles(popup)).toHaveLength(5);
      expect(titles(popup)[0]).toBe("Laravel build");
      expect(popup.$("feed-search").value).toBe("");
      expect(popup.$("feed-platform-filter").value).toBe("all");
      expect(popup.$("feed-workplace-filter").value).toBe("all");
      expect(popup.$("feed-status-filter").value).toBe("all");
      expect(ext.local().feedFilters).toEqual({ ...DEFAULT_FILTERS, sort: "found-asc" });
    });

    it("comes back as it was left when the popup is opened again", async () => {
      const popup = await start({
        feedFilters: { search: "engineer", platform: "linkedin", workplace: "On-site", status: "all", sort: "posted-asc" },
      });
      expect(popup.$("feed-search").value).toBe("engineer");
      expect(popup.$("feed-platform-filter").value).toBe("linkedin");
      expect(popup.$("feed-workplace-filter").value).toBe("On-site");
      expect(popup.$("feed-status-filter").value).toBe("all");
      expect(popup.$("feed-sort").value).toBe("posted-asc");
      expect(titles(popup)).toEqual(["Vue Engineer"]);
    });

    it("falls back to all platforms when the saved one has no postings left", async () => {
      const popup = await start({ feed: FEED.filter((e) => e.siteId !== "upwork"), feedFilters: { ...DEFAULT_FILTERS, platform: "upwork" } });
      expect(popup.$("feed-platform-filter").value).toBe("all");
      expect(titles(popup)).toHaveLength(4);
    });
  });

  describe("pages", () => {
    const many = Array.from({ length: 23 }, (_, i) => entry(i + 1, `Posting ${i + 1}`));
    const pageInfo = (popup) => popup.document.querySelector("#feed-pagination .page-info").textContent;

    it("shows ten postings a page", async () => {
      const popup = await start({ feed: many });
      const [prev, next] = popup.$("feed-pagination").querySelectorAll("button");
      expect(titles(popup)).toEqual(many.slice(0, 10).map((e) => e.title));
      expect(pageInfo(popup)).toBe("Page 1 of 3");
      expect(prev.disabled).toBe(true);
      expect(next.disabled).toBe(false);

      await quietly(() => popup.click(next));
      await popup.click(popup.button(popup.$("feed-pagination"), "Next ›"));
      expect(titles(popup)).toEqual(many.slice(20).map((e) => e.title));
      expect(pageInfo(popup)).toBe("Page 3 of 3");
      expect(popup.button(popup.$("feed-pagination"), "Next ›").disabled).toBe(true);

      await popup.click(popup.button(popup.$("feed-pagination"), "‹ Prev"));
      expect(pageInfo(popup)).toBe("Page 2 of 3");
    });

    it("goes back to the first page when a filter changes", async () => {
      const popup = await start({ feed: many });
      await popup.click(popup.button(popup.$("feed-pagination"), "Next ›"));
      await popup.choose(popup.$("feed-sort"), "found-asc");
      expect(pageInfo(popup)).toBe("Page 1 of 3");
      expect(titles(popup)[0]).toBe("Posting 23");
    });
  });
});
