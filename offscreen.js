// offscreen.js
//
// MV3 service workers have no DOM and can't play audio directly. Chrome's
// supported workaround for both is an "offscreen document": a hidden page
// that DOES have a DOM/Web Audio, which the background service worker
// messages to do the work. This file handles two message types:
//   - "parse-html": parse fetched job-search HTML into a job list
//   - "play-sound": synthesize a short notification tone

import { SITES } from "./sites.js";
import { playSound } from "./sounds.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "parse-html") {
    try {
      const site = SITES[message.siteId];
      if (!site) {
        sendResponse({ ok: false, error: `Unknown site id: ${message.siteId}` });
        return true;
      }
      const doc = new DOMParser().parseFromString(message.html, "text/html");
      const jobs = site.extractJobs(doc, message.baseUrl);
      sendResponse({ ok: true, jobs });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
    return true; // keep the message channel open for the async sendResponse
  }

  if (message?.type === "play-sound") {
    playSound(message.soundId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  return false;
});
