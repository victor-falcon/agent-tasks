import { AgentTasksError } from "../errors.ts";
import type { Notification, NotifierDeps } from "./types.ts";

// The `system` notifier: a desktop notification with `osascript` on macOS and
// `notify-send` on Linux. Elsewhere, or when the program is missing, it does
// nothing.

/** A one-line string literal for AppleScript (line breaks become spaces). */
export function appleScriptString(text: string): string {
  return `"${text.replace(/\s*[\r\n]+\s*/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The argv that shows `n`, or null when this platform has no notification command. */
export function systemNotifyArgv(n: Notification, deps: Pick<NotifierDeps, "env" | "platform">): string[] | null {
  const find = (name: string) => Bun.which(name, { PATH: deps.env.PATH ?? "" });
  if (deps.platform === "darwin") {
    const osascript = find("osascript");
    if (!osascript) return null;
    const script = `display notification ${appleScriptString(n.message)} with title "agent-tasks" subtitle ${appleScriptString(n.title)}`;
    return [osascript, "-e", script];
  }
  if (deps.platform === "linux") {
    const notifySend = find("notify-send");
    if (!notifySend) return null;
    return [notifySend, "--app-name=agent-tasks", `agent-tasks: ${n.title}`, n.message];
  }
  return null;
}

export function sendSystem(n: Notification, deps: NotifierDeps): void {
  const argv = systemNotifyArgv(n, deps);
  if (!argv) return;
  const result = deps.exec(argv, { env: deps.env, timeoutMs: 10_000 });
  if (result.code !== 0) throw new AgentTasksError("notifier", `${argv[0]} exited with ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
}
