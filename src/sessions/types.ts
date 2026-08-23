export type SessionState = "not_loaded" | "idle" | "active" | "error";

export type SessionSummary = {
  id: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  state: SessionState;
  pending: boolean;
};

export type SessionPage = {
  sessions: SessionSummary[];
  nextCursor: string | null;
};

export type TimelineItem =
  | {
    type: "message";
    id: string;
    role: "user" | "assistant";
    text: string;
  }
  | {
    type: "command";
    id: string;
    title: string;
    kind: string;
    status: string;
    output: string | null;
    outputTruncated: boolean;
  }
  | {
    type: "file_change";
    id: string;
    status: string;
    changedFiles: number;
  }
  | {
    type: "note";
    id: string;
    text: string;
  };

export type TurnStatus =
  | "queued"
  | "running"
  | "waiting_for_permission"
  | "completed"
  | "interrupted"
  | "failed";

export type TurnSnapshot = {
  id: string;
  status: TurnStatus;
  error: string | null;
  items: TimelineItem[];
};

export type PermissionMode = "ask" | "always-approve";

export const HISTORY_PAGE_SIZE = 20;
export const MAX_STORED_COMMAND_OUTPUT = 100_000;
export const PENDING_SESSION_PREFIX = "pending-";
