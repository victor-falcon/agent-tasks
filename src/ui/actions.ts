import { isInProgress } from "../run-info.ts";
import { readRunByRef } from "../store.ts";
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

export interface Actions {
  attach(target: Target | null): Promise<void>;
  retry(target: Target | null): void;
  runNow(target: Target | null): void;
  togglePause(target: Target | null): Promise<void>;
  /** Closes the session of a run's latest attempt (`session close`), after asking; only while it is open. */
  closeSession(target: Target | null): void;
  /** Shows a file in `$PAGER` (less by default), with the terminal handed over as for attach. */
  openInPager(path: string): Promise<void>;
  /** Copies `text` to the clipboard; `what` names it in the toast (`ref`, `summary`). */
  copy(text: string, what: string): void;
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
    return { code: result.code, first };
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

  /** The session of the run's latest attempt, while it is open (read now: the snapshot does not carry it). */
  const openSession = (ref: string) => {
    const ctx = store.ctx();
    if (!ctx) return null;
    try {
      const session = readRunByRef(ctx.paths, ref).attempts.at(-1)?.session;
      return session && !session.closed_at ? session : null;
    } catch {
      return null;
    }
  };

  const spawn =
    opts.spawn ??
    (async (argv: string[]) => {
      const proc = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, ...opts.env } });
      return await proc.exited;
    });

  return {
    background,
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
    closeSession(target) {
      if (!target) return;
      const run = target.kind === "run" ? target.run : null;
      const session = run ? openSession(run.ref) : null;
      if (!run || !session) {
        error("only a run whose session is still open (kept open, or running) has one to close");
        return;
      }
      const doing = `closing the session of ${run.ref}`;
      ui.ask({
        title: `Close the session of ${run.ref}?`,
        consequence: isInProgress(run.status) ? "The agent is still working: closing ends it. The run's status does not change." : `It closes ${session.handle}; the run's status does not change.`,
        onYes: () => void background(["session", "close", run.ref], doing).then(({ code, first }) => report(code, first, doing)),
      });
    },
    async openInPager(path) {
      const pager = opts.env?.PAGER || process.env.PAGER || "less";
      // $PAGER may carry its own arguments (`less -R`): let the shell split it.
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
