import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type GrokSessionRecord = {
  id: string;
  cwd: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  model: string | null;
  reasoningEffort: string | null;
  directory: string;
};

export function resolveGrokHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.GROK_HOME?.trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), ".grok");
}

export function sessionsRoot(grokHome: string): string {
  return path.join(grokHome, "sessions");
}

/**
 * 扫描 Grok 磁盘上属于某个项目 cwd 的会话。不启动 Worker。
 */
export class GrokSessionDisk {
  readonly #root: string;

  constructor(grokHome: string) {
    this.#root = sessionsRoot(grokHome);
  }

  async listForCwd(cwd: string): Promise<GrokSessionRecord[]> {
    let projectPath: string;
    try {
      projectPath = await realpath(cwd);
    } catch {
      return [];
    }

    const groups = await readDirSafe(this.#root);
    const records: GrokSessionRecord[] = [];

    for (const group of groups) {
      if (!group.isDirectory() || group.name.startsWith(".")) continue;
      const groupDir = path.join(this.#root, group.name);
      const groupCwd = await readGroupCwd(groupDir, group.name);
      if (groupCwd && !cwdMatches(groupCwd, projectPath)) {
        continue;
      }

      const entries = await readDirSafe(groupDir);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sessionDir = path.join(groupDir, entry.name);
        const record = await readSessionRecord(sessionDir);
        if (!record) continue;
        if (!cwdMatches(record.cwd, projectPath)) continue;
        records.push(record);
      }
    }

    records.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
    return records;
  }

  async read(sessionId: string): Promise<GrokSessionRecord | null> {
    const directory = await this.findDirectory(sessionId);
    if (!directory) return null;
    return readSessionRecord(directory);
  }

  async findDirectory(sessionId: string): Promise<string | null> {
    const groups = await readDirSafe(this.#root);
    for (const group of groups) {
      if (!group.isDirectory()) continue;
      const sessionDir = path.join(this.#root, group.name, sessionId);
      try {
        const info = await stat(sessionDir);
        if (info.isDirectory()) return sessionDir;
      } catch {
        continue;
      }
    }
    return null;
  }

  async delete(sessionId: string): Promise<boolean> {
    const directory = await this.findDirectory(sessionId);
    if (!directory) return false;
    await rm(directory, { recursive: true, force: true });
    return true;
  }

  async readUpdatesJsonl(sessionId: string): Promise<string> {
    const directory = await this.findDirectory(sessionId);
    if (!directory) return "";
    try {
      return await readFile(path.join(directory, "updates.jsonl"), "utf8");
    } catch {
      return "";
    }
  }
}

export async function readSessionRecord(sessionDir: string): Promise<GrokSessionRecord | null> {
  try {
    const raw = await readFile(path.join(sessionDir, "summary.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return null;
    const info = isObject(parsed.info) ? parsed.info : {};
    const id = typeof info.id === "string"
      ? info.id
      : path.basename(sessionDir);
    const cwd = typeof info.cwd === "string" ? info.cwd : "";
    if (!cwd) return null;
    const title = pickTitle(parsed);
    const preview = typeof parsed.last_turn_summary === "string"
      ? parsed.last_turn_summary
      : typeof parsed.session_summary === "string"
      ? parsed.session_summary
      : "";
    return {
      id,
      cwd,
      title,
      preview,
      createdAt: parseTimestamp(parsed.created_at),
      updatedAt: parseTimestamp(parsed.last_active_at ?? parsed.updated_at ?? parsed.created_at),
      model: typeof parsed.current_model_id === "string" ? parsed.current_model_id : null,
      reasoningEffort: typeof parsed.reasoning_effort === "string" ? parsed.reasoning_effort : null,
      directory: sessionDir,
    };
  } catch {
    return null;
  }
}

async function readGroupCwd(groupDir: string, groupName: string): Promise<string | null> {
  try {
    const marked = await readFile(path.join(groupDir, ".cwd"), "utf8");
    const trimmed = marked.trim();
    if (trimmed) return trimmed;
  } catch {
    // 普通分组目录名就是 URL 编码后的 cwd。
  }
  try {
    return decodeURIComponent(groupName);
  } catch {
    return null;
  }
}

function cwdMatches(sessionCwd: string, projectPath: string): boolean {
  const normalized = path.resolve(sessionCwd);
  return normalized === projectPath;
}

function pickTitle(summary: Record<string, unknown>): string {
  if (typeof summary.custom_title === "string" && summary.custom_title.trim()) {
    return summary.custom_title.trim();
  }
  if (typeof summary.generated_title === "string" && summary.generated_title.trim()) {
    return summary.generated_title.trim();
  }
  if (typeof summary.session_summary === "string" && summary.session_summary.trim()) {
    return summary.session_summary.trim();
  }
  return "未命名会话";
}

function parseTimestamp(value: unknown): number {
  if (typeof value === "string") {
    const millis = Date.parse(value);
    if (Number.isFinite(millis)) return Math.floor(millis / 1_000);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1_000) : Math.floor(value);
  }
  return 0;
}

async function readDirSafe(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
