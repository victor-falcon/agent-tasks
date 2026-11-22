import { join } from "node:path";
import type { AppHandle, AppOptions } from "./main.tsx";

// The new dashboard is Solid JSX, which Bun only runs through Solid's
// transform plugin. bunfig.toml's preload is not read when bin/agent-tasks
// runs from another folder (through ~/.local/bin), so the plugin is
// registered here, from this checkout's node_modules, right before the UI is
// imported: only commands that show it pay for it.

export type { AppHandle, AppOptions };

export async function startNewDashboard(opts: AppOptions): Promise<AppHandle> {
  const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin");
  ensureSolidTransformPlugin();
  const { startApp } = (await import(join(import.meta.dir, "main.tsx"))) as typeof import("./main.tsx");
  return await startApp(opts);
}
