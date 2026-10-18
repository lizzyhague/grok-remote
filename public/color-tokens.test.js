import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const styles = await readFile(new URL("./styles.css", import.meta.url), "utf8");

test("visible colors are declared in the color module", () => {
  const rootEnd = styles.indexOf("\n}");
  assert.notEqual(rootEnd, -1);

  const lightStart = styles.indexOf(':root[data-theme="light"]');
  const lightEnd = styles.indexOf("\n}", lightStart);
  assert.notEqual(lightStart, -1);
  assert.notEqual(lightEnd, -1);
  const rules = `${styles.slice(rootEnd + 2, lightStart)}${styles.slice(lightEnd + 2)}`.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
  assert.doesNotMatch(rules, /#[\da-f]{3,8}\b|(?:rgb|rgba|hsl|hsla)\(/iu);
});

test("light colors match lanting's Grok member palette", () => {
  const lightStart = styles.indexOf(':root[data-theme="light"]');
  const lightEnd = styles.indexOf("\n}", lightStart);
  const light = styles.slice(lightStart, lightEnd);
  assert.match(light, /--neutral:\s*#f8f4ea;/u);
  assert.match(light, /--ink:\s*#1c1c1e;/u);
  assert.match(light, /--theme:\s*color-mix\(in srgb, color-mix\(in srgb, var\(--neutral\) var\(--mix-text\), var\(--ink\)\) 20%, #f3c56b\);/u);
  assert.match(light, /--mix-bubble-ai:\s*15%;/u);
});
