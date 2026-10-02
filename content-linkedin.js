// content-linkedin.js
//
// Why this file exists: LinkedIn's job search page is genuinely
// JavaScript-rendered — confirmed live by fetching the search URL directly
// and finding the raw HTML response contains only the single job referenced
// by `currentJobId` (embedded for link-preview/SEO purposes), never the
// actual list of results. A background fetch() can't see the job list at
// all, so — like Glassdoor — this content script runs inside an actual
// open, signed-in LinkedIn tab and just reads the DOM that's already
// rendered there.
//
// IMPORTANT: LinkedIn serves (at least) two different page shapes for what
// looks like the same search:
//   - /jobs/search-results/?currentJobId=...  — confirmed live to have NO
//     stable identifiers at all in its job cards: no href, no data-job-id,
//     no embedded JSON, every class name is a build-specific hash. There's
//     no reliable way to read a job list out of this shape, so it's not
//     supported.
//   - /jobs/search/?keywords=...              — confirmed live to render
//     each job card as a real `<a href="/jobs/view/<id>/">` link, parseable
//     the same stable way as Glassdoor's `/job-listing/` links. This is the
//     only shape this content script (and its manifest.json content_scripts
//     match) targets. sites.js's normalizeUrl() for LinkedIn rewrites any
//     watch URL onto this shape when it's added, so pasting either kind of
//     LinkedIn URL still works.
//
// background.js pings this script (chrome.tabs.sendMessage) on its normal
// check interval; this script reads the CURRENT live document and replies
// with whatever job postings are visible right now. No independent timer
// in here — background.js stays the single place that decides when to
// check and how to diff/notify.
//
// NOTE: the extraction logic here is intentionally duplicated from the
// `linkedin` adapter in sites.js rather than imported. Content scripts
// declared in manifest.json run as classic (non-module) scripts, so a
// static `import` here isn't something we can rely on. Keep this in sync
// with sites.js's linkedin adapter if either changes.

(function () {
  // Climbs from the job anchor toward the document root, but stops right
  // before entering an ancestor that contains more than one job link —
  // i.e. stops before crossing into a shared list container that holds
  // sibling cards. Without this, a card missing its own posted-date
  // element could silently "borrow" a neighboring card's date instead of
  // correctly reporting "unknown."
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

  // Confirmed live (2026-08): non-promoted job cards include a
  // `<time datetime="YYYY-MM-DD">` element with the posting date (day
  // precision only) next to a human label like "3 days ago". Promoted /
  // sponsored cards don't show a posted date at all — they show
  // "Promoted" instead — so this correctly returns null for those rather
  // than guessing.
  function findLinkedInPostedTime(anchor) {
    const container = scopedJobContainer(anchor, (a) => /\/jobs\/view\//.test(a.getAttribute("href") || ""));
    if (!container) return null;
    const timeEl = container.querySelector("time");
    if (!timeEl) return null;
    const datetime = timeEl.getAttribute("datetime");
    const rawText = (timeEl.textContent || "").replace(/\s+/g, " ").trim();
    // The element sometimes holds two lines of text (e.g. "3 days ago"
    // plus an accessibility-only "Within the past 24 hours") — keep only
    // the leading "<n> <unit> ago" / "Today" phrase for display.
    const label = (rawText.match(/^(.*?\bago\b|today)/i) || [rawText])[0].trim();
    return { datetime, label: label || rawText };
  }

  // Best-effort salary/pay-range extraction — see the long comment above
  // SALARY_RE in sites.js for the full rationale (kept there rather than
  // duplicated here). LinkedIn in particular usually doesn't show one
  // unless the poster added it, so this returning null is the common case
  // here, not a bug — same as postedRaw when there's no date.
  // `i` flag + a unit suffix allowed after EITHER side of a range — see
  // the matching comment in sites.js for why (a real posting showed
  // "$10/Hour", capital H, which a case-sensitive version silently
  // truncated to just "$10").
  const SALARY_RE =
    /\$\s?\d[\d,]*(?:\.\d{1,2})?\s?[KkMm]?(?:\s?\/\s?(?:hr|hour|yr|year|mo|month))?(?:\s?(?:-|–|—|to)\s?\$?\s?\d[\d,]*(?:\.\d{1,2})?\s?[KkMm]?(?:\s?\/\s?(?:hr|hour|yr|year|mo|month))?)?/i;

  // Used both by findLinkedInEasyApply() to detect the label, and by
  // extractJobsFromLiveDocument() to strip it back out of a title when a
  // card wraps its whole contents in one anchor — same "whole card is one
  // anchor" concern SALARY_RE and postedRaw handle.
  const EASY_APPLY_RE = /\beasy apply\b/i;

  // LinkedIn and Glassdoor both flag each posting's workplace arrangement —
  // On-site, Remote, or Hybrid. Two different real-world shapes this can
  // take on the page, so both are checked (see findWorkplaceType below):
  //   1. Its own isolated label/pill, separate from the location — the
  //      element's ENTIRE trimmed text is just the one word.
  //   2. Appended to the location line in parentheses, e.g. a metadata row
  //      reading "San Francisco, CA (Remote)" or "New York, NY (Hybrid)" —
  //      confirmed to be the more common shape on both sites' current job
  //      search pages.
  // Neither is a plain substring test anywhere in the container (like
  // EASY_APPLY_RE) specifically because "remote" and "hybrid" are common
  // English words that can legitimately appear inside a job title or
  // description (e.g. "Remote Support Engineer," "Hybrid Cloud
  // Architect") — a bare substring match would false-positive constantly.
  // Shape 1 requires an isolated leaf element to match exactly; shape 2
  // requires the word to appear specifically inside parentheses, which a
  // real title is never going to coincidentally do right after a
  // location-shaped string.
  const WORKPLACE_TYPE_RE = /^(remote|hybrid|on-site|onsite)$/i;
  const WORKPLACE_TYPE_PAREN_RE = /\((remote|hybrid|on-site|onsite)\)/i;

  // Looks for a small "leaf" element (no element children of its own)
  // whose ENTIRE trimmed text matches — see the matching helper + comment
  // in sites.js for the full rationale (kept there rather than duplicated
  // here). Requiring the whole element's text to match avoids false
  // positives from a bigger blob of concatenated card text.
  function findLeafMatch(container, regex) {
    const all = container.querySelectorAll("*");
    for (const el of all) {
      if (el.children.length > 0) continue;
      const text = (el.textContent || "").trim();
      if (text && regex.test(text)) return text;
    }
    return null;
  }

  // Normalizes whatever casing/hyphenation LinkedIn used ("Onsite",
  // "On-site", "ON-SITE", etc.) to one consistent label for storage/display.
  function normalizeWorkplaceType(rawLabel) {
    const key = rawLabel.trim().toLowerCase().replace(/-/g, "");
    if (key === "remote") return "Remote";
    if (key === "hybrid") return "Hybrid";
    if (key === "onsite") return "On-site";
    return null;
  }

  // Tries the isolated-leaf exact match first (shape 1), then falls back to
  // a leaf containing "(<word>)" (shape 2) — see the comment above
  // WORKPLACE_TYPE_RE/WORKPLACE_TYPE_PAREN_RE. Returns null (not a guessed
  // default) when neither pattern is found anywhere in the container.
  // Returns { raw, normalized }: `raw` is the EXACT substring to strip back
  // out of a title later (e.g. "(Remote)" including the parentheses for
  // shape 2, or just "Remote" for shape 1) — cleanTitle's stripping is an
  // exact literal match, so it needs the real on-page text, not the
  // normalized label.
  function findWorkplaceType(container) {
    if (!container) return null;
    const exact = findLeafMatch(container, WORKPLACE_TYPE_RE);
    if (exact) {
      const normalized = normalizeWorkplaceType(exact);
      if (normalized) return { raw: exact, normalized };
    }
    const leaves = container.querySelectorAll("*");
    for (const el of leaves) {
      if (el.children.length > 0) continue;
      const text = (el.textContent || "").trim();
      if (!text || text.length > 80) continue;
      const match = text.match(WORKPLACE_TYPE_PAREN_RE);
      if (match) {
        const normalized = normalizeWorkplaceType(match[1]);
        if (normalized) return { raw: match[0], normalized };
      }
    }
    return null;
  }

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

  function findLinkedInSalary(anchor) {
    const container = scopedJobContainer(anchor, (a) => /\/jobs\/view\//.test(a.getAttribute("href") || ""));
    return findSalaryText(container);
  }

  // LinkedIn flags postings that support its own one-click "Easy Apply"
  // flow (applies without leaving LinkedIn / redirecting to the employer's
  // site) with a distinct "Easy Apply" label inside the job card, alongside
  // the posted-time and salary info. Not verified against a live example —
  // same caveat as looksLikeBlockPage below — so this is a best-effort text
  // check rather than a specific selector, which is also more resilient to
  // LinkedIn's markup changing than a class name would be. Scopes to the
  // same job container postedTime/salary use, and strips
  // script/style/noscript first for the same reason findSalaryText does:
  // LinkedIn embeds page config as inline JSON that could otherwise produce
  // a false positive from an unrelated internal field name.
  // Returns false (not null) when it can't confirm — unlike a missing
  // salary/date, "can't confirm Easy Apply" and "genuinely isn't Easy
  // Apply" should look the same to the user: no badge.
  function findLinkedInEasyApply(anchor) {
    const container = scopedJobContainer(anchor, (a) => /\/jobs\/view\//.test(a.getAttribute("href") || ""));
    if (!container) return false;
    const clone = container.cloneNode(true);
    clone.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
    return EASY_APPLY_RE.test(clone.textContent || "");
  }

  // Best-effort workplace-type extraction ("Remote" / "Hybrid" / "On-site")
  // — see the long comment above findWorkplaceType for the two shapes this
  // tries, in order, and why. Returns null (not a guessed default) when the
  // card doesn't show one at all — same as postedRaw/salaryRaw already do
  // for their own "not shown" cases.
  function findLinkedInWorkplaceType(anchor) {
    const container = scopedJobContainer(anchor, (a) => /\/jobs\/view\//.test(a.getAttribute("href") || ""));
    return findWorkplaceType(container);
  }

  // Some cards render the ENTIRE card — title, posted label, salary pill —
  // inside one clickable `<a>`, rather than the title being its own
  // isolated text node. See the long comment above cleanTitle() in
  // sites.js for the full rationale (kept there rather than duplicated
  // here). A no-op when the title genuinely doesn't contain those fields.
  function cleanTitle(rawTitle, ...stripPatterns) {
    let t = rawTitle;
    for (const p of stripPatterns) {
      if (!p) continue;
      t = p instanceof RegExp ? t.replace(p, " ") : t.split(p).join(" ");
    }
    t = t.replace(/\s+/g, " ").trim();
    return t || rawTitle.trim();
  }

  // LinkedIn shows a sign-in wall or security checkpoint to sessions it
  // doesn't trust, similar in spirit to Glassdoor's. Written from general
  // knowledge of what those interstitials say, not verified against a live
  // triggered example (deliberately triggering one would risk flagging a
  // real account) — treat as a best first guess to refine if a real
  // occurrence ever surfaces different wording.
  // See the matching helper + comment in content-glassdoor.js: plain
  // textContent pulls in <script>-tag JSON blobs (LinkedIn, like
  // Glassdoor, embeds page config that can contain phrase-like substrings
  // having nothing to do with an actual block), so this strips
  // script/style/noscript out of a clone first.
  function visibleBodyText() {
    if (!document.body) return "";
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
    return clone.textContent || "";
  }

  function looksLikeBlockPage() {
    const text = visibleBodyText().toLowerCase();
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

  function extractJobsFromLiveDocument() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'));
    const seen = new Set();
    const jobs = [];
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      if (!href) continue;
      let absoluteUrl, jobId;
      try {
        const u = new URL(href, location.href);
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
      // Day precision only (LinkedIn's own <time datetime> never includes a
      // time-of-day), so every LinkedIn date is flagged approximate —
      // unlike Glassdoor, where only the "30d+" bucket gets that flag.
      const postedRaw = posted?.label || null;
      const postedApprox = Boolean(postedAt);
      const salaryRaw = findLinkedInSalary(a);
      const easyApply = findLinkedInEasyApply(a);
      const workplace = findLinkedInWorkplaceType(a);
      const workplaceType = workplace?.normalized || null;
      // Strips workplace.raw (the exact text as it appeared), not
      // workplaceType — see the comment above findLinkedInWorkplaceType for
      // why.
      const title = cleanTitle(
        rawTitle,
        postedRaw,
        salaryRaw,
        easyApply ? EASY_APPLY_RE : null,
        workplace?.raw || null
      );

      jobs.push({ id: jobId, title, url: absoluteUrl, postedRaw, postedAt, postedApprox, salaryRaw, easyApply, workplaceType });
    }

    if (jobs.length === 0 && looksLikeBlockPage()) {
      throw new Error(
        "This LinkedIn tab is showing a sign-in wall or security-check page, not search results. Sign in / solve the check, reload the tab, then check again."
      );
    }

    return jobs;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "rescan" || message.siteId !== "linkedin") return false;
    try {
      const jobs = extractJobsFromLiveDocument();
      sendResponse({ ok: true, jobs, tabUrl: location.href });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return false; // synchronous reply — no need to keep the channel open
  });
})();
