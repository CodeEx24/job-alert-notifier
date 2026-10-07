// WD-80: a setting changed on the web reaches the extension on its next
// check cycle with the popup closed, and one changed in the extension is in
// the account for the web page's next load. The real service worker and the
// real popup (helpers/popup-harness.js) against the scripted WatchDesk: the
// table in docs/tickets/WD-80.md names a test here for each setting and
// direction.
//
// "On the web" is played by changing what the fake WatchDesk holds
// (api.setSettings); "what the web page shows after a refresh" is what its
// GET /api/settings would then answer (api.settings()).
import { afterEach, describe, expect, it } from "vitest";
import { startExtension, REFERENCE_ROOT, WATCHES } from "./helpers/popup-harness.js";
import { mergeTitleFilter } from "../account-settings.js";
import { IMPORT_KEY, TOKEN_KEY } from "../account-connection.js";

const IN_ACCOUNT = "The check interval, alert sound, mute and keyword filter are saved in your WatchDesk account.";
const OFFLINE_NOTE =
  "Can't reach WatchDesk. The check interval, alert sound, mute and keyword filter are shown as last loaded, and can't be changed until it's back.";

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
const chips = (popup) => [...popup.document.querySelectorAll(".keyword-chip > span")].map((el) => el.textContent);
const settingsCalls = (method) => ext.api.settingsCalls(method);
const feedTitles = () => ext.local().feed.map((entry) => entry.title);
const told = () => ext.chrome.runtime.sendMessage.mock.calls.map(([message]) => message).filter((m) => m?.type === "settings-changed");

// The check alarm firing, and everything it starts having finished.
const tick = async () => {
  await ext.chrome.alarms.onAlarm.dispatch({ name: "check-jobs", scheduledTime: Date.now() });
  await ext.settle();
};

// A connected browser watching one OnlineJobs.ph search, whose first check
// (the baseline, which notifies nothing) has run.
const watching = async (options = {}) => {
  ext = await startExtension({ connected: true, watches: [WATCHES[0]], ...options });
  ext.api.setSite(() => new Response("<html></html>", { status: 200 }));
  ext.pages.onlinejobsph = [job(1)];
  await tick();
  ext.chrome.alarms.create.mockClear();
  ext.chrome.notifications.create.mockClear();
  ext.chrome.runtime.sendMessage.mockClear();
  ext.take();
};

describe.skipIf(REFERENCE_ROOT)("a setting changed on the web is picked up on the next check cycle, with the popup closed (WD-80)", () => {
  describe.each([
    ["the service worker still running", false],
    ["a new service worker, started by the alarm", true],
  ])("%s", (_name, restarted) => {
    // The web change, then (in one case) Chrome stopping the worker, then
    // the alarm. Nothing but storage carries over.
    const nextCycle = async (onTheWeb, page) => {
      ext.api.setSettings(onTheWeb);
      if (restarted) await ext.restartWorker();
      ext.pages.onlinejobsph = page;
      await tick();
    };

    it("the check interval: the alarm is re-armed on it, once, a whole interval away", async () => {
      await watching();
      await nextCycle({ intervalMinutes: 30 }, [job(1)]);

      expect(ext.sync().intervalMinutes).toBe(30);
      expect(ext.chrome.alarms.create.mock.calls).toEqual([["check-jobs", { delayInMinutes: 30, periodInMinutes: 30 }]]);
      expect(await ext.chrome.alarms.get("check-jobs")).toMatchObject({ periodInMinutes: 30 });

      // The cycle after it finds nothing new and leaves the alarm alone.
      ext.chrome.alarms.create.mockClear();
      await tick();
      expect(ext.chrome.alarms.create).not.toHaveBeenCalled();
    });

    it("the alert sound: the next notification plays it", async () => {
      await watching();
      await nextCycle({ soundId: "alert" }, [job(2), job(1)]);

      expect(ext.sounds).toEqual(["alert"]);
      expect(ext.chrome.notifications.create).toHaveBeenCalledTimes(1);
      expect(ext.chrome.notifications.create.mock.calls[0][1].silent).toBe(true);
    });

    it('the alert sound "System default": the next notification is the one that sounds', async () => {
      await watching();
      await nextCycle({ soundId: "default" }, [job(2), job(1)]);

      expect(ext.sounds).toEqual([]);
      expect(ext.chrome.notifications.create.mock.calls[0][1].silent).toBe(false);
    });

    it("mute: the next new posting reaches the feed with no notification and no tone", async () => {
      await watching();
      await nextCycle({ notificationsMuted: true }, [job(2), job(1)]);

      expect(feedTitles()).toEqual(["PHP Developer 2"]);
      expect(ext.chrome.notifications.create).not.toHaveBeenCalled();
      expect(ext.sounds).toEqual([]);
    });

    it("unmute: the next new posting is notified again", async () => {
      await watching({ sync: { notificationsMuted: true } });
      await nextCycle({ notificationsMuted: false }, [job(2), job(1)]);

      expect(ext.chrome.notifications.create).toHaveBeenCalledTimes(1);
      expect(ext.sounds).toEqual(["chime"]);
    });

    it("the keyword filter turned off: the next detection keeps a title it would have dropped", async () => {
      await watching();
      const { keywords } = ext.api.settings().titleFilter;
      await nextCycle({ titleFilter: { enabled: false, keywords } }, [job(2, "Line Cook"), job(1)]);

      expect(feedTitles()).toEqual(["Line Cook"]);
    });

    it("the keyword filter turned on: the next detection drops a title with none of the keywords", async () => {
      await watching({ sync: { titleFilter: { enabled: false, keywords: ["php"] } } });
      await nextCycle({ titleFilter: { enabled: true, keywords: ["php"] } }, [job(3, "Line Cook"), job(2), job(1)]);

      expect(feedTitles()).toEqual(["PHP Developer 2"]);
    });

    it("a keyword added and one removed: the next detection uses the new list", async () => {
      await watching({ sync: { titleFilter: { enabled: true, keywords: ["php"] } } });
      await nextCycle({ titleFilter: { enabled: true, keywords: ["cook"] } }, [job(3, "Line Cook"), job(2), job(1)]);

      expect(feedTitles()).toEqual(["Line Cook"]);
      expect(ext.sync().titleFilter).toEqual({ enabled: true, keywords: ["cook"] });
    });

    it("the settings are fetched before the check, never after it, with one request", async () => {
      await watching();
      const from = ext.api.requests.length;
      await nextCycle({ soundId: "soft" }, [job(2), job(1)]);

      const cycle = ext.api.requests.slice(from);
      const settingsAt = cycle.findIndex((r) => r.path === "/api/settings");
      const pageAt = cycle.findIndex((r) => r.origin === "https://www.onlinejobs.ph");
      expect(settingsAt).toBeGreaterThanOrEqual(0);
      expect(settingsAt).toBeLessThan(pageAt);
      expect(cycle.filter((r) => r.path === "/api/settings").map((r) => r.method)).toEqual(["GET"]);
    });
  });

  it("nobody opened the popup: it sent nothing, and nothing was written to the account", async () => {
    await watching();
    ext.api.setSettings({ intervalMinutes: 15, soundId: "ping" });
    await tick();

    expect(ext.take()).toEqual([]);
    expect(settingsCalls("PUT")).toEqual([]);
    expect(ext.sync()).toMatchObject({ intervalMinutes: 15, soundId: "ping" });
  });

  describe("the watcher state is this browser's to decide (WD-71): it is reported, never read back", () => {
    it("paused on the account: this browser goes on checking, and its alarm stays", async () => {
      await watching();
      ext.api.setSettings({ watcherState: "paused" });
      ext.pages.onlinejobsph = [job(2), job(1)];
      await tick();

      expect(feedTitles()).toEqual(["PHP Developer 2"]);
      expect(ext.local().watcherState).toBeUndefined();
      expect(await ext.chrome.alarms.get("check-jobs")).toBeDefined();
    });

    it("running on the account: a browser the user paused stays paused, with no alarm", async () => {
      ext = await startExtension({ connected: true, watches: [WATCHES[0]], local: { watcherState: "paused" } });
      for (let turns = 0; turns < 20 && ext.api.settings().watcherState !== "paused"; turns += 1) await ext.settle();
      ext.api.setSettings({ watcherState: "running" });

      await ext.send({ type: "sync-settings" });
      await ext.settle();

      expect(ext.local().watcherState).toBe("paused");
      expect(await ext.chrome.alarms.get("check-jobs")).toBeUndefined();
    });
  });

  describe("while watching is paused", () => {
    const paused = async () => {
      ext = await startExtension({ connected: true, watches: [WATCHES[0]], local: { watcherState: "paused" } });
      ext.api.setSite(() => new Response("<html></html>", { status: 200 }));
      // The report of the paused state (WD-71) has to be through first: its
      // PUT is built on the settings it read.
      for (let turns = 0; turns < 20 && ext.api.settings().watcherState !== "paused"; turns += 1) await ext.settle();
      ext.chrome.alarms.create.mockClear();
    };

    it("there is no alarm, so nothing is fetched: a tick already on its way asks WatchDesk for nothing", async () => {
      await paused();
      const calls = ext.watchdeskCalls().length;
      ext.api.setSettings({ intervalMinutes: 30 });

      await tick();

      expect(ext.watchdeskCalls()).toHaveLength(calls);
      expect(ext.sync().intervalMinutes).not.toBe(30);
      expect(ext.chrome.alarms.create).not.toHaveBeenCalled();
    });

    it("Start Watching: the first check fetches the settings changed meanwhile and the alarm ends on the new interval", async () => {
      await paused();
      ext.api.setSettings({ intervalMinutes: 30, soundId: "alert" });

      await ext.send({ type: "set-watcher-state", state: "running" });
      await ext.settle();
      // The first check, a few seconds after Start, on the interval this
      // browser last knew.
      expect(ext.chrome.alarms.create.mock.calls).toEqual([["check-jobs", { delayInMinutes: 0.1, periodInMinutes: 5 }]]);
      ext.pages.onlinejobsph = [job(1)];
      await tick();

      expect(ext.sync()).toMatchObject({ intervalMinutes: 30, soundId: "alert" });
      expect(ext.chrome.alarms.create).toHaveBeenLastCalledWith("check-jobs", { delayInMinutes: 30, periodInMinutes: 30 });
      expect(ext.api.settings()).toMatchObject({ intervalMinutes: 30, soundId: "alert", watcherState: "running" });
    });
  });

  describe("a refresh that fails leaves the last copy in place and does not stop the check", () => {
    it.each([
      ["offline", () => ext.api.networkError()],
      ["a 403", () => ext.api.json(403, { error: "Forbidden." })],
      ["a 404", () => ext.api.json(404, { error: "Settings not found." })],
      ["a 429", () => ext.api.json(429, { error: "Too many requests." }, { "Retry-After": "30" })],
      ["a 500", () => ext.api.json(500, { error: "Something went wrong." })],
      ["an answer that is not settings", () => ext.api.json(200, { intervalMinutes: "soon" })],
    ])("%s", async (_name, answer) => {
      await watching({ sync: { soundId: "ping" } });
      const copy = ext.sync();
      ext.api.setSettings({ soundId: "alert", intervalMinutes: 30 });
      ext.api.setSettingsRoute(answer);
      const calls = settingsCalls().length;

      ext.pages.onlinejobsph = [job(2), job(1)];
      await tick();

      // Asked once, not again and again.
      expect(settingsCalls().slice(calls).map((r) => r.method)).toEqual(["GET"]);
      expect(ext.sync()).toEqual(copy);
      // The check ran, on the settings last loaded.
      expect(feedTitles()).toEqual(["PHP Developer 2"]);
      expect(ext.sounds).toEqual(["ping"]);
      expect(ext.chrome.alarms.create).not.toHaveBeenCalled();
      expect(ext.local()[TOKEN_KEY]).toBeDefined();

      // WatchDesk back: the cycle after that has the change.
      ext.api.setSettingsRoute(() => undefined);
      ext.pages.onlinejobsph = [job(3), job(2), job(1)];
      await tick();
      expect(ext.sounds).toEqual(["ping", "alert"]);
      expect(ext.sync().intervalMinutes).toBe(30);
    });

    it("a 401: the check still runs, and the last copy becomes this browser's own settings (WD-79)", async () => {
      await watching({ sync: { soundId: "ping" } });
      ext.api.setSettings({ soundId: "alert" });
      ext.api.setSettingsRoute(() => ext.api.json(401, { error: "Sign in to continue." }));

      ext.pages.onlinejobsph = [job(2), job(1)];
      await tick();

      expect(ext.local()[TOKEN_KEY]).toBeUndefined();
      expect(feedTitles()).toEqual(["PHP Developer 2"]);
      expect(ext.sounds).toEqual(["ping"]);
      expect(ext.sync().soundId).toBe("ping");

      // A change is this browser's now, and goes nowhere.
      const calls = ext.watchdeskCalls().length;
      expect(await ext.send({ type: "set-sound", soundId: "soft" })).toEqual({ ok: true });
      expect(ext.sync().soundId).toBe("soft");
      expect(ext.watchdeskCalls()).toHaveLength(calls);
    });
  });

  it("while the import question is unanswered (WD-81), the settings do not sync: no request, and the browser's own are used", async () => {
    ext = await startExtension({ watches: [WATCHES[0]], sync: { soundId: "ping" } });
    ext.api.setSite(() => new Response("<html></html>", { status: 200 }));
    ext.pages.onlinejobsph = [job(1)];
    await tick();
    await ext.pair();
    // Paired a moment ago; the tick below is what asks the question.
    expect(ext.local()[IMPORT_KEY].phase).toBe("connecting");
    ext.api.setSettings({ soundId: "alert", intervalMinutes: 30 });
    ext.chrome.runtime.sendMessage.mockClear();

    ext.pages.onlinejobsph = [job(2), job(1)];
    await tick();
    expect(ext.local()[IMPORT_KEY].phase).toBe("offered");
    ext.pages.onlinejobsph = [job(3), job(2), job(1)];
    await tick();

    expect(settingsCalls()).toEqual([]);
    expect(ext.sync().soundId).toBe("ping");
    expect(ext.sync().intervalMinutes).toBeUndefined();
    expect(ext.sounds).toEqual(["ping", "ping"]);
    expect(told()).toEqual([]);
  });

  it("with no account connected a check asks WatchDesk for nothing and tells the popup nothing", async () => {
    ext = await startExtension({ watches: [WATCHES[0]] });
    ext.api.setSite(() => new Response("<html></html>", { status: 200 }));
    ext.pages.onlinejobsph = [job(1)];
    const popup = await ext.openPopup();
    ext.chrome.runtime.sendMessage.mockClear();

    await tick();

    expect(ext.watchdeskCalls()).toEqual([]);
    expect(told()).toEqual([]);
    expect(popup.$("interval").value).toBe("5");
  });
});

describe.skipIf(REFERENCE_ROOT)("with the popup open, a check that brings a change updates the controls (WD-80)", () => {
  const onTheWeb = { intervalMinutes: 30, soundId: "soft", notificationsMuted: true, titleFilter: { enabled: false, keywords: ["rust", "go"] } };
  const open = async () => {
    await watching();
    const popup = await ext.openPopup();
    ext.chrome.runtime.sendMessage.mockClear();
    ext.take();
    return popup;
  };

  it("all four settings, without the popup asking and without reopening it", async () => {
    const popup = await open();
    ext.api.setSettings(onTheWeb);

    await tick();

    expect(popup.$("interval").value).toBe("30");
    expect(popup.$("sound").value).toBe("soft");
    expect(popup.$("mute-notifications").checked).toBe(true);
    expect(popup.$("title-filter-enabled").checked).toBe(false);
    expect(chips(popup)).toEqual(["rust", "go"]);
    expect(popup.text("settings-sync-note")).toBe(IN_ACCOUNT);
    expect(ext.take()).toEqual([]);
    expect(told()).toHaveLength(1);
    expect(JSON.stringify(told())).not.toContain(ext.local()[TOKEN_KEY]);
  });

  it("a check that brings nothing new tells the popup nothing", async () => {
    await open();
    await tick();
    await tick();
    expect(told()).toEqual([]);
  });

  it("a keyword being typed stays in its box, still focused, and is added to the list the check brought", async () => {
    const popup = await open();
    await popup.click(popup.$("settings-toggle"));
    const box = popup.$("title-filter-new-keyword");
    box.focus();
    popup.type(box, "larav");
    ext.api.setSettings(onTheWeb);

    await tick();

    expect(chips(popup)).toEqual(["rust", "go"]);
    expect(popup.$("title-filter-new-keyword")).toBe(box);
    expect(box.value).toBe("larav");
    expect(popup.document.activeElement).toBe(box);

    popup.type(box, "laravel");
    await popup.click(popup.$("title-filter-add-btn"));
    expect(ext.api.settings().titleFilter).toEqual({ enabled: false, keywords: ["rust", "go", "laravel"] });
  });

  it("a change the user is making as the check starts is not flicked back, and is the one saved", async () => {
    const popup = await open();
    const select = popup.$("interval");
    const shown = [];
    const original = Object.getOwnPropertyDescriptor(popup.window.HTMLSelectElement.prototype, "value");
    select.value = "15";
    select.dispatchEvent(new popup.window.Event("change", { bubbles: true }));
    Object.defineProperty(select, "value", {
      configurable: true,
      get: () => original.get.call(select),
      set: (value) => {
        shown.push(value);
        original.set.call(select, value);
      },
    });

    await tick();

    expect(shown.every((value) => value === "15")).toBe(true);
    expect(select.value).toBe("15");
    expect(ext.api.settings().intervalMinutes).toBe(15);
    expect(ext.sync().intervalMinutes).toBe(15);
  });

  it("WatchDesk out of reach at a check: the line says so, the controls stay, and it clears when WatchDesk is back", async () => {
    const popup = await open();
    ext.api.setSettingsRoute(ext.api.networkError);

    await tick();
    expect(popup.text("settings-sync-note")).toBe(OFFLINE_NOTE);
    expect(popup.$("interval").value).toBe("5");

    ext.api.setSettingsRoute(() => undefined);
    await tick();
    expect(popup.text("settings-sync-note")).toBe(IN_ACCOUNT);
  });
});

describe.skipIf(REFERENCE_ROOT)("a setting changed in the extension is in the account for the web page's next load (WD-80)", () => {
  const start = async (options = {}) => {
    ext = await startExtension({ connected: true, ...options });
    return ext.openPopup();
  };

  it.each([
    ["the check interval", (popup) => popup.choose(popup.$("interval"), "15"), { intervalMinutes: 15 }],
    ["the alert sound", (popup) => popup.choose(popup.$("sound"), "alert"), { soundId: "alert" }],
    ["mute", (popup) => popup.check(popup.$("mute-notifications"), true), { notificationsMuted: true }],
    [
      "the keyword filter turned off",
      (popup) => popup.check(popup.$("title-filter-enabled"), false),
      { titleFilter: { enabled: false, keywords: ["react"] } },
    ],
    [
      "a keyword added",
      async (popup) => {
        popup.type(popup.$("title-filter-new-keyword"), "laravel");
        await popup.click(popup.$("title-filter-add-btn"));
      },
      { titleFilter: { enabled: true, keywords: ["react", "laravel"] } },
    ],
    [
      "a keyword removed",
      (popup) => popup.click(popup.document.querySelector(".keyword-chip-remove")),
      { titleFilter: { enabled: true, keywords: [] } },
    ],
  ])("%s: sent with a PUT on top of what the account held at that moment, and WatchDesk's answer is what this browser keeps", async (_name, act, changed) => {
    const popup = await start({ sync: { titleFilter: { enabled: true, keywords: ["react"] } } });
    // Changed on the web since the popup loaded, in a field this change does
    // not touch. It has to survive the write.
    const elsewhere = "soundId" in changed ? { notificationsMuted: true } : { soundId: "soft" };
    ext.api.setSettings(elsewhere);
    const calls = settingsCalls().length;

    await act(popup);

    const made = settingsCalls().slice(calls);
    expect(made.map((r) => r.method)).toEqual(["GET", "PUT"]);
    // What a refresh of the web's Settings page now loads.
    expect(ext.api.settings()).toMatchObject({ ...changed, ...elsewhere, watcherState: "running" });
    expect(made[1].body).toEqual(ext.api.settings());
    // The copy is the PUT's answer, the web's change included.
    expect(ext.sync()).toMatchObject({ ...changed, ...elsewhere });
    expect(popup.text("settings-change-error")).toBe("");
  });

  it("the keywords this browser keeps are the ones WatchDesk answered with, not the ones it sent", async () => {
    await start({ sync: { titleFilter: { enabled: true, keywords: ["react"] } } });

    const answer = await ext.send({ type: "update-title-filter", titleFilter: { enabled: true, keywords: ["react", "  Go ", "go", "Rust"] } });

    expect(answer.ok).toBe(true);
    expect(ext.api.settings().titleFilter.keywords).toEqual(["react", "Go", "Rust"]);
    expect(answer.titleFilter.keywords).toEqual(["react", "Go", "Rust"]);
    expect(ext.sync().titleFilter.keywords).toEqual(["react", "Go", "Rust"]);
  });

  it("Pause Watching and Start Watching: the account's watcherState follows, and no setting is touched", async () => {
    const popup = await start();
    ext.api.setSettings({ soundId: "soft" });

    await popup.click(popup.$("watcher-toggle"));
    await ext.settle();
    expect(ext.api.settings()).toMatchObject({ watcherState: "paused", soundId: "soft" });
    expect(settingsCalls("PUT").at(-1).body).toMatchObject({ watcherState: "paused", soundId: "soft" });

    await popup.click(popup.$("watcher-toggle"));
    await ext.settle();
    expect(ext.api.settings()).toMatchObject({ watcherState: "running", soundId: "soft" });
  });

  it("with the popup closed too: a change sent straight to the worker is saved the same way", async () => {
    ext = await startExtension({ connected: true });
    expect((await ext.send({ type: "set-notifications-muted", muted: true })).ok).toBe(true);
    expect(ext.api.settings().notificationsMuted).toBe(true);
  });
});

describe.skipIf(REFERENCE_ROOT)("a keyword change is made to the filter the account holds now, not to the list the popup loaded (WD-80)", () => {
  const start = async () => {
    ext = await startExtension({ connected: true, sync: { titleFilter: { enabled: true, keywords: ["react", "vue", "php"] } } });
    const popup = await ext.openPopup();
    await popup.click(popup.$("settings-toggle"));
    // On the web, after the popup loaded: "go" added, "php" removed.
    ext.api.setSettings({ titleFilter: { enabled: true, keywords: ["react", "vue", "go"] } });
    return popup;
  };

  it("adding a keyword keeps one added on the web and does not put back one removed there", async () => {
    const popup = await start();
    popup.type(popup.$("title-filter-new-keyword"), "laravel");
    await popup.click(popup.$("title-filter-add-btn"));

    expect(ext.api.settings().titleFilter).toEqual({ enabled: true, keywords: ["react", "vue", "go", "laravel"] });
    expect(chips(popup)).toEqual(["react", "vue", "go", "laravel"]);
    expect(ext.sync().titleFilter.keywords).toEqual(["react", "vue", "go", "laravel"]);
  });

  it("removing a keyword removes that one only", async () => {
    const popup = await start();
    const vue = [...popup.document.querySelectorAll(".keyword-chip-remove")].find((button) => button.dataset.keyword === "vue");
    await popup.click(vue);

    expect(ext.api.settings().titleFilter).toEqual({ enabled: true, keywords: ["react", "go"] });
    expect(chips(popup)).toEqual(["react", "go"]);
  });

  it("turning the filter off leaves the keywords as the web has them", async () => {
    const popup = await start();
    await popup.check(popup.$("title-filter-enabled"), false);

    expect(ext.api.settings().titleFilter).toEqual({ enabled: false, keywords: ["react", "vue", "go"] });
    expect(chips(popup)).toEqual(["react", "vue", "go"]);
  });

  it("a keyword change leaves the switch as the web has it", async () => {
    const popup = await start();
    ext.api.setSettings({ titleFilter: { enabled: false, keywords: ["react", "vue", "php"] } });
    popup.type(popup.$("title-filter-new-keyword"), "laravel");
    await popup.click(popup.$("title-filter-add-btn"));

    expect(ext.api.settings().titleFilter).toEqual({ enabled: false, keywords: ["react", "vue", "php", "laravel"] });
    expect(popup.$("title-filter-enabled").checked).toBe(false);
  });

  it("a keyword the web already added is not added twice, and nothing is written", async () => {
    const popup = await start();
    const puts = settingsCalls("PUT").length;
    popup.type(popup.$("title-filter-new-keyword"), "GO");
    await popup.click(popup.$("title-filter-add-btn"));

    expect(settingsCalls("PUT")).toHaveLength(puts);
    expect(chips(popup)).toEqual(["react", "vue", "go"]);
    expect(popup.text("settings-change-error")).toBe("");
  });

  it("an addition that would take the account's list past WatchDesk's limit is refused before the write, and the account's list is shown", async () => {
    const popup = await start();
    const hundred = Array.from({ length: 100 }, (_, i) => `keyword ${i}`);
    ext.api.setSettings({ titleFilter: { enabled: true, keywords: hundred } });
    const puts = settingsCalls("PUT").length;
    popup.type(popup.$("title-filter-new-keyword"), "laravel");
    await popup.click(popup.$("title-filter-add-btn"));

    expect(settingsCalls("PUT")).toHaveLength(puts);
    expect(popup.text("settings-change-error")).toBe("Keep at most 100 keywords");
    expect(chips(popup)).toEqual(hundred);
    expect(ext.api.settings().titleFilter.keywords).toEqual(hundred);
    // The keyword stays in the box to be dealt with.
    expect(popup.$("title-filter-new-keyword").value).toBe("laravel");
  });

  describe("mergeTitleFilter(current, shown, wanted)", () => {
    const f = (enabled, ...keywords) => ({ enabled, keywords });
    it.each([
      ["nothing changed elsewhere: the wanted filter", f(true, "a", "b"), f(true, "a", "b"), f(true, "a", "b", "c"), f(true, "a", "b", "c")],
      ["an addition, over one made elsewhere", f(true, "a", "b", "x"), f(true, "a", "b"), f(true, "a", "b", "c"), f(true, "a", "b", "x", "c")],
      ["a removal, over one made elsewhere", f(true, "a"), f(true, "a", "b"), f(true, "b"), f(true)],
      ["a removal of a keyword already gone elsewhere", f(true, "a"), f(true, "a", "b"), f(true, "a"), f(true, "a")],
      ["letter case does not make a second keyword", f(true, "React"), f(true), f(true, "react"), f(true, "React")],
      ["a removal finds the keyword in another letter case", f(true, "React", "b"), f(true, "react", "b"), f(true, "b"), f(true, "b")],
      ["the switch only: the keywords are the account's", f(true, "x"), f(true, "a"), f(false, "a"), f(false, "x")],
      ["keywords only: the switch is the account's", f(false, "a"), f(true, "a"), f(true, "a", "b"), f(false, "a", "b")],
      ["the account's order is kept, additions go last", f(true, "c", "a"), f(true, "a", "c"), f(true, "b", "a", "c"), f(true, "c", "a", "b")],
      ["nothing was shown yet: the wanted keywords are added", f(true, "x"), undefined, f(false, "a"), f(false, "x", "a")],
    ])("%s", (_name, current, shown, wanted, merged) => {
      expect(mergeTitleFilter(current, shown, wanted)).toEqual(merged);
    });

    it.each([[undefined], [null], [{ enabled: "yes", keywords: [] }], [{ enabled: true }]])(
      "an account filter that is not one (%j) is replaced by the wanted filter",
      (current) => {
        const wanted = f(true, "a");
        expect(mergeTitleFilter(current, f(true), wanted)).toBe(wanted);
      },
    );
  });
});
