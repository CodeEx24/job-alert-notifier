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
  mode, and never change what an unconnected browser does.
- **Listings go to WatchDesk after the check, never in it** (WD-59).
  `listing-ingest.js` posts what a cycle read once `runAllChecks()` has
  saved its state and raised its notifications, badge and sound; it can
  never delay, block or fail a check, and it sends nothing with no account
  connected. A watch is named only by its WatchDesk id (never a local id),
  at most 200 listings a request, and neither the token nor a listing is
  ever logged.
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
| `watchdesk-api.js` | The only WatchDesk API client (`requestJson`, the authenticated `authorizedRequest` with retries (WD-44), one function per route, including the four watch routes (WD-54) and listing ingestion (WD-59)) |
| `account-connection.js` | Device pairing, token storage, connected state (WD-42) |
| `watch-sync.js` | The watch list of a connected browser: sync with the account, first-connection upload, add / rename / pause / remove through the API (WD-54) |
| `popup.html` / `popup.css` / `popup.js` | The popup |
| `popup-account.js` | The popup's account card (WD-42) |
| `listing-ingest.js` | Posts each check cycle's listings to the connected account, after the cycle; records the last success for the popup (WD-59) |
| `popup-watch-sync.js` | The popup's synced / offline line and refused-change message (WD-54), which is also its "last synced" indicator for listings (WD-59) |
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
