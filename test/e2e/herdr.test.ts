import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Run } from "../../src/schema.ts";

// End to end in a real Herdr, with no LLM: a runner in a new tab of the
// current space, two one-off tasks run by test/e2e/herdr-agent.sh through the
// herdr preset. Opt-in, because it opens real tabs and waits for real time:
//
//   AGENT_TASKS_E2E_HERDR=1 bun test test/e2e
//
// Run it from a terminal inside Herdr ($HC_TERMINAL_ID set, `hc` and
// `herdr-app` on PATH). Config and data live in a temp folder; everything it
// starts (the runner's terminal, the task tabs) is killed at the end.

const ENABLED = process.env.AGENT_TASKS_E2E_HERDR === "1";
const REPO = resolve(import.meta.dir, "..", "..");
const AGENT = join(import.meta.dir, "herdr-agent.sh");
const EVERY = "10s";
/** How far ahead the tasks are scheduled. */
const DUE_IN_MS = 60_000;
const WAIT_MS = 3 * 60_000;

interface HcTerminal {
  address: string;
  state: "live" | "finished";
  labels: Record<string, string>;
}

interface AppTab {
  id: string;
  terminals: { terminal: string }[];
}

function exec(argv: string[], env: Record<string, string | undefined> = process.env): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(argv, { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function execOk(argv: string[], env?: Record<string, string | undefined>): string {
  const r = exec(argv, env);
  if (r.code !== 0) throw new Error(`${argv.join(" ")} exited ${r.code}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** The terminal, or null once Herdr has forgotten it. */
function hcGet(address: string): HcTerminal | null {
  const r = exec(["hc", "get", address, "--json"]);
  return r.code === 0 ? (JSON.parse(r.stdout) as HcTerminal) : null;
}

function appTabs(): AppTab[] {
  const ls = JSON.parse(execOk(["herdr-app", "ls"])) as { spaces: { tabs: AppTab[] }[] };
  return ls.spaces.flatMap((s) => s.tabs);
}

const tabOf = (address: string) => appTabs().find((t) => t.terminals.some((x) => x.terminal === address)) ?? null;
const tabExists = (id: string) => appTabs().some((t) => t.id === id);

/** The last lines of a terminal, to explain a timeout. */
function screenOf(address: string): string {
  return exec(["hc", "read", "--lines", "40", address]).stdout.trim();
}

async function waitFor<T>(check: () => T | null | undefined | false, what: string, timeoutMs = WAIT_MS, explain?: () => string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${explain ? `\n${explain()}` : ""}`);
    await Bun.sleep(500);
  }
}

describe.skipIf(!ENABLED)("Herdr end to end (real Herdr, real time)", () => {
  let root: string;
  let project: string;
  let env: Record<string, string | undefined>;
  let space: string;
  let runner: string;
  let runnerTab: string;
  const started = new Set<string>();

  const cli = (...args: string[]) => execOk([join(REPO, "bin", "agent-tasks"), ...args], env);
  /** The task's only run file (`runs/<id>/<slot>.json`), as its slot id. */
  const slotOf = (taskId: string): string | null => {
    const dir = join(root, "data", "runs", taskId);
    const file = existsSync(dir) ? readdirSync(dir).find((f) => /^\d{8}T\d{6}Z\.json$/.test(f)) : undefined;
    return file ? file.replace(/\.json$/, "") : null;
  };
  const runOf = (taskId: string): Run | null => {
    const slot = slotOf(taskId);
    return slot ? (JSON.parse(readFileSync(join(root, "data", "runs", taskId, `${slot}.json`), "utf8")) as Run) : null;
  };
  /** The handle of the task's first session, once the runner has launched it. */
  const sessionOf = (taskId: string) => {
    const handle = runOf(taskId)?.attempts[0]?.session?.handle;
    if (handle) started.add(handle);
    return handle ?? null;
  };
  const refOf = (taskId: string) => `${taskId}/${slotOf(taskId)}`;

  beforeAll(async () => {
    const self = process.env.HC_TERMINAL_ID;
    if (!self) throw new Error("run this inside a Herdr terminal ($HC_TERMINAL_ID is not set)");
    space = hcGet(self)?.labels["herdr.space"] ?? "";
    if (!space) throw new Error(`terminal ${self} has no herdr.space label`);

    root = mkdtempSync(join(tmpdir(), "agent-tasks-e2e-"));
    project = join(root, "project");
    mkdirSync(project, { recursive: true });
    chmodSync(AGENT, 0o755);
    const configFile = join(root, "config", "config.json");
    mkdirSync(dirname(configFile), { recursive: true });
    writeFileSync(
      configFile,
      JSON.stringify({
        timezone: "UTC",
        launcher: { preset: "herdr" },
        agent: { command: AGENT },
        notifiers: [],
        defaults: { keep_open: "on_failure", timeout: "10m" },
      }),
    );
    const path = [join(REPO, "bin"), dirname(process.execPath), process.env.PATH].join(":");
    // /bin/sh as the tabs' shell: no user profile, so the test is the same on every machine.
    env = { ...process.env, PATH: path, SHELL: "/bin/sh", AGENT_TASKS_HOME: join(root, "data"), AGENT_TASKS_CONFIG: configFile };

    runnerTab = `tb${randomBytes(16).toString("hex")}`;
    const launched = execOk([
      "hc", "run", "--bg", "--json", "--no-parent", "--no-notify",
      "--name", "agent-tasks-e2e-runner", "--cwd", root,
      "--label", `herdr.space=${space}`, "--label", `herdr.tab=${runnerTab}`,
      "--", "/usr/bin/env", `PATH=${path}`, "SHELL=/bin/sh",
      `AGENT_TASKS_HOME=${env.AGENT_TASKS_HOME}`, `AGENT_TASKS_CONFIG=${configFile}`,
      "agent-tasks", "runner", "--every", EVERY,
    ]);
    runner = (JSON.parse(launched) as { address: string }).address;
    started.add(runner);
    await waitFor(() => exec([join(REPO, "bin", "agent-tasks"), "runner", "status"], env).code === 0, "the runner to start", 30_000);
  }, 60_000);

  afterAll(() => {
    for (const address of started) exec(["hc", "kill", address]);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test(
    "a succeeded run nests under the runner in its own tab and closes it; a failed one stays open",
    async () => {
      const due = new Date(Date.now() + DUE_IN_MS).toISOString();
      for (const [id, result] of [["e2e-ok", "succeeded"], ["e2e-fail", "failed"]] as const) {
        cli("add", "--id", id, "--title", `e2e ${result}`, "--cwd", project, "--at", due, "--instructions", `End to end test.\nE2E_RESULT: ${result}`);
      }

      // Both launched: each in its own tab of the runner's space, nested under the runner.
      const ok = await waitFor(() => sessionOf("e2e-ok"), "e2e-ok to launch");
      const fail = await waitFor(() => sessionOf("e2e-fail"), "e2e-fail to launch");
      for (const address of [ok, fail]) {
        const terminal = hcGet(address)!;
        expect(terminal.state).toBe("live");
        expect(terminal.labels["herdr.parent"]).toBe(runner);
        expect(terminal.labels["herdr.space"]).toBe(space);
        expect(terminal.labels["herdr.tab"]).not.toBe(runnerTab);
        const tab = await waitFor(() => tabOf(address), `the tab of ${address}`, 15_000);
        expect(tab.id).toBe(terminal.labels["herdr.tab"]!);
        expect(tab.terminals.map((t) => t.terminal)).toEqual([address]);
      }
      const okTab = hcGet(ok)!.labels["herdr.tab"]!;
      const failTab = hcGet(fail)!.labels["herdr.tab"]!;

      // Let both agents finish.
      for (const id of ["e2e-ok", "e2e-fail"]) writeFileSync(join(project, `release-${id}`), "");

      const okRun = await waitFor(() => {
        const run = runOf("e2e-ok");
        return run?.events.some((e) => e.event === "closed") ? run : null;
      }, "e2e-ok to finish and close", 60_000, () => `e2e-ok run: ${JSON.stringify(runOf("e2e-ok"), null, 2)}\nits screen:\n${screenOf(ok)}`);
      expect(okRun.status).toBe("succeeded");
      expect(okRun.attempts[0]!.summary).toBe("e2e agent finished as succeeded");
      await waitFor(() => hcGet(ok)?.state !== "live" && !tabExists(okTab), "e2e-ok's tab to close", 15_000);

      const failRun = await waitFor(() => {
        const run = runOf("e2e-fail");
        return run?.attempts[0]?.session?.kept_open ? run : null;
      }, "e2e-fail to finish", 60_000, () => `e2e-fail run: ${JSON.stringify(runOf("e2e-fail"), null, 2)}\nits screen:\n${screenOf(fail)}`);
      expect(failRun.status).toBe("failed");
      // keep_open: on_failure — the agent's tab is still there.
      await Bun.sleep(2_000);
      expect(hcGet(fail)?.state).toBe("live");
      expect(tabExists(failTab)).toBe(true);

      // The runner's screen shows the launches and both results (next tick).
      const failRef = refOf("e2e-fail");
      const screen = await waitFor(() => {
        const text = exec(["hc", "read", "--lines", "200", runner]).stdout;
        return text.includes(`■ ${refOf("e2e-ok")}`) && text.includes(`✕ ${failRef}`) ? text : null;
      }, "the results on the runner's screen", 60_000);
      expect(screen).toContain(`▶ ${refOf("e2e-ok")}`);
      expect(screen).toContain(`▶ ${failRef}`);

      // Closing the kept session by hand removes its tab.
      cli("session", "close", failRef);
      await waitFor(() => hcGet(fail)?.state !== "live" && !tabExists(failTab), "e2e-fail's tab to close", 15_000);
    },
    WAIT_MS + 3 * 60_000,
  );
});
