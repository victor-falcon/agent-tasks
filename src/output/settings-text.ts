import type { LauncherConfig, Resolution } from "../config.ts";

// Resolved settings in words, for `show` and the runner's view.

export function formatAgent(agent: Resolution["agent"]): string {
  return [agent.command, ...agent.args].join(" ") + (agent.shell ? " (shell)" : "");
}

/** `herdr`, `herdr (launch, close overridden)`, or `custom (launch, close)`. */
export function formatLauncher(launcher: LauncherConfig): string {
  const commands = Object.keys(launcher).filter((k) => k !== "preset");
  if (launcher.preset === undefined) return `custom (${commands.join(", ") || "no commands"})`;
  return commands.length === 0 ? launcher.preset : `${launcher.preset} (${commands.join(", ")} overridden)`;
}
