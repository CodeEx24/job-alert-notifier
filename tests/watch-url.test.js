// WD-82: when two watch URLs are the same search (watch-url.js). The rule
// decides which of an account's watches a watch of this browser becomes, so
// both directions matter: what is obviously the same search must match, and
// two searches that differ in anything a site could read must not.
import { describe, expect, it } from "vitest";
import { watchKey } from "../watch-url.js";

const OJ = "https://www.onlinejobs.ph/jobseekers/jobsearch";
const UPWORK = "https://www.upwork.com/nx/search/jobs/?q=react&sort=recency";
const GLASSDOOR = "https://www.glassdoor.com/Job/remote-react-jobs-SRCH_IL.0,6_IS11047_KO7,12.htm";
const LINKEDIN = "https://www.linkedin.com/jobs/search/?keywords=react&f_TPR=r86400&sortBy=DD";

describe("the same search, spelled differently", () => {
  it.each([
    ["a trailing slash", OJ, `${OJ}/`],
    ["the letter case of the scheme and the host", OJ, "HTTPS://WWW.OnlineJobs.PH/jobseekers/jobsearch"],
    ["a www. prefix", OJ, "https://onlinejobs.ph/jobseekers/jobsearch"],
    ["http for https", OJ, "http://www.onlinejobs.ph/jobseekers/jobsearch"],
    ["the default port", UPWORK, "https://www.upwork.com:443/nx/search/jobs/?q=react&sort=recency"],
    ["the order of the parameters", UPWORK, "https://www.upwork.com/nx/search/jobs/?sort=recency&q=react"],
    ["a trailing slash before the query", UPWORK, "https://www.upwork.com/nx/search/jobs?q=react&sort=recency"],
    ["tracking parameters", UPWORK, `${UPWORK}&utm_source=newsletter&utm_campaign=oct&fbclid=abc123&gclid=x`],
    ["a fragment", GLASSDOOR, `${GLASSDOOR}#jobs`],
    ["a space as %20 and as +", "https://www.upwork.com/nx/search/jobs/?q=react%20native", "https://www.upwork.com/nx/search/jobs/?q=react+native"],
    ["an escaped character that needs no escape", "https://www.onlinejobs.ph/jobseekers/job%2Dsearch", "https://www.onlinejobs.ph/jobseekers/job-search"],
    ["the letter case of an escape", "https://www.onlinejobs.ph/jobseekers/a%2fb", "https://www.onlinejobs.ph/jobseekers/a%2Fb"],
    ["spaces around the address", OJ, `  ${OJ}\n`],
    // What the extension's own LinkedIn rule rewrites, and WatchDesk's copy
    // of it: the page shape, the job that was open, the sort order.
    ["LinkedIn's two search pages", LINKEDIN, "https://www.linkedin.com/jobs/search-results/?keywords=react&f_TPR=r86400"],
    ["the LinkedIn job that was open", LINKEDIN, `${LINKEDIN}&currentJobId=4012345678&origin=JOB_SEARCH_PAGE_JOB_FILTER`],
    ["LinkedIn's sort order, which the extension always sets", LINKEDIN, "https://www.linkedin.com/jobs/search/?keywords=react&f_TPR=r86400&sortBy=R"],
    ["LinkedIn's click tracking", LINKEDIN, `${LINKEDIN}&trk=public_jobs_jobs-search-bar_search-submit&refId=abc&trackingId=def`],
    ["all of it at once", UPWORK, "http://UPWORK.com/nx/search/jobs?utm_medium=email&sort=recency&q=react#top"],
  ])("%s", (_what, a, b) => {
    expect(watchKey(a)).toBe(watchKey(b));
  });
});

describe("two different searches", () => {
  it.each([
    ["one filter value", LINKEDIN, "https://www.linkedin.com/jobs/search/?keywords=vue&f_TPR=r86400&sortBy=DD"],
    ["another value of the same filter", LINKEDIN, "https://www.linkedin.com/jobs/search/?keywords=react&f_TPR=r604800&sortBy=DD"],
    ["one more filter", LINKEDIN, `${LINKEDIN}&f_WT=2`],
    ["the letter case of a keyword", UPWORK, "https://www.upwork.com/nx/search/jobs/?q=React&sort=recency"],
    ["a parameter given twice", "https://www.upwork.com/nx/search/jobs/?q=react&t=0", "https://www.upwork.com/nx/search/jobs/?q=react&t=0&t=1"],
    ["a parameter that is there but empty", UPWORK, `${UPWORK}&location=`],
    ["another path", OJ, "https://www.onlinejobs.ph/jobseekers/jobsearch/2"],
    ["the letter case of the path", GLASSDOOR, GLASSDOOR.replace("/Job/", "/job/")],
    ["a Glassdoor search that differs in its code", GLASSDOOR, GLASSDOOR.replace("KO7,12", "KO7,13")],
    ["a subdomain that is not www.", LINKEDIN, LINKEDIN.replace("www.linkedin.com", "ph.linkedin.com")],
    ["another site with the same path", "https://www.upwork.com/jobs", "https://www.glassdoor.com/jobs"],
    ["another port", OJ, "https://www.onlinejobs.ph:8443/jobseekers/jobsearch"],
    ["a parameter that only looks like tracking", UPWORK, `${UPWORK}&utm=1&track=2`],
    // An escape of a character that does need one is kept: "/" in a path
    // segment is not the "/" between two segments.
    ["an escaped slash and a real one", "https://www.onlinejobs.ph/jobseekers/a%2Fb", "https://www.onlinejobs.ph/jobseekers/a/b"],
  ])("%s", (_what, a, b) => {
    expect(watchKey(a)).not.toBe(watchKey(b));
  });
});

describe("the site is part of the key", () => {
  it("names the site a URL belongs to, by the extension's own rule (sites.js)", () => {
    expect(watchKey(OJ).split("|")[0]).toBe("onlinejobsph");
    expect(watchKey(GLASSDOOR).split("|")[0]).toBe("glassdoor");
    expect(watchKey(LINKEDIN).split("|")[0]).toBe("linkedin");
    expect(watchKey(UPWORK).split("|")[0]).toBe("upwork");
    expect(watchKey("https://jobs.example.org/search?q=php").split("|")[0]).toBe("");
  });

  it("a LinkedIn address that is not a search is left as it is, tracking apart", () => {
    const view = "https://www.linkedin.com/jobs/view/4012345678/";
    expect(watchKey(view)).toBe(watchKey("https://linkedin.com/jobs/view/4012345678"));
    expect(watchKey(view)).not.toBe(watchKey("https://www.linkedin.com/jobs/view/4012345679/"));
    // No sort order is added to it.
    expect(watchKey(view)).not.toContain("sortBy");
  });
});

describe("an address that is not a web address", () => {
  it.each(["not a url", "", "javascript:alert(1)", "ftp://www.upwork.com/nx/search/jobs/?q=react", "//www.upwork.com/jobs"])(
    "%j is the same search only as itself",
    (text) => {
      expect(watchKey(text)).toBe(watchKey(` ${text} `));
      expect(watchKey(text)).not.toBe(watchKey(`${text}x`));
      expect(watchKey(text)).not.toBe(watchKey(UPWORK));
    },
  );

  it.each([undefined, null, 42, {}])("%j is read as no address", (value) => {
    expect(watchKey(value)).toBe(watchKey(""));
  });

  it("never throws, and says nothing but the key", () => {
    expect(() => watchKey("https://%zz")).not.toThrow();
    expect(typeof watchKey("https://www.upwork.com/%E0%A4%A")).toBe("string");
  });
});
