import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { AcpClient, GROK_REMOTE_SESSION_RULES } from "./acp-client.ts";

test("initializes without advertising fs or terminal capabilities", async () => {
  const { proc, stdin, stdout } = fakeProcess();
  const client = new AcpClient(proc);
  const handshake = client.initialize();
  const line = await readLine(stdin);
  const message = JSON.parse(line) as {
    method: string;
    params: { clientCapabilities: unknown };
  };
  assert.equal(message.method, "initialize");
  assert.deepEqual(message.params.clientCapabilities, {});

  stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
  })}\n`);
  const result = await handshake as { protocolVersion: number };
  assert.equal(result.protocolVersion, 1);
  await client.close();
});

test("explicitly sends the selected permission mode for new and resumed sessions", async () => {
  const { proc, stdin, stdout } = fakeProcess();
  const client = new AcpClient(proc);

  const created = client.sessionNew("/project", false);
  const newRequest = JSON.parse(await readLine(stdin)) as {
    id: number;
    method: string;
    params: { _meta: { yoloMode: boolean; rules?: string } };
  };
  assert.equal(newRequest.method, "session/new");
  assert.deepEqual(newRequest.params._meta, {
    yoloMode: false,
    rules: GROK_REMOTE_SESSION_RULES,
  });
  stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: newRequest.id,
    result: { sessionId: "s1" },
  })}\n`);
  assert.equal(await created, "s1");

  const resumed = client.sessionResume("s1", "/project", true);
  const resumeRequest = JSON.parse(await readLine(stdin)) as {
    id: number;
    method: string;
    params: { _meta: { yoloMode: boolean; rules?: string } };
  };
  assert.equal(resumeRequest.method, "session/resume");
  assert.deepEqual(resumeRequest.params._meta, { yoloMode: true });
  assert.equal("rules" in resumeRequest.params._meta, false);
  stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: resumeRequest.id,
    result: {},
  })}\n`);
  await resumed;
  await client.close();
});

test("new-session rules describe browser-viewable file placement and links", () => {
  assert.match(GROK_REMOTE_SESSION_RULES, /正式文件保存在当前项目内/u);
  assert.match(GROK_REMOTE_SESSION_RULES, /临时预览一律写到 ~\/preview/u);
  assert.match(GROK_REMOTE_SESSION_RULES, /不要把这类文件放到 ~\/\.grok 或 \/tmp/u);
  assert.match(GROK_REMOTE_SESSION_RULES, /Markdown 链接/u);
  assert.match(GROK_REMOTE_SESSION_RULES, /\/view\?path= 加 URL 编码后的绝对路径/u);
});

test("sends structured image and embedded-resource prompt blocks unchanged", async () => {
  const { proc, stdin, stdout } = fakeProcess();
  const client = new AcpClient(proc);
  const prompt = [
    { type: "text" as const, text: "inspect" },
    { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" },
    {
      type: "resource" as const,
      resource: { uri: "file://attachment/note.txt", mimeType: "text/plain", text: "hello" },
    },
  ];
  const pending = client.sessionPrompt("s1", prompt);
  const request = JSON.parse(await readLine(stdin)) as {
    id: number;
    method: string;
    params: unknown;
  };
  assert.equal(request.method, "session/prompt");
  assert.deepEqual(request.params, { sessionId: "s1", prompt });
  stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    result: { stopReason: "end_turn" },
  })}\n`);
  assert.equal((await pending).stopReason, "end_turn");
  await client.close();
});

test("forwards permission requests to the caller", async () => {
  const { proc, stdout } = fakeProcess();
  const client = new AcpClient(proc);
  const seen = new Promise((resolve) => {
    client.once("permission", resolve);
  });
  stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 9,
    method: "session/request_permission",
    params: {
      sessionId: "s1",
      toolCall: { toolCallId: "c1", title: "run tests" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    },
  })}\n`);
  const permission = await seen as { rpcId: number; options: unknown[] };
  assert.equal(permission.rpcId, 9);
  assert.equal(permission.options.length, 2);
  await client.close();
});

test("uses Grok ACP methods for session commands", async () => {
  const { proc, stdin, stdout } = fakeProcess();
  const client = new AcpClient(proc);

  await exchange(
    stdin,
    stdout,
    client.sessionSetModel("s1", "grok-4.5", "medium"),
    "session/set_model",
    {
      sessionId: "s1",
      modelId: "grok-4.5",
      _meta: { reasoningEffort: "medium" },
    },
    {},
  );
  await exchange(
    stdin,
    stdout,
    client.sessionSetMode("s1", "plan"),
    "session/set_mode",
    { sessionId: "s1", modeId: "plan" },
    {},
  );
  await exchange(
    stdin,
    stdout,
    client.sessionRename("s1", "new title"),
    "_x.ai/session/rename",
    { sessionId: "s1", title: "new title", resetToAuto: false },
    { success: true },
  );

  const infoPromise = client.sessionInfo("s1");
  const infoRequest = JSON.parse(await readLine(stdin)) as { id: number; method: string };
  assert.equal(infoRequest.method, "_x.ai/session/info");
  stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: infoRequest.id,
    result: { result: { sessionId: "s1", model: "grok-4.5" } },
  })}\n`);
  assert.equal((await infoPromise).model, "grok-4.5");

  await exchange(
    stdin,
    stdout,
    client.sessionCompact("s1"),
    "_x.ai/compact_conversation",
    { sessionId: "s1" },
    {},
  );

  const pointsPromise = client.rewindPoints("s1");
  const pointsRequest = JSON.parse(await readLine(stdin)) as { id: number; method: string };
  assert.equal(pointsRequest.method, "_x.ai/rewind/points");
  stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: pointsRequest.id,
    result: { rewind_points: [{ prompt_index: 3, prompt_preview: "latest" }] },
  })}\n`);
  assert.equal((await pointsPromise)[0]?.prompt_index, 3);

  const rewindPromise = client.rewindConversation("s1", 3);
  const rewindRequest = JSON.parse(await readLine(stdin)) as {
    id: number;
    method: string;
    params: unknown;
  };
  assert.equal(rewindRequest.method, "_x.ai/rewind/execute");
  assert.deepEqual(rewindRequest.params, {
    sessionId: "s1",
    targetPromptIndex: 3,
    force: true,
    mode: "conversation_only",
  });
  stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: rewindRequest.id,
    result: { success: true, prompt_text: "latest" },
  })}\n`);
  assert.equal((await rewindPromise).prompt_text, "latest");

  await client.close();
});

function fakeProcess(): {
  proc: ChildProcessWithoutNullStreams;
  stdin: PassThrough;
  stdout: PassThrough;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = {
    stdin,
    stdout,
    stderr,
    killed: false,
    exitCode: null,
    pid: 1234,
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === "exit") stdin.on("end", () => listener(0, null));
      return proc;
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      return proc.on(event, listener);
    },
    kill() {
      return true;
    },
  } as unknown as ChildProcessWithoutNullStreams;
  return { proc, stdin, stdout };
}

function readLine(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      stream.off("data", onData);
      resolve(chunk.toString("utf8").trim());
    };
    stream.on("data", onData);
  });
}

async function exchange(
  stdin: PassThrough,
  stdout: PassThrough,
  pending: Promise<unknown>,
  method: string,
  params: unknown,
  result: unknown,
): Promise<void> {
  const request = JSON.parse(await readLine(stdin)) as {
    id: number;
    method: string;
    params: unknown;
  };
  assert.equal(request.method, method);
  assert.deepEqual(request.params, params);
  stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  await pending;
}
