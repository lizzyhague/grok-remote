import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const VM_STAT_PATH = "/usr/bin/vm_stat";
const VM_STAT_TIMEOUT_MS = 1_000;

export type MemorySource = "linux-meminfo" | "darwin-vm-stat" | "os-freemem";

export type MemoryReading = {
  availableBytes: number;
  platform: NodeJS.Platform;
  source: MemorySource;
  degradedReason?: string;
};

export type AvailableMemoryOptions = {
  platform?: NodeJS.Platform;
  readLinuxMeminfo?: () => Promise<string>;
  readVmStat?: () => Promise<string>;
  readFreeMemory?: () => number;
  readTotalMemory?: () => number;
};

/**
 * Linux 使用 MemAvailable，macOS 使用 vm_stat 估算包含可回收缓存的可用内存。
 * 平台专用读数失败时保留 os.freemem() 作为诊断值，但降级值不能用于拦截 Worker。
 */
export async function readAvailableMemory(
  options: AvailableMemoryOptions = {},
): Promise<MemoryReading> {
  const platform = options.platform ?? process.platform;

  if (platform === "linux") {
    try {
      const source = await (options.readLinuxMeminfo ?? readProcMeminfo)();
      const bytes = parseLinuxAvailableBytes(source);
      if (bytes !== undefined) {
        return { availableBytes: bytes, platform, source: "linux-meminfo" };
      }
      return degraded(platform, "/proc/meminfo 中没有可用的 MemAvailable 数值", options);
    } catch (error) {
      return degraded(platform, `读取 /proc/meminfo 失败（${errorSummary(error)}）`, options);
    }
  }

  if (platform === "darwin") {
    try {
      const source = await (options.readVmStat ?? readVmStat)();
      const parsed = parseDarwinAvailableBytes(source, readTotal(options));
      if (parsed.ok) {
        return { availableBytes: parsed.availableBytes, platform, source: "darwin-vm-stat" };
      }
      return degraded(platform, `vm_stat 输出缺少${parsed.missing}`, options);
    } catch (error) {
      return degraded(platform, `执行 vm_stat 失败（${errorSummary(error)}）`, options);
    }
  }

  return degraded(platform, `没有为 ${platform} 实现专用的内存读数`, options);
}

export function parseLinuxAvailableBytes(meminfo: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/mu.exec(meminfo);
  if (!match?.[1]) return undefined;
  const bytes = Number(match[1]) * 1_024;
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

export type DarwinMemoryParse =
  | { ok: true; availableBytes: number }
  | { ok: false; missing: string };

export function parseDarwinAvailableBytes(vmStat: string, totalBytes: number): DarwinMemoryParse {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    return { ok: false, missing: "可用的物理内存总量" };
  }
  const pageSize = parsePageSize(vmStat);
  if (pageSize === undefined) return { ok: false, missing: "页大小" };

  const fields = [
    { label: "Anonymous pages", name: " Anonymous pages" },
    { label: "Pages wired down", name: " Pages wired down" },
    { label: "Pages occupied by compressor", name: " Pages occupied by compressor" },
  ] as const;
  let occupiedPages = 0;
  for (const field of fields) {
    const pages = parsePageCount(vmStat, field.label);
    if (pages === undefined) return { ok: false, missing: field.name };
    occupiedPages += pages;
  }

  const occupiedBytes = occupiedPages * pageSize;
  if (!Number.isSafeInteger(occupiedBytes)) return { ok: false, missing: "可信的页数" };
  return { ok: true, availableBytes: Math.max(0, totalBytes - occupiedBytes) };
}

export function memoryLowMessage(reading: MemoryReading, minimumBytes: number): string {
  return `主机可用内存不足，无法再启动 Grok Worker。` +
    `当前可用 ${mebibytes(reading.availableBytes)} MiB，门槛 ${mebibytes(minimumBytes)} MiB` +
    `（平台 ${reading.platform}，读数来源 ${sourceLabel(reading.source)}）。` +
    `内存回落后会自动恢复；如果这台主机本来就该在这个水位上工作，` +
    `可以调整 GROK_REMOTE_MIN_FREE_MEMORY_MB。`;
}

export function memoryDegradedMessage(reading: MemoryReading, minimumBytes: number): string {
  return `主机内存读数不可靠，本次 Grok Worker 已放行。` +
    `平台 ${reading.platform} 的专用读数失败：${reading.degradedReason ?? "原因未知"}；` +
    `os.freemem() 读到 ${mebibytes(reading.availableBytes)} MiB，但它不包含可回收缓存，` +
    `因此 ${mebibytes(minimumBytes)} MiB 的门槛暂不生效。`;
}

function degraded(
  platform: NodeJS.Platform,
  reason: string,
  options: AvailableMemoryOptions,
): MemoryReading {
  const free = (options.readFreeMemory ?? freemem)();
  const availableBytes = Number.isSafeInteger(free) && free >= 0 ? free : 0;
  return { availableBytes, platform, source: "os-freemem", degradedReason: reason };
}

function readTotal(options: AvailableMemoryOptions): number {
  const total = (options.readTotalMemory ?? totalmem)();
  return Number.isSafeInteger(total) && total > 0 ? total : 0;
}

function readProcMeminfo(): Promise<string> {
  return readFile("/proc/meminfo", "utf8");
}

async function readVmStat(): Promise<string> {
  const { stdout } = await execFileAsync(VM_STAT_PATH, { timeout: VM_STAT_TIMEOUT_MS });
  return stdout;
}

function parsePageSize(vmStat: string): number | undefined {
  const match = /page size of (\d+) bytes/u.exec(vmStat);
  if (!match?.[1]) return undefined;
  const size = Number(match[1]);
  return Number.isSafeInteger(size) && size > 0 ? size : undefined;
}

function parsePageCount(vmStat: string, label: string): number | undefined {
  const match = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, "mu").exec(vmStat);
  if (!match?.[1]) return undefined;
  const pages = Number(match[1]);
  return Number.isSafeInteger(pages) && pages >= 0 ? pages : undefined;
}

function sourceLabel(source: MemorySource): string {
  if (source === "linux-meminfo") return "/proc/meminfo 的 MemAvailable";
  if (source === "darwin-vm-stat") return "vm_stat";
  return "os.freemem()";
}

function mebibytes(bytes: number): number {
  return Math.round(bytes / 1_048_576);
}

function errorSummary(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
