import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GrokSessionDisk } from "./disk.ts";
import { parseUpdatesJsonl } from "./history.ts";

test("lists sessions that belong to the project cwd", async (context) => {
  const grokHome = await mkdtemp(path.join(tmpdir(), "grok-remote-sessions-"));
  context.after(() => rm(grokHome, { recursive: true, force: true }));

  const project = path.join(grokHome, "proj");
  const other = path.join(grokHome, "other");
  await mkdir(project, { recursive: true });
  await mkdir(other, { recursive: true });

  const group = path.join(grokHome, "sessions", encodeURIComponent(project));
  const otherGroup = path.join(grokHome, "sessions", encodeURIComponent(other));
  await mkdir(path.join(group, "sess-keep"), { recursive: true });
  await mkdir(path.join(otherGroup, "sess-skip"), { recursive: true });
  await writeSummary(path.join(group, "sess-keep"), "sess-keep", project, "Keep me");
  await writeSummary(path.join(otherGroup, "sess-skip"), "sess-skip", other, "Skip me");

  const disk = new GrokSessionDisk(grokHome);
  const listed = await disk.listForCwd(project);
  assert.deepEqual(listed.map((item) => item.id), ["sess-keep"]);
  assert.equal(listed[0]?.title, "Keep me");
});

test("parses updates.jsonl into chat items and hides thoughts", () => {
  const source = [
    JSON.stringify({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "u1",
          content: { type: "text", text: "hi" },
        },
        _meta: { promptId: "turn-1" },
      },
    }),
    JSON.stringify({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "secret thought" },
        },
        _meta: { promptId: "turn-1" },
      },
    }),
    JSON.stringify({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "a1",
          content: { type: "text", text: "hello " },
        },
        _meta: { promptId: "turn-1" },
      },
    }),
    JSON.stringify({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "a1",
          content: { type: "text", text: "world" },
        },
        _meta: { promptId: "turn-1" },
      },
    }),
    JSON.stringify({
      method: "session/update",
      params: {
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "c1",
          title: "ls -la /very/long/path/that/should/stay/in/title/for/backend",
          kind: "execute",
          status: "completed",
        },
        _meta: { promptId: "turn-1" },
      },
    }),
  ].join("\n");

  const turns = parseUpdatesJsonl(source);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0]?.items.map((item) => item.type), ["message", "message"]);
  const assistant = turns[0]?.items[1];
  assert.equal(assistant && assistant.type === "message" ? assistant.text : "", "hello world");
  assert.equal(
    turns[0]?.items.some((item) => item.type === "message" && item.text.includes("secret")),
    false,
  );
});

test("starts a new assistant bubble after tools even without message ids", () => {
  const source = [
    updateLine("user_message_chunk", { content: { type: "text", text: "do it" } }),
    updateLine("agent_message_chunk", { content: { type: "text", text: "first " } }),
    updateLine("agent_message_chunk", { content: { type: "text", text: "paragraph" } }),
    updateLine("tool_call", {
      toolCallId: "c1",
      title: "ls",
      kind: "execute",
      status: "pending",
      rawInput: { command: "ls -la src" },
    }),
    updateLine("tool_call_update", {
      toolCallId: "c1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "app.js\n" } }],
    }),
    updateLine("agent_message_chunk", { content: { type: "text", text: "second paragraph" } }),
  ].join("\n");

  const turns = parseUpdatesJsonl(source);
  assert.deepEqual(turns[0]?.items.map((item) => item.type), ["message", "message", "message"]);
  assert.equal(textOf(turns[0]?.items[1]), "first paragraph");
  assert.equal(textOf(turns[0]?.items[2]), "second paragraph");
  assert.equal(JSON.stringify(turns).includes("ls -la src"), false);
  assert.equal(JSON.stringify(turns).includes("app.js"), false);
});

test("starts a new assistant bubble after hidden thoughts", () => {
  const source = [
    updateLine("user_message_chunk", { content: { type: "text", text: "do it" } }),
    updateLine("agent_message_chunk", { content: { type: "text", text: "first reply" } }),
    updateLine("agent_thought_chunk", { content: { type: "text", text: "hidden thought" } }),
    updateLine("agent_message_chunk", { content: { type: "text", text: "second reply" } }),
  ].join("\n");

  const turns = parseUpdatesJsonl(source);
  assert.deepEqual(turns[0]?.items.map((item) => item.type), ["message", "message", "message"]);
  assert.equal(textOf(turns[0]?.items[1]), "first reply");
  assert.equal(textOf(turns[0]?.items[2]), "second reply");
});

test("hides think tools while preserving their assistant bubble boundary", () => {
  const source = [
    updateLine("user_message_chunk", { content: { type: "text", text: "do it" } }),
    updateLine("agent_message_chunk", { content: { type: "text", text: "first reply" } }),
    updateLine("tool_call", {
      toolCallId: "think-1",
      title: "private plan",
      kind: "think",
      rawInput: { private: "hidden plan" },
    }),
    updateLine("agent_message_chunk", { content: { type: "text", text: "second reply" } }),
  ].join("\n");

  const turns = parseUpdatesJsonl(source);
  assert.deepEqual(turns[0]?.items.map((item) => item.type), ["message", "message", "message"]);
  assert.equal(textOf(turns[0]?.items[1]), "first reply");
  assert.equal(textOf(turns[0]?.items[2]), "second reply");
  assert.equal(JSON.stringify(turns).includes("private"), false);
});

function updateLine(sessionUpdate: string, update: Record<string, unknown>): string {
  return JSON.stringify({
    method: "session/update",
    params: {
      update: { sessionUpdate, ...update },
      _meta: { promptId: "turn-1" },
    },
  });
}

function textOf(item: { type: string; text?: string } | undefined): string {
  return item && item.type === "message" ? item.text ?? "" : "";
}

async function writeSummary(
  directory: string,
  id: string,
  cwd: string,
  title: string,
): Promise<void> {
  await writeFile(path.join(directory, "summary.json"), JSON.stringify({
    info: { id, cwd },
    generated_title: title,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    last_active_at: "2026-01-02T00:00:00.000Z",
  }));
}
