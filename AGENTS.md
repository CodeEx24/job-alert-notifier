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
