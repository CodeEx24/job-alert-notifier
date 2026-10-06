// settings-limits.js — what WatchDesk accepts for a setting (WD-79).
//
// Copied from the WatchDesk repository, which shares no code with this one:
//   lib/settings.ts             INTERVAL_MINUTES_OPTIONS, SOUND_IDS
//   lib/validation/settings.ts  TITLE_FILTER_MAX_KEYWORDS,
//                               TITLE_FILTER_KEYWORD_MAX_LENGTH,
//                               normalizeTitleFilterKeywords, and the messages
// A change there has to be made here too. tests/settings-limits.test.js fails
// when the popup offers an interval or a sound that is not on these lists.
//
// With an account connected, account-settings.js checks a change against
// these before anything is sent, so a value WatchDesk would refuse is
// refused in the popup with WatchDesk's own words and no request. With no
// account connected nothing here applies: the settings are this browser's,
// as they always were.

export const INTERVAL_MINUTES_OPTIONS = Object.freeze([1, 5, 15, 30]);
export const SOUND_IDS = Object.freeze(["default", "chime", "ping", "alert", "soft", "none"]);
export const TITLE_FILTER_MAX_KEYWORDS = 100;
export const TITLE_FILTER_KEYWORD_MAX_LENGTH = 100;

// The keywords as WatchDesk stores them: trimmed, blanks dropped, and a
// keyword already in the list, in any letter case, not kept twice. The
// limits below count what is left.
export function normalizeTitleFilterKeywords(keywords) {
  const seen = new Set();
  return keywords
    .map((keyword) => keyword.trim())
    .filter((keyword) => {
      const key = keyword.toLowerCase();
      if (!keyword || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// Why WatchDesk would refuse these settings (any of intervalMinutes, soundId,
// notificationsMuted, titleFilter), in its own words, or null when it would
// take them.
export function settingsProblem(settings) {
  if ("intervalMinutes" in settings && !INTERVAL_MINUTES_OPTIONS.includes(settings.intervalMinutes)) {
    return `Check interval must be ${INTERVAL_MINUTES_OPTIONS.slice(0, -1).join(", ")} or ${INTERVAL_MINUTES_OPTIONS.at(-1)} minutes`;
  }
  if ("soundId" in settings && !SOUND_IDS.includes(settings.soundId)) return "Choose one of the alert sounds";
  if ("notificationsMuted" in settings && typeof settings.notificationsMuted !== "boolean") {
    return "Muted must be true or false";
  }
  if ("titleFilter" in settings) {
    const filter = settings.titleFilter;
    if (!filter || typeof filter !== "object") return "Send the title filter";
    if (typeof filter.enabled !== "boolean") return "Enabled must be true or false";
    if (!Array.isArray(filter.keywords)) return "Keywords must be a list";
    if (filter.keywords.some((keyword) => typeof keyword !== "string")) return "Keywords must be text";
    const keywords = normalizeTitleFilterKeywords(filter.keywords);
    if (keywords.some((keyword) => keyword.length > TITLE_FILTER_KEYWORD_MAX_LENGTH)) {
      return `A keyword must be at most ${TITLE_FILTER_KEYWORD_MAX_LENGTH} characters`;
    }
    if (keywords.length > TITLE_FILTER_MAX_KEYWORDS) return `Keep at most ${TITLE_FILTER_MAX_KEYWORDS} keywords`;
  }
  return null;
}
