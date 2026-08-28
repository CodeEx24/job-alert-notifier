# Job Alert Notifier

A Chrome extension that checks your OnlineJobs.ph, Glassdoor, LinkedIn,
and/or Upwork job searches on a timer and pops a native desktop
notification the moment a job you haven't seen before shows up.
OnlineJobs.ph works fully in the background — no tab needs to be open.
Glassdoor, LinkedIn, and Upwork each need one tab of that search kept
open (Glassdoor and LinkedIn need that tab signed in; Upwork's search
results are fully readable signed out — see below for why).

## Install (load unpacked, since this isn't published to the Chrome Web Store)

1. Unzip this folder somewhere permanent (don't delete it after installing —
   Chrome loads the extension from these files every time).
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder.
5. Pin the extension (puzzle-piece icon in the toolbar → pin "Job Alert
   Notifier") so you can see it and click it easily.

## How to use it

1. Click the extension icon to open the popup.
2. By default it watches the general OnlineJobs.ph job search page (all
   postings). To watch something more specific — on any of the four sites:
   - Go to onlinejobs.ph, glassdoor.com, linkedin.com, or upwork.com, run a
     job search with whatever filters you want (skills, category, keyword,
     location), and copy the resulting URL.
   - Paste that URL into "Watch a search" in the popup, give it a label
     (e.g. "Virtual Assistant jobs"), and click **Add watch**. The
     extension figures out which site it's for automatically from the URL.
     For LinkedIn specifically, paste whatever URL is in your address bar
     when you're looking at search results — it's automatically rewritten
     behind the scenes into the shape this extension can actually read
     (see the LinkedIn section below for why that rewrite happens).
3. **If you added a Glassdoor, LinkedIn, or Upwork watch:** open that
   exact search URL in a tab on that site and leave it open — signed in,
   for Glassdoor and LinkedIn (Upwork's results are readable without
   signing in). All three block background requests (see below), so this
   extension reads that tab's page instead of fetching anything itself.
   OnlineJobs.ph watches don't need this — they run fully in the
   background. (The "Open all tabs my watches need" button, described
   below, does this for you in one click.)
   **Tracking more than one search on the same site at once (e.g. two
   different Glassdoor searches, or two different Upwork searches)?**
   Keep a separate tab open for each one, each on its own exact search
   URL. The extension matches each watch to a tab by exact URL first; if
   that's not open, it'll fall back to whatever single tab of that site
   you do have open, but only when there's exactly one candidate. With
   two or more tabs of the same site open and none matching a watch
   exactly, it can't safely guess which tab belongs to which search, so
   it reports a clear error instead of risking mixing up the results —
   see below. (Upwork specifically: its own search UI sometimes drops a
   filter like "Payment verified" from the address bar for a signed-out
   session, so a pasted watch URL may not match a tab's URL character for
   character — this same one-candidate fallback is what makes that
   harmless as long as you're only tracking one Upwork search at a time.)
4. Set the check interval (1/5/15/30 minutes) at the top of the popup.
5. Pick an alert sound from the dropdown (Chime, Ping, Alert, Soft tone,
   System default, or Silent) and click **Test** to preview it. These are
   synthesized tones, not audio files, so there's nothing to download.
6. Leave Chrome running. When a new posting appears in any enabled watch:
   - You get a desktop notification with your chosen sound — clicking it
     opens the job listing directly.
   - The toolbar icon shows a badge count of unseen new jobs.
   - The popup's **"New postings found"** list logs every new job it
     detected: title (click to open it), which watch it came from (shown
     as a small colored dot — same color every time for that watch), the
     posted date the site reported, and roughly how long ago the
     extension itself noticed it (e.g. "2m ago", hover for the exact
     time). It keeps the last 100, paginated 10 per page so it never
     turns into one long scroll.

You can pause, resume, or remove any watch from the popup at any time, and
rename ("Edit") its title whenever you want — handy since the default name
for a pasted search URL is just the site name until you relabel it.

### Getting all the tabs you need open in one click

Right above the watch list is an **"Open all tabs my watches need ↗"**
button. Click it any time — right after adding a batch of watches, after
restarting Chrome, whenever — and it opens a tab for every watch that
actually needs one open (Glassdoor, LinkedIn, and Upwork watches;
OnlineJobs.ph never needs a tab since it checks fully in the background,
so it's skipped). Track five searches across those three sites and it
opens all five tabs at once, instead of you clicking one, hitting an
error, opening that one, hitting the next error, and so on. It also skips
any search that already has a tab open for it, so clicking it again later
won't pile up duplicate tabs — only what's genuinely missing gets opened.
This button works generically off each site's `fetchMode` — nothing about
it is specific to any one site, which is exactly why it needed no changes
when LinkedIn or Upwork were added, and won't need any for the next site
either.

### When a watch shows an error

Any watch with an error shows an **"Open Link ↗"** link right under the
message, which opens that watch's exact search URL in a new tab — the fix
for basically every Glassdoor/LinkedIn/Upwork error is "have that search
open in a live tab," so this saves you hunting for or retyping the URL (the error
text itself no longer spells out the raw URL, since this link is the
one-click way to open it). If more than one
watch is erroring at once, a banner appears above the watch list ("N
searches need attention") with an **"Open all ↗"** button that opens all
of them in new tabs in one click. The difference from the button above:
this one only reacts to watches that are *currently* erroring, while "Open
all tabs my watches need" proactively opens everything up front so you
ideally never see those errors in the first place.

### Tracking what you've seen

Every entry in "New postings found" starts tagged **New** (purple pill).
Clicking its title to open the job marks it **✓ Visited** (green) instead,
so at a glance you can tell what you've already checked out versus what's
still waiting for a look. Use **Mark all read** to clear every New tag at
once, or **Clear** to wipe the whole log (you'll get a confirmation first,
since that can't be undone).

### Settings

Click the **⚙** icon in the header to open the Settings panel.

- **Pause All / Resume All** — flips every watch on or off in one click,
  without deleting any of them. Useful if you're stepping away for a while
  and don't want checks (or notifications) firing.
- **Per-platform Pause / Resume** — a row for each site you actually have
  watches on (OnlineJobs.ph, Glassdoor, LinkedIn, Upwork), each showing a
  live "N active · N paused" count. Handy if, say, you've filled the role
  you were tracking on LinkedIn but still want your OnlineJobs.ph watches
  running.
- **Mute desktop notifications** — checks keep running and the feed and
  badge count keep updating as normal; this only skips the OS popup and
  alert tone. Good for quiet hours without losing any data.
- **Export… / Import…** — Export saves every watch and setting to a JSON
  file you can keep as a backup or move to another computer. Import
  restores from one of those files; it re-derives each watch's platform
  from its URL rather than trusting whatever the file claims, so a
  corrupted or hand-edited backup can't silently point a watch at the
  wrong site — anything it can't confidently place gets dropped and the
  import summary tells you how many watches were skipped.
- **Reset Extension…** — clears every watch, the whole feed, and all
  settings back to defaults (a single OnlineJobs.ph watch, 5-minute
  interval, chime sound). Asks for confirmation first, since it can't be
  undone — export a backup beforehand if you might want any of it again.

## How it works (so you can extend it)

There are two ways a watch gets checked, chosen automatically per site:

- **Background fetch** (OnlineJobs.ph) — `background.js` is a service
  worker. On a `chrome.alarms` timer, it fetches the watched search URL
  directly (no tab needs to be open), hands the raw HTML to an offscreen
  document for parsing (service workers don't have `DOMParser`), diffs
  the job IDs found against what it saw last time, and fires
  `chrome.notifications` for anything new.
- **Content script / open tab** (Glassdoor, LinkedIn, Upwork) —
  `background.js` instead finds an open tab on that site
  (`chrome.tabs.query`, preferring an exact match on the watch's saved
  URL, falling back to any open tab on the site's job-search section) and
  messages it (`chrome.tabs.sendMessage`) asking it to scan its own
  current page. `content-glassdoor.js` / `content-linkedin.js` /
  `content-upwork.js`, injected automatically into the matching
  job-search tabs via `manifest.json`'s `content_scripts`, do that scan
  and reply with the job list. Everything downstream — diffing against
  what was seen before, notifying, updating the feed and badge — is the
  same code either way; only how the raw job list gets fetched differs.

Why Glassdoor, LinkedIn, and Upwork all need the second path: confirmed
live for all three — a plain background `fetch()` of Glassdoor's search
URL gets flagged by its anti-bot layer even on a first, otherwise-
unremarkable request (not just aggressive rate limiting); a background
`fetch()` of LinkedIn's search URL returns a near-empty shell containing
only the single job referenced by its `currentJobId` parameter (for
link-preview purposes), never the actual result list, since its job
cards are built client-side after the page's JS runs; and a background
`fetch()` of an Upwork search URL lands on Cloudflare's managed
challenge page ("Just a moment...") instead of results. Reading an
actual open tab's DOM instead sidesteps all three problems, since it's
indistinguishable from you looking at the page yourself — it *is* your
own browsing session, not a request made by the extension "as itself."
(Only Glassdoor and LinkedIn additionally require that tab to be signed
in — Upwork's results render in full for a signed-out session; the tab
just needs to be open and past Cloudflare's check.)

- `sites.js` — one "adapter" per job board, used for parsing rules
  (and, for OnlineJobs.ph, the actual live fetch path too):
  - `onlinejobsph` finds postings by matching the stable
    `/jobseekers/job/<slug>-<id>` URL pattern (rather than CSS class
    names, which are more likely to change), and reads the posted date
    from the "Posted on YYYY-MM-DD HH:MM:SS" text OnlineJobs.ph prints
    next to each listing (treated as Philippine Time / UTC+8 — it's a
    PH-based board — then converted to your local time for display).
  - `glassdoor` finds postings by matching links containing
    `/job-listing/`, and reads the job's ID from the `jl=` query
    parameter on that link (Glassdoor's internal listing ID) rather than
    parsing the slug. Glassdoor only shows a relative freshness label
    next to each card ("24h", "6d", "30d+", "Today"), not an exact
    timestamp, so the posted date shown for Glassdoor jobs is a
    best-effort approximation — entries derived from a "30d+"-style label
    are marked with a "~" and "(approx.)" in the popup so they're never
    mistaken for an exact time. Its `extractJobs()` here is kept for
    documentation/offline testing; the live path duplicates this same
    logic in `content-glassdoor.js` (see note below on why).
  - `linkedin` finds postings by matching links containing
    `/jobs/view/`, reading the job's numeric ID straight out of the URL
    path (e.g. `/jobs/view/4448139666/`). Organic (non-sponsored) listings
    include a `<time datetime="YYYY-MM-DD">` element with the exact
    posting date (confirmed live) — day precision only, no time-of-day —
    alongside a human label like "3 days ago"; sponsored/"Promoted"
    listings don't show a posted date at all, so those are left with a
    null date rather than a guessed one. LinkedIn also has a
    `normalizeUrl()` step (see the LinkedIn section below) that runs when
    a watch is added, since LinkedIn's address-bar URL shape can't be read
    reliably as-is.
  - `upwork` finds postings via `[data-test="JobTile"]` cards — a stable
    testing-attribute hook rather than a build-hashed CSS class name —
    reading the job's numeric ID out of its title link's `href` (the part
    after `~`) and rebuilding a clean `/jobs/~<id>/` link rather than
    reusing that href as-is (confirmed live: Upwork bakes the search's
    `<span class="highlight">` markup literally into the href's title
    slug, and separately confirmed that a bare `/jobs/~<id>/` link
    correctly redirects to the real posting). Upwork prints a relative
    "Posted ... ago" label per card (`[data-test="job-pubilshed-date"]` —
    that's Upwork's own attribute spelling); minute/hour-precision labels
    are treated as close enough to exact, while day/week/month/year
    labels (and shorthand like "last week") are inherently bucketed
    language, so those are marked with "~" and "(approx.)" in the popup,
    the same spirit as Glassdoor's "30d+" flag.
  - All four adapters scope their date-lookup to "the closest ancestor
    that doesn't contain more than one job link" before searching its
    text, so a listing that's missing its own date element can't
    accidentally inherit a neighboring listing's date.
- `content-glassdoor.js` / `content-linkedin.js` / `content-upwork.js` —
  the content scripts injected into open Glassdoor / LinkedIn / Upwork
  job-search tabs. Each duplicates (rather than imports) the extraction
  logic from its matching adapter in `sites.js`, because content scripts
  declared in `manifest.json` run as classic, non-module scripts — a
  static `import` isn't something to rely on there. If you ever change
  how postings are parsed for any of these sites, update both places (the
  adapter in `sites.js` and its `content-*.js` twin).
- `offscreen.js` / `offscreen.html` — a hidden page Chrome lets the
  service worker delegate DOM parsing (for the background-fetch path)
  AND sound playback to (service workers can do neither directly).
- `sounds.js` — the notification tones, synthesized with the Web Audio
  API (oscillators, not audio files). Used by both the offscreen document
  (to actually play an alert) and the popup (to preview a sound and to
  populate the dropdown).
- `popup.html` / `popup.js` — the UI for managing watches and interval.

## LinkedIn: why watch URLs get rewritten

LinkedIn actually serves two different page shapes for what looks like
the same search, confirmed by inspecting both live:

- **`/jobs/search-results/?currentJobId=...`** — the URL you get by
  copying the address bar while clicking through jobs inside LinkedIn's
  own UI (this is the shape both of the example links used when this was
  built). Its job cards have **no stable identifier at all** — no `href`,
  no `data-job-id`, no embedded JSON, every CSS class is a build-specific
  hash that changes on deploy. There's no reliable way to read a job list
  out of this page shape, so it isn't supported.
- **`/jobs/search/?keywords=...`** — the older results page. Its job
  cards are real `<a href="/jobs/view/<id>/">` links, parseable the same
  stable way as Glassdoor's `/job-listing/` links.

Rather than making you figure out which shape you have, adding a LinkedIn
watch automatically rewrites the URL onto the `/jobs/search/` shape the
moment you click **Add watch** — it drops `currentJobId`, `origin`, and
`referralSearchId` (these only describe which single job happened to be
open when you copied the link, not the search itself) and keeps every
real filter (`keywords`, `f_TPR`, `f_SAL`, location, etc.) untouched. So
you can paste either kind of LinkedIn URL and it'll work the same either
way — this is `normalizeUrl()` in `sites.js`'s `linkedin` adapter,
applied in `background.js`'s `add-watch` handler.

One consequence: because LinkedIn's `<time datetime="...">` gives day
precision only (never a time-of-day), every LinkedIn posted date shows
with "~" and "(approx.)" in the popup — unlike Glassdoor, where that
only happens for the vaguer "30d+" bucket.

## Upwork: what to know

Upwork is the one site here where the tab requirement is about bot
protection, not sign-in. Confirmed live: a background `fetch()` of an
Upwork search URL lands on Cloudflare's own managed challenge page
("Just a moment..." / "Verification successful, waiting for
www.upwork.com to respond") rather than results — but once a real
browser tab clears that challenge, the results render as plain,
fully-readable HTML, no login required. So an Upwork watch needs a tab
open the same way Glassdoor and LinkedIn's do, but you don't need an
Upwork account for it to work.

Two smaller live quirks worth knowing about:

- Upwork's own client-side app sometimes drops a filter from the address
  bar for a signed-out session — confirmed live with `payment_verified=1`,
  which disappeared from the URL entirely after the page settled. If
  you're only tracking one Upwork search at a time this is invisible
  (the tab-matching fallback described above handles it); it only matters
  if you're tracking multiple Upwork searches and want to be sure each
  pasted URL will exact-match its tab.
- Job links in Upwork's search results have the search's own
  `<span class="highlight">` markup baked literally into the URL's title
  slug (a real rendering quirk, not something introduced here). Rather
  than use that messy href as-is, watched Upwork jobs get linked via a
  clean `/jobs/~<id>/` URL built from the job's numeric ID — confirmed
  live that this shorter form correctly redirects to the same posting.

## A note on Glassdoor, LinkedIn, and Upwork specifically

If a Glassdoor watch shows an error, it'll be one of these:

- **"No open Glassdoor tab found for this search"** — exactly what it
  says: open that search URL in a Glassdoor tab (signed in) and leave it
  there, then check again.
- **"Multiple Glassdoor tabs are open, but none matches this watch's
  search exactly..."** — you're tracking more than one Glassdoor search
  (or just have several Glassdoor tabs open) and none of them is open to
  this particular watch's exact URL, so there's no safe way to tell
  which tab's results belong to which watch. Open this watch's exact
  search URL in its own tab — one tab per distinct Glassdoor search
  you're tracking — and leave it there, then check again.
- **"This Glassdoor tab is showing a sign-in wall or bot-check page"** —
  the content script found zero jobs AND detected block/challenge
  language on the page, so it reports this instead of silently looking
  like "0 new jobs" (which would be indistinguishable from a genuinely
  empty search otherwise). Sign into that tab / solve whatever it's
  showing, reload it once, and check again.
- **"Lost the connection to your open Glassdoor tab"** — the tab is open,
  but the extension couldn't message it, almost always because that tab
  was already open before you installed/reloaded the extension (so its
  page-reading script never loaded into it) or it's drifted off the
  search page. Reload that tab (or open the search fresh) and leave it
  sitting on the results page — a live, freshly-loaded tab is also what
  keeps Glassdoor from flagging the check as bot activity.
- If you just installed or reloaded the extension and already had a
  Glassdoor tab open from before, refresh that tab once — Chrome only
  auto-injects content scripts into tabs that load *after* the extension
  is installed/updated, not ones already open.

If a LinkedIn watch shows an error, it'll be one of the same shapes, with
"LinkedIn" in place of "Glassdoor" — **"No open LinkedIn tab found for
this search,"** **"Multiple LinkedIn tabs are open, but none matches this
watch's search exactly...,"** **"This LinkedIn tab is showing a sign-in
wall or security-check page,"** or **"Lost the connection to your open
LinkedIn tab."** Same fixes apply: open/refresh the exact search URL in
its own signed-in tab, one tab per distinct LinkedIn search you're
tracking, and refresh once after first installing/reloading the extension
if you already had a LinkedIn tab open. The one difference: LinkedIn's
sign-in-wall detection is a best first guess written from general
knowledge of what those interstitials tend to say, not confirmed against
a real triggered example (deliberately triggering LinkedIn's bot-check on
a real account isn't something worth risking just to test this) — if you
ever see "0 jobs found" on a LinkedIn watch that you know has results, or
a error message that doesn't seem to fit, that's the detection heuristic
needing a tweak, not you doing anything wrong.

If an Upwork watch shows an error, it's the same set of shapes again,
with "Upwork" in place of "Glassdoor" — **"No open Upwork tab found for
this search,"** **"Multiple Upwork tabs are open, but none matches this
watch's search exactly...,"** **"This Upwork tab is showing a bot-check
page instead of search results,"** or **"Lost the connection to your
open Upwork tab."** Same fixes apply, with one difference worth
repeating: Upwork's message deliberately doesn't say "signed-in" — you
don't need to be logged into Upwork for this to work, just have the tab
open and past Cloudflare's check.

## Scaling to more sites

`background.js`'s `fetchJobsViaTab()` and the "Open all tabs my watches
need" button both work generically off each site's `fetchMode` — neither
needed any changes when LinkedIn or Upwork were added, and neither will
need changes for the next site either (adding Upwork's `requiresSignIn:
false` did mean adding *a* generic per-site flag to the "no tab found"
error message, the one small exception — everything else about the
plumbing stayed untouched). To add a new site: add its host to
`host_permissions` and a matching `content_scripts` entry in
`manifest.json`, write a `content-<site>.js` following
`content-glassdoor.js` / `content-linkedin.js` / `content-upwork.js`'s
shape (extract jobs from `document`, reply to a `{type: "rescan"}`
ping), and add an entry to `SITES` in `sites.js` with `fetchMode:
"content-script"` and a `tabQueryPattern` (plus a `normalizeUrl()` if
that site's address-bar URL needs rewriting the way LinkedIn's does, and
`requiresSignIn: true` if — unlike Upwork — the site actually needs a
logged-in session to show results).

The tricky part is never the plumbing, it's figuring out a stable
selector or URL pattern for that site's job cards — ideally a URL
fragment like OnlineJobs.ph's `/jobseekers/job/`, Glassdoor's
`/job-listing/`, or LinkedIn's `/jobs/view/` (Upwork instead has a
purpose-built `data-test="JobTile"` testing attribute, which is just as
stable) — something that tends to outlast CSS class names across
redeploys. That takes actually inspecting a live page first (which is
exactly how LinkedIn's and Upwork's support here was both built), not
guessing from documentation.

## Notes / limitations

- Monitors OnlineJobs.ph (background), and Glassdoor, LinkedIn, and
  Upwork (each needs an open tab; Glassdoor and LinkedIn need that tab
  signed in, Upwork doesn't).
- Checks the *first page* of results for each watch. If more than a full
  page of new jobs appears between two checks, only what's currently on
  page 1 is seen — shortening the interval reduces the odds of missing a
  fast-scrolling result set for very broad/busy searches.
- The very first check after adding a watch only establishes a baseline
  (no notification) so you don't get flooded with alerts for jobs that
  already existed before you added the search.
- Glassdoor's, LinkedIn's, and Upwork's posted dates are all
  approximate (see above, for slightly different reasons each) —
  OnlineJobs.ph's are exact.
- Notifications require Chrome (and your OS's notification permission
  for Chrome) to be allowed to show notifications, and Chrome needs to be
  running — it does not run when Chrome is fully closed.
