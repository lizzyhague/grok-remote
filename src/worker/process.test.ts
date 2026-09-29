import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertWorkerCapacity, spawnGrokAgent, terminateAgent } from "./process.ts";

test("does not pass the web access token to a Grok worker", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "grok-remote-env-"));
  context.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const capturePath = path.join(temporaryDirectory, "environment.json");
  const fakeGrok = path.join(temporaryDirectory, "fake-grok.mjs");
  await writeFile(fakeGrok, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
await writeFile(process.env.GROK_REMOTE_ENV_CAPTURE, JSON.stringify({
  remoteToken: process.env.GROK_REMOTE_TOKEN ?? null,
  inherited: process.env.GROK_REMOTE_ENV_PROBE ?? null
}));
setInterval(() => {}, 1_000);
`, "utf8");
  await chmod(fakeGrok, 0o700);

  const agent = spawnGrokAgent({
    grokBin: fakeGrok,
    cwd: temporaryDirectory,
    environment: {
      ...process.env,
      GROK_REMOTE_TOKEN: "web-access-token-must-not-be-inherited",
      GROK_REMOTE_ENV_PROBE: "still-inherited",
      GROK_REMOTE_ENV_CAPTURE: capturePath,
    },
  });
  try {
    const captured = await waitForFile(capturePath, 2_000);
    assert.deepEqual(JSON.parse(captured), {
      remoteToken: null,
      inherited: "still-inherited",
    });
  } finally {
    await terminateAgent(agent);
  }
});

test("rejects new workers at the process and memory gates", () => {
  assert.throws(
    () => assertWorkerCapacity({
      activeWorkers: 2,
      maxWorkers: 2,
      minFreeMemoryBytes: 1,
      memory: { availableBytes: 10, platform: "linux", source: "linux-meminfo" },
    }),
    /已达到上限/u,
  );
  assert.throws(
    () => assertWorkerCapacity({
      activeWorkers: 0,
      maxWorkers: 2,
      minFreeMemoryBytes: 1_000,
      memory: { availableBytes: 10, platform: "darwin", source: "darwin-vm-stat" },
    }),
    /可用内存不足/u,
  );
  assert.doesNotThrow(() => assertWorkerCapacity({
    activeWorkers: 1,
    maxWorkers: 2,
    minFreeMemoryBytes: 10,
    memory: { availableBytes: 100, platform: "linux", source: "linux-meminfo" },
  }));
  assert.doesNotThrow(() => assertWorkerCapacity({
    activeWorkers: 0,
    maxWorkers: 2,
    minFreeMemoryBytes: 1_000,
    memory: {
      availableBytes: 0,
      platform: "darwin",
      source: "os-freemem",
      degradedReason: "vm_stat failed",
    },
  }));
});

async function waitForFile(filePath: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (!isMissingFile(error) || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
