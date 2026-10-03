// config.js — where the WatchDesk web app lives.
//
// This is the ONLY script that names the WatchDesk origin. manifest.json's
// host_permissions must list the same origins (Chrome reads the manifest
// before any script runs, so it cannot import this). tests/config.test.js
// fails if an origin shows up in any other shipped file, or if the manifest
// is missing one.
//
// To point the extension at a local WatchDesk dev server, change
// WATCHDESK_ENV below to "development" and reload the extension at
// chrome://extensions. Set it back to "production" before releasing.

export const WATCHDESK_ORIGINS = Object.freeze({
  production: "https://watchdesk-rosy.vercel.app",
  development: "http://localhost:3000",
});

export const WATCHDESK_ENV = "production";

export const WATCHDESK_ORIGIN = WATCHDESK_ORIGINS[WATCHDESK_ENV];
