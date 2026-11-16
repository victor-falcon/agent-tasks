import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commands } from "../src/commands/index.ts";
import { createContext } from "../src/context.ts";
import { abortableSleep, followRun, newLines } from "../src/follow.ts";
import { createStyle } from "../src/output/style.ts";
import { at, DEMO_REF, type ExecHome, execTask, FAKE_AGENT, makeExecHome, settled, waitFor } from "./exec-helpers.ts";

// `attach` and `log --follow`, with the process preset (a real child process)
// and the herdr preset against the fake `hc` in test/fixtures/.

setDefaultTimeout(30_000);

let home: ExecHome;
afterEach(() => home?.cleanup());

const LOG = () => join(home.dataDir, "runs/demo/20261117T080000Z.log");
const finish = (status: string, minutes = 10) => home.cli("finish", DEMO_REF, "--status", status, "--summary", "all done", "--now", at(minutes));

/** Calls followRun in-process with a sleep that runs `steps` (one per poll) instead of waiting. */
async function follow(steps: Array<() => Promise<unknown> | unknown>, opts: { raw?: boolean; signal?: AbortSignal; shown?: string } = {}) {
  let out = "";
  let err = "";
  const ctx = createContext({ now: new Date(at(5)), json: false, env: home.env, cwd: home.project, stdout: { write: (t) => void (out += t) }, stderr: { write: (t) => void (err += t) }, commands });
  const sleeps: number[] = [];
  let i = 0;
  const result = await followRun(ctx, DEMO_REF, {
    shown: opts.shown ?? "",
    raw: opts.raw,
    signal: opts.signal,
    style: createStyle(false),
    intervalMs: 50,
    sleep: async (ms) => {
      sleeps.push(ms);
      const step = steps[i++];
      if (!step) throw new Error("followRun polled more times than expected");
      await step();
    },
  });
  return { out, err, result, sleeps };
}

describe("newLines", () => {
  test("skips what overlaps with the lines already shown", () => {
    expect(newLines(["a", "b", "c"], ["b", "c", "d", "e"])).toEqual(["d", "e"]);
    expect(newLines(["a", "b"], ["a", "b"])).toEqual([]);
    expect(newLines([], ["x"])).toEqual(["x"]);
    expect(newLines(["a", "b"], ["x", "y"])).toEqual(["x", "y"]);
  });

  test("a screen redrawn in place prints only the lines that changed", () => {
    expect(newLines(["header", "⠋ working", "footer"], ["header", "⠙ working", "footer"], ["header", "⠋ working", "footer"])).toEqual(["⠙ working"]);
  });
});

describe("abortableSleep", () => {
  test("resolves as soon as the signal is aborted", async () => {
    const controller = new AbortController();
    const sleeping = abortableSleep(controller.signal)(60_000);
    controller.abort();
    await sleeping;
    await abortableSleep(controller.signal)(60_000);
  });
});

describe("process preset", () => {
  beforeEach(() => {
    home = makeExecHome();
    home.writeConfig({ timezone: "Europe/Madrid", agent: { command: "bun", args: [FAKE_AGENT] } });
  });

  async function launchHanging() {
    execTask(home, "hang");
    await home.tick(1);
    await waitFor(() => (readFileSync(LOG(), "utf8").includes("prompt:") ? true : null), "the agent's first output");
  }

  test("log --follow streams new lines and stops at the final status", async () => {
    await launchHanging();
    const shown = readFileSync(LOG(), "utf8");
    const { out, result, sleeps } = await follow(
      [
        () => {},
        () => appendFileSync(LOG(), "step 1\n"),
        () => appendFileSync(LOG(), "step 2\nstep 3\n"),
        async () => {
          appendFileSync(LOG(), "last words\n");
          await finish("succeeded");
        },
      ],
      { shown },
    );
    expect(result.finished).toBe(true);
    expect(result.run.status).toBe("succeeded");
    expect(sleeps).toEqual([50, 50, 50, 50]);
    expect(out).toBe(`step 1\nstep 2\nstep 3\nlast words\n\n■ ok  ${DEMO_REF} · all done\n`);
  });

  test("--raw follow prints only the output", async () => {
    await launchHanging();
    const { out } = await follow([() => appendFileSync(LOG(), "more\n"), () => finish("failed")], { raw: true, shown: readFileSync(LOG(), "utf8") });
    expect(out).toBe("more\n");
  });

  test("an aborted follow (Ctrl+C) stops without the final line", async () => {
    await launchHanging();
    const controller = new AbortController();
    const { out, result } = await follow([() => appendFileSync(LOG(), "x\n"), () => controller.abort()], { signal: controller.signal, shown: readFileSync(LOG(), "utf8") });
    expect(result).toMatchObject({ finished: false, run: { status: "running" } });
    expect(out).toBe("x\n");
    await finish("succeeded");
  });

  test("log --follow on a finished run is the same as log", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    await waitFor(settled(home), "the run to finish and close");
    const plain = await home.cli("log", DEMO_REF, "--now", at(5));
    const followed = await home.cli("log", DEMO_REF, "--follow", "--now", at(5));
    expect(followed.code).toBe(0);
    expect(followed.stdout).toBe(plain.stdout);
    const json = await home.cli("log", "demo", "--follow", "--json", "--now", at(5));
    expect(json.json()).toMatchObject({ ref: DEMO_REF, run: { status: "succeeded" } });
  });

  test("--follow can't be combined with --attempt while the run is in progress", async () => {
    await launchHanging();
    const result = await home.cli("log", DEMO_REF, "--follow", "--attempt", "1");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("can't be combined with --attempt");
    await finish("succeeded");
    expect((await home.cli("log", DEMO_REF, "--follow", "--attempt", "1")).code).toBe(0);
  });

  test("attach without an attach command points at session read", async () => {
    await launchHanging();
    const result = await home.cli("attach", "demo");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`the process launcher has no attach command; read the session's screen with "agent-tasks session read ${DEMO_REF}"`);
    await finish("succeeded");
  });

  test("attach hands over to an overridden attach command and returns its exit code", async () => {
    home.writeConfig({ timezone: "Europe/Madrid", agent: { command: "bun", args: [FAKE_AGENT] }, launcher: { preset: "process", attach: ["sh", "-c", "echo attached to $0; exit 7", "{{handle}}"] } });
    await launchHanging();
    const result = await home.cli("attach", DEMO_REF, "--json");
    expect(result.code).toBe(7);
    expect(result.json()).toMatchObject({ run_ref: DEMO_REF, launcher: "process", exit_code: 7, command: ["sh", "-c", expect.any(String), home.run(DEMO_REF).attempts[0]!.session!.handle] });
    await finish("succeeded");
  });

  test("attach to a finished run says the session is gone and suggests log", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    await waitFor(() => (home.run(DEMO_REF).attempts[0]?.session?.closed_at ? true : null), "the session to close");
    const byRef = await home.cli("attach", DEMO_REF);
    expect(byRef.code).toBe(1);
    expect(byRef.stderr).toContain(`the session of ${DEMO_REF} was closed (succeeded); see its output with "agent-tasks log ${DEMO_REF}"`);
    const byTask = await home.cli("attach", "demo", "--json");
    expect(byTask.json()).toMatchObject({ error: { code: "not_found", message: expect.stringContaining(`has no running or blocked run (latest: ${DEMO_REF}, succeeded)`) } });
  });

  test("attach errors for unknown runs and tasks", async () => {
    execTask(home, "succeed");
    expect((await home.cli("attach", "demo")).stderr).toContain('task "demo" has no runs yet');
    expect((await home.cli("attach", "nope")).stderr).toContain('task "nope" not found');
    expect((await home.cli("attach", "demo/20261117T080000Z")).code).toBe(1);
  });
});

describe("herdr preset (fake hc)", () => {
  beforeEach(() => {
    home = makeExecHome();
    home.env.HC_TERMINAL_ID = "t1";
    home.writeConfig({ timezone: "Europe/Madrid", launcher: { preset: "herdr" }, agent: { command: "clc" } });
  });
  const screen = (text: string) => writeFileSync(join(home.hcDir, "screen-t2"), text);

  test("attach runs hc attach on the session and returns its exit code", async () => {
    execTask(home, "hang");
    await home.tick(1);
    writeFileSync(join(home.hcDir, "attach-exit"), "3");
    const result = await home.cli("attach", "demo");
    expect(result.code).toBe(3);
    expect(home.hcCalls().filter((c) => c[0] === "attach")).toEqual([["attach", "t2"]]);
  });

  test("attach to a terminal that is gone suggests log", async () => {
    execTask(home, "hang");
    await home.tick(1);
    await home.cli("session", "close", DEMO_REF);
    const result = await home.cli("attach", DEMO_REF);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`the session of ${DEMO_REF} was closed (running); see its output with "agent-tasks log ${DEMO_REF}"`);
    expect(home.hcCalls().filter((c) => c[0] === "attach")).toEqual([]);
  });

  test("attach to a terminal whose agent exited says so", async () => {
    execTask(home, "hang");
    await home.tick(1);
    const file = join(home.hcDir, "terminals", "t2.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), state: "finished", exit_code: 0 }));
    const result = await home.cli("attach", "demo", "--json");
    expect(result.code).toBe(1);
    expect(result.json()).toMatchObject({ error: { code: "session_gone", message: `the session of ${DEMO_REF} is exited (running); see its output with "agent-tasks log ${DEMO_REF}"` } });
  });

  test("log --follow says once when the session can't be read, and keeps waiting", async () => {
    execTask(home, "hang");
    await home.tick(1);
    writeFileSync(join(home.hcDir, "fail-read"), "");
    const { out, err } = await follow([() => {}, () => {}, () => {}, () => {}, () => finish("failed")]);
    expect(err).toBe(`agent-tasks: the session of ${DEMO_REF} can't be read right now; waiting for the run to finish\n`);
    expect(out).toBe(`\n✕ failed  ${DEMO_REF} · all done\n`);
  });

  test("log --follow diffs the screen from hc read", async () => {
    execTask(home, "hang");
    await home.tick(1);
    screen("line 1\nline 2\n");
    const { out, result } = await follow([
      () => {},
      () => screen("line 2\nline 3\n"),
      () => screen("line 2\nline 3\n"),
      () => screen("line 3\nline 4\n"),
      () => finish("succeeded"),
    ]);
    expect(result.run.status).toBe("succeeded");
    // The last poll can't read the killed terminal and uses the screen captured into the log.
    expect(out).toBe(`line 1\nline 2\nline 3\nline 4\n\n■ ok  ${DEMO_REF} · all done\n`);
  });
});
