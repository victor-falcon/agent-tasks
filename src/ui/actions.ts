import { isInProgress } from "../run-info.ts";
import type { CommandRunner } from "../tui/app.ts";
import type { DashRun } from "../tui/snapshot.ts";
import { type Keymap, keyHint } from "./keymap/config.ts";
import type { UiState } from "./state.ts";
import type { Store } from "./store.ts";

// What the dashboard does, for every view: each action runs the CLI's own
// command (`agent-tasks retry <ref>`…), like the old dashboard, so the CLI
// stays the only way to change anything. Cheap actions (pause, resume) run
// at once and can be undone from their toast; the ones that launch an agent
// ask first. A view passes the selected run or task; this module says why
// an action does not apply when it does not.

/** What an action acts on: a run, or a task with no run in hand. */
export type Target = { kind: "run"; run: DashRun } | { kind: "task"; taskId: string; paused: boolean };

export interface ActionsOptions {
  store: Store;
  ui: UiState;
  keymap: Keymap;
  exec: CommandRunner;
  /** Hands the terminal to `run` (the renderer suspended) and takes it back; a non-zero exit code waits for a key first. */
  suspend(run: () => Promise<number>): Promise<void>;
  /** Leaves the dashboard (renderer.destroy()). */
  quit(): void;
}

export interface Actions {
  attach(target: Target | null): Promise<void>;
  retry(target: Target | null): void;
  runNow(target: Target | null): void;
  togglePause(target: Target | null): Promise<void>;
  /** Undoes the newest toast that can be undone. */
  undo(): void;
  quit(): void;
  /** Runs an agent-tasks command in the background with a spinner, then a toast with its first line. */
  background(args: string[], doing: string): Promise<{ code: number; first: string }>;
}

const RETRYABLE = ["failed", "timed_out", "missed"];

function taskOf(target: Target): string {
  return target.kind === "run" ? target.run.task_id : target.taskId;
}

export function createActions(opts: ActionsOptions): Actions {
  const { store, ui, exec } = opts;

  const isPaused = (taskId: string) => store.dash()?.next.some((n) => n.task_id === taskId && n.state === "paused") ?? false;

  const background = async (args: string[], doing: string) => {
    const busy = ui.startBusy(`${doing}…`);
    let result: { code: number; output: string };
    try {
      result = await exec(args, { interactive: false });
    } catch (err) {
      result = { code: 1, output: (err as Error).message };
    } finally {
      ui.endBusy(busy);
    }
    const first = result.output.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
    store.reload();
    return { code: result.code, first };
  };

  const report = (code: number, first: string, doing: string, undo?: () => void) => {
    if (code !== 0) return ui.toast(`${doing} failed: ${first || `exit code ${code}`}`, { error: true });
    const key = undo ? keyHint(opts.keymap, "undo") : null;
    return ui.toast(`${first || `${doing}: done`}${key ? ` · ${key} undo` : ""}`, { undo });
  };

  const setPaused = async (taskId: string, pause: boolean, undoable: boolean): Promise<void> => {
    const doing = pause ? `pausing ${taskId}` : `resuming ${taskId}`;
    const { code, first } = await background([pause ? "pause" : "resume", taskId], doing);
    report(code, first, doing, undoable && code === 0 ? () => void setPaused(taskId, !pause, false) : undefined);
  };

  const doQuit = () => opts.quit();

  return {
    background,
    async attach(target) {
      if (!target) return;
      if (target.kind !== "run" || !isInProgress(target.run.status)) {
        ui.toast("only running or blocked runs have a session to attach to; open the run to read its log", { error: true });
        return;
      }
      const ref = target.run.ref;
      await opts.suspend(async () => (await exec(["attach", ref], { interactive: true })).code);
    },
    retry(target) {
      if (!target) return;
      if (target.kind !== "run" || !RETRYABLE.includes(target.run.status)) {
        ui.toast("only failed, timed-out or missed runs can be retried", { error: true });
        return;
      }
      const ref = target.run.ref;
      ui.ask({
        title: `Retry ${ref}?`,
        consequence: "It launches a new agent now.",
        onYes: () => void background(["retry", ref], `retrying ${ref}`).then(({ code, first }) => report(code, first, `retrying ${ref}`)),
      });
    },
    runNow(target) {
      if (!target) return;
      const id = taskOf(target);
      ui.ask({
        title: `Run ${id} now?`,
        consequence: "It launches a new agent outside its schedule.",
        onYes: () => void background(["run", id], `starting ${id}`).then(({ code, first }) => report(code, first, `starting ${id}`)),
      });
    },
    async togglePause(target) {
      if (!target) return;
      const id = taskOf(target);
      const paused = target.kind === "task" ? target.paused : isPaused(id);
      await setPaused(id, !paused, true);
    },
    undo() {
      const toast = [...ui.toasts()].reverse().find((t) => t.undo);
      if (!toast) return;
      ui.dismiss(toast.id);
      toast.undo!();
    },
    quit() {
      if (ui.busy().length === 0) return doQuit();
      ui.ask({ title: "Quit?", consequence: "A command is still running; it goes on without the dashboard.", onYes: doQuit });
    },
  };
}
