// watch-url.js — when two watch URLs are the same search (WD-82).
//
// A watch of this browser that is added to an account (the first sync after
// connecting, the import of its own data, a backup file) must not double a
// watch the account already has. WatchDesk itself keeps no such rule: it
// stores a URL as it is sent, only rewriting a LinkedIn search the way
// normalizeLinkedInUrl() does here, and it allows two watches with the same
// URL. So which of the account's watches a local watch *is* is decided in
// this browser, by watchKey(): two URLs with the same key are one search on
// one site.
//
// The key folds only what cannot change what a search finds:
//   - http and https, the letter case of the host, a leading "www." and a
//     default port;
//   - trailing slashes on the path, and how the path is percent-encoded;
//   - the order of the query's parameters, and how they are encoded
//     ("%20" and "+");
//   - a fragment;
//   - parameters that only say where a link was clicked (TRACKING, and a
//     site's own in SITE_TRACKING);
//   - whatever the site's normalizeUrl() already rewrites (LinkedIn: the
//     search-results page shape, the job that was open, the sort order).
// Everything else is kept, so two searches that differ in one filter value,
// in the case of a keyword, in a subdomain other than "www." (a regional
// Glassdoor or LinkedIn host) or in an empty parameter are two searches. When
// in doubt the answer is "different": a watch uploaded twice can be deleted,
// two searches merged into one lose one of them.

import { siteForUrl } from "./sites.js";

// Says where a link came from, on any site; never part of a search.
const TRACKING = /^(utm_[a-z0-9_]*|gclid|gbraid|wbraid|dclid|fbclid|msclkid|yclid|igshid|mc_cid|mc_eid|_ga|_gl)$/i;
// The same, for one site: LinkedIn's click tracking.
const SITE_TRACKING = {
  linkedin: new Set(["trk", "trackingId", "refId", "lipi"]),
};

const UNRESERVED = /[A-Za-z0-9\-._~]/;

// One spelling for a path however it was percent-encoded: an escape of a
// character that needs none is decoded, any other is upper-cased.
function canonicalPath(pathname) {
  const path = pathname.replace(/%[0-9a-f]{2}/gi, (escape) => {
    const char = String.fromCharCode(parseInt(escape.slice(1), 16));
    return UNRESERVED.test(char) ? char : escape.toUpperCase();
  });
  return path.replace(/\/+$/, "");
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The name two URLs share when they are the same search on the same site.
// A URL that cannot be read as an http(s) address is only the same as itself.
export function watchKey(rawUrl) {
  const text = typeof rawUrl === "string" ? rawUrl.trim() : "";
  const site = siteForUrl(text) || null;
  let url;
  try {
    url = new URL(site?.normalizeUrl ? site.normalizeUrl(text) : text);
  } catch {
    return `as-is|${text}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return `as-is|${text}`;

  const host = url.hostname.replace(/^www\./, "");
  const siteTracking = SITE_TRACKING[site?.id];
  const query = [...url.searchParams]
    .filter(([name]) => !TRACKING.test(name) && !siteTracking?.has(name))
    .sort((a, b) => byText(a[0], b[0]) || byText(a[1], b[1]));
  return `${site?.id || ""}|${host}${url.port ? `:${url.port}` : ""}${canonicalPath(url.pathname)}?${new URLSearchParams(query)}`;
}
