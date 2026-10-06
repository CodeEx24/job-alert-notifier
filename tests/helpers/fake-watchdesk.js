// A scripted WatchDesk API behind a mocked global fetch. Each test says what
// the next poll answers; every request is recorded so a test can check its
// URL, method and headers.
import { vi } from "vitest";
import { WATCHDESK_ORIGIN } from "../../config.js";

export const TEST_CODE = "WDJB-MJHT";
export const TEST_POLL_SECRET = "pollsecret-abcdefghijklmnopqrstuvwxyz0123456789";
export const TEST_TOKEN = "wd_0123456789abcdef0123456789abcdef.tokensecret-abcdefghijklmnopqrstuvwxyz012";

function json(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// `saveUrl(url)` is what POST /api/watches stores for a URL it is sent. The
// real route normalises it (lib/sites.ts in the WatchDesk repository); here
// it is stored as sent unless a test says otherwise (WD-111).
export function installFakeWatchDesk({ now = () => Date.now(), saveUrl = (url) => url } = {}) {
  const requests = [];
  const pollAnswers = [];
  let pollDefault = () => json(200, { status: "pending" });
  let startAnswer = () =>
    json(200, {
      code: TEST_CODE,
      pollSecret: TEST_POLL_SECRET,
      expiresAt: new Date(now() + 10 * 60 * 1000).toISOString(),
      pollIntervalSeconds: 3,
    });
  let currentAnswer = () =>
    json(200, {
      account: { email: "ada@example.com", displayName: "Ada Lovelace" },
      device: { id: "10302851-62a8-4e42-937b-593948258a48", label: "Chrome on my laptop" },
    });

  // The account's watches (WD-52's routes), oldest first. A test changes
  // this array directly to play "someone used the web app".
  const watches = [];
  let watchCount = 0;
  let watchRoute = () => undefined;
  const WATCH_SITES = {
    "onlinejobs.ph": ["onlinejobsph", "OnlineJobs.ph"],
    "glassdoor.com": ["glassdoor", "Glassdoor"],
    "linkedin.com": ["linkedin", "LinkedIn"],
    "upwork.com": ["upwork", "Upwork"],
  };
  const siteOf = (url) => {
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      return null;
    }
    const domain = Object.keys(WATCH_SITES).find((d) => host.endsWith(d));
    return domain ? WATCH_SITES[domain] : null;
  };
  const addWatch = ({ url, label, enabled = true }) => {
    const [siteId, siteName] = siteOf(url);
    watchCount += 1;
    const stamp = new Date(now()).toISOString();
    const watch = {
      id: `00000000-0000-4000-8000-${String(watchCount).padStart(12, "0")}`,
      siteId,
      url,
      label: label || siteName,
      enabled,
      createdAt: stamp,
      updatedAt: stamp,
    };
    watches.push(watch);
    return watch;
  };
  const answerWatches = (request) => {
    const scripted = watchRoute(request);
    if (scripted) return scripted;
    if (!request.headers.Authorization) return json(401, { error: "Sign in to continue." });
    const id = request.path.slice("/api/watches/".length);
    if (request.path === "/api/watches") {
      if (request.method === "GET") return json(200, { watches });
      if (request.method === "POST") {
        if (!siteOf(request.body?.url)) {
          return json(400, {
            error: "Check the highlighted fields.",
            fieldErrors: { url: ["Enter a search URL on OnlineJobs.ph, Glassdoor, LinkedIn or Upwork"] },
          });
        }
        return json(201, addWatch({ ...request.body, url: saveUrl(request.body.url) }));
      }
    }
    const index = watches.findIndex((w) => w.id === id);
    if (index < 0) return json(404, { error: "Watch not found." });
    if (request.method === "PATCH") {
      Object.assign(watches[index], request.body, { updatedAt: new Date(now()).toISOString() });
      return json(200, watches[index]);
    }
    if (request.method === "DELETE") {
      watches.splice(index, 1);
      return json(200, { ok: true });
    }
    return json(405, { error: "Method not allowed." });
  };

  // The account's listings (WD-57's route): one per site and posting,
  // however often it is sent.
  const listings = [];
  let ingestRoute = () => undefined;
  const answerIngest = (request) => {
    const scripted = ingestRoute(request);
    if (scripted) return scripted;
    if (!request.headers.Authorization) return json(401, { error: "Sign in to continue." });
    const sent = request.body?.listings;
    if (!Array.isArray(sent) || sent.length > 200) {
      return json(400, {
        error: "Check the highlighted fields.",
        fieldErrors: { listings: ["Send at most 200 listings in one request"] },
      });
    }
    const watch = watches.find((w) => w.id === request.body.watchId);
    if (!watch) return json(404, { error: "Watch not found." });
    const inserted = [];
    const inBatch = new Set();
    for (const listing of sent) {
      const sourceKey = `${watch.siteId}:${listing.id}`;
      if (inBatch.has(sourceKey)) continue;
      inBatch.add(sourceKey);
      if (listings.some((row) => row.sourceKey === sourceKey)) continue;
      const row = { listingId: `listing-${listings.length + 1}`, sourceKey, watchId: watch.id, listing };
      listings.push(row);
      inserted.push({ id: row.listingId, jobId: listing.id });
    }
    return json(200, { watchId: watch.id, siteId: watch.siteId, received: inBatch.size, inserted });
  };

  // The account's settings (WD-56's route, with WD-71's watcherState). PUT
  // replaces them all: a setting left out is a 400, a key that is not a
  // setting is dropped. The rules for a value are the real route's
  // (lib/validation/settings.ts in the WatchDesk repository), written out
  // here because that is the server's code, not the extension's (WD-79).
  const SETTINGS_FIELDS = ["intervalMinutes", "soundId", "notificationsMuted", "titleFilter", "watcherState"];
  const asWatchDeskKeepsKeywords = (keywords) => {
    const seen = new Set();
    return keywords
      .map((keyword) => keyword.trim())
      .filter((keyword) => keyword && !seen.has(keyword.toLowerCase()) && seen.add(keyword.toLowerCase()));
  };
  const account = {
    settings: {
      intervalMinutes: 15,
      soundId: "ping",
      notificationsMuted: true,
      titleFilter: { enabled: true, keywords: ["php"] },
      watcherState: "running",
    },
    settingsUpdatedAt: new Date(now()).toISOString(),
  };
  let settingsRoute = () => undefined;
  const answerSettings = (request) => {
    const scripted = settingsRoute(request);
    if (scripted) return scripted;
    if (!request.headers.Authorization) return json(401, { error: "Sign in to continue." });
    if (request.method === "GET") return json(200, { ...account.settings, updatedAt: account.settingsUpdatedAt });
    if (request.method !== "PUT") return json(405, { error: "Method not allowed." });
    const body = request.body && typeof request.body === "object" ? request.body : {};
    const fieldErrors = {};
    for (const field of SETTINGS_FIELDS) {
      if (!(field in body)) fieldErrors[field] = ["Missing"];
    }
    if ("watcherState" in body && !["running", "paused"].includes(body.watcherState)) {
      fieldErrors.watcherState = ["Watching must be running or paused"];
    }
    if ("intervalMinutes" in body && ![1, 5, 15, 30].includes(body.intervalMinutes)) {
      fieldErrors.intervalMinutes = ["Check interval must be 1, 5, 15 or 30 minutes"];
    }
    if ("soundId" in body && !["default", "chime", "ping", "alert", "soft", "none"].includes(body.soundId)) {
      fieldErrors.soundId = ["Choose one of the alert sounds"];
    }
    let keywords = body.titleFilter?.keywords;
    if (Array.isArray(keywords)) {
      keywords = asWatchDeskKeepsKeywords(keywords);
      const long = keywords.findIndex((keyword) => keyword.length > 100);
      if (long >= 0) fieldErrors[`titleFilter.keywords.${long}`] = ["A keyword must be at most 100 characters"];
      if (keywords.length > 100) fieldErrors["titleFilter.keywords"] = ["Keep at most 100 keywords"];
    }
    if (Object.keys(fieldErrors).length > 0) return json(400, { error: "Check the highlighted fields.", fieldErrors });
    account.settings = Object.fromEntries(SETTINGS_FIELDS.map((field) => [field, body[field]]));
    if (Array.isArray(keywords)) account.settings.titleFilter = { ...body.titleFilter, keywords };
    account.settingsUpdatedAt = new Date(now()).toISOString();
    return json(200, { ...account.settings, updatedAt: account.settingsUpdatedAt });
  };

  // A job site's own page. Unreachable unless a test says what it answers.
  let siteAnswer = () => {
    throw new TypeError("Failed to fetch");
  };

  const fetchMock = vi.fn(async (url, init = {}) => {
    const parsed = new URL(url);
    const request = {
      url,
      origin: parsed.origin,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      method: init.method || "GET",
      headers: { ...(init.headers || {}) },
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      credentials: init.credentials,
      signal: init.signal,
      at: now(),
    };
    requests.push(request);
    if (parsed.origin !== WATCHDESK_ORIGIN) return siteAnswer(request);
    if (request.path === "/api/auth/device/start") return startAnswer(request);
    if (request.path === "/api/auth/device/poll") {
      const answer = pollAnswers.length ? pollAnswers.shift() : pollDefault;
      return answer(request);
    }
    if (request.path === "/api/devices/current") return currentAnswer(request);
    if (request.path === "/api/watches" || request.path.startsWith("/api/watches/")) return answerWatches(request);
    if (request.path === "/api/listings/ingest") return answerIngest(request);
    if (request.path === "/api/settings") return answerSettings(request);
    return json(404, { error: "Not found." });
  });

  globalThis.fetch = fetchMock;

  return {
    fetch: fetchMock,
    requests,
    polls: () => requests.filter((r) => r.path === "/api/auth/device/poll"),
    // Queue the answers of the next polls, in order; then pollDefault.
    queuePoll: (...answers) => pollAnswers.push(...answers),
    setPollDefault: (answer) => {
      pollDefault = answer;
    },
    setStart: (answer) => {
      startAnswer = answer;
    },
    setCurrent: (answer) => {
      currentAnswer = answer;
    },
    // The account's watches, and the calls made to them.
    watches,
    // A watch made on the web app.
    addWatch,
    watchCalls: (method) =>
      requests.filter((r) => r.path.startsWith("/api/watches") && (!method || r.method === method)),
    // Scripts the watch routes: `answer(request)` returns a Response to
    // send instead of the store's, or nothing to let the store answer.
    setWatchRoute: (answer) => {
      watchRoute = answer;
    },
    // The account's stored listings ({ listingId, sourceKey, watchId,
    // listing }), and the calls made to the ingest route.
    listings,
    ingestCalls: () => requests.filter((r) => r.path === "/api/listings/ingest"),
    // Scripts the ingest route, like setWatchRoute.
    setIngestRoute: (answer) => {
      ingestRoute = answer;
    },
    // The account's settings as WatchDesk holds them now, a way to play
    // "someone changed them on the web", and the calls made to the route.
    settings: () => structuredClone(account.settings),
    setSettings: (patch) => {
      account.settings = { ...account.settings, ...patch };
    },
    settingsCalls: (method) => requests.filter((r) => r.path === "/api/settings" && (!method || r.method === method)),
    // Scripts the settings route, like setWatchRoute.
    setSettingsRoute: (answer) => {
      settingsRoute = answer;
    },
    // What a job site answers a fetch of its page: `answer(request)`.
    setSite: (answer) => {
      siteAnswer = answer;
    },
    // The request never gets an answer; it ends when the caller aborts it.
    hang: ({ signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      ),
    json,
    pending: () => json(200, { status: "pending" }),
    approved: () => json(200, { status: "approved", token: TEST_TOKEN }),
    denied: () => json(200, { status: "denied" }),
    expired: () => json(200, { status: "expired" }),
    networkError: () => {
      throw new TypeError("Failed to fetch");
    },
  };
}
