import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { AcpClient } from "./acp-client.ts";

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
