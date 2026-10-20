import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  DISPLAY_TIMEZONE_KEY,
  deviceTimeZone,
  formatDisplayTime,
  loadDisplayTimezonePreference,
  resolveDisplayTimeZone,
  saveDisplayTimezonePreference,
} from "./display-timezone.js";

const [html, app, styles, stringsSource] = await Promise.all([
  readFile(new URL("./index.html", import.meta.url), "utf8"),
  readFile(new URL("./app.js", import.meta.url), "utf8"),
  readFile(new URL("./styles.css", import.meta.url), "utf8"),
  readFile(new URL("./strings.js", import.meta.url), "utf8"),
]);

const dialog = html.slice(
  html.indexOf('<dialog id="app-settings-dialog"'),
  html.indexOf("</dialog>", html.indexOf('<dialog id="app-settings-dialog"')),
);

function strings() {
  const window = {};
  vm.runInNewContext(stringsSource, { window });
  return window.grokRemoteStrings;
}

function section(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing section ${start}`);
  return app.slice(from, to);
}

test("the settings button matches the other projects' application settings gear", () => {
  assert.match(html, /id="app-settings-button"[^>]*class="quiet small icon-button app-settings-button"/u);
  assert.match(html, /id="app-settings-button"[\s\S]*?aria-label="应用设置"[\s\S]*?<path d="M12\.22 2h-\.44a2 2 0 0 0-2 2v\.18/u);
  assert.doesNotMatch(html, /appearance-settings/u);
});

test("application settings lists appearance, language, then time zone in the same row format", () => {
  assert.match(dialog, /<h2 id="app-settings-title"[^>]*>应用设置<\/h2>/u);
  const order = ["theme-setting", "language-setting", "timezone-setting"].map((id) => dialog.indexOf(`<section id="${id}" class="app-settings-section">`));
  assert.ok(order.every((index) => index >= 0));
  assert.ok(order[0] < order[1] && order[1] < order[2]);
  assert.equal(dialog.match(/class="app-settings-help" data-i18n="settings\.browserOnly"/gu)?.length, 3);
  assert.match(dialog, /<select id="display-timezone-select" class="timezone-select">\s*<option value="device"[^>]*>跟随设备<\/option>/u);
  assert.match(styles, /\.app-settings-title \{[^}]*color: var\(--text\);[^}]*font-size: 0\.95rem;/u);
});

test("the sidebar labels Grok's activity time in both languages", () => {
  const lastActive = strings()["session.lastActive"];
  assert.equal(lastActive.zh, "最后活动于 {date}");
  assert.equal(lastActive.en, "last active at {date}");
  assert.match(app, /t\("session\.lastActive", \{ date \}\)/u);
});

test("the time zone applies on change, keeps the last city when following the device, and drives sidebar times", () => {
  const storage = new Map();
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  saveDisplayTimezonePreference({ followDevice: false, cityTimeZone: "Asia/Tokyo" }, localStorage);
  let rendered = 0;
  const context = vm.createContext({
    deviceTimeZone,
    formatDisplayTime,
    resolveDisplayTimeZone,
    saveDisplayTimezonePreference: (input) => saveDisplayTimezonePreference(input, localStorage),
    state: { displayTimezone: loadDisplayTimezonePreference(localStorage) },
    elements: { displayTimezoneSelect: { value: "" } },
    renderSessionList() { rendered += 1; },
  });
  vm.runInContext([
    section("function syncDisplayTimezoneSelect(", "function clearTimeline("),
    section("function formatDate(", "/** Status line for the login card"),
  ].join("\n"), context);

  // 2026-01-15T12:00:00Z in seconds, as Grok session records store it.
  const stamp = 1_768_478_400;
  assert.equal(context.formatDate(stamp), "01-15 21:00");

  context.elements.displayTimezoneSelect.value = "America/New_York";
  context.selectDisplayTimezone();
  assert.deepEqual(JSON.parse(storage.get(DISPLAY_TIMEZONE_KEY)), { followDevice: false, cityTimeZone: "America/New_York" });
  assert.equal(context.formatDate(stamp), "01-15 07:00");
  assert.equal(rendered, 1);

  context.elements.displayTimezoneSelect.value = "device";
  context.selectDisplayTimezone();
  assert.deepEqual(JSON.parse(storage.get(DISPLAY_TIMEZONE_KEY)), { followDevice: true, cityTimeZone: "America/New_York" });
  assert.equal(context.elements.displayTimezoneSelect.value, "device");
});
