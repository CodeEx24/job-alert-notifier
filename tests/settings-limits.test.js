// WD-79: what WatchDesk accepts for a setting (settings-limits.js), and that
// the popup offers nothing outside it. The numbers are a copy of the
// WatchDesk repository's lib/settings.ts and lib/validation/settings.ts; the
// two repositories share no code, so this is what notices the extension
// drifting from them.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  INTERVAL_MINUTES_OPTIONS,
  SOUND_IDS,
  TITLE_FILTER_MAX_KEYWORDS,
  TITLE_FILTER_KEYWORD_MAX_LENGTH,
  normalizeTitleFilterKeywords,
  settingsProblem,
} from "../settings-limits.js";
import { SOUND_OPTIONS } from "../sounds.js";

describe("the limits, as WatchDesk has them", () => {
  it("are WatchDesk's: 1, 5, 15 or 30 minutes, its six sounds, 100 keywords of 100 characters", () => {
    expect(INTERVAL_MINUTES_OPTIONS).toEqual([1, 5, 15, 30]);
    expect(SOUND_IDS).toEqual(["default", "chime", "ping", "alert", "soft", "none"]);
    expect(TITLE_FILTER_MAX_KEYWORDS).toBe(100);
    expect(TITLE_FILTER_KEYWORD_MAX_LENGTH).toBe(100);
  });

  it("every interval the popup offers is one WatchDesk takes", () => {
    const doc = new JSDOM(readFileSync("popup.html", "utf8")).window.document;
    const offered = [...doc.getElementById("interval").options].map((option) => Number(option.value));
    expect(offered.length).toBeGreaterThan(0);
    for (const minutes of offered) expect(INTERVAL_MINUTES_OPTIONS, `${minutes} minutes`).toContain(minutes);
  });

  it("every sound the popup offers is one WatchDesk takes", () => {
    expect(SOUND_OPTIONS.length).toBeGreaterThan(0);
    for (const { id } of SOUND_OPTIONS) expect(SOUND_IDS, id).toContain(id);
  });

  it("the extension's default settings are within them", () => {
    expect(settingsProblem({ intervalMinutes: 5, soundId: "chime", notificationsMuted: false })).toBeNull();
  });
});

describe("normalizeTitleFilterKeywords", () => {
  it("trims, drops blanks, and keeps the first spelling of a keyword repeated in any case", () => {
    expect(normalizeTitleFilterKeywords(["  PHP ", "", "   ", "php", "React", "react ", "Vue"])).toEqual(["PHP", "React", "Vue"]);
    expect(normalizeTitleFilterKeywords([])).toEqual([]);
  });
});

describe("settingsProblem", () => {
  const filter = (keywords, enabled = true) => ({ titleFilter: { enabled, keywords } });
  const many = (n) => Array.from({ length: n }, (_, i) => `keyword ${i}`);

  it("takes anything WatchDesk would", () => {
    for (const minutes of [1, 5, 15, 30]) expect(settingsProblem({ intervalMinutes: minutes })).toBeNull();
    for (const soundId of SOUND_IDS) expect(settingsProblem({ soundId })).toBeNull();
    expect(settingsProblem({ notificationsMuted: true })).toBeNull();
    expect(settingsProblem(filter([]))).toBeNull();
    expect(settingsProblem(filter(many(100), false))).toBeNull();
    expect(settingsProblem(filter(["x".repeat(100)]))).toBeNull();
    expect(settingsProblem({})).toBeNull();
  });

  it.each([0, 2, 10, 60, -5, 1.5, "5", null, undefined, NaN])("refuses an interval of %j in WatchDesk's words", (minutes) => {
    expect(settingsProblem({ intervalMinutes: minutes })).toBe("Check interval must be 1, 5, 15 or 30 minutes");
  });

  it.each(["bell", "", "Chime", 3, null])("refuses the sound %j", (soundId) => {
    expect(settingsProblem({ soundId })).toBe("Choose one of the alert sounds");
  });

  it("refuses a mute that is not true or false", () => {
    expect(settingsProblem({ notificationsMuted: "yes" })).toBe("Muted must be true or false");
  });

  it("refuses a keyword one character too long, and a list one keyword too long", () => {
    expect(settingsProblem(filter(["ok", "x".repeat(101)]))).toBe("A keyword must be at most 100 characters");
    expect(settingsProblem(filter(many(101)))).toBe("Keep at most 100 keywords");
  });

  it("counts the keywords as WatchDesk stores them: padding and repeats do not count", () => {
    expect(settingsProblem(filter([`  ${"x".repeat(100)}  `]))).toBeNull();
    expect(settingsProblem(filter([...many(100), "KEYWORD 0", "  keyword 1 ", "  "]))).toBeNull();
  });

  it("refuses a filter that is not one", () => {
    expect(settingsProblem({ titleFilter: null })).toBe("Send the title filter");
    expect(settingsProblem({ titleFilter: { enabled: "on", keywords: [] } })).toBe("Enabled must be true or false");
    expect(settingsProblem({ titleFilter: { enabled: true, keywords: "php" } })).toBe("Keywords must be a list");
    expect(settingsProblem({ titleFilter: { enabled: true, keywords: ["php", 7] } })).toBe("Keywords must be text");
  });
});
