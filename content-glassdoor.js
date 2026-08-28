// content-glassdoor.js
//
// Why this file exists: a plain background fetch() to Glassdoor gets
// flagged by its anti-bot layer (confirmed in practice — see the watch
// error message background.js surfaces). This content script runs inside
// an actual open, signed-in Glassdoor tab instead, and just reads the
// DOM that's already rendered there — indistinguishable from the user
// looking at the page themselves, since it IS the user's own browsing
// session.
//
// background.js pings this script (chrome.tabs.sendMessage) on its normal
// check interval; this script reads the CURRENT live document and replies
// with whatever job postings are visible right now. No independent timer
// in here — background.js stays the single place that decides when to
// check and how to diff/notify.
//
// NOTE: the extraction logic here is intentionally duplicated from the
// `glassdoor` adapter in sites.js rather than imported. Content scripts
// declared in manifest.json run as classic (non-module) scripts, so a
// static `import` here isn't something we can rely on. Keep this in sync
// with sites.js's glassdoor adapter if either changes.

(function () {
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

  // Only matches a small "leaf" element (no element children) whose ENTIRE
  // trimmed text is the freshness label — avoids matching a stray number
  // inside a bigger blob of text (e.g. part of a salary figure).
  function findLeafMatch(container, regex) {
    const all = container.querySelectorAll("*");
    for (const el of all) {
      if (el.children.length > 0) continue;
      const text = (el.textContent || "").trim();
      if (text && regex.test(text)) return text;
    }
    return null;
  }

  // Climbs from the job anchor toward the document root, but stops right
  // before entering an ancestor that contains more than one job link —
  // i.e. stops before crossing into a shared list container that holds
  // sibling cards. Without this, a card missing its own date element
  // could silently "borrow" a neighboring card's date instead of
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

  function findGlassdoorPostedLabel(anchor) {
    const container = scopedJobContainer(anchor, (a) =>
      /\/job-listing\//.test(a.getAttribute("href") || "")
    );
    if (!container) return null;
    return findLeafMatch(container, /^(\d{1,3}\s*[hd]\+?|today|new|just posted)$/i);
  }

  // Best-effort salary/estimate extraction — see the long comment above
  // SALARY_RE in sites.js for the full rationale (kept there rather than
  // duplicated here). Not every posting shows one; this simply returns
  // null when nothing salary-shaped is found nearby, same as postedRaw
  // does when there's no date.
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

  function findGlassdoorSalary(anchor) {
    const container = scopedJobContainer(anchor, (a) =>
      /\/job-listing\//.test(a.getAttribute("href") || "")
    );
    return findSalaryText(container);
  }

  // Some Glassdoor cards render the ENTIRE card — title, freshness label,
  // salary — inside one clickable `<a>`, rather than the title being its
  // own isolated text node. See the long comment above cleanTitle() in
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

  // Plain `.textContent` walks EVERY text node, including the contents of
  // <script> tags — and Glassdoor (like most React/Next.js sites) embeds a
  // chunk of inline JSON config on literally every page load that happens
  // to contain a real key like "recaptcha":{"publicKeyForUserAuth":...}".
  // That made the bare "captcha" phrase below match on every single page,
  // blocked or not (confirmed live) — completely defeating its purpose as
  // a signal. `.innerText` would dodge this (it only reflects rendered,
  // visible text) but requires a real layout engine, which test tooling
  // like jsdom doesn't implement — so instead this strips script/style/
  // noscript content out of a clone before reading textContent, which
  // gives the same result and works in both a live tab and a test harness.
  function visibleBodyText() {
    if (!document.body) return "";
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
    return clone.textContent || "";
  }

  function looksLikeBlockPage() {
    const text = visibleBodyText().toLowerCase();
    return [
      "verify you are a human",
      "unusual traffic",
      "checking your browser",
      "access denied",
      "captcha",
      "are you a robot",
      "sign in to continue",
    ].some((phrase) => text.includes(phrase));
  }

  function extractJobsFromLiveDocument() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/job-listing/"]'));
    const seen = new Set();
    const jobs = [];
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      if (!href) continue;
      let absoluteUrl, jobId;
      try {
        const u = new URL(href, location.href);
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
      const title = cleanTitle(rawTitle, label, salaryRaw);

      jobs.push({ id: jobId, title, url: absoluteUrl, postedRaw, postedAt, postedApprox, salaryRaw });
    }

    if (jobs.length === 0 && looksLikeBlockPage()) {
      throw new Error(
        "This Glassdoor tab is showing a sign-in wall or bot-check page, not search results. Sign in and reload the tab, then check again."
      );
    }

    return jobs;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "rescan" || message.siteId !== "glassdoor") return false;
    try {
      const jobs = extractJobsFromLiveDocument();
      sendResponse({ ok: true, jobs, tabUrl: location.href });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return false; // synchronous reply — no need to keep the channel open
  });
})();
