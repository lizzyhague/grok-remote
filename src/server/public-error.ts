/**
 * 发给浏览器的错误文字。本仓库自己写的提示会原样保留，但操作系统抛出的
 * 错误常常带着主机上的绝对路径，那些只应该留在服务端日志里。
 */
export function publicErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "请求失败。";
  }
  if (isSystemError(error)) {
    console.error(`未向浏览器透传的系统错误：${error.message}`);
    return "服务器无法访问本地文件，请查看服务日志。";
  }
  return redactPaths(error.message);
}

function isSystemError(error: Error): boolean {
  const candidate = error as NodeJS.ErrnoException;
  return typeof candidate.code === "string" && typeof candidate.syscall === "string";
}

function redactPaths(message: string): string {
  return message.replace(/(?:\/[\w.@+-]+){2,}\/?/g, "<路径>");
}
