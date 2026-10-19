import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  englishText,
  hasText,
  isLocalText,
  localizeKnownText,
  localizeKnownTexts,
  localText,
  renderText,
} from "./local-text.ts";

test("renders shared interface text and nested parameters in either language", () => {
  const text = localText("backend.listRequired", {
    field: localText("field.sessionId"),
    count: 1000,
  });
  assert.equal(renderText(text, "zh"), "会话 ID列表不能为空，且一次最多 1000 项。");
  assert.equal(englishText(text), "session ID list must not be empty and may contain at most 1000 items.");
  assert.equal(hasText(text.key), true);
  assert.equal(isLocalText(text), true);
});

test("does not rewrite user or Grok-authored payload fields", () => {
  assert.deepEqual(localizeKnownTexts({
    type: "message.delta",
    text: "This turn failed.",
    title: "Model",
    output: "Context",
  }), {
    type: "message.delta",
    text: "This turn failed.",
    title: "Model",
    output: "Context",
  });
});

test("maps known backend text and leaves Grok-authored text unchanged", () => {
  assert.deepEqual(localizeKnownText("This session could not be found."), {
    key: "backend.sessionMissing",
  });
  assert.deepEqual(localizeKnownText("The attachment upload failed."), {
    key: "attachment.failed",
  });
  assert.deepEqual(localizeKnownText("The Grok worker exited (SIGTERM)."), {
    key: "backend.workerExited",
    params: { detail: "SIGTERM" },
  });
  assert.deepEqual(
    localizeKnownText("This client message ID was already used for different text or attachments."),
    { key: "backend.clientMessageConflict" },
  );
  assert.equal(localizeKnownText("A message written by Grok."), "A message written by Grok.");
});

test("defines every translation key referenced by the backend localizer", () => {
  const source = readFileSync(new URL("local-text.ts", import.meta.url), "utf8");
  const keys = [...source.matchAll(/"((?:backend|command|field|rename|request|selection|session|task|attachment)\.[A-Za-z][A-Za-z0-9]*)"/gu)]
    .map((match) => match[1]!);
  assert.ok(keys.length > 0);
  assert.deepEqual(keys.filter((key) => !hasText(key)), []);
});
