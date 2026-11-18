import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Run, Task } from "../src/schema.ts";
import { parseRunRef } from "../src/slot.ts";
import { makeTask, makeTempHome, runCli, type TempHome } from "./helpers.ts";

export const REPO = resolve(import.meta.dir, "..");
export const FAKE_AGENT = join(REPO, "test", "fixtures", "fake-agent.ts");
export const FAKE_BIN = join(REPO, "test", "fixtures", "bin");

/** The scheduled time used by most tests, and helpers to move the clock from it. */
export const T0 = "2026-11-17T09:00:00+01:00";
export function at(minutesAfterT0: number): string {
  return new Date(Date.parse(T0) + minutesAfterT0 * 60_000).toISOString();
}

export interface ExecHome extends TempHome {
  project: string;
  hcDir: string;
  tick(minutes: number): Promise<{ events: any[]; errors: string[] }>;
  cli(...args: string[]): ReturnType<typeof runCli>;
  run(ref: string): Run;
  hcCalls(): string[][];
  /** State folder of a fake multiplexer CLI in test/fixtures/bin (`hc`, `tmux`, `rex`). */
  fakeDir(tool: FakeTool): string;
  /** Every call that fake received, as argv. */
  fakeCalls(tool: FakeTool): string[][];
}

export type FakeTool = "hc" | "tmux" | "rex";

/**
 * A temp home where `agent-tasks` (the repo's bin) and the fake `hc`, `tmux` and `rex` are on
 * PATH, the shell is /bin/sh and tasks run in a temp project folder.
 */
export function makeExecHome(): ExecHome {
  const home = makeTempHome();
  const project = join(home.root, "project");
  const fakeDir = (tool: FakeTool) => join(home.root, tool);
  const hcDir = fakeDir("hc");
  mkdirSync(project, { recursive: true });
  for (const tool of ["hc", "tmux", "rex"] as const) mkdirSync(fakeDir(tool), { recursive: true });
  Object.assign(home.env, {
    // With ~/.local/bin, as in a terminal: launchEnv leaves the PATH as it is
    // (no login shell, whose profile differs between machines).
    PATH: [join(REPO, "bin"), FAKE_BIN, dirname(process.execPath), join(home.env.HOME!, ".local", "bin"), process.env.PATH].join(":"),
    SHELL: "/bin/sh",
    FAKE_HC_DIR: hcDir,
    FAKE_TMUX_DIR: fakeDir("tmux"),
    FAKE_REX_DIR: fakeDir("rex"),
  });
  const fakeCalls = (tool: FakeTool) => {
    const file = join(fakeDir(tool), "calls.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };
  const cli = (...args: string[]) => runCli(args, home, project);
  return {
    ...home,
    project,
    hcDir,
    cli,
    async tick(minutes) {
      const result = await cli("tick", "--json", "--now", at(minutes));
      if (result.code !== 0) throw new Error(`tick failed: ${result.stdout}${result.stderr}`);
      return result.json();
    },
    run(ref) {
      const { taskId, slot } = parseRunRef(ref);
      return JSON.parse(readFileSync(join(home.paths.runsDir, taskId, `${slot}.json`), "utf8"));
    },
    hcCalls: () => fakeCalls("hc"),
    fakeDir,
    fakeCalls,
  };
}

/** A one-off task due at T0 in the temp project, for the fake agent. */
export function execTask(home: ExecHome, mode: string, overrides: Partial<Task> = {}): Task {
  const task = makeTask({
    id: "demo",
    title: "Demo task",
    cwd: home.project,
    instructions: `Do the demo.\nMODE: ${mode}`,
    schedule: { type: "once", at: T0 },
    ...overrides,
  });
  home.writeTask(task);
  return task;
}

export const DEMO_REF = "demo/20261117T080000Z";

/**
 * A `waitFor` check: the run once attempt `n` has ended AND its session is
 * settled. `finish` writes the result first and settles the session (keeps it
 * open, or records `closed` and runs `close`) in a later write, so waiting for
 * `finished_at` alone races with the rest of `finish`. A close that fails
 * replaces `closed` with `close_failed` afterwards; tests of that wait for it.
 */
export function settled(home: ExecHome, ref = DEMO_REF, n = 1): () => Run | null {
  return () => {
    const run = home.run(ref);
    const attempt = run.attempts[n - 1];
    if (!attempt?.finished_at) return null;
    if (!attempt.session || attempt.session.kept_open) return run;
    return run.events.some((e) => e.attempt === n && (e.event === "closed" || e.event === "close_failed" || e.event === "session_gone")) ? run : null;
  };
}

/** Waits for a real child process (not for the clock). */
export async function waitFor<T>(check: () => T | null | undefined | false, what: string, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
