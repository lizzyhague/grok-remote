export const COMMAND_NAMES = [
  "always-approve",
  "compact",
  "context",
  "effort",
  "model",
  "plan",
  "rename",
  "rewind",
  "session-info",
] as const;

export type CommandName = typeof COMMAND_NAMES[number];

export type CommandDescriptor = {
  name: CommandName;
  title: string;
  description: string;
  action: "confirm" | "options" | "immediate" | "argument";
  confirmation?: string;
};

export const COMMAND_CATALOG: readonly CommandDescriptor[] = [
  {
    name: "always-approve",
    title: "always-approve",
    description: "Turn always-approve on or off. When enabled, approvable tools no longer prompt.",
    action: "immediate",
  },
  {
    name: "compact",
    title: "Compact session",
    description: "Summarize earlier conversation to free context space.",
    action: "confirm",
    confirmation: "Compaction summarizes earlier conversation to free context space. Start now?",
  },
  {
    name: "context",
    title: "View context",
    description: "Show context usage for the current session.",
    action: "immediate",
  },
  {
    name: "effort",
    title: "Reasoning effort",
    description: "Change reasoning effort for the current model without switching models.",
    action: "options",
  },
  {
    name: "model",
    title: "Switch model",
    description: "Choose the model to use for subsequent turns in this session.",
    action: "options",
  },
  {
    name: "plan",
    title: "Plan mode",
    description: "Enter plan mode; a question may follow the command.",
    action: "immediate",
  },
  {
    name: "rename",
    title: "Rename session",
    description: "Give the current session an easy-to-find name.",
    action: "argument",
  },
  {
    name: "rewind",
    title: "Rewind one turn",
    description: "Remove the latest turn from conversation context without undoing file changes.",
    action: "confirm",
    confirmation: "Rewinding removes the latest turn from this session but does not undo its file changes. Continue?",
  },
  {
    name: "session-info",
    title: "View status",
    description: "Show the current model, session, and context usage. You can also enter /status.",
    action: "immediate",
  },
];

export function canonicalCommandName(value: string): CommandName | null {
  if (value === "status") return "session-info";
  return (COMMAND_NAMES as readonly string[]).includes(value) ? value as CommandName : null;
}

export function isCommandName(value: string): boolean {
  return canonicalCommandName(value) !== null;
}
