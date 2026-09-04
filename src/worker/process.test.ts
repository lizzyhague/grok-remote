import assert from "node:assert/strict";
import test from "node:test";

import { assertWorkerCapacity } from "./process.ts";

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
