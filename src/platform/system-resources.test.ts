import assert from "node:assert/strict";
import test from "node:test";

import {
  memoryDegradedMessage,
  memoryLowMessage,
  parseDarwinAvailableBytes,
  parseLinuxAvailableBytes,
  readAvailableMemory,
} from "./system-resources.ts";

const appleSiliconVmStat = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     9183.
Pages active:                                 411410.
Pages inactive:                               487519.
Pages speculative:                              1860.
Pages wired down:                             103114.
File-backed pages:                            433779.
Anonymous pages:                              467010.
Pages occupied by compressor:                    798.
`;

const intelVmStat = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                              200000.
Pages wired down:                         50000.
Anonymous pages:                         100000.
Pages occupied by compressor:             10000.
`;

const sixteenGiB = 17_179_869_184;
const eightGiB = 8_589_934_592;

test("Linux reads MemAvailable instead of only completely free pages", async () => {
  assert.equal(parseLinuxAvailableBytes("MemAvailable: 2048 kB\n"), 2_097_152);
  const reading = await readAvailableMemory({
    platform: "linux",
    readLinuxMeminfo: async () => "MemTotal: 4000000 kB\nMemAvailable: 2861716 kB\n",
  });
  assert.equal(reading.source, "linux-meminfo");
  assert.equal(reading.availableBytes, 2_930_397_184);
});

test("macOS estimates available memory from vm_stat on both page sizes", async () => {
  const appleSilicon = parseDarwinAvailableBytes(appleSiliconVmStat, sixteenGiB);
  assert.equal(appleSilicon.ok, true);
  assert.equal(
    appleSilicon.ok && appleSilicon.availableBytes,
    sixteenGiB - (467_010 + 103_114 + 798) * 16_384,
  );

  const intel = parseDarwinAvailableBytes(intelVmStat, eightGiB);
  assert.equal(intel.ok, true);
  assert.equal(intel.ok && intel.availableBytes, eightGiB - 160_000 * 4_096);

  const reading = await readAvailableMemory({
    platform: "darwin",
    readVmStat: async () => appleSiliconVmStat,
    readTotalMemory: () => sixteenGiB,
    readFreeMemory: () => 1,
  });
  assert.equal(reading.source, "darwin-vm-stat");
  assert.equal(reading.degradedReason, undefined);
});

test("platform reader failures degrade to os.freemem with an explicit reason", async () => {
  const linux = await readAvailableMemory({
    platform: "linux",
    readLinuxMeminfo: async () => "MemTotal: 1000 kB\n",
    readFreeMemory: () => 512 * 1_048_576,
  });
  assert.equal(linux.source, "os-freemem");
  assert.match(linux.degradedReason ?? "", /MemAvailable/u);

  const darwin = await readAvailableMemory({
    platform: "darwin",
    readVmStat: async () => "unexpected output",
    readTotalMemory: () => sixteenGiB,
    readFreeMemory: () => 216 * 1_048_576,
  });
  assert.equal(darwin.source, "os-freemem");
  assert.equal(darwin.availableBytes, 216 * 1_048_576);
  assert.match(darwin.degradedReason ?? "", /vm_stat/u);
});

test("memory messages identify the source, threshold, and degraded behavior", () => {
  const low = memoryLowMessage(
    { availableBytes: 512 * 1_048_576, platform: "darwin", source: "darwin-vm-stat" },
    1_024 * 1_048_576,
  );
  assert.match(low, /当前可用 512 MiB/u);
  assert.match(low, /门槛 1024 MiB/u);
  assert.match(low, /GROK_REMOTE_MIN_FREE_MEMORY_MB/u);

  const degraded = memoryDegradedMessage({
    availableBytes: 216 * 1_048_576,
    platform: "darwin",
    source: "os-freemem",
    degradedReason: "vm_stat 输出缺少页大小",
  }, 1_024 * 1_048_576);
  assert.match(degraded, /已放行/u);
  assert.match(degraded, /门槛暂不生效/u);
});
