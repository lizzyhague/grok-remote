import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./theme.js", import.meta.url), "utf8");

function run({ stored = null, systemLight = false, storageThrows = false } = {}) {
  const attributes = new Map();
  const mediaListeners = [];
  const windowListeners = new Map();
  const writes = [];
  const header = { content: "#0f0f10", setAttribute(name, value) { if (name === "content") this.content = value; } };
  const media = { matches: systemLight, addEventListener(name, listener) { if (name === "change") mediaListeners.push(listener); } };
  const localStorage = {
    getItem() { if (storageThrows) throw new Error("blocked"); return stored; },
    setItem(key, value) { if (storageThrows) throw new Error("blocked"); stored = value; writes.push(["set", key, value]); },
    removeItem(key) { if (storageThrows) throw new Error("blocked"); stored = null; writes.push(["remove", key]); },
  };
  const window = { matchMedia() { return media; }, addEventListener(name, listener) { windowListeners.set(name, listener); } };
  vm.runInNewContext(source, {
    document: {
      documentElement: { setAttribute(name, value) { attributes.set(name, value); } },
      querySelector(selector) { return selector === 'meta[name="theme-color"]' ? header : null; },
    },
    localStorage,
    window,
  });
  return { attributes, header, media, mediaListeners, windowListeners, window, writes, setStored(value) { stored = value; } };
}

test("defaults to the system theme and follows later system changes", () => {
  const page = run({ systemLight: true });
  assert.equal(page.attributes.get("data-theme"), "light");
  page.media.matches = false;
  page.mediaListeners[0]();
  assert.equal(page.attributes.get("data-theme"), "dark");
  assert.equal(page.window.grokRemoteTheme.get(), "system");
});

test("a manual choice is stored, applied immediately, and can return to system", () => {
  const page = run();
  page.window.grokRemoteTheme.set("light");
  assert.equal(page.attributes.get("data-theme"), "light");
  assert.deepEqual(page.writes[0], ["set", "grok-remote.theme", "light"]);
  page.window.grokRemoteTheme.set("system");
  assert.equal(page.attributes.get("data-theme"), "dark");
  assert.deepEqual(page.writes[1], ["remove", "grok-remote.theme"]);
});

test("storage changes synchronize tabs and blocked storage still allows switching", () => {
  const page = run();
  page.setStored("light");
  page.windowListeners.get("storage")({ key: "grok-remote.theme" });
  assert.equal(page.attributes.get("data-theme"), "light");
  const blocked = run({ storageThrows: true });
  blocked.window.grokRemoteTheme.set("light");
  assert.equal(blocked.attributes.get("data-theme"), "light");
});

test("the PWA header color follows the applied theme", () => {
  const page = run({ systemLight: true });
  assert.equal(page.header.content, "#fbf9f4");
  page.media.matches = false;
  page.mediaListeners[0]();
  assert.equal(page.header.content, "#0f0f10");
  page.window.grokRemoteTheme.set("light");
  assert.equal(page.header.content, "#fbf9f4");
});
