import { join } from "node:path";
import type { AppHandle, AppOptions } from "./main.tsx";

// The dashboard is Solid JSX, which Bun only runs through Solid's transform
// plugin. bunfig.toml's preload is not read when bin/agent-tasks runs from
// another folder (through ~/.local/bin), so the plugin is registered here,
// from this checkout's node_modules, right before the UI is imported: only
// commands that show it pay for it.

export type { AppHandle, AppOptions };

/** Whether this process can show the dashboard: stdout and stdin are a terminal. */
export function canShowDashboard(stdout: { isTTY?: boolean }): boolean {
  return stdout.isTTY === true && process.stdin.isTTY === true;
}

/** Opens the dashboard on this process's terminal; `stop()` on the result gives the terminal back (await `closed`). */
export async function startDashboard(opts: AppOptions): Promise<AppHandle> {
  const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
  ensureSolidTransformPlugin();
  const { startApp } = (await import(join(import.meta.dir, "main.tsx"))) as typeof import("./main.tsx");
  return await startApp(opts);
}

/**
 * Why the dashboard did not start, for the terminal. The likely cause after
 * an update is a `git pull` without `bun install` (OpenTUI missing or at
 * another version), so the message says how to check.
 */
export function dashboardFailed(err: unknown): string {
  return `the dashboard could not start (${err instanceof Error ? err.message : String(err)}); if agent-tasks was just updated, run bun install in its checkout (agent-tasks doctor checks it)`;
}
