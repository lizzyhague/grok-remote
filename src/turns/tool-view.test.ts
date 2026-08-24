import assert from "node:assert/strict";
import test from "node:test";

import {
  createPublicToolView,
  exposesToolText,
  updatePublicToolView,
} from "./tool-view.ts";

test("normalizes Grok tool metadata into public kinds", () => {
  const cases = [
    ["read_file", "read", "read"],
    ["list_dir", "list", "read"],
    ["search_replace", "edit", "edit"],
    ["write", "write", "edit"],
    ["run_terminal_command", "execute", "execute"],
    ["web_fetch", "web_fetch", "fetch"],
    ["todo_write", "plan", "think"],
    ["use_tool", "use_tool", "other"],
  ] as const;
  for (const [name, kind, expected] of cases) {
    const view = createPublicToolView({
      _meta: { "x.ai/tool": { name, kind, label: name } },
    });
    assert.equal(view.kind, expected);
  }
});

test("keeps search queries and resource addresses without result content", () => {
  const start = createPublicToolView({ kind: "search", title: "Search" });
  const completed = updatePublicToolView(start, {
    rawOutput: {
      action: {
        query: "ACP tool calls",
        sources: [
          { title: "ACP", url: "https://agentclientprotocol.com/protocol/tool-calls" },
          { path: "src/turns/runtime.ts", matches: [{ content: "private source line" }] },
        ],
      },
      body: "private page body",
    },
  });
  assert.equal(completed.query, "ACP tool calls");
  assert.deepEqual(completed.resources, [
    {
      address: "https://agentclientprotocol.com/protocol/tool-calls",
      label: "ACP",
    },
    { address: "src/turns/runtime.ts", label: null },
  ]);
  assert.equal(JSON.stringify(completed).includes("private"), false);
});

test("shows local search patterns and matched file paths without matched lines", () => {
  const start = createPublicToolView({
    _meta: { "x.ai/tool": { name: "grep", kind: "search", label: "Search" } },
    rawInput: { pattern: "BrowserTurnEvent", path: "src" },
  });
  const completed = updatePublicToolView(start, {
    rawOutput: {
      file_matches: [
        { path: "src/turns/runtime.ts", matches: [{ content: "private matching line" }] },
      ],
    },
  });
  assert.equal(completed.query, "BrowserTurnEvent");
  assert.deepEqual(completed.resources, [
    { address: "src/turns/runtime.ts", label: null },
  ]);
  assert.equal(JSON.stringify(completed).includes("matching line"), false);
});

test("keeps a fetched resource address and drops fetched text", () => {
  const start = createPublicToolView({
    _meta: { "x.ai/tool": { name: "web_fetch", kind: "web_fetch", label: "Web Fetch" } },
    rawInput: { url: "https://example.com/article" },
  });
  const completed = updatePublicToolView(start, {
    rawOutput: {
      Content: "article body with https://tracker.example/pixel",
      resource: "another copy of the fetched body",
    },
    content: [{ type: "content", content: { type: "text", text: "article body" } }],
  });
  assert.deepEqual(completed.resources, [
    { address: "https://example.com/article", label: null },
  ]);
  assert.equal(JSON.stringify(completed).includes("article body"), false);
  assert.equal(JSON.stringify(completed).includes("another copy"), false);
  assert.equal(JSON.stringify(completed).includes("tracker"), false);
});

test("uses the command as execute input", () => {
  const view = createPublicToolView({
    _meta: { "x.ai/tool": { name: "run_terminal_command", kind: "execute" } },
    rawInput: { command: "npm test", timeout: 30 },
  });
  assert.equal(view.kind, "execute");
  assert.equal(view.input, "npm test");
});

test("only execute and other tools expose arbitrary input and output text", () => {
  assert.equal(exposesToolText("execute"), true);
  assert.equal(exposesToolText("other"), true);
  for (const kind of [
    "read", "edit", "delete", "move", "search", "think", "fetch", "switch_mode",
  ] as const) {
    assert.equal(exposesToolText(kind), false, kind);
  }
});
