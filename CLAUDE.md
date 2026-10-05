# CLAUDE.md — Job Alert Notifier (WatchDesk extension)

Working notes for anyone (human or agent) changing this repository. Read
before writing code. AGENTS.md mirrors the must-follow rules.

## What this is

A Manifest V3 Chrome extension that watches job searches on OnlineJobs.ph,
Glassdoor, LinkedIn and Upwork and notifies on new postings. It is the
extension half of the **WatchDesk** project; the web app and API live in the
WatchDesk repository (checked out at `D:\Orca Project Folder\WatchDesk`).

- Jira project **WD**. Every branch, commit and PR carries the Jira key.
- Branch: `<type>/wd-<###>/<short-kebab-title>` (feat, fix, chore, refactor,
  docs, test, perf, build, ci).
- Commits: Conventional Commits with the key, e.g.
  `feat(auth): connect the extension to a WatchDesk account (WD-42)`.
- A feature that needs both sides is two PRs; the WatchDesk API PR merges
  first.
- Per-ticket detail goes in `docs/tickets/WD-###.md`, not here.

Reference documents in the WatchDesk repository:

- `docs/extension-baseline.md`: a map of this extension at commit
  `45c1419` (files, storage keys, check cycle, messages). §8 lists the
  behaviours that must not regress, and §9 lists where the code and the
  documents disagree.
- `docs/adr/0002-extension-auth.md`: the device-pairing design.
- `docs/tickets/WD-41.md`, `WD-43.md`, `WD-45.md`, `WD-52.md`, `WD-57.md`:
  the API contracts the extension calls.

## Non-negotiables

- **Manifest V3, vanilla JavaScript, no build step for shipped files.** The
  repository root is the extension: it must load unpacked as it is. No
  framework, no bundler, no runtime dependency. `package.json` and
  `node_modules/` are dev tooling only.
- **The device token is a secret.** It lives in `chrome.storage.local` only:
  never `chrome.storage.sync`, never logged, never in an error message, never
  sent to the popup or a content script, never in the DOM. The pairing poll
  secret is treated the same way, and it lives in `chrome.storage.session`.
- **Only the service worker talks to the WatchDesk API**, through
  `watchdesk-api.js`. The popup asks the worker via messages.
- **Every call that carries the device token goes through
  `authorizedRequest()`** in `watchdesk-api.js` (WD-44): it adds the Bearer
  header, retries per `RETRY_POLICY`, and hands a 401 to the one handler
  that discards the token. Never build an `Authorization` header elsewhere.
  Pass `idempotent: true` on a POST/PATCH only when the server dedupes
  repeats. The pairing calls stay on the single-attempt `requestJson()`.
- **The watch list has two modes** (WD-54). With no account connected it
  lives in `chrome.storage.sync`, exactly as before. With one connected,
  WatchDesk is the source of truth and `chrome.storage.sync`'s `watches` is
  the last-synced copy that the check cycle reads; every change to it goes
  through `watch-sync.js`, which calls the API first and refuses the change
  when WatchDesk is unreachable. Never write `watches` directly in connected
  mode, and never change what an unconnected browser does. That covers the
  quiet writers too (WD-111): `getSettings()`'s URL migration is skipped for
  a connected account (its URLs are WatchDesk's), Import adds the file's
  watches through `importAccountWatches()` and imports nothing when WatchDesk
  does not answer, and the install handler writes no settings at all.
- **Listings go to WatchDesk after the check, never in it** (WD-59).
  `listing-ingest.js` posts what a cycle read once `runAllChecks()` has
  saved its state and raised its notifications, badge and sound; it can
  never delay, block or fail a check, and it sends nothing with no account
  connected. A watch is named only by its WatchDesk id (never a local id),
  at most 200 listings a request, and neither the token nor a listing is
  ever logged.
- **Unsent listings wait in a queue that belongs to one account** (WD-60).
  It lives in `chrome.storage.local` (`watchdeskListingQueue`), is sent
  oldest first before a cycle's own listings, and a listing leaves it only
  after WatchDesk answered for it. It is capped (2,000 listings, 2 MB) and at
  most 10 queued requests go out per cycle. It is sent only while the account
  it was read for (by email) is the connected one: it survives a 401, and a
  different account connecting removes it. Never send it to another account,
  never queue a 400, and never drop from it without counting the drop for the
  popup.
- **The queue is written before it is sent, and sent only on the connection
  it was read on** (WD-110). A cycle's listings go into the queue before the
  first request and leave it as WatchDesk answers; the cap is applied when
  the cycle ends, never to make room for what is about to be sent. Every
  request of a cycle carries the `connection` that `captureConnection()`
  returned at its start, so `authorizedRequest()` sends it with that
  connection's token or not at all: never read the token again for a batch
  that was read earlier. `watchdeskAccount` must always describe the stored
  token or be empty. An answer the code has no rule for (not 2xx, 400, 401,
  403, 404, 429 or 5xx) never ends a cycle: the batch is retried on later
  cycles, 3 attempts in all, then dropped and counted. A 403 is the account
  being refused, not the batch: it ends the cycle like an outage and never
  counts as an attempt.
- **Paused means no check alarm, and this browser decides it** (WD-71).
  `watcherState` in `chrome.storage.local` ("running" | "paused") is the
  authority; `scheduleAlarm()` is the only place the alarm is created and it
  creates none while paused, so install, update, browser start, a changed
  interval, reset and import cannot restart checks behind a pause. Pausing
  changes no watch (that is Pause All) and "Check now" still works. With an
  account connected, `watcher-state.js` reports the state to
  `settings.watcherState` after the alarm is dealt with and the popup
  answered: GET then PUT of the whole settings object with only that field
  changed, both on one `captureConnection()`. A failed report never blocks or
  undoes a pause or a start; it is shown in the sync line and sent again on
  the next sync. The state is never read back from WatchDesk, and no other
  setting is synced here.
- **The WatchDesk origin is named in one place:** `config.js`, plus the same
  origins in `manifest.json`'s `host_permissions`. `tests/config.test.js`
  enforces this.
- **No regression in shipped behaviour** (baseline §8): Open All Tabs, the
  settings panel, the per-platform retention cap as coded
  (`FEED_LIMIT_PER_PLATFORM = 20`), the workplace-type null-passthrough, and
  the title-keyword filter's LinkedIn / OnlineJobs.ph scope. These are
  deliberate. Do not "clean up" baseline §9 findings unless a ticket asks.
- Match the existing popup's look (`popup.css` tokens) and code style.

## Files

| File | Role |
|---|---|
| `manifest.json` | Permissions, hosts, content scripts, worker, popup |
| `background.js` | Service worker: check cycle, feed, notifications, popup messages |
| `config.js` | The WatchDesk origin (production / development) |
| `watchdesk-api.js` | The only WatchDesk API client (`requestJson`, the authenticated `authorizedRequest` with retries (WD-44), one function per route, including the four watch routes (WD-54), listing ingestion (WD-59) and reading / replacing the account's settings (WD-71)) |
| `account-connection.js` | Device pairing, token storage, connected state (WD-42); `captureConnection()`, the handle that binds a request to one token (WD-110), and `isCurrentConnection()` (WD-71) |
| `watch-sync.js` | The watch list of a connected browser: sync with the account, first-connection upload, add / rename / pause / remove through the API (WD-54), and adding an imported backup's watches (WD-111) |
| `watcher-state.js` | Whether the periodic check is running or paused, kept in this browser, and reporting it to the connected account's settings (WD-71) |
| `popup.html` / `popup.css` / `popup.js` | The popup |
| `popup-watcher.js` | The popup's Start Watching / Pause Watching control (WD-71) |
| `popup-account.js` | The popup's account card (WD-42): the one status area, titled with the connected account's email, "Connecting…" until WatchDesk has named it, or "Not connected" (WD-73) |
| `listing-ingest.js` | Posts each check cycle's listings to the connected account, after the cycle; records the last success for the popup (WD-59); queues what could not be sent and retries it on the next cycle (WD-60); queues a cycle before sending it, gives up on a batch WatchDesk will not take, and binds every request to the cycle's connection (WD-110) |
| `popup-watch-sync.js` | The sync line inside the account card (WD-73): "Last synced Xm ago" (the later of the watch sync and the listing upload) and, as the live region, how many listings are waiting, offline, a refused account (403), dropped listings (WD-54, WD-59, WD-60), a watcher state WatchDesk has not been given yet (WD-71); and the refused-change message above the watch list (WD-54) |
| `sites.js`, `content-*.js`, `offscreen.*`, `sounds.js` | Site adapters, tab readers, HTML parsing, alert tones |
| `tests/` | Vitest unit tests with mocked `chrome.*` and `fetch` |

## Commands

```
npm ci            # dev tooling (Node 20+)
npm run lint      # ESLint on the WatchDesk modules and tests + a syntax check of every shipped script
npm test          # Vitest
```

CI (`.github/workflows/ci.yml`) runs the same on every pull request and on
`main`.

ESLint does not cover `background.js`, `popup.js`, `sites.js`,
`content-*.js`, `offscreen.js` or `sounds.js` yet. `background.js` and
`popup.js` have six pre-existing findings (unused catch bindings and useless
initial assignments). They are only syntax-checked until a ticket cleans
them up.

## Running the extension

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → select
   this repository's root. `node_modules/` may be present; Chrome ignores it.
2. After a code change, press the reload icon on the extension's card.

### Pointing it at a local WatchDesk

`config.js` has `WATCHDESK_ENV = "production"`
(`https://watchdesk-rosy.vercel.app`). For a WatchDesk dev server on
`http://localhost:3000`, set it to `"development"` and reload the extension.
Do not commit that change. Both origins are already in `host_permissions`.
For a Chrome Web Store release, drop the `localhost` entry from the manifest
and from `WATCHDESK_ORIGINS` (`tests/config.test.js` keeps the two in step).
