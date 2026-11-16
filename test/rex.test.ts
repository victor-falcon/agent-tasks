import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { at, DEMO_REF, type ExecHome, execTask, makeExecHome } from "./exec-helpers.ts";

// The rex preset end to end against a fake `rex` (test/fixtures/fake-rex.ts)
// that records its calls and serves blocks from files. Rex itself is not
// tested: the fake follows the rex CLI calls of the delegate skill's helper.

setDefaultTimeout(30_000);

let home: ExecHome;
beforeEach(() => {
  home = makeExecHome();
  home.env.REX_SESSION = "s-test";
  home.writeConfig({ timezone: "Europe/Madrid", launcher: { preset: "rex" }, agent: { command: "clc" } });
});
afterEach(() => home.cleanup());

const calls = (...prefix: string[]) => home.fakeCalls("rex").filter((c) => prefix.every((p, i) => c[i] === p));
const blockFile = (b: string) => join(home.fakeDir("rex"), "blocks", `${b}.json`);
const block = (b: string) => JSON.parse(readFileSync(blockFile(b), "utf8"));
const setState = (b: string, state: string | null) => writeFileSync(blockFile(b), JSON.stringify({ ...block(b), state }));
const finish = (status: string) => home.cli("finish", DEMO_REF, "--status", status, "--summary", "done", "--now", at(10), "--json");

describe("rex preset (fake rex)", () => {
  test("launch opens a window in the runner's session and types the agent command", async () => {
    execTask(home, "succeed");
    const { events } = await home.tick(1);
    expect(events).toEqual([expect.objectContaining({ type: "launched", handle: "b1" })]);

    expect(calls("window", "new")[0]!.slice(0, 10)).toEqual(["window", "new", "-s", "s-test", "task-demo-20261117t080000z", "-c", home.project, "--focus=false", "--json", "--"]);
    expect(block("b1")).toMatchObject({
      session: "s-test",
      argv: [
        "/usr/bin/env",
        `PATH=${home.env.PATH}`,
        `AGENT_TASKS_HOME=${home.dataDir}`,
        `AGENT_TASKS_CONFIG=${home.configFile}`,
        `AGENT_TASKS_RUN=${DEMO_REF}`,
        "AGENT_TASKS_ATTEMPT=1",
        "/bin/sh",
        "-i",
      ],
      typed: [` clc '/run-agent-task ${DEMO_REF}'; exit`, "<enter>"],
    });
    expect(home.run(DEMO_REF).attempts[0]!.session).toMatchObject({ launcher: "rex", handle: "b1", closed_at: null });
  });

  test("program_status drives the state: nothing reported is working, blocked blocks, done is idle", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    const state = async () => (await home.cli("session", "status", DEMO_REF, "--json")).json().state;
    expect(await state()).toBe("working");
    setState("b1", "blocked");
    expect((await home.tick(2)).events).toEqual([expect.objectContaining({ type: "blocked" })]);
    setState("b1", "working");
    await home.tick(3);
    expect(home.run(DEMO_REF).status).toBe("running");
    setState("b1", "done");
    expect(await state()).toBe("idle");
    expect(calls("block", "call")[0]).toEqual(["block", "call", "-s", "s-test", "-b", "b1", "program_status"]);
  });

  test("finish captures the screen into the log and closes the block's window", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    expect((await finish("succeeded")).json()).toMatchObject({ status: "succeeded", session: { closed_at: expect.any(String) } });
    expect(calls("capture")).toEqual([["capture", "-s", "s-test", "-b", "b1", "--trim", "--unwrap"]]);
    expect(calls("window", "close")).toEqual([["window", "close", "-s", "s-test", "w1"]]);
    expect(readFileSync(join(home.dataDir, "runs/demo/20261117T080000Z.log"), "utf8")).toContain("screen of b1\n");
  });

  test("a block that disappeared without finish is failed / exited_without_report", async () => {
    execTask(home, "succeed");
    await home.tick(1);
    await home.cli("session", "close", DEMO_REF);
    expect((await home.tick(2)).events).toEqual([expect.objectContaining({ type: "failed", reason: "exited_without_report" })]);
  });

  test("on timeout the screen is captured, the window closed and the run timed_out", async () => {
    execTask(home, "succeed", { timeout: "30m" });
    await home.tick(1);
    expect((await home.tick(40)).events).toEqual([expect.objectContaining({ type: "timed_out" })]);
    expect(calls("capture")).toHaveLength(1);
    expect(calls("window", "close")).toHaveLength(1);
  });

  test("without $REX_SESSION the launch fails with a clear reason", async () => {
    delete home.env.REX_SESSION;
    execTask(home, "succeed");
    const { events } = await home.tick(1);
    expect(events).toEqual([expect.objectContaining({ type: "failed", reason: "launch_failed", message: expect.stringContaining("$REX_SESSION is not set") })]);
    expect(calls("window", "new")).toEqual([]);
  });
});
