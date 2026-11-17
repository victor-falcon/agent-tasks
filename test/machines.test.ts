import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configErrors, isHub, isKnownMachine, knownMachines, localMachine } from "../src/config.ts";
import { migrateTaskMachines } from "../src/migrate.ts";
import { TASK_FIELDS } from "../src/schema.ts";
import { makeTask, makeTempHome, runCli, type TempHome } from "./helpers.ts";

const NOW = "--now=2026-11-16T15:00:00+01:00";
const HUB_CONFIG = { timezone: "Europe/Madrid", machine: "linux", machines: { mac: { ssh: "mac-mini" } } };

let home: TempHome;
let project: string;
beforeEach(() => {
  home = makeTempHome();
  project = join(home.root, "Projects", "foo");
  mkdirSync(project, { recursive: true });
  home.writeConfig({ timezone: "Europe/Madrid" });
});
afterEach(() => home.cleanup());

function readStored(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** A task as written by a version without multi-machine support. */
function writeLegacyTask(dir: string, id: string): string {
  const { machine: _, ...legacy } = makeTask({ id });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify(legacy, null, 2));
  return file;
}

describe("machine config", () => {
  test("without machine keys, this machine is a hub called local", () => {
    expect(configErrors({})).toEqual([]);
    expect(localMachine({})).toBe("local");
    expect(isHub({})).toBe(true);
    expect(knownMachines({})).toEqual({ local: { local: true } });
  });

  test("a hub's registry: this machine is implicitly local, others are reached over SSH", () => {
    expect(configErrors(HUB_CONFIG)).toEqual([]);
    expect(configErrors({ machine: "linux", machines: { linux: { local: true }, mac: { ssh: "mac" } } })).toEqual([]);
    expect(knownMachines(HUB_CONFIG)).toEqual({ mac: { ssh: "mac-mini" }, linux: { local: true } });
    expect(isKnownMachine(HUB_CONFIG, "mac")).toBe(true);
    expect(isKnownMachine(HUB_CONFIG, "linux")).toBe(true);
    expect(isKnownMachine(HUB_CONFIG, "local")).toBe(false);
    expect(isKnownMachine(HUB_CONFIG, "constructor")).toBe(false);
  });

  test("a client has a hub and no registry", () => {
    const client = { machine: "mac", hub: { ssh: "linux-box" } };
    expect(configErrors(client)).toEqual([]);
    expect(isHub(client)).toBe(false);
    expect(localMachine(client)).toBe("mac");
  });

  test("invalid machine keys are reported with their path", () => {
    expect(
      configErrors({
        machine: "My Mac",
        machines: { mac: {}, pi: { local: true, ssh: "pi" }, Box: { ssh: "box" }, nas: { ssh: "" }, vm: { local: false }, srv: "srv" },
        hub: { host: "x" },
      }),
    ).toEqual([
      'machine: must be a machine name: lowercase letters, digits and dashes, starting with a letter (got "My Mac")',
      'machines.mac: needs exactly one of "local": true or "ssh": "<host alias>"',
      'machines.pi: needs exactly one of "local": true or "ssh": "<host alias>"',
      'machines.Box: must be a machine name: lowercase letters, digits and dashes, starting with a letter (got "Box")',
      "machines.nas.ssh: must be a non-empty string",
      "machines.vm.local: must be true (leave it out otherwise)",
      'machines.vm: needs exactly one of "local": true or "ssh": "<host alias>"',
      'machines.srv: must be { "local": true } or { "ssh": "<host alias>" }',
      "hub.host: unknown field (allowed: ssh)",
      "hub.ssh: must be a non-empty string",
      "machines: only the hub keeps the machine registry; a client (with `hub`) must not set it",
    ]);
    expect(configErrors({ machine: "linux", machines: { mac: { local: true } } })).toEqual(['machines.mac.local: only this machine ("linux", from `machine`) can be local']);
    expect(configErrors({ machine: "linux", machines: { linux: { ssh: "linux" } } })).toEqual([
      'machines.linux.ssh: "linux" is this machine (from `machine`); it is local, not reached over SSH',
    ]);
  });
});

describe("migration: tasks without machine", () => {
  test("gives saved and archived tasks this machine's name, once, in field order", () => {
    const saved = writeLegacyTask(home.paths.tasksDir, "old-task");
    const archived = writeLegacyTask(home.paths.archiveDir, "old-archived");
    const current = home.writeTask(makeTask({ id: "new-task", machine: "mac" }));
    writeFileSync(join(home.paths.tasksDir, "broken.json"), "{ nope");

    expect(migrateTaskMachines(home.paths, "linux")).toEqual([saved, archived]);
    expect(readStored(saved).machine).toBe("linux");
    expect(readStored(archived).machine).toBe("linux");
    expect(readStored(current).machine).toBe("mac");
    expect(readFileSync(join(home.paths.tasksDir, "broken.json"), "utf8")).toBe("{ nope");
    const keys = Object.keys(readStored(saved));
    expect(keys).toEqual(TASK_FIELDS.filter((k) => keys.includes(k)));

    const again = readFileSync(saved, "utf8");
    expect(migrateTaskMachines(home.paths, "other")).toEqual([]);
    expect(readFileSync(saved, "utf8")).toBe(again);
  });

  test("a task that can't be rewritten is left alone and reported where it is read", async () => {
    const file = writeLegacyTask(home.paths.tasksDir, "weekly-report");
    chmodSync(home.paths.tasksDir, 0o555);
    try {
      expect(migrateTaskMachines(home.paths, "local")).toEqual([]);
      const r = await runCli(["list", "--json", NOW], home);
      expect(r.code).toBe(0);
      expect(r.json().errors[0]).toContain("machine: must be a machine name");
    } finally {
      chmodSync(home.paths.tasksDir, 0o755);
    }
    expect(readStored(file).machine).toBeUndefined();
  });

  test("a missing data folder is nothing to migrate", () => {
    const empty = makeTempHome();
    try {
      expect(migrateTaskMachines({ ...empty.paths, tasksDir: join(empty.root, "nope"), archiveDir: join(empty.root, "nope2") }, "local")).toEqual([]);
    } finally {
      empty.cleanup();
    }
  });

  test("any command migrates an existing data folder before reading it", async () => {
    home.writeConfig({ ...HUB_CONFIG });
    const file = writeLegacyTask(home.paths.tasksDir, "weekly-report");
    const r = await runCli(["list", "--json", NOW], home);
    expect(r.code).toBe(0);
    expect(r.json().errors).toEqual([]);
    expect(r.json().tasks[0]).toMatchObject({ id: "weekly-report", machine: "linux" });
    expect(readStored(file).machine).toBe("linux");
  });

  test("without machine in the config, old tasks become local", async () => {
    const file = writeLegacyTask(home.paths.tasksDir, "weekly-report");
    expect((await runCli(["show", "weekly-report", "--json", NOW], home)).json().task.machine).toBe("local");
    expect(readStored(file).machine).toBe("local");
  });
});

const addFlags = ["--cron", "0 9 * * 1", "--instructions", "Do it."];

describe("--machine", () => {
  test("add defaults to this machine; the list shows no MACHINE column on a single machine", async () => {
    const r = await runCli(["add", "--title", "Here", ...addFlags, "--json", NOW], home, project);
    expect(r.code).toBe(0);
    expect(r.json().task.machine).toBe("local");
    const list = await runCli(["list", NOW], home);
    expect(list.stdout.split("\n")[0]).not.toContain("MACHINE");
    expect((await runCli(["show", "here", NOW], home)).stdout).toMatch(/Machine\s+local/);
  });

  test("add --machine takes a machine from the registry, rejects unknown ones", async () => {
    home.writeConfig(HUB_CONFIG);
    const here = await runCli(["add", "--title", "Here", ...addFlags, "--json", NOW], home, project);
    expect(here.json().task.machine).toBe("linux");
    const there = await runCli(["add", "--title", "There", ...addFlags, "--machine", "mac", "--json", NOW], home, project);
    expect(there.code).toBe(0);
    expect(there.json().task.machine).toBe("mac");

    const unknown = await runCli(["add", "--title", "Nowhere", ...addFlags, "--machine", "pi", "--json", NOW], home, project);
    expect(unknown.code).toBe(1);
    expect(unknown.json().error).toMatchObject({ code: "unknown_machine", message: 'unknown machine "pi" (known: linux, mac); add it to `machines` in the config' });
    const invalid = await runCli(["add", "--title", "Bad", ...addFlags, "--machine", "My Mac", "--json", NOW], home, project);
    expect(invalid.json().error.details).toEqual(['machine: must be a machine name: lowercase letters, digits and dashes, starting with a letter (got "My Mac")']);
  });

  test("edit --machine moves a task; an unknown machine is rejected", async () => {
    home.writeConfig(HUB_CONFIG);
    home.writeTask(makeTask({ machine: "linux" }));
    const moved = await runCli(["edit", "weekly-report", "--machine", "mac", "--json", NOW], home);
    expect(moved.code).toBe(0);
    expect(moved.json()).toMatchObject({ changed: ["machine"], task: { machine: "mac" } });
    const bad = await runCli(["edit", "weekly-report", "--machine", "pi", "--json", NOW], home);
    expect(bad.json().error.code).toBe("unknown_machine");
    // A task on a machine that left the registry can still be edited otherwise.
    home.writeConfig({ ...HUB_CONFIG, machines: {} });
    expect((await runCli(["edit", "weekly-report", "--title", "Renamed", "--json", NOW], home)).code).toBe(0);
  });

  test("list and status filter by machine and show it once several are involved", async () => {
    home.writeConfig(HUB_CONFIG);
    home.writeTask(makeTask({ id: "on-linux", machine: "linux" }));
    home.writeTask(makeTask({ id: "on-mac", machine: "mac" }));

    const ids = async (...args: string[]) => (await runCli(["list", "--json", ...args, NOW], home)).json().tasks.map((t: { id: string }) => t.id);
    expect(await ids()).toEqual(["on-linux", "on-mac"]);
    expect(await ids("--machine", "mac")).toEqual(["on-mac"]);
    const typo = await runCli(["list", "--machine", "pi", NOW], home);
    expect(typo.code).toBe(2);
    expect(typo.stderr).toContain('--machine: unknown machine "pi" (known: linux, mac)');
    expect((await runCli(["status", "--machine", "pi", NOW], home)).code).toBe(2);
    // A machine some task still runs on is a valid filter, even once it left the config.
    home.writeTask(makeTask({ id: "stray", machine: "local" }));
    expect(await ids("--machine", "local")).toEqual(["stray"]);
    const human = await runCli(["list", NOW], home);
    expect(human.stdout.split("\n")[0]).toMatch(/^\s+ID\s+SCHEDULE\s+NEXT\s+LAST 10\s+MACHINE\s+FOLDER$/);
    expect(human.stdout).toMatch(/on-mac .* mac\s+~\/Projects\/foo/);

    const status = await runCli(["status", "--json", "--machine", "linux", NOW], home);
    expect(status.json().tasks).toBe(1);
    expect((await runCli(["list", "--json", "--machine", "local", NOW], home)).json().tasks.map((t: { id: string }) => t.id)).toEqual(["stray"]);
    expect(status.json().next.map((n: { task_id: string; machine: string }) => `${n.task_id}@${n.machine}`)).toEqual(["on-linux@linux"]);
    const all = await runCli(["status", NOW], home);
    expect(all.stdout).toMatch(/on-linux\s+linux/);
    expect(all.stdout).toMatch(/on-mac\s+mac/);
  });
});
