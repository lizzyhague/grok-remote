import { canonicalCommandName, type CommandName } from "../commands/catalog.ts";
import type { SessionView } from "../sessions/types.ts";

export type BrowserSessionView = SessionView;
export type BrowserSessionMutationAction =
  | "archive"
  | "unarchive"
  | "trash-active"
  | "trash-archived"
  | "restore-trash"
  | "delete-trash";

/**
 * WebSocket frame limit. It must be well above the message-body limit, or the ws layer closes
 * oversized messages before the browser can receive a readable error.
 */
export const MAX_BROWSER_MESSAGE_BYTES = 2_097_152;

/** Maximum body size for one message sent to Grok, in UTF-8 bytes. */
export const MAX_MESSAGE_TEXT_BYTES = 1_048_576;

const MAX_MESSAGE_TEXT_LENGTH = 524_288;
const MAX_SESSION_TITLE_LENGTH = 160;

export type BrowserRequest =
  | { type: "projects.list"; requestId: string }
  | {
    type: "sessions.list";
    requestId: string;
    projectId: string;
    cursor: string | null;
    view: BrowserSessionView;
    searchTerm: string | null;
  }
  | {
    type: "sessions.mutate";
    requestId: string;
    projectId: string;
    sessionIds: string[];
    action: BrowserSessionMutationAction;
  }
  | { type: "session.start"; requestId: string; projectId: string }
  | {
    type: "session.resume";
    requestId: string;
    projectId: string;
    sessionId: string;
  }
  | {
    type: "session.mark";
    requestId: string;
    projectId: string;
    sessionId: string;
    marked: boolean;
  }
  | {
    type: "session.rename";
    requestId: string;
    projectId: string;
    sessionId: string;
    title: string;
  }
  | { type: "history.older"; requestId: string }
  | { type: "events.resume"; requestId: string; afterSeq: number }
  | { type: "commands.list"; requestId: string }
  | {
    type: "command.options";
    requestId: string;
    command: CommandName;
  }
  | {
    type: "command.run";
    requestId: string;
    command: CommandName;
    option: string | null;
    argument: string | null;
  }
  | { type: "permissions.always-approve.toggle"; requestId: string }
  | {
    type: "attachment.ticket.create";
    requestId: string;
    originalName: string;
    declaredMime: string;
    expectedSize: number;
  }
  | {
    type: "message.send";
    requestId: string;
    text: string;
    clientMessageId: string;
    attachmentIds: string[];
  }
  | { type: "task.stop"; requestId: string }
  | {
    type: "approval.answer";
    requestId: string;
    approvalId: string;
    decision: "approve_once" | "decline";
    optionId: string | null;
  };

export type BrowserResponse =
  | { type: "response"; requestId: string; ok: true; data: unknown }
  | {
    type: "response";
    requestId: string;
    ok: false;
    error: { code: string; message: string };
  };

export type BrowserProtocolError = {
  type: "error";
  requestId: string | null;
  error: { code: string; message: string };
};

export type BrowserEvent = {
  type: "event";
  event: Record<string, unknown> & { type: string };
};

export type BrowserMessage = BrowserResponse | BrowserProtocolError | BrowserEvent;

export class ProtocolError extends Error {
  readonly code: string;
  readonly requestId: string | null;

  constructor(code: string, message: string, requestId: string | null = null) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.requestId = requestId;
  }
}

export function parseBrowserRequest(source: string): BrowserRequest {
  if (Buffer.byteLength(source, "utf8") > MAX_BROWSER_MESSAGE_BYTES) {
    throw new ProtocolError("message_too_large", "The message is too large. The limit is 2 MiB.");
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new ProtocolError("invalid_json", "The message is not valid JSON.");
  }
  if (!isObject(value)) {
    throw new ProtocolError("invalid_message", "The message must be a JSON object.");
  }

  const requestId = readBoundedString(value.requestId, 128);
  if (!requestId) {
    throw new ProtocolError("invalid_request_id", "The request ID must not be empty.");
  }
  if (typeof value.type !== "string") {
    throw new ProtocolError("invalid_message", "The message is missing a type.", requestId);
  }

  switch (value.type) {
    case "projects.list":
      return { type: "projects.list", requestId };
    case "sessions.list":
      return {
        type: "sessions.list",
        requestId,
        projectId: requireString(value.projectId, "project ID", requestId, 1_024),
        cursor: value.cursor === undefined || value.cursor === null
          ? null
          : requireString(value.cursor, "pagination cursor", requestId, 4_096),
        view: readSessionView(value.view, requestId),
        searchTerm: readOptionalString(value.searchTerm, "search text", requestId, 256),
      };
    case "sessions.mutate":
      return {
        type: "sessions.mutate",
        requestId,
        projectId: requireString(value.projectId, "project ID", requestId, 1_024),
        sessionIds: requireStringArray(value.sessionIds, "session ID", requestId, 1_000, 1_024),
        action: requireSessionMutationAction(value.action, requestId),
      };
    case "session.start":
      return {
        type: "session.start",
        requestId,
        projectId: requireString(value.projectId, "project ID", requestId, 1_024),
      };
    case "session.resume":
      return {
        type: "session.resume",
        requestId,
        projectId: requireString(value.projectId, "project ID", requestId, 1_024),
        sessionId: requireString(value.sessionId, "session ID", requestId, 1_024),
      };
    case "session.mark":
      return {
        type: "session.mark",
        requestId,
        projectId: requireString(value.projectId, "project ID", requestId, 1_024),
        sessionId: requireString(value.sessionId, "session ID", requestId, 1_024),
        marked: requireBoolean(value.marked, "marked", requestId),
      };
    case "session.rename":
      return {
        type: "session.rename",
        requestId,
        projectId: requireString(value.projectId, "project ID", requestId, 1_024),
        sessionId: requireString(value.sessionId, "session ID", requestId, 1_024),
        title: requireSessionTitle(value.title, requestId),
      };
    case "history.older":
      return { type: "history.older", requestId };
    case "events.resume":
      return {
        type: "events.resume",
        requestId,
        afterSeq: requireNonNegativeInt(value.afterSeq, "event sequence number", requestId),
      };
    case "commands.list":
      return { type: "commands.list", requestId };
    case "command.options":
      return {
        type: "command.options",
        requestId,
        command: requireCommand(value.command, requestId),
      };
    case "command.run":
      return {
        type: "command.run",
        requestId,
        command: requireCommand(value.command, requestId),
        option: readOptionalString(value.option, "command option", requestId, 256),
        argument: readOptionalString(value.argument, "command argument", requestId, 2_048),
      };
    case "permissions.always-approve.toggle":
      return { type: "permissions.always-approve.toggle", requestId };
    case "attachment.ticket.create":
      return {
        type: "attachment.ticket.create",
        requestId,
        originalName: requireString(value.originalName, "file name", requestId, 1_024),
        declaredMime: readOptionalString(value.declaredMime, "MIME", requestId, 255) ??
          "application/octet-stream",
        expectedSize: requireNonNegativeInt(value.expectedSize, "file size", requestId),
      };
    case "message.send": {
      const attachmentIds = readOptionalStringArray(
        value.attachmentIds,
        "attachment ID",
        requestId,
        100,
        128,
      );
      return {
        type: "message.send",
        requestId,
        text: requireMessageText(value.text, requestId, attachmentIds.length > 0),
        clientMessageId: requireString(value.clientMessageId, "client message ID", requestId, 128),
        attachmentIds,
      };
    }
    case "task.stop":
      return { type: "task.stop", requestId };
    case "approval.answer": {
      const decision = value.decision;
      if (decision !== "approve_once" && decision !== "decline") {
        throw new ProtocolError("invalid_decision", "The approval decision is not recognized.", requestId);
      }
      return {
        type: "approval.answer",
        requestId,
        approvalId: requireString(value.approvalId, "approval ID", requestId, 256),
        decision,
        optionId: readOptionalString(value.optionId, "option ID", requestId, 256),
      };
    }
    default:
      throw new ProtocolError("unknown_message_type", "This message type is not supported.", requestId);
  }
}

function readSessionView(value: unknown, requestId: string): BrowserSessionView {
  if (value === undefined || value === null) return "active";
  if (value === "active" || value === "archived" || value === "trash") return value;
  throw new ProtocolError("invalid_field", "The session list view is not recognized.", requestId);
}

function requireSessionMutationAction(
  value: unknown,
  requestId: string,
): BrowserSessionMutationAction {
  if (
    value === "archive" || value === "unarchive" ||
    value === "trash-active" || value === "trash-archived" ||
    value === "restore-trash" || value === "delete-trash"
  ) {
    return value;
  }
  throw new ProtocolError("invalid_field", "The session organization action is not recognized.", requestId);
}

function requireCommand(value: unknown, requestId: string): CommandName {
  if (typeof value !== "string") {
    throw new ProtocolError("unknown_command", "This slash command is not supported.", requestId);
  }
  const command = canonicalCommandName(value);
  if (!command) {
    throw new ProtocolError("unknown_command", "This slash command is not supported.", requestId);
  }
  return command;
}

function requireStringArray(
  value: unknown,
  label: string,
  requestId: string,
  maxItems: number,
  maxItemLength: number,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new ProtocolError(
      "invalid_field",
      `${label} list must not be empty and may contain at most ${maxItems} items.`,
      requestId,
    );
  }
  const result = value.map((item) => requireString(item, label, requestId, maxItemLength));
  return [...new Set(result)];
}

function readOptionalStringArray(
  value: unknown,
  label: string,
  requestId: string,
  maxItems: number,
  maxItemLength: number,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ProtocolError(
      "invalid_field",
      `${label} list may contain at most ${maxItems} items.`,
      requestId,
    );
  }
  return [...new Set(value.map((item) =>
    requireString(item, label, requestId, maxItemLength)
  ))];
}

function readOptionalString(
  value: unknown,
  label: string,
  requestId: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireString(value, label, requestId, maxLength);
}

function requireMessageText(
  value: unknown,
  requestId: string,
  allowEmpty = false,
): string {
  const text = allowEmpty && value === ""
    ? ""
    : requireString(value, "message", requestId, MAX_MESSAGE_TEXT_LENGTH);
  if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_TEXT_BYTES) {
    throw new ProtocolError(
      "message_too_large",
      "The message is too long. Split it into multiple messages.",
      requestId,
    );
  }
  return text;
}

function requireSessionTitle(value: unknown, requestId: string): string {
  if (typeof value !== "string") {
    throw new ProtocolError("invalid_field", "The session name must not be empty.", requestId);
  }
  const title = value.trim();
  if (!title) {
    throw new ProtocolError("invalid_field", "The session name must not be empty.", requestId);
  }
  if (title.length > MAX_SESSION_TITLE_LENGTH) {
    throw new ProtocolError("invalid_field", "The session name is too long.", requestId);
  }
  if (/[\r\n]/u.test(title)) {
    throw new ProtocolError("invalid_field", "The session name must not contain line breaks.", requestId);
  }
  return title;
}

function requireBoolean(value: unknown, label: string, requestId: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProtocolError("invalid_field", `${label} must be a boolean.`, requestId);
  }
  return value;
}

function requireNonNegativeInt(value: unknown, label: string, requestId: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ProtocolError("invalid_field", `${label} must be a non-negative integer.`, requestId);
  }
  return value;
}

function requireString(
  value: unknown,
  label: string,
  requestId: string,
  maxLength: number,
): string {
  const result = readBoundedString(value, maxLength);
  if (!result) {
    throw new ProtocolError("invalid_field", `${label} must not be empty or too long.`, requestId);
  }
  return result;
}

function readBoundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
