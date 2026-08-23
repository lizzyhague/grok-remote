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
    description: "打开或关闭 always-approve。打开后可授权的工具不再询问。",
    action: "immediate",
  },
  {
    name: "compact",
    title: "压缩会话",
    description: "把较早的对话整理成摘要，腾出上下文空间。",
    action: "confirm",
    confirmation: "压缩会把较早的对话整理成摘要，以腾出上下文空间。现在开始吗？",
  },
  {
    name: "context",
    title: "查看上下文",
    description: "显示当前会话的上下文占用情况。",
    action: "immediate",
  },
  {
    name: "effort",
    title: "思考强度",
    description: "只改当前模型的 reasoning effort，不换模型。",
    action: "options",
  },
  {
    name: "model",
    title: "切换模型",
    description: "选择当前会话后续使用的模型。",
    action: "options",
  },
  {
    name: "plan",
    title: "计划模式",
    description: "进入计划模式；后面也可以直接跟问题。",
    action: "immediate",
  },
  {
    name: "rename",
    title: "重命名会话",
    description: "给当前会话起一个容易找到的名字。",
    action: "argument",
  },
  {
    name: "rewind",
    title: "回退一轮",
    description: "从对话上下文移除最近一轮；不会撤销文件改动。",
    action: "confirm",
    confirmation: "回退会从当前会话移除最近一轮对话，但不会撤销这一轮已经造成的文件改动。确定继续吗？",
  },
  {
    name: "session-info",
    title: "查看状态",
    description: "显示当前模型、会话和上下文用量。也可输入 /status。",
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
