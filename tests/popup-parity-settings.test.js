// WD-72: every setting of the shipped popup is still in the popup and still
// does what it did (baseline §3, §5, §8.2): the check interval, the alert
// sound and its Test button, mute, the title-keyword filter, the settings
// panel's Pause All / Resume All and per-platform rows, Export, Import and
// Reset. Each is driven in the real popup with no account connected and with
// one connected. Settings stay in this browser in both: none is sent to
// WatchDesk.
import { afterEach, describe, expect, it, vi } from "vitest";
import { startExtension, TESTED_MODES, REFERENCE_ROOT, NOW, WATCHES, OJ_URL, UPWORK_URL } from "./helpers/popup-harness.js";

// The filter's keywords on a browser that never changed them.
const DEFAULT_KEYWORDS = [
  "full stack",
  "full-stack",
  "fullstack",
  "software engineer",
  "software developer",
  "web developer",
  "web development",
  "app developer",
  "application developer",
  "developer",
  "engineer",
  "engineering",
  "frontend",
  "front-end",
  "front end",
  "backend",
  "back-end",
  "back end",
  "ai automation",
  "automation engineer",
  "ai engineer",
  "machine learning",
  "wordpress",
  "elementor",
  "php",
];
const DEFAULT_FEED_FILTERS = { search: "", platform: "all", workplace: "all", status: "all", sort: "found-desc" };
const RESET_CONFIRM =
  "Reset Job Alert Notifier? This clears every watch, the whole feed, and all settings back to defaults. This can't be undone — export a backup first if you want to keep any of it.";

// Messages the popup has sent since the account work began; the shipped
// popup sends none of them.
// WD-71 added set-watcher-state (Start Watching / Pause Watching).
const SINCE_SHIPPED = /^(account-|sync-watches$|listing-drops-seen$|set-watcher-state$)/;
const asShipped = (messages) => messages.filter((m) => !SINCE_SHIPPED.test(m.type));

let ext;
afterEach(() => ext?.dispose());

const job = (n, title = `PHP Developer ${n}`) => ({
  id: `13100${n}`,
  title,
  url: `https://www.onlinejobs.ph/jobseekers/job/13100${n}`,
  postedRaw: "2026-10-05 09:15:00",
  postedAt: "2026-10-05T01:15:00.000Z",
  salaryRaw: null,
});

describe.each(TESTED_MODES)("the popup's settings $mode", ({ connected }) => {
  const start = async (options = {}) => {
    ext = await startExtension({ connected, ...options });
    return ext.openPopup(options.popup);
  };
  // Runs `act`, and returns what the popup sent; fails if anything went to
  // WatchDesk because of it.
  const local = async (act) => {
    ext.take();
    const calls = ext.watchdeskCalls().length;
    await act();
    expect(ext.watchdeskCalls()).toHaveLength(calls);
    return ext.take();
  };

  describe("opening the popup", () => {
    it("clears the badge, then asks for the state", async () => {
      const popup = await start({ local: { badgeCount: 4 } });
      expect(asShipped(popup.opening).slice(0, 2)).toEqual([{ type: "clear-badge" }, { type: "get-state" }]);
      if (!connected) expect(asShipped(popup.opening)).toHaveLength(2);
      expect(ext.local().badgeCount).toBe(0);
      expect(ext.chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
    });

    it("shows the stored settings in their controls", async () => {
      const popup = await start({
        sync: {
          intervalMinutes: 30,
          soundId: "ping",
          notificationsMuted: true,
          titleFilter: { enabled: false, keywords: ["react", "vue"] },
        },
      });
      expect(popup.$("interval").value).toBe("30");
      expect(popup.$("sound").value).toBe("ping");
      expect(popup.$("mute-notifications").checked).toBe(true);
      expect(popup.$("title-filter-enabled").checked).toBe(false);
      expect([...popup.document.querySelectorAll(".keyword-chip > span")].map((el) => el.textContent)).toEqual(["react", "vue"]);
    });

    it("shows the defaults on a browser that has stored none", async () => {
      const popup = await start();
      expect(popup.$("interval").value).toBe("5");
      expect(popup.$("sound").value).toBe("chime");
      expect(popup.$("mute-notifications").checked).toBe(false);
      expect(popup.$("title-filter-enabled").checked).toBe(true);
      expect(popup.document.querySelectorAll(".keyword-chip")).toHaveLength(25);
    });

    it("shows the installed version in Settings", async () => {
      const popup = await start();
      expect(popup.text("about-version")).toBe("Job Alert Notifier v1.1.0");
      expect(popup.$("update-banner").hidden).toBe(true);
    });

    it("shows the 'Updated to' banner once after an update, and acknowledges it", async () => {
      const popup = await start({ local: { justUpdated: { toVersion: "1.1.0", fromVersion: "1.0.0" } } });
      expect(popup.$("update-banner").hidden).toBe(false);
      expect(popup.text("update-banner-text")).toBe("✓ Updated to v1.1.0 (from v1.0.0)");
      expect(popup.opening.filter((m) => m.type === "ack-update")).toHaveLength(1);
      expect(ext.local().justUpdated).toBeUndefined();

      await vi.advanceTimersByTimeAsync(8000);
      expect(popup.$("update-banner").hidden).toBe(true);
    });
  });

  describe("check interval", () => {
    it("offers 1, 5, 15 and 30 minutes, next to Check now", async () => {
      const popup = await start();
      expect([...popup.$("interval").options].map((o) => [o.value, o.textContent])).toEqual([
        ["1", "1 minute"],
        ["5", "5 minutes"],
        ["15", "15 minutes"],
        ["30", "30 minutes"],
      ]);
      expect(popup.$("interval").closest("section").contains(popup.$("check-now"))).toBe(true);
    });

    it.each([1, 15, 30])("choosing %i minutes stores it and re-arms the check alarm", async (minutes) => {
      const popup = await start();
      const sent = await local(() => popup.choose(popup.$("interval"), String(minutes)));

      expect(sent).toEqual([{ type: "set-interval", minutes }]);
      expect(ext.sync().intervalMinutes).toBe(minutes);
      expect(ext.chrome.alarms.create).toHaveBeenLastCalledWith("check-jobs", { delayInMinutes: 0.1, periodInMinutes: minutes });
    });

    it("is still chosen when the popup is opened again", async () => {
      let popup = await start();
      await popup.choose(popup.$("interval"), "15");
      popup = await ext.openPopup();
      expect(popup.$("interval").value).toBe("15");
    });
  });

  describe("alert sound", () => {
    it("offers the six tones", async () => {
      const popup = await start();
      expect([...popup.$("sound").options].map((o) => [o.value, o.textContent])).toEqual([
        ["default", "System default"],
        ["chime", "Chime (two ascending notes)"],
        ["ping", "Ping (single high note)"],
        ["alert", "Alert (three quick beeps)"],
        ["soft", "Soft tone (gentle low note)"],
        ["none", "Silent (no sound)"],
      ]);
    });

    it("choosing one stores it", async () => {
      const popup = await start();
      const sent = await local(() => popup.choose(popup.$("sound"), "alert"));

      expect(sent).toEqual([{ type: "set-sound", soundId: "alert" }]);
      expect(ext.sync().soundId).toBe("alert");
      expect(ext.sounds).toEqual([]);

      expect((await ext.openPopup()).$("sound").value).toBe("alert");
    });

    it("Test plays the tone that is selected, stored or not", async () => {
      const popup = await start();
      expect(await local(() => popup.click(popup.$("test-sound")))).toEqual([{ type: "test-sound", soundId: "chime" }]);

      popup.$("sound").value = "soft";
      expect(await local(() => popup.click(popup.$("test-sound")))).toEqual([{ type: "test-sound", soundId: "soft" }]);
      expect(ext.sounds).toEqual(["chime", "soft"]);
      expect(ext.sync().soundId).toBeUndefined();
    });

    it.each(["none", "default"])("Test plays nothing of the extension's own for '%s'", async (soundId) => {
      const popup = await start({ sync: { soundId } });
      expect(await local(() => popup.click(popup.$("test-sound")))).toEqual([{ type: "test-sound", soundId }]);
      expect(ext.sounds).toEqual([]);
    });
  });

  describe("mute desktop notifications", () => {
    it("is in the settings panel, which the gear opens and ✕ closes", async () => {
      const popup = await start();
      const panel = popup.$("settings-panel");
      expect(panel.classList.contains("open")).toBe(false);

      await popup.click(popup.$("settings-toggle"));
      expect(panel.classList.contains("open")).toBe(true);
      for (const id of [
        "pause-all",
        "resume-all",
        "settings-per-site",
        "mute-notifications",
        "title-filter-enabled",
        "title-filter-keywords",
        "title-filter-new-keyword",
        "title-filter-add-btn",
        "export-settings",
        "import-settings-btn",
        "reset-extension",
        "about-version",
      ]) {
        expect(panel.contains(popup.$(id)), id).toBe(true);
      }

      await popup.click(popup.$("settings-close"));
      expect(panel.classList.contains("open")).toBe(false);
      await popup.click(popup.$("settings-toggle"));
      await popup.click(popup.$("settings-toggle"));
      expect(panel.classList.contains("open")).toBe(false);
    });

    it("turning it on and off stores it", async () => {
      const popup = await start();
      expect(await local(() => popup.check(popup.$("mute-notifications"), true))).toEqual([
        { type: "set-notifications-muted", muted: true },
      ]);
      expect(ext.sync().notificationsMuted).toBe(true);
      expect((await ext.openPopup()).$("mute-notifications").checked).toBe(true);

      const reopened = await ext.openPopup();
      expect(await local(() => reopened.check(reopened.$("mute-notifications"), false))).toEqual([
        { type: "set-notifications-muted", muted: false },
      ]);
      expect(ext.sync().notificationsMuted).toBe(false);
    });

    it.each([
      [false, 1, ["chime"]],
      [true, 0, []],
    ])("muted %s: a new posting still reaches the feed and the badge; %i notification", async (muted, notifications, tones) => {
      const popup = await start({ watches: [WATCHES[0]] });
      ext.api.setSite(() => new Response("<html></html>", { status: 200 }));
      if (muted) await popup.check(popup.$("mute-notifications"), true);

      ext.pages.onlinejobsph = [job(1)];
      await popup.click(popup.$("check-now"));
      ext.pages.onlinejobsph = [job(2), job(1)];
      await popup.click(popup.$("check-now"));

      expect(ext.local().feed.map((entry) => entry.title)).toEqual(["PHP Developer 2"]);
      expect(ext.local().badgeCount).toBe(1);
      expect(ext.chrome.notifications.create).toHaveBeenCalledTimes(notifications);
      expect(ext.sounds).toEqual(tones);
      expect(popup.document.querySelectorAll(".feed-item")).toHaveLength(1);
    });
  });

  describe("title-keyword filter", () => {
    const chips = (popup) => [...popup.document.querySelectorAll(".keyword-chip > span")].map((el) => el.textContent);
    const add = async (popup, value, how = "button") => {
      popup.$("title-filter-new-keyword").value = value;
      if (how === "button") await popup.click(popup.$("title-filter-add-btn"));
      else await popup.key(popup.$("title-filter-new-keyword"), "Enter");
    };

    it("turning it off and on sends the whole filter and stores it", async () => {
      const popup = await start();
      expect(await local(() => popup.check(popup.$("title-filter-enabled"), false))).toEqual([
        { type: "update-title-filter", titleFilter: { enabled: false, keywords: DEFAULT_KEYWORDS } },
      ]);
      expect(ext.sync().titleFilter).toEqual({ enabled: false, keywords: DEFAULT_KEYWORDS });

      expect(await local(() => popup.check(popup.$("title-filter-enabled"), true))).toEqual([
        { type: "update-title-filter", titleFilter: { enabled: true, keywords: DEFAULT_KEYWORDS } },
      ]);
      expect(ext.sync().titleFilter.enabled).toBe(true);
    });

    it.each(["button", "Enter"])("adds a keyword with the %s", async (how) => {
      const popup = await start();
      const sent = await local(() => add(popup, "  laravel  ", how));

      expect(sent).toEqual([
        { type: "update-title-filter", titleFilter: { enabled: true, keywords: [...DEFAULT_KEYWORDS, "laravel"] } },
      ]);
      expect(ext.sync().titleFilter.keywords.at(-1)).toBe("laravel");
      expect(chips(popup).at(-1)).toBe("laravel");
      expect(popup.$("title-filter-new-keyword").value).toBe("");
    });

    it("adds nothing for an empty box or a keyword already listed, whatever its case", async () => {
      const popup = await start();
      expect(await local(() => add(popup, "   "))).toEqual([]);
      expect(await local(() => add(popup, "PHP"))).toEqual([]);
      expect(popup.$("title-filter-new-keyword").value).toBe("");
      expect(chips(popup)).toEqual(DEFAULT_KEYWORDS);
      expect(ext.sync().titleFilter).toBeUndefined();
    });

    it("removes a keyword with its ✕", async () => {
      const popup = await start({ sync: { titleFilter: { enabled: false, keywords: ["react", "vue"] } } });
      const remove = popup.document.querySelector('.keyword-chip-remove[data-keyword="react"]');
      expect(remove.title).toBe('Remove "react"');

      expect(await local(() => popup.click(remove))).toEqual([
        { type: "update-title-filter", titleFilter: { enabled: false, keywords: ["vue"] } },
      ]);
      expect(ext.sync().titleFilter).toEqual({ enabled: false, keywords: ["vue"] });
      expect(chips(popup)).toEqual(["vue"]);
    });

    it("an emptied list stays empty and says every posting passes", async () => {
      const popup = await start({ sync: { titleFilter: { enabled: true, keywords: ["react"] } } });
      await popup.click(popup.document.querySelector(".keyword-chip-remove"));

      expect(ext.sync().titleFilter).toEqual({ enabled: true, keywords: [] });
      expect(popup.text("title-filter-keywords")).toBe(
        "No keywords yet — every LinkedIn/OnlineJobs.ph posting will pass through unfiltered.",
      );
      expect((await ext.openPopup()).document.querySelectorAll(".keyword-chip")).toHaveLength(0);
    });

    it("changes made one after another build on each other", async () => {
      const popup = await start();
      await add(popup, "laravel");
      await popup.check(popup.$("title-filter-enabled"), false);
      await popup.click(popup.document.querySelector('.keyword-chip-remove[data-keyword="php"]'));

      expect(ext.sync().titleFilter).toEqual({
        enabled: false,
        keywords: [...DEFAULT_KEYWORDS.filter((k) => k !== "php"), "laravel"],
      });
    });

    it.each([
      [true, ["PHP Developer 2"]],
      [false, ["PHP Developer 2", "Food Safety Manager"]],
    ])("enabled %s decides which new OnlineJobs.ph postings reach the feed", async (enabled, titles) => {
      const popup = await start({ watches: [WATCHES[0]] });
      ext.api.setSite(() => new Response("<html></html>", { status: 200 }));
      if (!enabled) await popup.check(popup.$("title-filter-enabled"), false);

      ext.pages.onlinejobsph = [job(1)];
      await popup.click(popup.$("check-now"));
      ext.pages.onlinejobsph = [job(2), job(3, "Food Safety Manager"), job(1)];
      await popup.click(popup.$("check-now"));

      expect(ext.local().feed.map((entry) => entry.title)).toEqual(titles);
    });
  });

  describe("Pause All / Resume All and the per-platform rows", () => {
    const enabled = () => ext.watches().map((w) => w.enabled);
    const row = (popup, name) =>
      [...popup.document.querySelectorAll(".settings-site-row")].find(
        (el) => el.querySelector(".settings-site-name").textContent === name,
      );

    it("Pause All pauses every watch, then only Resume All is offered, and it resumes them all", async () => {
      const popup = await start();
      expect(popup.$("pause-all").disabled).toBe(false);
      expect(popup.$("resume-all").disabled).toBe(false);

      await popup.click(popup.$("pause-all"));
      expect(ext.take().slice(-2)).toEqual([{ type: "pause-all" }, { type: "get-state" }]);
      expect(enabled()).toEqual([false, false, false, false, false]);
      expect(popup.$("pause-all").disabled).toBe(true);
      expect(popup.document.querySelectorAll(".pill--paused")).toHaveLength(5);

      await popup.click(popup.$("resume-all"));
      expect(ext.take()).toEqual([{ type: "resume-all" }, { type: "get-state" }]);
      expect(enabled()).toEqual([true, true, true, true, true]);
      expect(popup.$("resume-all").disabled).toBe(true);
    });

    it("lists each platform in use with its counts, behind a toggle that starts closed past three", async () => {
      const popup = await start();
      expect(popup.text("settings-per-site-count")).toBe("(4)");
      expect(
        [...popup.document.querySelectorAll(".settings-site-row")].map((el) => [
          el.querySelector(".settings-site-name").textContent,
          el.querySelector(".settings-site-counts").textContent,
        ]),
      ).toEqual([
        ["OnlineJobs.ph", "1 active · 0 paused"],
        ["Glassdoor", "1 active · 0 paused"],
        ["LinkedIn", "1 active · 1 paused"],
        ["Upwork", "1 active · 0 paused"],
      ]);

      const toggle = popup.$("settings-per-site-toggle");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(popup.$("settings-per-site").classList.contains("collapsed")).toBe(true);
      await popup.click(toggle);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(popup.$("settings-per-site").classList.contains("collapsed")).toBe(false);
    });

    it("a platform's Pause and Resume change that platform's watches only", async () => {
      const popup = await start();
      const linkedin = () => row(popup, "LinkedIn");
      expect(popup.button(row(popup, "Glassdoor"), "Resume").disabled).toBe(true);

      await popup.click(popup.button(linkedin(), "Pause"));
      expect(ext.take().slice(-2)).toEqual([{ type: "set-site-enabled", siteId: "linkedin", enabled: false }, { type: "get-state" }]);
      expect(enabled()).toEqual([true, true, false, false, true]);
      expect(linkedin().querySelector(".settings-site-counts").textContent).toBe("0 active · 2 paused");
      expect(popup.button(linkedin(), "Pause").disabled).toBe(true);

      await popup.click(popup.button(linkedin(), "Resume"));
      expect(ext.take()).toEqual([{ type: "set-site-enabled", siteId: "linkedin", enabled: true }, { type: "get-state" }]);
      expect(enabled()).toEqual([true, true, true, true, true]);
    });

    it.skipIf(REFERENCE_ROOT)("changes the list where it lives: this browser, or the account", async () => {
      const popup = await start();
      const calls = ext.watchdeskCalls().length;
      await popup.click(popup.$("pause-all"));

      const patches = ext.watchdeskCalls().slice(calls);
      if (connected) {
        // One PATCH per watch that was active.
        expect(patches.map((r) => [r.method, r.body])).toEqual(Array(4).fill(["PATCH", { enabled: false }]));
        expect(ext.api.watches.map((w) => w.enabled)).toEqual([false, false, false, false, false]);
      } else {
        expect(patches).toEqual([]);
      }
    });
  });

  describe("Export and Import", () => {
    const pickFile = async (popup, text) => {
      const input = popup.$("import-settings-file");
      Object.defineProperty(input, "files", { configurable: true, value: [{ text: async () => text }] });
      input.dispatchEvent(new popup.window.Event("change"));
      await popup.settle();
    };
    const status = (popup) => [popup.text("settings-status-msg"), popup.$("settings-status-msg").className];

    it("Export downloads the watches and every setting as job-alert-notifier-backup.json", async () => {
      const popup = await start({
        sync: { intervalMinutes: 15, soundId: "soft", notificationsMuted: true, titleFilter: { enabled: false, keywords: ["react"] } },
      });
      const blobs = [];
      vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => blobs.push(blob) && "blob:backup");
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

      const sent = await local(() => popup.click(popup.$("export-settings")));

      expect(sent).toEqual([]);
      expect(popup.downloads).toEqual([{ href: "blob:backup", download: "job-alert-notifier-backup.json" }]);
      expect(blobs[0].type).toBe("application/json");
      expect(JSON.parse(await blobs[0].text())).toEqual({
        watches: ext.watches(),
        intervalMinutes: 15,
        soundId: "soft",
        notificationsMuted: true,
        titleFilter: { enabled: false, keywords: ["react"] },
        exportedAt: new Date(NOW).toISOString(),
      });
      expect(ext.watches().map((w) => w.label)).toEqual(WATCHES.map((w) => w.label));
      expect(status(popup)).toEqual(["Backup downloaded.", "settings-status success"]);
      expect(popup.document.querySelector("a[download]")).toBeNull();
    });

    it("Import… opens the file picker, which takes JSON", async () => {
      const popup = await start();
      const input = popup.$("import-settings-file");
      input.click = vi.fn();
      expect(input.accept).toBe("application/json");
      expect(await local(() => popup.click(popup.$("import-settings-btn")))).toEqual([]);
      expect(input.click).toHaveBeenCalledTimes(1);
    });

    it("importing a backup restores its settings and watches and starts the run state again", async () => {
      const popup = await start({ local: { feed: [], lastRunAt: NOW - 60000, seenIds: { default: ["1"] } } });
      const backup = {
        watches: [
          { id: "w_1700000000000_abcde", siteId: "upwork", url: `${UPWORK_URL}&page=3`, label: "Imported", enabled: false },
          { id: "w_1700000000001_abcde", url: "https://example.com/jobs", label: "Nowhere" },
        ],
        intervalMinutes: 15,
        soundId: "ping",
        notificationsMuted: true,
        titleFilter: { enabled: false, keywords: ["react"] },
        exportedAt: "2026-09-01T00:00:00.000Z",
      };
      ext.take();
      await pickFile(popup, JSON.stringify(backup));

      expect(ext.take()).toEqual([{ type: "import-settings", data: backup }, { type: "get-state" }]);
      expect(status(popup)).toEqual(["Imported 1 watch. Skipped 1 unrecognized.", "settings-status success"]);
      expect(ext.sync()).toMatchObject({
        intervalMinutes: 15,
        soundId: "ping",
        notificationsMuted: true,
        titleFilter: { enabled: false, keywords: ["react"] },
      });
      expect(ext.local()).toMatchObject({ seenIds: {}, lastRunAt: null, feed: [], badgeCount: 0 });
      expect(popup.$("interval").value).toBe("15");
      expect(popup.$("sound").value).toBe("ping");
      expect(popup.$("mute-notifications").checked).toBe(true);
      expect(popup.labels()).toContain("Imported");
      expect(ext.watch("Imported")).toMatchObject({ siteId: "upwork", url: `${UPWORK_URL}&page=3`, enabled: false });
      expect(popup.$("import-settings-file").value).toBe("");

      if (connected) {
        // WD-54: the file's watches join the account's.
        expect(ext.api.watches.map((w) => w.label)).toEqual([...WATCHES.map((w) => w.label), "Imported"]);
        expect(ext.watches()).toHaveLength(6);
      } else {
        expect(ext.watches()).toEqual([
          { id: "w_1700000000000_abcde", siteId: "upwork", url: `${UPWORK_URL}&page=3`, label: "Imported", enabled: false },
        ]);
      }
    });

    it("says so when the file is not JSON, and sends nothing", async () => {
      const popup = await start();
      expect(await local(() => pickFile(popup, "{ not json"))).toEqual([]);
      expect(status(popup)).toEqual(["That file isn't valid JSON.", "settings-status error"]);
    });

    it.each([
      [{ hello: "world" }, "That file doesn't look like a Job Alert Notifier backup."],
      [{ watches: [{ url: "https://example.com/jobs" }] }, "No valid watches found in that file."],
    ])("shows why a file that is not a backup was refused, and changes nothing", async (data, message) => {
      const popup = await start();
      const before = JSON.stringify(ext.sync());
      await pickFile(popup, JSON.stringify(data));

      expect(ext.take()).toEqual([{ type: "import-settings", data }]);
      expect(status(popup)).toEqual([message, "settings-status error"]);
      expect(JSON.stringify(ext.sync())).toBe(before);
    });
  });

  describe("Reset Extension", () => {
    const customised = {
      sync: { intervalMinutes: 30, soundId: "ping", notificationsMuted: true, titleFilter: { enabled: false, keywords: ["react"] } },
      local: {
        feedFilters: { search: "react", platform: "all", workplace: "Remote", status: "applied", sort: "posted-asc" },
        lastRunAt: NOW - 60000,
        badgeCount: 2,
      },
    };

    it("does nothing when the confirmation is declined", async () => {
      const popup = await start({ ...customised, popup: { confirm: false } });
      expect(await local(() => popup.click(popup.$("reset-extension")))).toEqual([]);
      expect(popup.confirm).toHaveBeenCalledTimes(1);
      expect(ext.sync().intervalMinutes).toBe(30);
    });

    it("puts every setting, the feed and the feed filters back to their defaults", async () => {
      const popup = await start(customised);
      expect(popup.$("feed-sort").value).toBe("posted-asc");
      ext.take();
      await popup.click(popup.$("reset-extension"));

      expect(ext.take()).toEqual([{ type: "reset-extension" }, { type: "get-state" }]);
      expect(ext.sync()).toMatchObject({
        intervalMinutes: 5,
        soundId: "chime",
        notificationsMuted: false,
        titleFilter: { enabled: true, keywords: DEFAULT_KEYWORDS },
      });
      expect(ext.local()).toMatchObject({ feed: [], seenIds: {}, lastRunAt: null, badgeCount: 0, feedFilters: DEFAULT_FEED_FILTERS });
      expect(ext.chrome.alarms.create).toHaveBeenLastCalledWith("check-jobs", { delayInMinutes: 0.1, periodInMinutes: 5 });
      expect(popup.$("interval").value).toBe("5");
      expect(popup.$("sound").value).toBe("chime");
      expect(popup.$("mute-notifications").checked).toBe(false);
      expect(popup.$("title-filter-enabled").checked).toBe(true);
      expect(popup.$("feed-search").value).toBe("");
      expect(popup.$("feed-workplace-filter").value).toBe("all");
      expect(popup.$("feed-status-filter").value).toBe("all");
      expect(popup.$("feed-sort").value).toBe("found-desc");
      expect([popup.text("settings-status-msg"), popup.$("settings-status-msg").className]).toEqual([
        "Extension reset to defaults.",
        "settings-status success",
      ]);
    });

    it.skipIf(connected)("asks first, in the shipped words, and leaves only the default watch", async () => {
      const popup = await start(customised);
      await popup.click(popup.$("reset-extension"));

      expect(popup.confirm).toHaveBeenCalledWith(RESET_CONFIRM);
      expect(ext.watches()).toEqual([
        { id: "default", siteId: "onlinejobsph", url: OJ_URL, label: "All OnlineJobs.ph postings", enabled: true },
      ]);
      expect(popup.labels()).toEqual(["All OnlineJobs.ph postings"]);
    });

    it.skipIf(!connected)("keeps the watches, which are the account's (WD-54), and says so before resetting", async () => {
      const popup = await start(customised);
      const calls = ext.watchdeskCalls().length;
      await popup.click(popup.$("reset-extension"));

      expect(popup.confirm.mock.calls[0][0]).toMatch(/^Reset Job Alert Notifier\? This clears the whole feed and all settings back to defaults\. Your watches are kept/);
      expect(ext.watches().map((w) => w.label)).toEqual(WATCHES.map((w) => w.label));
      expect(ext.api.watches).toHaveLength(5);
      expect(ext.watchdeskCalls().slice(calls).filter((r) => r.method !== "GET")).toEqual([]);
    });
  });

  it.skipIf(!connected)("no setting is ever in a request to WatchDesk", async () => {
    const popup = await start();
    await popup.choose(popup.$("interval"), "15");
    await popup.choose(popup.$("sound"), "alert");
    await popup.check(popup.$("mute-notifications"), true);
    await popup.check(popup.$("title-filter-enabled"), false);
    popup.$("title-filter-new-keyword").value = "zzkeywordzz";
    await popup.click(popup.$("title-filter-add-btn"));
    // A check, and the popup opened again, with those settings stored.
    ext.api.setSite(() => new Response("<html></html>", { status: 200 }));
    await popup.click(popup.$("check-now"));
    await ext.openPopup();

    const sentToWatchDesk = JSON.stringify(ext.watchdeskCalls().map((r) => [r.url, r.body]));
    for (const word of ["intervalMinutes", "soundId", "notificationsMuted", "titleFilter", "zzkeywordzz", "alert"]) {
      expect(sentToWatchDesk).not.toContain(word);
    }
    // WD-71: the one thing asked of the settings route is whether the account
    // has this browser's watcher state. It is a read with no body; nothing
    // is written there while the state is unchanged.
    const settingsCalls = ext.watchdeskCalls().filter((r) => /settings/i.test(r.path));
    expect(settingsCalls.every((r) => r.method === "GET" && r.body === undefined)).toBe(true);
    // And the sync that ran on reopening left them alone.
    expect(ext.sync()).toMatchObject({ intervalMinutes: 15, soundId: "alert", notificationsMuted: true });
    expect(ext.sync().titleFilter.keywords.at(-1)).toBe("zzkeywordzz");
  });

  // WD-71: the one write to the settings route. It sends back what the
  // account already holds, with the watcher state changed.
  it.skipIf(!connected)("Pause Watching reports the state with the account's own settings, never this browser's", async () => {
    const popup = await start();
    await popup.choose(popup.$("interval"), "30");
    await popup.choose(popup.$("sound"), "alert");
    popup.$("title-filter-new-keyword").value = "zzkeywordzz";
    await popup.click(popup.$("title-filter-add-btn"));
    const onWatchDesk = ext.api.settings();
    ext.take();

    await popup.click(popup.$("watcher-toggle"));

    expect(ext.take().filter((m) => m.type === "set-watcher-state")).toEqual([{ type: "set-watcher-state", state: "paused" }]);
    const writes = ext.watchdeskCalls().filter((r) => /settings/i.test(r.path) && r.method !== "GET");
    expect(writes.map((r) => [r.method, r.body])).toEqual([["PUT", { ...onWatchDesk, watcherState: "paused" }]]);
    expect(JSON.stringify(writes.map((r) => r.body))).not.toContain("zzkeywordzz");
    // This browser's settings are as the user left them.
    expect(ext.sync()).toMatchObject({ intervalMinutes: 30, soundId: "alert" });
    expect(ext.sync().titleFilter.keywords.at(-1)).toBe("zzkeywordzz");
  });
});
