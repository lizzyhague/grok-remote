import type { AttachmentDisplayMapping } from "../attachments/path-redaction.ts";
import { redactKnownAttachmentPaths } from "../attachments/path-redaction.ts";
import {
  parsePrivateAttachmentPaths,
  stripPrivateAttachmentPaths,
} from "../attachments/private-paths.ts";
import {
  MAX_STORED_COMMAND_OUTPUT,
  type TimelineItem,
  type TurnSnapshot,
  type TurnStatus,
} from "./types.ts";
import {
  createPublicToolView,
  exposesToolText,
  updatePublicToolView,
  type PublicToolKind,
} from "../turns/tool-view.ts";

type JsonObject = Record<string, unknown>;

export type ParseUpdatesOptions = {
  /**
   * Last prompt index on Grok's active branch. -1 means no user turn; undefined means rewind-point
   * data is unreliable, so only duplicate-index removal applies.
   */
  activePromptIndex?: number | undefined;
  mappings?: readonly AttachmentDisplayMapping[];
  attachmentRecords?: Array<{
    messageId: string;
    attachments: AttachmentDisplayMapping[];
  }>;
};

/**
 * rewind_points.jsonl follows Grok's active branch while updates.jsonl is append-only. Undefined means
 * the file is missing or unreliable, so callers retain compatibility fallback behavior.
 */
export function parseActivePromptIndex(source: string | null): number | undefined {
  if (source === null) return undefined;
  if (!source.trim()) return -1;

  let latest: number | undefined;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;
    const promptIndex = nonNegativeInteger(parsed.prompt_index) ??
      nonNegativeInteger(parsed.promptIndex);
    if (promptIndex === null) continue;
    latest = latest === undefined ? promptIndex : Math.max(latest, promptIndex);
  }
  return latest;
}

/**
 * Convert Grok's updates.jsonl into a browser timeline. Thinking content and ACP internals stay server-side.
 */
export function parseUpdatesJsonl(
  source: string,
  options: ParseUpdatesOptions = {},
): TurnSnapshot[] {
  const turns: MutableTurn[] = [];
  const unindexedTurns = new Map<string, MutableTurn>();
  let fallback = 0;
  let indexedOccurrence = 0;
  let currentIndexedTurn: MutableTurn | null = null;
  let currentIndexedTurnAcceptsUserChunks = false;

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;
    const method = parsed.method;
    if (method !== "session/update" && method !== "_x.ai/session/update") continue;
    const params = isObject(parsed.params) ? parsed.params : {};
    const update = isObject(params.update) ? params.update : {};
    const meta = {
      ...asObject(parsed._meta),
      ...asObject(params._meta),
      ...asObject(update._meta),
    };
    const kind = stringField(update.sessionUpdate);
    const promptId = stringField(meta.promptId) ??
      stringField(meta.prompt_id) ??
      stringField(update.prompt_id);
    const promptIndex = nonNegativeInteger(meta.promptIndex) ??
      nonNegativeInteger(meta.prompt_index) ??
      nonNegativeInteger(update.promptIndex) ??
      nonNegativeInteger(update.prompt_index);

    let turn: MutableTurn;
    if (kind === "user_message_chunk" && promptIndex !== null) {
      if (
        !currentIndexedTurn ||
        currentIndexedTurn.promptIndex !== promptIndex ||
        !currentIndexedTurnAcceptsUserChunks
      ) {
        turn = createTurn(
          promptId ?? `prompt-${promptIndex}-${indexedOccurrence}`,
          promptIndex,
        );
        indexedOccurrence += 1;
        turns.push(turn);
        currentIndexedTurn = turn;
      } else {
        turn = currentIndexedTurn;
      }
      currentIndexedTurnAcceptsUserChunks = true;
    } else if (kind === "user_message_chunk") {
      currentIndexedTurn = null;
      currentIndexedTurnAcceptsUserChunks = false;
      const key = promptId ?? `anon-${fallback++}`;
      turn = unindexedTurns.get(key) ?? createTurn(key, null);
      if (!unindexedTurns.has(key)) {
        unindexedTurns.set(key, turn);
        turns.push(turn);
      }
    } else if (currentIndexedTurn) {
      turn = currentIndexedTurn;
      currentIndexedTurnAcceptsUserChunks = false;
      if (promptId) turn.id = promptId;
    } else {
      const key = promptId ?? `anon-${fallback++}`;
      turn = unindexedTurns.get(key) ?? createTurn(key, null);
      if (!unindexedTurns.has(key)) {
        unindexedTurns.set(key, turn);
        turns.push(turn);
      }
    }
    applyUpdate(turn, update, meta, options.mappings ?? []);
  }

  const latestByPromptIndex = new Map<number, MutableTurn>();
  for (const turn of turns) {
    if (turn.promptIndex === null) continue;
    if (
      options.activePromptIndex !== undefined &&
      turn.promptIndex > options.activePromptIndex
    ) {
      continue;
    }
    latestByPromptIndex.set(turn.promptIndex, turn);
  }

  return turns
    .filter((turn) => {
      if (turn.promptIndex === null) return true;
      if (
        options.activePromptIndex !== undefined &&
        turn.promptIndex > options.activePromptIndex
      ) {
        return false;
      }
      return latestByPromptIndex.get(turn.promptIndex) === turn;
    })
    .map((turn) => freezeTurn(turn, options));
}

type MutableTurn = {
  id: string;
  promptIndex: number | null;
  status: TurnStatus;
  error: string | null;
  items: TimelineItem[];
  messages: Map<string, { role: "user" | "assistant"; text: string; item: Extract<TimelineItem, { type: "message" }> }>;
  commands: Map<string, Extract<TimelineItem, { type: "command" }>>;
  breakAssistantMessage: boolean;
};

function createTurn(id: string, promptIndex: number | null): MutableTurn {
  return {
    id,
    promptIndex,
    status: "completed",
    error: null,
    items: [],
    messages: new Map(),
    commands: new Map(),
    breakAssistantMessage: false,
  };
}

function applyUpdate(
  turn: MutableTurn,
  update: JsonObject,
  meta: JsonObject,
  mappings: readonly AttachmentDisplayMapping[],
): void {
  const kind = stringField(update.sessionUpdate);
  if (kind === "user_message_chunk") {
    appendMessage(turn, "user", textFromContent(update.content), stringField(update.messageId));
    return;
  }
  if (kind === "agent_message_chunk") {
    appendMessage(turn, "assistant", textFromContent(update.content), stringField(update.messageId));
    return;
  }
  if (kind === "agent_thought_chunk") {
    // Thinking is omitted from history but starts a new assistant work phase, so the next visible reply
    // needs a new bubble to match the live event stream.
    turn.breakAssistantMessage = true;
    return;
  }
  if (kind === "tool_call") {
    const id = stringField(update.toolCallId) ?? `tool-${turn.commands.size}`;
    const tool = createPublicToolView(update, mappings);
    if (tool.kind === "think") {
      turn.breakAssistantMessage = true;
      return;
    }
    const command: Extract<TimelineItem, { type: "command" }> = {
      type: "command",
      id,
      title: tool.title,
      kind: tool.kind,
      status: stringField(update.status) ?? "pending",
      input: exposesToolText(tool.kind) ? clipStoredText(tool.input) : null,
      output: null,
      outputTruncated: false,
    };
    turn.commands.set(id, command);
    turn.items.push(command);
    return;
  }
  if (kind === "tool_call_update") {
    const id = stringField(update.toolCallId);
    if (!id) return;
    const command = turn.commands.get(id);
    if (!command) return;
    if (typeof update.status === "string") command.status = update.status;
    const tool = updatePublicToolView({
      kind: command.kind as PublicToolKind,
      title: command.title,
      input: command.input,
      query: null,
      resources: [],
    }, update, mappings);
    command.kind = tool.kind;
    command.title = tool.title;
    if (exposesToolText(tool.kind) && tool.input) command.input = clipStoredText(tool.input);
    const output = toolOutputText(update.content);
    if (output && exposesToolText(tool.kind)) {
      const combined = `${command.output ?? ""}${output}`;
      if (combined.length > MAX_STORED_COMMAND_OUTPUT) {
        command.output = combined.slice(-MAX_STORED_COMMAND_OUTPUT);
        command.outputTruncated = true;
      } else {
        command.output = combined;
      }
    }
    if (looksLikeFileChange(update, command)) {
      replaceWithFileChange(turn, command);
    }
    return;
  }
  if (kind === "turn_completed") {
    const stop = stringField(update.stop_reason) ?? stringField(update.stopReason);
    if (stop === "cancelled") {
      turn.status = "interrupted";
      turn.error = "This turn was cancelled.";
    } else if (stop && stop !== "end_turn") {
      turn.status = "failed";
      turn.error = stop;
    } else {
      turn.status = "completed";
    }
    return;
  }
  if (kind === "session_info" || kind === "usage_update") {
    return;
  }
}

function appendMessage(
  turn: MutableTurn,
  role: "user" | "assistant",
  text: string,
  messageId: string | null,
): void {
  if (!text) return;
  // Merge consecutive text from one role into the current bubble; start a new segment after a tool.
  const last = turn.items.at(-1);
  if (
    last?.type === "message" &&
    last.role === role &&
    !(role === "assistant" && turn.breakAssistantMessage)
  ) {
    last.text += text;
    const tracked = turn.messages.get(last.id);
    if (tracked) {
      tracked.text = last.text;
      tracked.item.text = last.text;
    }
    return;
  }
  let id = messageId ?? `${role}-${turn.messages.size}`;
  if (turn.messages.has(id)) {
    id = `${id}-${turn.messages.size}`;
  }
  const item: Extract<TimelineItem, { type: "message" }> = {
    type: "message",
    id,
    role,
    text,
  };
  turn.messages.set(id, { role, text, item });
  turn.items.push(item);
  if (role === "assistant") turn.breakAssistantMessage = false;
}

function freezeTurn(turn: MutableTurn, options: ParseUpdatesOptions): TurnSnapshot {
  const items: TimelineItem[] = [];
  for (const item of turn.items) {
    if (item.type === "message") {
      if (item.role === "user") {
        const records = parsePrivateAttachmentPaths(item.text);
        if (records.length > 0) {
          options.attachmentRecords?.push({
            messageId: item.id,
            attachments: records.map((record) => ({
              id: record.id,
              originalName: record.originalName,
              path: record.path,
            })),
          });
        }
        item.text = stripPrivateAttachmentPaths(item.text);
      }
      if (!item.text && item.role === "user") continue;
      items.push(item);
      continue;
    }
    if (item.type === "note") items.push(item);
  }
  const snapshot = {
    id: turn.id,
    status: turn.status,
    error: turn.error,
    items,
  };
  return redactHistoryTurn(snapshot, options.mappings ?? []);
}

export function redactHistoryTurns(
  turns: TurnSnapshot[],
  mappings: readonly AttachmentDisplayMapping[],
): TurnSnapshot[] {
  if (mappings.length === 0) return turns;
  return turns.map((turn) => redactHistoryTurn(turn, mappings));
}

function redactHistoryTurn(
  turn: TurnSnapshot,
  mappings: readonly AttachmentDisplayMapping[],
): TurnSnapshot {
  if (mappings.length === 0) return turn;
  return {
    ...turn,
    error: turn.error ? redactKnownAttachmentPaths(turn.error, mappings) : null,
    items: turn.items.map((item) => {
      if (item.type === "message" || item.type === "note") {
        return { ...item, text: redactKnownAttachmentPaths(item.text, mappings) };
      }
      return item;
    }),
  };
}

function clipStoredText(text: string | null): string | null {
  if (!text) return null;
  if (text.length <= MAX_STORED_COMMAND_OUTPUT) return text;
  return text.slice(-MAX_STORED_COMMAND_OUTPUT);
}


function looksLikeFileChange(
  update: JsonObject,
  command: Extract<TimelineItem, { type: "command" }>,
): boolean {
  if (command.kind === "edit" || command.kind === "delete" || command.kind === "move") {
    return true;
  }
  return Array.isArray(update.content) &&
    update.content.some((entry) => isObject(entry) && entry.type === "diff");
}

function replaceWithFileChange(
  turn: MutableTurn,
  command: Extract<TimelineItem, { type: "command" }>,
): void {
  const index = turn.items.indexOf(command);
  if (index < 0) return;
  const changed: Extract<TimelineItem, { type: "file_change" }> = {
    type: "file_change",
    id: command.id,
    status: command.status,
    changedFiles: 1,
  };
  turn.items[index] = changed;
  turn.commands.delete(command.id);
}

function toolOutputText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (!isObject(entry)) continue;
    if (entry.type === "content" && isObject(entry.content)) {
      const text = textFromContent(entry.content);
      if (text) parts.push(text);
    }
  }
  return parts.join("");
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (isObject(content) && content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function asObject(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
