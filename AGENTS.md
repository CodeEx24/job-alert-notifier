# AGENTS.md — Job Alert Notifier (WatchDesk extension)

Rules for every coding agent in this repository. **CLAUDE.md is canonical**;
this file mirrors its must-follow rules.

## Non-negotiables

- Part of the WatchDesk project (Jira key **WD**). Branch
  `<type>/wd-<###>/<slug>`; commits `type(scope): summary (WD-###)`.
- **Manifest V3, vanilla JS, no build step for shipped files.** The repository
  root must load unpacked as is. Dev tooling (`package.json`,
  `node_modules/`, `tests/`) never becomes a runtime dependency.
- **The device token is a secret:** `chrome.storage.local` only, never
  `chrome.storage.sync`, never logged, never in an error, a message to the
  popup or a content script, or the DOM. The same goes for the pairing poll
  secret, which lives in `chrome.storage.session`.
- **Only the service worker calls the WatchDesk API** (`watchdesk-api.js`).
  Every token-carrying call goes through `authorizedRequest()` (Bearer
  header, retries, the shared 401 handler); none builds its own.
- **The watch list has two modes** (WD-54): not connected, it lives in
  `chrome.storage.sync` as before; connected, WatchDesk is the truth,
  `watches` is the last-synced copy, and every change goes through
  `watch-sync.js` (API first, refused when unreachable). Never change what
  an unconnected browser does. Connected, the URL migration in
  `getSettings()` is skipped, Import goes through `importAccountWatches()`
  and imports nothing when WatchDesk does not answer, and the install
  handler writes no settings (WD-111).
- **Listings go to WatchDesk after the check, never in it** (WD-59):
  `listing-ingest.js` runs once a cycle is saved and notified, cannot delay
  or fail a check, sends nothing when not connected, names a watch only by
  its WatchDesk id, and never logs the token or a listing.
- **Unsent listings wait in a queue that belongs to one account** (WD-60):
  `chrome.storage.local` only, sent oldest first before a cycle's own, removed
  only after WatchDesk answered, capped (2,000 listings, 2 MB; 10 queued
  requests per cycle), kept through a 401 and removed when a different
  account connects. Never send it to another account, never queue a 400, and
  never drop from it without counting the drop for the popup.
- **The queue is written before it is sent, and sent only on the connection
  it was read on** (WD-110): a cycle's listings are queued before the first
  request; the cap is applied when the cycle ends; every request carries the
  cycle's `connection` (`captureConnection()`), so it goes out with that
  connection's token or not at all; `watchdeskAccount` always describes the
  stored token or is empty; an answer with no rule never ends a cycle and is
  dropped, counted, after 3 attempts; a 403 is waited out like an outage and
  never counted.
- **Paused means no check alarm, and this browser decides it** (WD-71):
  `watcherState` in `chrome.storage.local` is the authority and
  `scheduleAlarm()`, the only place the alarm is created, creates none while
  paused. Pausing changes no watch and "Check now" still works. Connected,
  `watcher-state.js` reports it to `settings.watcherState` after the click is
  answered (GET then PUT of the whole object, one field changed, one
  `captureConnection()`); a failure never blocks or undoes the change, shows
  in the sync line and is sent again on the next sync. The state is never
  read back from WatchDesk and no other setting is synced.
- **The WatchDesk origin lives only in `config.js`** (and `manifest.json`'s
  `host_permissions`).
- **No regression in shipped behaviour:** Open All Tabs, the settings panel,
  the per-platform retention cap as coded, the workplace-type
  null-passthrough, and the title-keyword filter's LinkedIn / OnlineJobs.ph
  scope. Details are in the WatchDesk repo's `docs/extension-baseline.md`
  §8. Leave its §9 findings alone unless a ticket asks.
- **Tests before done:** `npm run lint` and `npm test` pass (CI runs both).
  New code gets unit tests with mocked `chrome.*` and `fetch`.
- Per-ticket detail goes in `docs/tickets/WD-###.md`.

## When a ticket's AC and a convention conflict

The acceptance criteria decide **what** to build; conventions decide
**how**. If they cannot both hold, stop and flag it.
