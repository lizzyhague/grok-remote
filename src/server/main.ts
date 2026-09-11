import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CommandRunner } from "../commands/runner.ts";
import { ProjectCatalog } from "../projects/catalog.ts";
import { GrokSessionDisk, resolveGrokHome } from "../sessions/disk.ts";
import {
  resolveLayoutStatePath,
  SessionLayoutStore,
} from "../sessions/layout-store.ts";
import { SessionService } from "../sessions/service.ts";
import { AttachmentDisplayIndex } from "../sessions/attachment-index.ts";
import { RemoteSessionStore, resolveStateDir } from "../sessions/store.ts";
import { SharedUploadClient } from "../shared-upload/client.ts";
import { resolveSharedUploadSocket } from "../shared-upload/paths.ts";
import { PresenceTracker } from "./presence.ts";
import { ProjectTaskLocks } from "./project-locks.ts";
import { RemoteWebSocketServer } from "./http-server.ts";
import { buildViewableRoots, ensurePreviewRoot } from "./viewable-roots.ts";
import { TurnRuntime } from "../turns/runtime.ts";
import {
  DEFAULT_MAX_WORKERS,
  DEFAULT_MIN_FREE_MEMORY_BYTES,
} from "../worker/process.ts";

const TRASH_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export async function main(): Promise<void> {
  const token = process.env.GROK_REMOTE_TOKEN;
  if (!token || token.length < 32) {
    throw new Error("请设置至少 32 个字符的 GROK_REMOTE_TOKEN。");
  }
  const port = readPort(process.env.GROK_REMOTE_PORT ?? "3000");
  const configPath = process.env.GROK_REMOTE_PROJECTS_CONFIG ??
    path.resolve("config/projects.json");
  const grokBin = process.env.GROK_BIN?.trim() || "grok";
  await assertGrokBin(grokBin);

  const projects = await ProjectCatalog.fromConfigFile(configPath);
  const previewRoot = await ensurePreviewRoot();
  const disk = new GrokSessionDisk(resolveGrokHome());
  const stateDir = resolveStateDir();
  const store = new RemoteSessionStore(stateDir);
  const attachmentIndex = await AttachmentDisplayIndex.open(stateDir);
  const layout = await SessionLayoutStore.open(resolveLayoutStatePath());
  const presence = new PresenceTracker();
  const uploads = new SharedUploadClient(resolveSharedUploadSocket());
  const turns = new TurnRuntime({
    store,
    projects,
    presence,
    grokBin,
    uploads,
    attachmentIndex,
    maxWorkers: readPositiveInt(process.env.GROK_REMOTE_MAX_WORKERS, DEFAULT_MAX_WORKERS),
    minFreeMemoryBytes: readPositiveInt(
      process.env.GROK_REMOTE_MIN_FREE_MEMORY_MB,
      DEFAULT_MIN_FREE_MEMORY_BYTES / 1_048_576,
    ) * 1_048_576,
  });
  const sessions = new SessionService(projects, disk, store, layout, {
    isRunning: (sessionId) => turns.isBusy(sessionId),
    attachmentIndex,
  });
  await sessions.discardUnboundPending();
  await turns.markOrphanedTurnsInterrupted();
  const commands = new CommandRunner(turns, disk, store);
  let cleanupTimer: NodeJS.Timeout | null = null;
  const remote = new RemoteWebSocketServer({
    token,
    fileRoots: buildViewableRoots(projects.fileRoots(), [previewRoot]),
    allowedOrigins: readAllowedOrigins(process.env.GROK_REMOTE_ALLOWED_ORIGINS),
    services: {
      projects,
      sessions,
      turns,
      commands,
      locks: new ProjectTaskLocks(turns),
      presence,
      uploads,
    },
    uploads,
  });

  try {
    await cleanExpiredTrash(sessions);
    cleanupTimer = setInterval(() => {
      void cleanExpiredTrash(sessions);
    }, TRASH_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
    const address = await remote.listen(port);
    console.log(`Grok Remote 正在监听 http://${address.host}:${address.port}/`);
    await waitForShutdownSignal();
  } finally {
    if (cleanupTimer) clearInterval(cleanupTimer);
    await remote.close();
    await turns.dispose();
    presence.dispose();
  }
}

async function cleanExpiredTrash(sessions: SessionService): Promise<void> {
  const result = await sessions.purgeExpired();
  if (result.deleted > 0) {
    console.log(`回收站自动清除了 ${result.deleted} 个过期会话。`);
  }
  for (const failure of result.failed) {
    console.error(`回收站无法清除会话 ${failure.sessionId}：${failure.message}`);
  }
}

async function assertGrokBin(grokBin: string): Promise<void> {
  if (grokBin.includes("/") || grokBin.includes("\\")) {
    try {
      await access(grokBin);
      return;
    } catch {
      throw new Error(`找不到 GROK_BIN：${grokBin}`);
    }
  }
}

function readAllowedOrigins(source: string | undefined): string[] {
  return (source ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readPort(source: string): number {
  const port = Number(source);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("GROK_REMOTE_PORT 必须是 1 到 65535 之间的整数。");
  }
  return port;
}

function readPositiveInt(source: string | undefined, fallback: number): number {
  if (!source) return fallback;
  const value = Number(source);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`数值无效：${source}`);
  }
  return value;
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
