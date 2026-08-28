// sites.js
//
// One "adapter" per job board. This is the file you extend when you scale
// to more sites. Each adapter just needs to know:
//   - which URLs it applies to
//   - how to pull job {id, title, url, postedRaw, postedAt} out of a parsed
//     HTML document
//
// ARCHITECTURE NOTE — two ways a site gets checked (fetchMode):
// OnlineJobs.ph renders its job search results as server-side HTML — a
// background fetch() of the search URL returns real job listings in the
// response body, so it can be checked with no tab open at all
// (fetchMode: "background").
//
// Glassdoor and LinkedIn are both JavaScript-rendered: a raw fetch() of
// either's search URL returns a near-empty shell (LinkedIn's shell embeds
// only the single job referenced by `currentJobId`, for link-preview
// purposes — never the actual result list). Both need fetchMode:
// "content-script" instead — a script injected into an actual open,
// signed-in tab that reads the already-rendered DOM
// (background.js's fetchJobsViaTab() handles finding/messaging that tab
// generically for any site using this mode). Each "extractJobs(doc)"
// function below is written so its logic can be reused as-is inside that
// site's content script — only the fetching mechanism changes, not the
// parsing logic (see the note on each content-*.js file for why the code
// is duplicated there rather than imported).

// OnlineJobs.ph prints the posting timestamp as literal text next to each
// listing, e.g. "Posted on 2026-07-31 11:09:19". It reads as the site's
// local time — OnlineJobs.ph is a Philippines-based board, so this is
// treated as Philippine Time (UTC+8) when converting to a real Date.
// If that assumption turns out wrong once you see it live, this is the
// one line to adjust.
const POSTED_ON_RE = /Posted on (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/;
const POSTED_SITE_UTC_OFFSET = "+08:00";

// Shared helper: climb from a job anchor up toward the document root, but
// STOP just before entering an ancestor that contains more than one link
// matching `isJobLink` — i.e. stop right before we'd cross into a shared
// list container holding sibling job cards. Without this guard, a card
// that's missing its own posted-date element would silently "borrow" a
// neighboring job's date once the climb reaches their common ancestor
// (both cards' text is visible from there). Searches should be scoped to
// the returned container, never wider.
function scopedJobContainer(anchor, isJobLink, maxLevels = 6) {
  let node = anchor.parentElement;
  let candidate = node;
  for (let i = 0; i < maxLevels && node; i++) {
    const jobLinksInside = Array.from(node.querySelectorAll("a")).filter(isJobLink);
    if (jobLinksInside.length > 1) break;
    candidate = node;
    node = node.parentElement;
  }
  return candidate;
}

function findPostedText(anchor) {
  const container = scopedJobContainer(anchor, (a) =>
    /\/jobseekers\/job\//.test(a.getAttribute("href") || "")
  );
  if (!container) return null;
  const match = (container.textContent || "").match(POSTED_ON_RE);
  return match ? match[1] : null;
}

function toIsoTimestamp(postedRaw) {
  if (!postedRaw) return null;
  const d = new Date(postedRaw.replace(" ", "T") + POSTED_SITE_UTC_OFFSET);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function findOnlineJobsPhSalary(anchor) {
  const container = scopedJobContainer(anchor, (a) =>
    /\/jobseekers\/job\//.test(a.getAttribute("href") || "")
  );
  return findSalaryText(container);
}

// --- Salary / rate extraction -------------------------------------------
//
// Best-effort only, on purpose: not every posting lists a figure (LinkedIn
// especially usually doesn't, unless the poster added one), and the exact
// markup for whichever ones do varies by site — and can drift with either
// site's own redesigns/A-B tests. Rather than hard-coding one fragile
// selector per site, this looks for a short, salary-shaped piece of text
// near the job listing — the same generic approach reused across all four
// sites — and simply leaves it null when nothing matches, exactly like
// postedRaw already does when a date isn't present. That also means it's
// naturally currency-and-format-agnostic (hourly rate, fixed budget,
// annual range, "K" shorthand, "Employer est." qualifiers, etc.) without
// needing to know which of those a given site uses.
//
// NOT verified against every site's live markup at the time this was
// written (no live browser session was available). If a real posting on a
// given site clearly shows a range in its search results and this still
// comes back empty for it, that's the signal to open a real search there,
// see the actual markup, and tighten SALARY_RE or add a site-specific
// selector — the failure mode is "shows nothing" (safe), never a wrong
// number attributed to a job.
// `i` flag matters in practice, not just in theory: a real posting on
// OnlineJobs.ph showed "$10/Hour" (capital H) and the original version of
// this regex — case-sensitive, only matching lowercase "hour" — silently
// truncated that to just "$10", dropping the "/Hour" part. Each side of a
// range can also carry its own unit suffix (e.g. "$120K/yr - $150K/yr",
// common on LinkedIn/Glassdoor-style postings) rather than one trailing
// unit for the whole range, so the suffix group is checked after BOTH the
// first number and the second.
const SALARY_RE =
  /\$\s?\d[\d,]*(?:\.\d{1,2})?\s?[KkMm]?(?:\s?\/\s?(?:hr|hour|yr|year|mo|month))?(?:\s?(?:-|–|—|to)\s?\$?\s?\d[\d,]*(?:\.\d{1,2})?\s?[KkMm]?(?:\s?\/\s?(?:hr|hour|yr|year|mo|month))?)?/i;

function findSalaryText(container) {
  if (!container) return null;
  // Same script/style/noscript-stripping precaution as visibleText() above
  // (and content-*.js's matching visibleBodyText()) — plain .textContent
  // walks into embedded <script> tag contents too, and a real page's
  // inline JSON config can easily contain a dollar-amount-looking string
  // that has nothing to do with any job's actual salary.
  const clone = container.cloneNode(true);
  clone.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
  // Prefer a short, isolated leaf element whose text IS basically the
  // salary line/pill (e.g. "$70K - $90K (Employer est.)" or "$15.00 -
  // $35.00/hr") — mirrors how posted-date labels are structured on these
  // same sites. The length cap is what keeps this from misfiring on a
  // long job-description sentence that happens to mention a dollar figure
  // in passing (e.g. "budget under $500 for materials").
  const leaves = clone.querySelectorAll("*");
  for (const el of leaves) {
    if (el.children.length > 0) continue;
    const text = (el.textContent || "").trim();
    if (!text || text.length > 60) continue;
    if (SALARY_RE.test(text)) return text;
  }
  // Fall back to scanning the whole container's text for a salary-shaped
  // substring — needed for server-rendered markup where the figure isn't
  // necessarily isolated in its own leaf node (e.g. OnlineJobs.ph).
  const text = clone.textContent || "";
  const match = text.match(SALARY_RE);
  return match ? match[0].trim() : null;
}

// Some sites render the ENTIRE job card — title, posted-date, AND/OR
// salary — inside one single clickable `<a>`, rather than the title
// living in its own isolated text node. When that happens, naively using
// the anchor's whole `.textContent` as the title pulls those other fields
// in too. Confirmed live on OnlineJobs.ph (2026-08): a real posting's
// title came back as "Full Stack Web Developer Part Time Posted on
// 2026-08-09 13:26:15 $10/Hour" — the posted-date and salary text were
// both inside the same anchor as the title, not separate sibling elements
// the way the original extraction logic assumed.
//
// This strips out anything already captured separately as the posted-date
// or salary (each site passes in whatever raw text it actually matched —
// see each call site below) before using what's left as the display
// title. It's a no-op (returns rawTitle unchanged) on a site/listing where
// the title genuinely doesn't contain those fields, so it's safe to apply
// everywhere rather than just where it's been confirmed necessary.
function cleanTitle(rawTitle, ...stripPatterns) {
  let t = rawTitle;
  for (const p of stripPatterns) {
    if (!p) continue;
    // A RegExp (only ever POSTED_ON_RE, for OnlineJobs.ph's fixed "Posted
    // on <timestamp>" phrasing) vs. a plain string (the exact raw text
    // another helper already matched, e.g. a salary pill or a relative
    // "6d"/"3 days ago" label) need different removal strategies — split/
    // join removes every occurrence of a literal string; regex .replace
    // only needs one pass since the phrase only ever appears once.
    t = p instanceof RegExp ? t.replace(p, " ") : t.split(p).join(" ");
  }
  t = t.replace(/\s+/g, " ").trim();
  // Safety net: never return an empty title just because everything got
  // stripped out (e.g. an unexpected false-positive match) — fall back to
  // the original text rather than showing a blank posting.
  return t || rawTitle.trim();
}

// --- Glassdoor helpers -----------------------------------------------
//
// Unlike OnlineJobs.ph, Glassdoor doesn't print an exact timestamp — just a
// relative freshness label next to each listing ("24h", "6d", "30d+",
// "Today"). We parse that into an *approximate* postedAt (now minus the
// label's duration). "30d+" means "at least 30 days", so it's flagged as
// approximate rather than treated as an exact 30-day-old timestamp.
const GLASSDOOR_RELATIVE_RE = /^(\d{1,3})\s*(h|d)(\+)?$/i;

function parseGlassdoorRelative(text) {
  if (!text) return null;
  const t = text.trim();
  if (/^(today|new|just posted)$/i.test(t)) {
    return { ms: 0, approx: false, label: "Today" };
  }
  const match = t.match(GLASSDOOR_RELATIVE_RE);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const approx = Boolean(match[3]);
  const ms = unit === "h" ? n * 3600000 : n * 86400000;
  return { ms, approx, label: `${n}${unit}${approx ? "+" : ""} ago` };
}

// Looks for a small "leaf" element (no element children of its own) near
// the job link whose ENTIRE trimmed text matches a freshness label like
// "6d" or "24h". Requiring the whole element's text to match (rather than
// substring-matching a big blob of concatenated text) avoids false
// positives from salary figures or other numbers on the card.
function findLeafMatch(container, regex) {
  const all = container.querySelectorAll("*");
  for (const el of all) {
    if (el.children.length > 0) continue;
    const text = (el.textContent || "").trim();
    if (text && regex.test(text)) return text;
  }
  return null;
}

function findGlassdoorPostedLabel(anchor) {
  const container = scopedJobContainer(anchor, (a) =>
    /\/job-listing\//.test(a.getAttribute("href") || "")
  );
  if (!container) return null;
  return findLeafMatch(container, /^(\d{1,3}\s*[hd]\+?|today|new|just posted)$/i);
}

function findGlassdoorSalary(anchor) {
  const container = scopedJobContainer(anchor, (a) =>
    /\/job-listing\//.test(a.getAttribute("href") || "")
  );
  return findSalaryText(container);
}

// `doc.body.textContent` walks EVERY text node, including the contents of
// <script> tags — and Glassdoor (like most React/Next.js sites) embeds a
// chunk of inline JSON config on literally every page load that happens to
// contain a real key like "recaptcha":{"publicKeyForUserAuth":...}". That
// made the bare "captcha" phrase below match on every single page, blocked
// or not — completely defeating its purpose as a signal. Stripping
// <script>/<style>/<noscript> content first (can't use the simpler
// `.innerText`, since `doc` here is a DOMParser-parsed document that was
// never attached to a render tree, and `.innerText` needs layout to work)
// keeps this scoped to what a human would actually see on the page.
function visibleText(doc) {
  const body = doc.body;
  if (!body) return "";
  const clone = body.cloneNode(true);
  clone.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
  return (clone.textContent || "").toLowerCase();
}

// Glassdoor's anti-bot layer sometimes serves a 200-status challenge/login
// page instead of results. If we find zero jobs, check for tell-tale
// phrases so that shows up as a clear error instead of a silent "0 new
// jobs" (which would look identical to a genuinely empty search).
function looksLikeGlassdoorBlockPage(doc) {
  const text = visibleText(doc);
  return [
    "verify you are a human",
    "unusual traffic",
    "checking your browser",
    "access denied",
    "captcha",
    "are you a robot",
  ].some((phrase) => text.includes(phrase));
}

// --- LinkedIn helpers --------------------------------------------------
//
// LinkedIn actually serves TWO different job-search page shapes depending
// on how you arrive at the URL:
//   - /jobs/search-results/?currentJobId=...  — the single-job-focused view
//     you get when clicking a job from inside LinkedIn's own UI (this is
//     what you get if you just copy the address bar). Confirmed live: its
//     job cards have no href, no data-job-id, no embedded JSON — every
//     class name is a build-specific hash that changes on deploy. There is
//     no reliable way to read a job list out of this page shape.
//   - /jobs/search/?keywords=...              — the older results page.
//     Confirmed live: each job card is a real `<a href="/jobs/view/<id>/">`
//     link, so it can be parsed the same stable way as Glassdoor's
//     `/job-listing/` links.
// Because of this, `normalizeUrl()` below rewrites any watch URL you add
// onto the `/jobs/search/` shape (dropping only the params that describe
// which single job was open, not the search itself), so you can paste
// either kind of LinkedIn URL and it'll still work.
function normalizeLinkedInUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (!u.hostname.endsWith("linkedin.com")) return rawUrl;

  u.pathname = u.pathname.replace(/\/jobs\/search-results\/?/, "/jobs/search/");
  if (!u.pathname.startsWith("/jobs/search")) {
    // Not a search-results-shaped URL (e.g. a single /jobs/view/ link) —
    // leave it alone rather than guessing what it should become.
    return rawUrl;
  }
  // These three only describe which single job was open/how you clicked
  // into it when you copied the link — not the search itself — so they're
  // dropped. Every real filter (keywords, location, f_TPR, f_SAL, f_E,
  // f_JT, etc.) is left untouched.
  for (const param of ["currentJobId", "origin", "referralSearchId"]) {
    u.searchParams.delete(param);
  }
  return u.toString();
}

// --- Shared tab-matching (used by both background.js's real checks and
// popup.js's "Open Link"/"Open all" tab-reuse) ---------------------------
//
// A watch's saved url and a real, currently-open tab's url can legitimately
// diverge even when the tab genuinely IS that watch's search: LinkedIn's
// client-side routing appends `currentJobId` (and friends) to a
// `/jobs/search/` tab's address bar within moments of load, just from the
// page rendering — no click required. Plain `chrome.tabs.query({url: watch.url})`
// requires a literal match, so that drift alone was enough to make a
// perfectly valid tab stop being recognized as "already open" almost
// immediately after it loaded.
//
// That wouldn't matter much with only one watch per site — the old
// fallback ("exactly one tab open anywhere on this site's search section =
// must be mine") covered it. It falls apart the moment two or more watches
// on the same site each have their own (both drifted) tab open: the
// pattern query then returns 2+ candidates and there's no way to tell
// which belongs to which watch, so EVERY watch on that site reports
// "multiple tabs, can't tell which" — forever, since nothing about that
// situation ever resolves on its own.
//
// The fix: for any site that defines normalizeUrl (currently just
// LinkedIn), re-run that same normalization on each candidate tab's LIVE
// url and compare it to the watch's already-normalized saved url. Since
// normalizeUrl strips exactly the params that describe "which job you
// clicked into," not the search itself, this recognizes a drifted tab as
// belonging to a specific watch even when several other drifted tabs for
// OTHER watches are open on the same site at the same time — something the
// old "only one tab total" guess could never do.
//
// `candidates` should already have any tabs known to belong to a
// different watch (e.g. ones a batch "open all" run just created for
// someone else) filtered out by the caller. Returns the same shape as
// before: `tab` is the matched tab or null; `ambiguous: true` means more
// than one open tab could plausibly be this watch's and it's not safe to
// guess.
export function pickWatchTabFromCandidates(watch, site, candidates) {
  if (site?.normalizeUrl) {
    const targetKey = site.normalizeUrl(watch.url);
    const normMatches = candidates.filter((t) => {
      try {
        return site.normalizeUrl(t.url) === targetKey;
      } catch {
        return false;
      }
    });
    if (normMatches.length === 1) return { tab: normMatches[0], ambiguous: false };
    if (normMatches.length > 1) return { tab: null, ambiguous: true };
    // No candidate's normalized url matches this watch's — fall through to
    // the coarser "only one tab total for this site" guess below, which
    // still helps for sites with no normalizeUrl (Glassdoor, Upwork) or
    // for a tab that's drifted in some way normalizeUrl doesn't strip.
  }
  if (candidates.length === 1) return { tab: candidates[0], ambiguous: false };
  if (candidates.length > 1) return { tab: null, ambiguous: true };
  return { tab: null, ambiguous: false };
}

// Confirmed live (2026-08): non-promoted LinkedIn job cards on the
// `/jobs/search/` page include a `<time datetime="YYYY-MM-DD">` element
// with the posting date (day precision only, no time-of-day) alongside a
// human label like "3 days ago". Promoted/sponsored cards don't show a
// posted date at all (they show "Promoted" instead) — extractJobs() below
// leaves postedRaw/postedAt as null for those rather than guessing.
function findLinkedInPostedTime(anchor) {
  const container = scopedJobContainer(anchor, (a) => /\/jobs\/view\//.test(a.getAttribute("href") || ""));
  if (!container) return null;
  const timeEl = container.querySelector("time");
  if (!timeEl) return null;
  const datetime = timeEl.getAttribute("datetime");
  const rawText = (timeEl.textContent || "").replace(/\s+/g, " ").trim();
  // The element sometimes holds two lines of text (e.g. "3 days ago" plus
  // an accessibility-only "Within the past 24 hours") — keep only the
  // leading "<n> <unit> ago" / "Today" phrase for display.
  const label = (rawText.match(/^(.*?\bago\b|today)/i) || [rawText])[0].trim();
  return { datetime, label: label || rawText };
}

function findLinkedInSalary(anchor) {
  const container = scopedJobContainer(anchor, (a) => /\/jobs\/view\//.test(a.getAttribute("href") || ""));
  return findSalaryText(container);
}

// LinkedIn shows a sign-in wall or security checkpoint to sessions it
// doesn't trust, similar in spirit to Glassdoor's. This heuristic is
// written from general knowledge of what those interstitials say, not
// verified against a live triggered example (doing that intentionally
// would risk flagging a real account) — treat it as a best first guess to
// refine if a real occurrence ever surfaces a different message.
function looksLikeLinkedInBlockPage(doc) {
  const text = visibleText(doc);
  return [
    "let's do a quick security check",
    "security verification",
    "unusual activity",
    "verify you are a human",
    "are you a robot",
    "captcha",
    "sign in to see more jobs",
  ].some((phrase) => text.includes(phrase));
}

// --- Upwork helpers -----------------------------------------------------
//
// Confirmed live (2026-08): Upwork sits behind a Cloudflare managed
// challenge ("Just a moment..." / "Verification successful, waiting for
// www.upwork.com to respond") on a cold request — a background fetch()
// would land on that interstitial, not real results, the same problem
// Glassdoor has. Once a real browser tab clears the challenge, though,
// the search results render as plain server-delivered HTML and are fully
// readable even signed out (no login wall on the results list itself,
// unlike Glassdoor sometimes teasing partial results). So, like Glassdoor
// and LinkedIn, this needs fetchMode: "content-script" — reading an
// actual open tab's live DOM rather than fetching in the background.
//
// Job tiles are marked with stable data-test hooks rather than
// build-hashed class names: data-test="JobTile" for each card,
// data-test~="job-tile-title-link" for the title anchor (its href embeds
// the job's numeric id after a "~", e.g. ".../Full-Stack-Developer_~0220
// 77401644373082589/"), and data-test="job-pubilshed-date" (that's
// Upwork's own attribute spelling, not a typo introduced here) for the
// relative "Posted ... ago" label. Confirmed a bare
// "/jobs/~<id>/" URL (dropping the slug entirely) correctly redirects to
// the real job posting, so that's what extractJobs() builds rather than
// reusing the slug out of the href (which — another live quirk — has the
// search's <span class="highlight"> markup baked into it literally).
const UPWORK_RELATIVE_UNIT_MS = {
  minute: 60000,
  hour: 3600000,
  day: 86400000,
  week: 7 * 86400000,
  month: 30 * 86400000,
  year: 365 * 86400000,
};

// Confirmed live formats: "Posted 4 minutes ago", "Posted 1 hour ago",
// "Posted 3 weeks ago", "Posted last week", "Posted 2 months ago",
// "Posted last month". Minute/hour granularity is treated as close enough
// to exact; day/week/month/year (and the "last ___" shorthand) are
// inherently bucketed language, so those are flagged approximate — same
// spirit as Glassdoor's "30d+" flag.
function parseUpworkRelative(text) {
  if (!text) return null;
  const t = text.trim().replace(/^Posted\s+/i, "");
  const lower = t.toLowerCase();
  if (/^(just now|moments ago|today)$/.test(lower)) {
    return { ms: 0, approx: lower === "today", label: t };
  }
  if (lower === "yesterday") return { ms: UPWORK_RELATIVE_UNIT_MS.day, approx: true, label: t };
  if (lower === "last week") return { ms: UPWORK_RELATIVE_UNIT_MS.week, approx: true, label: t };
  if (lower === "last month") return { ms: UPWORK_RELATIVE_UNIT_MS.month, approx: true, label: t };
  if (lower === "last year") return { ms: UPWORK_RELATIVE_UNIT_MS.year, approx: true, label: t };

  const match = lower.match(/^(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const approx = unit !== "minute" && unit !== "hour";
  return { ms: n * UPWORK_RELATIVE_UNIT_MS[unit], approx, label: t };
}

// Confirmed live: Cloudflare's interstitial title reads "Just a moment..."
// with body text like "Verification successful. Waiting for
// www.upwork.com to respond" plus a "Cloudflare Ray ID:" footer. Also
// covers the more common "checking your browser" / "attention required"
// phrasing Cloudflare uses elsewhere, in case Upwork's exact copy changes.
function looksLikeUpworkBlockPage(doc) {
  const text = ((doc.title || "") + " " + visibleText(doc)).toLowerCase();
  return [
    "just a moment",
    "checking your browser",
    "verification successful",
    "verify you are human",
    "attention required",
    "enable javascript and cookies",
    "needs to review the security of your connection",
  ].some((phrase) => text.includes(phrase));
}

export const SITES = {
  onlinejobsph: {
    id: "onlinejobsph",
    name: "OnlineJobs.ph",
    // Any URL under this host can be a "watch" target (job search results
    // page with whatever filters the user applied).
    hostMatch: (url) => {
      try {
        return new URL(url).hostname.endsWith("onlinejobs.ph");
      } catch {
        return false;
      }
    },
    defaultUrl: "https://www.onlinejobs.ph/jobseekers/jobsearch",
    fetchMode: "background", // plain background fetch() works
    // Pull job postings out of a parsed HTML Document.
    // Deliberately keyed off the stable job URL pattern
    // (/jobseekers/job/<slug>-<numeric-id>) rather than CSS class names,
    // since class names are far more likely to change than the URL scheme.
    extractJobs(doc, baseUrl) {
      const anchors = Array.from(
        doc.querySelectorAll('a[href*="/jobseekers/job/"]')
      );
      const seen = new Set();
      const jobs = [];
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        const match = href.match(/\/jobseekers\/job\/([a-z0-9-]+)-(\d+)/i);
        if (!match) continue;
        const id = match[2];
        if (seen.has(id)) continue; // same job can appear twice (title + image link)
        const rawTitle = (a.textContent || "").trim();
        if (!rawTitle) continue; // skip non-text (e.g. thumbnail) links to the same job
        seen.add(id);
        let absoluteUrl;
        try {
          absoluteUrl = new URL(href, baseUrl).toString();
        } catch {
          absoluteUrl = href;
        }
        const postedRaw = findPostedText(a);
        const postedAt = toIsoTimestamp(postedRaw);
        const salaryRaw = findOnlineJobsPhSalary(a);
        // The whole card (title + "Posted on ..." + salary) can live
        // inside one anchor here — strip those back out of the title.
        const title = cleanTitle(rawTitle, POSTED_ON_RE, salaryRaw);
        jobs.push({ id, title, url: absoluteUrl, postedRaw, postedAt, salaryRaw });
      }
      return jobs;
    },
  },

  glassdoor: {
    id: "glassdoor",
    name: "Glassdoor",
    hostMatch: (url) => {
      try {
        return new URL(url).hostname.endsWith("glassdoor.com");
      } catch {
        return false;
      }
    },
    // A broad "remote jobs" search as a reasonable default; the user will
    // normally replace this by pasting their own filtered search URL.
    defaultUrl:
      "https://www.glassdoor.com/Job/remote-jobs-SRCH_IL.0,6_IS11047.htm",
    // Confirmed in practice: a background fetch() to Glassdoor gets
    // flagged by its anti-bot layer even on a fresh, first-ever request —
    // this isn't just rate-limiting, so there's no reliable "background"
    // mode for it. Instead, content-glassdoor.js reads an actual open,
    // signed-in Glassdoor tab's live DOM, and background.js reaches it
    // via chrome.tabs.sendMessage (see fetchJobsViaTab there). This
    // extractJobs() function is kept here for documentation/offline
    // testing, but the live path duplicates it in content-glassdoor.js
    // (content scripts run as classic, non-module scripts, so importing
    // this file directly isn't something to rely on).
    fetchMode: "content-script",
    tabQueryPattern: "https://www.glassdoor.com/Job/*",
    requiresSignIn: true,
    // Glassdoor job listing links look like:
    //   /job-listing/<title-slug>-<company-slug>-JV_....htm?jl=<numeric-id>
    // The numeric ID lives in the `jl` query parameter (Glassdoor's
    // internal jobListingId), so we parse the URL rather than regex the
    // path — much more stable if the slug format changes.
    extractJobs(doc, baseUrl) {
      const anchors = Array.from(
        doc.querySelectorAll('a[href*="/job-listing/"]')
      );
      const seen = new Set();
      const jobs = [];
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        if (!href) continue;
        let absoluteUrl, jobId;
        try {
          const u = new URL(href, baseUrl);
          jobId = u.searchParams.get("jl");
          absoluteUrl = u.toString();
        } catch {
          continue;
        }
        if (!jobId || seen.has(jobId)) continue;
        const rawTitle = (a.textContent || "").trim();
        if (!rawTitle) continue;
        seen.add(jobId);

        const label = findGlassdoorPostedLabel(a);
        const parsed = parseGlassdoorRelative(label);
        const postedAt = parsed ? new Date(Date.now() - parsed.ms).toISOString() : null;
        const postedRaw = parsed ? parsed.label : null;
        const postedApprox = parsed ? parsed.approx : false;
        const salaryRaw = findGlassdoorSalary(a);
        // `label` (the raw leaf text, e.g. "6d") — not the reformatted
        // postedRaw ("6d ago") — is what would actually appear verbatim
        // inside the title if the whole card is one anchor.
        const title = cleanTitle(rawTitle, label, salaryRaw);

        jobs.push({ id: jobId, title, url: absoluteUrl, postedRaw, postedAt, postedApprox, salaryRaw });
      }

      if (jobs.length === 0 && looksLikeGlassdoorBlockPage(doc)) {
        throw new Error(
          "Glassdoor appears to have blocked or challenged this request (bot detection / sign-in wall). Try a longer check interval, or open this search in Glassdoor in a signed-in tab first."
        );
      }

      return jobs;
    },
  },

  linkedin: {
    id: "linkedin",
    name: "LinkedIn",
    hostMatch: (url) => {
      try {
        return new URL(url).hostname.endsWith("linkedin.com");
      } catch {
        return false;
      }
    },
    defaultUrl: "https://www.linkedin.com/jobs/search/?f_TPR=r86400",
    // Confirmed live: LinkedIn's job search page is genuinely JS-rendered —
    // a background fetch() of the URL returns a shell containing only the
    // single job referenced by `currentJobId` (for link-preview/SEO
    // purposes), not the actual list of results. So, like Glassdoor, this
    // needs an open, live tab read via content-linkedin.js rather than a
    // background fetch. This extractJobs() is kept for documentation/
    // offline testing; the live path duplicates it in content-linkedin.js
    // for the same reason Glassdoor's does (content scripts run as
    // classic, non-module scripts).
    fetchMode: "content-script",
    tabQueryPattern: "https://www.linkedin.com/jobs/search/*",
    requiresSignIn: true,
    // See the big comment above normalizeLinkedInUrl() for why this exists:
    // LinkedIn's "single job open" URL shape (what you get copying the
    // address bar) can't be read reliably, so watches get rewritten onto
    // the shape that can be, the moment they're added.
    normalizeUrl: normalizeLinkedInUrl,
    extractJobs(doc, baseUrl) {
      const anchors = Array.from(doc.querySelectorAll('a[href*="/jobs/view/"]'));
      const seen = new Set();
      const jobs = [];
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        if (!href) continue;
        let absoluteUrl, jobId;
        try {
          const u = new URL(href, baseUrl);
          const match = u.pathname.match(/\/jobs\/view\/(\d+)/);
          jobId = match ? match[1] : null;
          absoluteUrl = u.origin + u.pathname; // drop tracking query params
        } catch {
          continue;
        }
        if (!jobId || seen.has(jobId)) continue;
        const rawTitle = (a.textContent || "").trim();
        if (!rawTitle) continue;
        seen.add(jobId);

        const posted = findLinkedInPostedTime(a);
        const postedAt =
          posted?.datetime && !isNaN(new Date(`${posted.datetime}T00:00:00`).getTime())
            ? new Date(`${posted.datetime}T00:00:00`).toISOString()
            : null;
        // Day precision only (LinkedIn's own <time datetime> never includes
        // a time-of-day), so every LinkedIn date is flagged approximate —
        // unlike Glassdoor, where only the "30d+" bucket gets that flag.
        const postedRaw = posted?.label || null;
        const postedApprox = Boolean(postedAt);
        const salaryRaw = findLinkedInSalary(a);
        const title = cleanTitle(rawTitle, postedRaw, salaryRaw);

        jobs.push({ id: jobId, title, url: absoluteUrl, postedRaw, postedAt, postedApprox, salaryRaw });
      }

      if (jobs.length === 0 && looksLikeLinkedInBlockPage(doc)) {
        throw new Error(
          "LinkedIn appears to have blocked or challenged this request (bot detection / sign-in wall). Try a longer check interval, or open this search in LinkedIn in a signed-in tab first."
        );
      }

      return jobs;
    },
  },

  upwork: {
    id: "upwork",
    name: "Upwork",
    hostMatch: (url) => {
      try {
        return new URL(url).hostname.endsWith("upwork.com");
      } catch {
        return false;
      }
    },
    // Sorted "Newest" rather than the default "Relevance" — a much better
    // fit for a new-postings alert; the user will normally replace this by
    // pasting their own filtered search URL anyway.
    defaultUrl: "https://www.upwork.com/nx/search/jobs/?sort=recency",
    // Confirmed live: a cold background fetch() lands on Cloudflare's
    // challenge interstitial, not real results — see the big comment above
    // looksLikeUpworkBlockPage() for details. This extractJobs() is kept
    // here for documentation/offline testing; the live path duplicates it
    // in content-upwork.js for the same reason Glassdoor's and LinkedIn's
    // do (content scripts run as classic, non-module scripts).
    fetchMode: "content-script",
    tabQueryPattern: "https://www.upwork.com/nx/search/jobs/*",
    // No requiresSignIn here (unlike Glassdoor/LinkedIn): confirmed live
    // that Upwork's job search results render in full for a signed-out
    // session — the tab just needs to be open and past Cloudflare's
    // bot-check, not authenticated.
    extractJobs(doc, baseUrl) {
      const tiles = Array.from(doc.querySelectorAll('[data-test="JobTile"]'));
      const seen = new Set();
      const jobs = [];

      let origin;
      try {
        origin = new URL(baseUrl).origin;
      } catch {
        origin = "https://www.upwork.com";
      }

      for (const tile of tiles) {
        const linkEl =
          tile.querySelector('a[data-test*="job-tile-title-link"]') ||
          tile.querySelector('a[href*="_~"]');
        if (!linkEl) continue;
        const href = linkEl.getAttribute("href") || "";
        const match = href.match(/~(\d+)/);
        if (!match) continue;
        const id = match[1];
        if (seen.has(id)) continue;
        const rawTitle = (linkEl.textContent || "").trim();
        if (!rawTitle) continue;
        seen.add(id);

        // Rebuild a clean canonical link rather than reusing the href
        // as-is — confirmed live that Upwork bakes the search's
        // highlight markup literally into the href's title slug (e.g.
        // ".../span-class-highlight-Full-span-Stack-Developer_~123.../"),
        // and confirmed separately that a bare "/jobs/~<id>/" link
        // correctly redirects to the real job posting.
        const absoluteUrl = `${origin}/jobs/~${id}/`;

        const dateEl = tile.querySelector('[data-test="job-pubilshed-date"]');
        const postedRaw = dateEl ? dateEl.textContent.trim() : null;
        const parsed = parseUpworkRelative(postedRaw);
        const postedAt = parsed ? new Date(Date.now() - parsed.ms).toISOString() : null;
        const postedApprox = parsed ? parsed.approx : false;
        // Upwork tiles are already a tightly-scoped single-job container
        // (one <tile> per JobTile), so no extra scoping is needed here the
        // way the other three sites need scopedJobContainer() — this is
        // Upwork's hourly-rate range or fixed-price budget line.
        const salaryRaw = findSalaryText(tile);
        // linkEl is already title-specific (not the whole tile), so this
        // is defensive rather than a confirmed-necessary fix like the
        // other three sites — cheap enough to apply anyway.
        const title = cleanTitle(rawTitle, postedRaw, salaryRaw);

        jobs.push({ id, title, url: absoluteUrl, postedRaw, postedAt, postedApprox, salaryRaw });
      }

      if (jobs.length === 0 && looksLikeUpworkBlockPage(doc)) {
        throw new Error(
          "Upwork appears to be showing a bot-check page instead of search results. Reload the tab (it may take a few seconds to clear), then check again."
        );
      }

      return jobs;
    },
  },
};

export function siteForUrl(url) {
  return Object.values(SITES).find((s) => s.hostMatch(url));
}
