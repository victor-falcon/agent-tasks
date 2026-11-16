import { AgentTasksError } from "../errors.ts";
import { shellLine } from "../launcher.ts";
import { render, type Vars } from "../template.ts";
import type { CommandNotifierConfig, Notification, NotifierDeps } from "./types.ts";

// The `command` notifier: any command, with the notification in template
// variables. An argv array is run as is; a string runs with `/bin/sh -c`
// (use `{{message_quoted}}` and friends there).

export function notificationVars(n: Notification): Vars {
  return {
    values: {
      event: n.event,
      task_id: n.task_ids.join(","),
      title: n.title,
      run_ref: n.run_refs.join(","),
      message: n.message,
      count: String(Math.max(n.run_refs.length, 1)),
    },
  };
}

export function commandNotifyArgv(config: CommandNotifierConfig, n: Notification): string[] {
  const vars = notificationVars(n);
  const where = "the command notifier's `run`";
  if (typeof config.run === "string") return ["/bin/sh", "-c", render(config.run, vars, where)];
  return config.run.map((arg) => render(arg, vars, where));
}

export function sendCommand(config: CommandNotifierConfig, n: Notification, deps: NotifierDeps): void {
  const argv = commandNotifyArgv(config, n);
  const result = deps.exec(argv, { env: deps.env, timeoutMs: 30_000 });
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-3).join(" | ");
    throw new AgentTasksError("notifier", `${shellLine(argv)} exited with ${result.code}${detail ? `: ${detail}` : ""}`);
  }
}
