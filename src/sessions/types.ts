export type SessionState = "not_loaded" | "idle" | "active" | "error";

export type SessionView = "active" | "archived" | "trash";

export type SessionSummary = {
  id: string;
  title: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  state: SessionState;
  pending: boolean;
  projectId: string;
  projectName: string;
  marked: boolean;
  deletedAt: number | null;
  purgeAt: number | null;
};

export type SessionPage = {
  sessions: SessionSummary[];
  /** 「最近会话」里跨项目置顶；不算进分页。归档 / 回收站为空数组。 */
  marked: SessionSummary[];
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
    input: string | null;
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
