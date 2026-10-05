// The popup's Start Watching / Pause Watching control (popup-watcher.js,
// WD-71), rendered into the real popup.html with jsdom.
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeWatcher, initWatcherControl, renderWatcher } from "../popup-watcher.js";

let doc;
const section = () => doc.getElementById("watcher-control");
const status = () => doc.getElementById("watcher-status");
const detail = () => doc.getElementById("watcher-detail");
const button = () => doc.getElementById("watcher-toggle");
// Lets the click handler's awaits run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  // The real markup, without its script tag.
  const html = readFileSync("popup.html", "utf8").replace(/<script[^>]*><\/script>/g, "");
  doc = new JSDOM(html).window.document;
});

describe("describeWatcher", () => {
  it("shows nothing before the worker has said which it is", () => {
    expect(describeWatcher(undefined)).toBeNull();
    expect(describeWatcher(null)).toBeNull();
  });

  it("running offers Pause Watching", () => {
    expect(describeWatcher({ state: "running" })).toMatchObject({
      state: "running",
      status: "Watching is running",
      action: "Pause Watching",
      next: "paused",
    });
  });

  it("paused offers Start Watching", () => {
    expect(describeWatcher({ state: "paused" })).toMatchObject({
      state: "paused",
      status: "Watching is paused",
      action: "Start Watching",
      next: "running",
    });
  });

  it("reads anything that is not paused as running, as the worker does", () => {
    expect(describeWatcher({ state: "stopped" }).state).toBe("running");
    expect(describeWatcher({}).state).toBe("running");
  });
});

describe("the control in popup.html", () => {
  it("is there once, hidden until rendered, with a live state line and a plain button", () => {
    expect(doc.querySelectorAll("#watcher-control")).toHaveLength(1);
    expect(section().hidden).toBe(true);
    // Announced when it changes; the one role="status" is the sync line's.
    expect(status().getAttribute("aria-live")).toBe("polite");
    expect(status().hasAttribute("role")).toBe(false);
    expect(button().getAttribute("type")).toBe("button");
  });

  it("sits above the check controls and leaves Pause All where it was", () => {
    const controls = doc.querySelector("section.controls");
    expect(section().compareDocumentPosition(controls) & 4).toBe(4); // DOCUMENT_POSITION_FOLLOWING
    expect(doc.getElementById("pause-all").textContent).toBe("Pause All");
    expect(doc.getElementById("resume-all").textContent).toBe("Resume All");
    expect(doc.getElementById("check-now").textContent).toBe("Check now");
  });

  it("stays hidden when CSS would otherwise show it", () => {
    const css = readFileSync("popup.css", "utf8");
    expect(css).toMatch(/\.watcher-control\[hidden\]\s*\{\s*display:\s*none;/);
  });
});

describe("renderWatcher", () => {
  it("says in words that watching is running, and offers to pause", () => {
    renderWatcher({ state: "running" }, doc);

    expect(section().hidden).toBe(false);
    expect(section().dataset.state).toBe("running");
    expect(status().textContent).toBe("Watching is running");
    expect(detail().textContent).toBe("Your watches are checked automatically.");
    expect(button().textContent).toBe("Pause Watching");
    expect(button().dataset.next).toBe("paused");
    expect(button().classList.contains("secondary")).toBe(true);
    expect(button().disabled).toBe(false);
  });

  it("says in words that watching is paused, and makes starting the main button", () => {
    renderWatcher({ state: "paused" }, doc);

    expect(section().dataset.state).toBe("paused");
    expect(status().textContent).toBe("Watching is paused");
    expect(detail().textContent).toContain("No automatic checks until you start watching again");
    expect(detail().textContent).toContain("Check now");
    expect(button().textContent).toBe("Start Watching");
    expect(button().dataset.next).toBe("running");
    expect(button().classList.contains("secondary")).toBe(false);
  });

  it("names the state in text, not by colour alone", () => {
    for (const state of ["running", "paused"]) {
      renderWatcher({ state }, doc);
      expect(status().textContent).toContain(state);
    }
  });

  it("follows the state back and forth", () => {
    renderWatcher({ state: "paused" }, doc);
    renderWatcher({ state: "running" }, doc);
    expect(status().textContent).toBe("Watching is running");
    expect(button().textContent).toBe("Pause Watching");
  });

  it("hides again with no state, and does nothing on a page without the control", () => {
    renderWatcher({ state: "paused" }, doc);
    renderWatcher(undefined, doc);
    expect(section().hidden).toBe(true);

    const empty = new JSDOM("<body></body>").window.document;
    expect(() => renderWatcher({ state: "paused" }, empty)).not.toThrow();
    expect(() => initWatcherControl({ send: vi.fn(), onState: vi.fn() }, empty)).not.toThrow();
  });
});

describe("initWatcherControl", () => {
  // The worker's answer: the popup state after the change.
  const answer = (state) => ({ settings: {}, runState: {}, watcher: { state }, watchSync: { mode: "local" } });

  it("Pause Watching asks the worker to pause, and hands its answer on", async () => {
    const send = vi.fn(async () => answer("paused"));
    const onState = vi.fn((state) => renderWatcher(state.watcher, doc));
    renderWatcher({ state: "running" }, doc);
    initWatcherControl({ send, onState }, doc);

    button().click();
    await settle();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "set-watcher-state", state: "paused" });
    expect(onState).toHaveBeenCalledWith(answer("paused"));
    expect(status().textContent).toBe("Watching is paused");
    expect(button().textContent).toBe("Start Watching");
    expect(button().disabled).toBe(false);
  });

  it("Start Watching asks the worker to run", async () => {
    const send = vi.fn(async () => answer("running"));
    renderWatcher({ state: "paused" }, doc);
    initWatcherControl({ send, onState: (state) => renderWatcher(state.watcher, doc) }, doc);

    button().click();
    await settle();

    expect(send).toHaveBeenCalledWith({ type: "set-watcher-state", state: "running" });
    expect(status().textContent).toBe("Watching is running");
  });

  it("is busy, and cannot be clicked twice, until the worker answers", async () => {
    let finish;
    const send = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    renderWatcher({ state: "running" }, doc);
    initWatcherControl({ send, onState: (state) => renderWatcher(state.watcher, doc) }, doc);

    button().click();
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe("Pausing…");
    button().click();
    expect(send).toHaveBeenCalledTimes(1);

    finish(answer("paused"));
    await settle();
    expect(button().disabled).toBe(false);
    expect(button().textContent).toBe("Start Watching");
  });

  it.each([
    ["refuses", async () => ({ ok: false, error: "Unknown watcher state" })],
    ["answers nothing", async () => undefined],
    [
      "cannot be reached",
      async () => {
        throw new Error("Could not establish connection.");
      },
    ],
  ])("puts the button back as it was when the worker %s", async (_label, send) => {
    const onState = vi.fn();
    renderWatcher({ state: "running" }, doc);
    initWatcherControl({ send, onState }, doc);

    button().click();
    await settle();

    expect(onState).not.toHaveBeenCalled();
    expect(status().textContent).toBe("Watching is running");
    expect(button().textContent).toBe("Pause Watching");
    expect(button().disabled).toBe(false);
  });
});
