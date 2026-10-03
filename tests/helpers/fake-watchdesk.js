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

export function installFakeWatchDesk({ now = () => Date.now() } = {}) {
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

  const fetchMock = vi.fn(async (url, init = {}) => {
    const parsed = new URL(url);
    const request = {
      url,
      origin: parsed.origin,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      method: init.method || "GET",
      headers: { ...(init.headers || {}) },
      credentials: init.credentials,
      at: now(),
    };
    requests.push(request);
    if (parsed.origin !== WATCHDESK_ORIGIN) throw new TypeError("Failed to fetch");
    if (request.path === "/api/auth/device/start") return startAnswer(request);
    if (request.path === "/api/auth/device/poll") {
      const answer = pollAnswers.length ? pollAnswers.shift() : pollDefault;
      return answer(request);
    }
    if (request.path === "/api/devices/current") return currentAnswer(request);
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
