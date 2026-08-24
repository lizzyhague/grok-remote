export type PublicToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type PublicToolResource = {
  address: string;
  label: string | null;
};

export type PublicToolView = {
  kind: PublicToolKind;
  title: string;
  input: string | null;
  query: string | null;
  resources: PublicToolResource[];
};

const ADDRESS_KEYS = new Set([
  "file_path",
  "filename",
  "href",
  "output_file",
  "path",
  "resource_uri",
  "target_directory",
  "target_file",
  "uri",
  "url",
]);
const QUERY_KEYS = new Set(["keyword", "keywords", "pattern", "query"]);
const MAX_RESOURCES = 50;
const MAX_ADDRESS_LENGTH = 2_048;
const MAX_INPUT_LENGTH = 100_000;
const MAX_QUERY_LENGTH = 4_096;

export function createPublicToolView(update: Record<string, unknown>): PublicToolView {
  const kind = inferPublicToolKind(update) ?? "other";
  return {
    kind,
    title: toolTitle(update) ?? kind,
    input: exposesToolText(kind) ? publicToolInput(update) : null,
    query: toolQuery(update),
    resources: toolResources(update, kind),
  };
}

export function updatePublicToolView(
  current: PublicToolView,
  update: Record<string, unknown>,
): PublicToolView {
  const kind = inferPublicToolKind(update) ?? current.kind;
  return {
    kind,
    title: toolTitle(update) ?? current.title,
    input: exposesToolText(kind) ? publicToolInput(update) ?? current.input : null,
    query: toolQuery(update) ?? current.query,
    resources: mergeResources(current.resources, toolResources(update, kind)),
  };
}

export function publicToolInput(update: Record<string, unknown>): string | null {
  const raw = update.rawInput;
  if (typeof raw === "string" && raw.trim()) return clipInput(raw);
  if (!isObject(raw)) return null;
  if (typeof raw.command === "string" && raw.command.trim()) return clipInput(raw.command);
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "variant" || value == null) continue;
    fields[key] = value;
  }
  const keys = Object.keys(fields);
  if (keys.length === 0) return null;
  if (keys.length === 1 && typeof fields[keys[0]!] === "string") {
    return clipInput(String(fields[keys[0]!]));
  }
  return clipInput(JSON.stringify(fields, null, 2));
}

export function exposesToolText(kind: PublicToolKind): boolean {
  return kind === "execute" || kind === "other";
}

function inferPublicToolKind(update: Record<string, unknown>): PublicToolKind | null {
  const tool = toolMeta(update);
  const rawKind = stringField(update.kind) ?? stringField(tool.kind);
  const name = stringField(tool.name);
  const direct = normalizeKind(rawKind);
  if (direct) return direct;
  return normalizeToolName(name);
}

function normalizeKind(kind: string | null): PublicToolKind | null {
  if (!kind) return null;
  if (
    kind === "read" || kind === "edit" || kind === "delete" || kind === "move" ||
    kind === "search" || kind === "execute" || kind === "think" || kind === "fetch" ||
    kind === "switch_mode" || kind === "other"
  ) {
    return kind;
  }
  if (kind === "list") return "read";
  if (kind === "write") return "edit";
  if (kind === "plan") return "think";
  if (kind === "web_fetch") return "fetch";
  return null;
}

function normalizeToolName(name: string | null): PublicToolKind | null {
  if (!name) return null;
  if (name === "read_file" || name === "list_dir") return "read";
  if (name === "search_replace" || name === "write") return "edit";
  if (name === "run_terminal_command") return "execute";
  if (name === "grep") return "search";
  if (name === "web_fetch") return "fetch";
  if (name === "todo_write") return "think";
  if (name === "switch_mode") return "switch_mode";
  return null;
}

function toolTitle(update: Record<string, unknown>): string | null {
  const direct = stringField(update.title);
  if (direct) return direct;
  const tool = toolMeta(update);
  return stringField(tool.label) ?? stringField(tool.name);
}

function toolQuery(update: Record<string, unknown>): string | null {
  const query = findNamedString(update.rawInput, QUERY_KEYS) ??
    findNamedString(update.rawOutput, QUERY_KEYS);
  return query ? query.slice(0, MAX_QUERY_LENGTH) : null;
}

function toolResources(
  update: Record<string, unknown>,
  kind: PublicToolKind,
): PublicToolResource[] {
  if (kind !== "search" && kind !== "fetch") return [];
  const resources: PublicToolResource[] = [];
  if (kind === "fetch") collectResources(update.rawInput, resources);
  collectResources(update.rawOutput, resources);
  collectResources(update.locations, resources);
  collectResources(update.content, resources);
  return mergeResources([], resources);
}

function findNamedString(value: unknown, names: Set<string>, depth = 0): string | null {
  if (depth > 8) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNamedString(entry, names, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isObject(value)) return null;
  for (const [key, entry] of Object.entries(value)) {
    if (names.has(key.toLowerCase())) {
      if (typeof entry === "string" && entry.trim()) return entry.trim();
      if (Array.isArray(entry)) {
        const joined = entry.filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
          .join(", ");
        if (joined) return joined;
      }
    }
  }
  for (const entry of Object.values(value)) {
    const found = findNamedString(entry, names, depth + 1);
    if (found) return found;
  }
  return null;
}

function collectResources(
  value: unknown,
  resources: PublicToolResource[],
  depth = 0,
): void {
  if (depth > 8 || resources.length >= MAX_RESOURCES) return;
  if (Array.isArray(value)) {
    for (const entry of value) collectResources(entry, resources, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  const label = stringField(value.title) ?? stringField(value.label) ?? stringField(value.name);
  for (const [key, entry] of Object.entries(value)) {
    if (!ADDRESS_KEYS.has(key.toLowerCase())) continue;
    if (typeof entry === "string") addResource(resources, entry, label);
    if (Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item === "string") addResource(resources, item, label);
      }
    }
  }
  for (const entry of Object.values(value)) collectResources(entry, resources, depth + 1);
}

function addResource(
  resources: PublicToolResource[],
  address: string,
  label: string | null,
): void {
  const clean = address.trim();
  if (!clean || clean.length > MAX_ADDRESS_LENGTH || /[\u0000-\u001f\u007f]/.test(clean)) return;
  const cleanLabel = label?.replace(/\s+/g, " ").trim().slice(0, 256) || null;
  resources.push({ address: clean, label: cleanLabel });
}

function mergeResources(
  first: PublicToolResource[],
  second: PublicToolResource[],
): PublicToolResource[] {
  const merged = new Map<string, PublicToolResource>();
  for (const resource of [...first, ...second]) {
    const existing = merged.get(resource.address);
    if (!existing || (!existing.label && resource.label)) merged.set(resource.address, resource);
    if (merged.size >= MAX_RESOURCES) break;
  }
  return [...merged.values()];
}

function toolMeta(update: Record<string, unknown>): Record<string, unknown> {
  const meta = asObject(update._meta);
  return asObject(meta["x.ai/tool"]);
}

function asObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clipInput(value: string): string {
  return value.length <= MAX_INPUT_LENGTH ? value : value.slice(0, MAX_INPUT_LENGTH);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
