import { existsSync } from "node:fs";
import { localMachine } from "../config.ts";
import { resolvePath, tildify } from "../paths.ts";
import { isInProgress } from "../run-info.ts";
import type { CommandRunner } from "./exec.ts";
import type { DashRun } from "../dashboard.ts";
import { type Keymap, keyHint } from "./keymap/config.ts";
import type { UiState } from "./state.ts";
import type { Store } from "./store.ts";

// What the dashboard does, for every view: each action runs the CLI's own
// command (`agent-tasks retry <ref>`…), so the CLI stays the only way to
// change anything. Cheap actions (pause, resume) run
// at once and can be undone from their toast; the ones that launch an agent
// ask first. A view passes the selected run or task; this module says why
// an action does not apply when it does not. Only reading needs no command:
// a file in the pager, text to the clipboard.

/** What an action acts on: a run, or a task with no run in hand. */
export type Target = { kind: "run"; run: DashRun } | { kind: "task"; taskId: string };

export interface ActionsOptions {
  store: Store;
  ui: UiState;
  keymap: Keymap;
  exec: CommandRunner;
  /** Hands the terminal to `run` (the renderer suspended) and takes it back; a non-zero exit code waits for a key first. */
  suspend(run: () => Promise<number>): Promise<void>;
  /** Leaves the dashboard (renderer.destroy()). */
  quit(): void;
  /** Runs a program with the terminal (the pager), returning its exit code. */
  spawn?: (argv: string[]) => Promise<number>;
  /** Copies text to the clipboard (OSC 52); false when the terminal can't. */
  copy?: (text: string) => boolean;
  env?: Record<string, string | undefined>;
}

/** A task as the task actions need it. */
export interface TaskRef {
  id: string;
  cwd: string;
  machine: string;
}

export interface Actions {
  attach(target: Target | null): Promise<void>;
  retry(target: Target | null): void;
  runNow(target: Target | null): void;
  togglePause(target: Target | null): Promise<void>;
  /** Closes the session of a run's latest attempt (`session close`), after asking; `handle` is that session's, null when it is not open. */
  closeSession(run: DashRun, handle: string | null): void;
  /** Shows a file in `$PAGER` (less by default), with the terminal handed over as for attach. */
  openInPager(path: string): Promise<void>;
  /** Copies `text` to the clipboard; `what` names it in the toast (`ref`, `summary`). */
  copy(text: string, what: string): void;
  /** Archives a task (`agent-tasks rm`), after asking; `running`: a run of it is in progress (rm leaves it going). */
  archive(taskId: string, running?: boolean): void;
  /** Hands the terminal to a shell in the task's folder; back to the dashboard when it exits. */
  openFolder(task: TaskRef): Promise<void>;
  /** A sticky error toast that says how to dismiss it (for a view's own refusals). */
  error(text: string): void;
  /** Undoes the newest toast that can be undone. */
  undo(): void;
  quit(): void;
  /**
   * Runs an agent-tasks command in the background with a spinner and reloads;
   * gives its exit code, first line and whole output (for `--json`). The
   * caller says how it went (`report`, or a toast of its own).
   */
  background(args: string[], doing: string): Promise<{ code: number; first: string; output: string }>;
  /** The toast that ends a background command: its first line, or the error (which stays until dismissed). */
  report(code: number, first: string, doing: string): void;
}

/** Statuses `retry` accepts (the palette offers only these runs to retry). */
export const RETRYABLE: readonly string[] = ["failed", "timed_out", "missed"];

function taskOf(target: Target): string {
  return target.kind === "run" ? target.run.task_id : target.taskId;
}

export function createActions(opts: ActionsOptions): Actions {
  const { store, ui, exec } = opts;

  /** Errors stay until dismissed: say how. */
  const dismissHint = () => {
    const key = keyHint(opts.keymap, "dismiss");
    return key ? ` · ${key} dismiss` : "";
  };
  const error = (text: string) => ui.toast(`${text}${dismissHint()}`, { error: true });

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
    return { code: result.code, first, output: result.output };
  };

  const report = (code: number, first: string, doing: string, undo?: () => void) => {
    if (code !== 0) return error(`${doing} failed: ${first || `exit code ${code}`}`);
    const key = undo ? keyHint(opts.keymap, "undo") : null;
    return ui.toast(`${first || `${doing}: done`}${key ? ` · ${key} undo` : ""}`, { undo });
  };

  const setPaused = async (taskId: string, pause: boolean, undoable: boolean): Promise<void> => {
    const doing = pause ? `pausing ${taskId}` : `resuming ${taskId}`;
    const { code, first } = await background([pause ? "pause" : "resume", taskId], doing);
    report(code, first, doing, undoable && code === 0 ? () => void setPaused(taskId, !pause, false) : undefined);
  };

  const doQuit = () => opts.quit();

  const spawn =
    opts.spawn ??
    (async (argv: string[]) => {
      const proc = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, ...opts.env } });
      return await proc.exited;
    });

  return {
    background,
    error,
    archive(taskId, running = false) {
      ui.ask({
        title: `Archive ${taskId}?`,
        consequence: `It is not scheduled any more; its run history is kept${running ? ", and the run in progress goes on" : ""}. It can be restored.`,
        onYes: () => void background(["rm", taskId], `archiving ${taskId}`).then(({ code, first }) => report(code, first, `archiving ${taskId}`)),
      });
    },
    async openFolder(task) {
      const ctx = store.ctx();
      if (!ctx) return;
      const here = localMachine(ctx.config.config);
      if (task.machine !== here) {
        error(`${task.id} runs on ${task.machine}: its folder is there, not on ${here}`);
        return;
      }
      const dir = resolvePath(task.cwd, ctx.env, ctx.cwd);
      if (!existsSync(dir)) {
        error(`${tildify(dir, ctx.env)} does not exist`);
        return;
      }
      const shell = opts.env?.SHELL || process.env.SHELL || "/bin/sh";
      // The folder goes as $1 (spaces and quotes in it are safe); the shell gets the terminal, as the pager does.
      // A shell that exits non-zero (its last command failed) is not an error worth a key press.
      await opts.suspend(async () => {
        process.stdout.write(`agent-tasks: ${shell} in ${dir}; exit it to go back to the dashboard.\n`);
        await spawn(["sh", "-c", 'cd "$1" && exec "$2"', "sh", dir, shell]);
        return 0;
      });
    },
    report: (code, first, doing) => void report(code, first, doing),
    async attach(target) {
      if (!target) return;
      if (target.kind !== "run" || !isInProgress(target.run.status)) {
        error("only running or blocked runs have a session to attach to; open the run to read its log");
        return;
      }
      const ref = target.run.ref;
      await opts.suspend(async () => (await exec(["attach", ref], { interactive: true })).code);
    },
    retry(target) {
      if (!target) return;
      if (target.kind !== "run" || !RETRYABLE.includes(target.run.status)) {
        error("only failed, timed-out or missed runs can be retried");
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
      await setPaused(id, !isPaused(id), true);
    },
    closeSession(run, handle) {
      if (handle === null) {
        error("only a run whose session is still open (kept open, or running) has one to close");
        return;
      }
      const doing = `closing the session of ${run.ref}`;
      ui.ask({
        title: `Close the session of ${run.ref}?`,
        consequence: isInProgress(run.status) ? "The agent is still working: closing ends it. The run's status does not change." : `It closes ${handle}; the run's status does not change.`,
        onYes: () => void background(["session", "close", run.ref], doing).then(({ code, first }) => report(code, first, doing)),
      });
    },
    async openInPager(path) {
      const pager = opts.env?.PAGER || process.env.PAGER || "less";
      // $PAGER is the user's own setting and may carry arguments (`less -R`): the shell
      // splits it; the path goes as $1, so spaces or quotes in it are safe.
      await opts.suspend(() => spawn(["sh", "-c", `${pager} "$1"`, "sh", path]));
    },
    copy(text, what) {
      const copied = opts.copy?.(text) ?? false;
      if (copied) ui.toast(`copied the ${what}`);
      else error("this terminal does not take clipboard writes (OSC 52)");
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
