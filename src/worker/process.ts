import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { freemem } from "node:os";

export const DEFAULT_MAX_WORKERS = 2;
export const DEFAULT_MIN_FREE_MEMORY_BYTES = 512 * 1_048_576;
export const WORKER_EXIT_WAIT_MS = 8_000;

export type SpawnedAgent = {
  pid: number;
  process: ChildProcessWithoutNullStreams;
  killGroup: (signal: NodeJS.Signals) => void;
};

export type SpawnAgent = (options: {
  grokBin: string;
  cwd: string;
}) => SpawnedAgent;

export const spawnGrokAgent: SpawnAgent = (options) => {
  const child = spawn(options.grokBin, ["agent", "--no-leader", "stdio"], {
    cwd: options.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  if (child.pid === undefined) {
    throw new Error("无法启动 Grok Worker。");
  }

  return {
    pid: child.pid,
    process: child,
    killGroup: (signal) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // 进程已经不在了。
        }
      }
    },
  };
};

export function assertWorkerCapacity(options: {
  activeWorkers: number;
  maxWorkers: number;
  minFreeMemoryBytes: number;
  freeMemoryBytes?: number;
}): void {
  if (options.activeWorkers >= options.maxWorkers) {
    throw Object.assign(new Error("当前活动的 Grok 会话已达到上限，请等其中一个结束后再试。"), {
      code: "worker_limit",
    });
  }
  const free = options.freeMemoryBytes ?? freemem();
  if (free < options.minFreeMemoryBytes) {
    throw Object.assign(new Error("主机可用内存不足，无法再启动 Grok Worker。"), {
      code: "memory_limit",
    });
  }
}

export async function terminateAgent(
  agent: SpawnedAgent,
  waitMs = WORKER_EXIT_WAIT_MS,
): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (agent.process.exitCode !== null || agent.process.killed) {
      resolve();
      return;
    }
    agent.process.once("exit", () => resolve());
  });

  agent.killGroup("SIGTERM");
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), waitMs).unref();
  });
  const result = await Promise.race([exited.then(() => "exited" as const), timeout]);
  if (result === "timeout") {
    agent.killGroup("SIGKILL");
    await exited;
  }
}
