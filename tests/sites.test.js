// Which site a URL belongs to (WD-108): the site's domain or a dot-separated
// subdomain of it, and nothing that merely ends with the domain.
//
// site-host-cases.json is, byte for byte, WatchDesk's
// lib/sites.host-cases.json, which is run against lib/sites.ts there, so the
// two rules agree on every host in it. Change both copies together.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SITES, siteForUrl } from "../sites.js";

const HOST_CASES = JSON.parse(readFileSync("tests/site-host-cases.json", "utf8"));

const DOMAINS = {
  onlinejobsph: "onlinejobs.ph",
  glassdoor: "glassdoor.com",
  linkedin: "linkedin.com",
  upwork: "upwork.com",
};

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

describe("siteForUrl", () => {
  it.each(HOST_CASES)("$url → $site", ({ url, site }) => {
    expect(siteForUrl(url)?.id ?? null).toBe(site);
  });

  it.each(HOST_CASES)("only the matching adapter's hostMatch accepts $url", ({ url, site }) => {
    const accepting = Object.values(SITES)
      .filter((adapter) => adapter.hostMatch(url))
      .map((adapter) => adapter.id);
    expect(accepting).toEqual(site ? [site] : []);
  });

  it("covers every site, matched and refused", () => {
    expect(Object.keys(DOMAINS)).toEqual(Object.keys(SITES));
    const refused = HOST_CASES.filter((c) => c.site === null)
      .map((c) => hostnameOf(c.url))
      .filter(Boolean);

    for (const [id, domain] of Object.entries(DOMAINS)) {
      const matched = HOST_CASES.filter((c) => c.site === id).map((c) => hostnameOf(c.url));

      expect(matched).toContain(domain);
      expect(matched).toContain(`www.${domain}`);
      // A longer label that ends in the domain, and the domain used as a
      // subdomain of another.
      expect(refused.some((h) => h.endsWith(domain) && !h.endsWith(`.${domain}`))).toBe(true);
      expect(refused.some((h) => h.startsWith(`${domain}.`))).toBe(true);
    }
  });

  // Every host the manifest lets the extension read is still its site's.
  it("still matches every job-site host in the manifest and the adapters", () => {
    const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
    const patterns = [
      ...manifest.host_permissions,
      ...manifest.content_scripts.flatMap((script) => script.matches),
      ...Object.values(SITES).flatMap((adapter) => [adapter.defaultUrl, adapter.tabQueryPattern]),
    ].filter(Boolean);
    const jobSiteUrls = patterns
      .map((pattern) => pattern.replace(/\*$/, ""))
      .filter((url) => Object.values(DOMAINS).some((domain) => url.includes(domain)));

    expect(jobSiteUrls.length).toBeGreaterThanOrEqual(4);
    for (const url of jobSiteUrls) {
      const expected = Object.keys(DOMAINS).find((id) => url.includes(DOMAINS[id]));
      expect(siteForUrl(url)?.id, url).toBe(expected);
    }
  });
});

describe("LinkedIn normalizeUrl", () => {
  it("rewrites a LinkedIn search URL on the domain or a subdomain", () => {
    expect(
      SITES.linkedin.normalizeUrl("https://ph.linkedin.com/jobs/search-results/?currentJobId=1&keywords=qa"),
    ).toBe("https://ph.linkedin.com/jobs/search/?keywords=qa&sortBy=DD");
  });

  it("leaves a look-alike host alone", () => {
    const url = "https://notlinkedin.com/jobs/search-results/?currentJobId=1&keywords=qa";
    expect(SITES.linkedin.normalizeUrl(url)).toBe(url);
  });
});
