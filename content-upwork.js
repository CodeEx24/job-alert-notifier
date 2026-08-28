// content-upwork.js
//
// Why this file exists: confirmed live that a cold background fetch() of
// an Upwork job search URL lands on Cloudflare's managed-challenge
// interstitial ("Just a moment..." / "Verification successful, waiting
// for www.upwork.com to respond"), not real results — the same problem
// Glassdoor's anti-bot layer causes. Once an actual browser tab clears
// that challenge, though, the results render as plain, fully-readable
// HTML (confirmed even signed out, with no partial-results login wall).
// So, like Glassdoor and LinkedIn, this content script runs inside an
// actual open Upwork search tab and just reads the DOM that's already
// there — no fetch of its own, no re-triggering the challenge.
//
// background.js pings this script (chrome.tabs.sendMessage) on its normal
// check interval; this script reads the CURRENT live document and replies
// with whatever job postings are visible right now. No independent timer
// in here — background.js stays the single place that decides when to
// check and how to diff/notify.
//
// NOTE: the extraction logic here is intentionally duplicated from the
// `upwork` adapter in sites.js rather than imported. Content scripts
// declared in manifest.json run as classic (non-module) scripts, so a
// static `import` here isn't something we can rely on. Keep this in sync
// with sites.js's upwork adapter if either changes.

(function () {
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
  // "Posted last month". Minute/hour granularity is treated as close
  // enough to exact; day/week/month/year (and the "last ___" shorthand)
  // are inherently bucketed language, so those are flagged approximate —
  // same spirit as Glassdoor's "30d+" flag.
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

  // Confirmed live: Cloudflare's interstitial title reads "Just a
  // moment..." with body text like "Verification successful. Waiting for
  // www.upwork.com to respond" plus a "Cloudflare Ray ID:" footer. Also
  // covers the more common "checking your browser" / "attention required"
  // phrasing Cloudflare uses elsewhere, in case Upwork's exact copy
  // changes.
  // See the matching helper + comment in content-glassdoor.js: plain
  // textContent pulls in <script>-tag JSON blobs, so this strips
  // script/style/noscript out of a clone first.
  function visibleBodyText() {
    if (!document.body) return "";
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
    return clone.textContent || "";
  }

  // Best-effort salary/rate extraction — see the long comment above
  // SALARY_RE in sites.js for the full rationale (kept there rather than
  // duplicated here). Upwork tiles almost always show one (hourly range or
  // fixed-price budget), but this still degrades to null rather than
  // guessing if a tile's markup doesn't match.
  // `i` flag + a unit suffix allowed after EITHER side of a range — see
  // the matching comment in sites.js for why (a real posting showed
  // "$10/Hour", capital H, which a case-sensitive version silently
  // truncated to just "$10").
  const SALARY_RE =
    /\$\s?\d[\d,]*(?:\.\d{1,2})?\s?[KkMm]?(?:\s?\/\s?(?:hr|hour|yr|year|mo|month))?(?:\s?(?:-|–|—|to)\s?\$?\s?\d[\d,]*(?:\.\d{1,2})?\s?[KkMm]?(?:\s?\/\s?(?:hr|hour|yr|year|mo|month))?)?/i;

  function findSalaryText(container) {
    if (!container) return null;
    // Same script/style/noscript-stripping precaution as visibleBodyText()
    // above — plain .textContent walks into embedded <script> tag
    // contents too, and a real page's inline JSON config can easily
    // contain a dollar-amount-looking string unrelated to any job's
    // actual salary.
    const clone = container.cloneNode(true);
    clone.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
    const leaves = clone.querySelectorAll("*");
    for (const el of leaves) {
      if (el.children.length > 0) continue;
      const text = (el.textContent || "").trim();
      if (!text || text.length > 60) continue;
      if (SALARY_RE.test(text)) return text;
    }
    const text = clone.textContent || "";
    const match = text.match(SALARY_RE);
    return match ? match[0].trim() : null;
  }

  // See the long comment above cleanTitle() in sites.js for the full
  // rationale (kept there rather than duplicated here). linkEl here is
  // already title-specific rather than the whole tile, so this is
  // defensive rather than a confirmed-necessary fix — cheap to apply
  // anyway, and a no-op when the title doesn't contain those fields.
  function cleanTitle(rawTitle, ...stripPatterns) {
    let t = rawTitle;
    for (const p of stripPatterns) {
      if (!p) continue;
      t = p instanceof RegExp ? t.replace(p, " ") : t.split(p).join(" ");
    }
    t = t.replace(/\s+/g, " ").trim();
    return t || rawTitle.trim();
  }

  function looksLikeBlockPage() {
    const text = ((document.title || "") + " " + visibleBodyText()).toLowerCase();
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

  function extractJobsFromLiveDocument() {
    const tiles = Array.from(document.querySelectorAll('[data-test="JobTile"]'));
    const seen = new Set();
    const jobs = [];
    const origin = location.origin;

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

      // Rebuild a clean canonical link rather than reusing the href as-is
      // — confirmed live that Upwork bakes the search's highlight markup
      // literally into the href's title slug, and confirmed separately
      // that a bare "/jobs/~<id>/" link correctly redirects to the real
      // job posting.
      const absoluteUrl = `${origin}/jobs/~${id}/`;

      const dateEl = tile.querySelector('[data-test="job-pubilshed-date"]');
      const postedRaw = dateEl ? dateEl.textContent.trim() : null;
      const parsed = parseUpworkRelative(postedRaw);
      const postedAt = parsed ? new Date(Date.now() - parsed.ms).toISOString() : null;
      const postedApprox = parsed ? parsed.approx : false;
      // The tile itself is already a tightly-scoped single-job container,
      // so no extra scoping needed here the way the anchor-based sites do.
      const salaryRaw = findSalaryText(tile);
      const title = cleanTitle(rawTitle, postedRaw, salaryRaw);

      jobs.push({ id, title, url: absoluteUrl, postedRaw, postedAt, postedApprox, salaryRaw });
    }

    if (jobs.length === 0 && looksLikeBlockPage()) {
      throw new Error(
        "This Upwork tab is showing a bot-check page instead of search results. Reload the tab (it may take a few seconds to clear), then check again."
      );
    }

    return jobs;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "rescan" || message.siteId !== "upwork") return false;
    try {
      const jobs = extractJobsFromLiveDocument();
      sendResponse({ ok: true, jobs, tabUrl: location.href });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return false; // synchronous reply — no need to keep the channel open
  });
})();
