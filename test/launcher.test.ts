import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentArgv, exec, extractHandle, launchEnv, LauncherError, listPresets, renderCommand, resolveLauncher, sessionName, type SessionInput, sessionStatus } from "../src/launcher.ts";
import { render, shellQuote, TemplateError } from "../src/template.ts";

function input(overrides: Partial<SessionInput> = {}): SessionInput {
  return {
    runRef: "demo/20261117T080000Z",
    taskId: "demo",
    title: "Demo",
    cwd: "/tmp",
    slot: "2026-11-17T09:00:00+01:00",
    slotId: "20261117T080000Z",
    attempt: 1,
    skill: "run-agent-task",
    prompt: () => "/run-agent-task demo/20261117T080000Z",
    agent: { command: "claude", args: [], shell: false },
    logPath: "/tmp/demo.log",
    env: { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" },
    agentEnv: { FOO: "1" },
    ...overrides,
  };
}

describe("templates and quoting", () => {
  const tricky = ["plain", "with spaces", `it's "quoted"`, "$HOME `cmd` \\ back", "new\nline", "", "'''"];

  test("shellQuote survives a real shell", () => {
    for (const value of tricky) {
      const result = exec(["/bin/sh", "-c", `printf %s ${shellQuote(value)}`], { env: { PATH: "/usr/bin:/bin" } });
      expect(result.stdout).toBe(value);
    }
  });

  test("{{name_quoted}} quotes any variable; unknown variables are errors", () => {
    const vars = { values: { prompt: "/x it's" } };
    expect(render("say {{prompt_quoted}}", vars)).toBe(`say '/x it'\\''s'`);
    expect(render("{{ prompt }}", vars)).toBe("/x it's");
    expect(() => render("{{nope}}", vars)).toThrow(TemplateError);
  });

  test("{{env.NAME}} reads the runner's environment and says when it is not set", () => {
    const env = { PATH: "/usr/bin:/bin", REX_SESSION: "my session" };
    expect(renderCommand(["rex", "-s", "{{env.REX_SESSION}}"], input({ env }), "t", { space: null })).toEqual(["rex", "-s", "my session"]);
    expect(renderCommand("rex -s {{env.REX_SESSION_quoted}}", input({ env }), "t", { space: null })).toEqual(["/bin/sh", "-c", "rex -s 'my session'"]);
    expect(() => renderCommand(["{{env.REX_SESSION}}"], input(), "launcher.launch", { space: null })).toThrow("variable {{env.REX_SESSION}} in launcher.launch is not available: $REX_SESSION is not set");
  });

  test("a variable that is not available says why", () => {
    const argv = () => renderCommand(["x", "{{runner_terminal}}"], input(), "launcher.launch", { space: null });
    expect(argv).toThrow("$HC_TERMINAL_ID is not set");
  });
});

describe("commands", () => {
  test("{{agent_argv}} expands to the agent, through an interactive shell when agent.shell is set", () => {
    expect(agentArgv(input())).toEqual(["claude", "/run-agent-task demo/20261117T080000Z"]);
    const shell = input({ agent: { command: "clc", args: ["--model", "a b"], shell: true } });
    expect(agentArgv(shell)).toEqual(["/bin/zsh", "-ic", `clc --model 'a b' '/run-agent-task demo/20261117T080000Z'`]);
    expect(renderCommand(["env", "{{env_argv}}", "{{agent_argv}}"], input(), "t", { space: null })).toEqual(["env", "FOO=1", "claude", "/run-agent-task demo/20261117T080000Z"]);
  });

  test("a string command runs through sh -c", () => {
    expect(renderCommand("echo {{task_id}}", input(), "t", { space: null })).toEqual(["/bin/sh", "-c", "echo demo"]);
  });

  test("handles come from JSON, a regex or the first line", () => {
    expect(extractHandle("json:.address", '{"address":"t17g"}')).toBe("t17g");
    expect(extractHandle("json:.a.b", '{"a":{"b":42}}')).toBe("42");
    expect(extractHandle("json:.block_ids.0", '{"block_ids":["b7","b8"]}')).toBe("b7");
    expect(() => extractHandle("json:.block_ids.2", '{"block_ids":["b7"]}')).toThrow(LauncherError);
    expect(extractHandle("regex:window (@\\d+)", "created window @12\n")).toBe("@12");
    expect(extractHandle(null, "  abc\nmore\n")).toBe("abc");
    expect(() => extractHandle("json:.address", "not json")).toThrow(LauncherError);
    expect(() => extractHandle(null, "")).toThrow(LauncherError);
  });

  test("session names fit in 32 characters", () => {
    expect(sessionName("demo", "20261117T080000Z", 1)).toBe("task-demo-20261117t080000z");
    expect(sessionName("demo", "20261117T080000Z", 2)).toBe("task-demo-20261117t080000z-a2");
    const long = sessionName("a-very-long-task-identifier-for-tests", "manual-20261117T080000Z", 1);
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(/^[a-z0-9_-]+$/);
  });

  test("status_map translates herdr's JSON and custom outputs", () => {
    const herdr = resolveLauncher({ preset: "herdr" });
    const fake = (json: unknown) => ({ ...herdr, status: ["/bin/sh", "-c", `printf %s ${shellQuote(JSON.stringify(json))}`] });
    expect(sessionStatus(fake({ state: "finished" }), input())?.state).toBe("exited");
    expect(sessionStatus(fake({ state: "live", status: { state: "blocked" } }), input())?.state).toBe("blocked");
    expect(sessionStatus(fake({ state: "live", status: { state: "done" } }), input())?.state).toBe("idle");
    expect(sessionStatus(fake({ state: "live", status: null }), input())?.state).toBe("working");
    const custom = resolveLauncher({ launch: ["x"], status: "echo waiting", status_map: { waiting: "blocked" } });
    expect(sessionStatus(custom, input())?.state).toBe("blocked");
    expect(sessionStatus(resolveLauncher({ launch: ["x"], status: ["false"] }), input())?.state).toBe("gone");
    expect(sessionStatus(resolveLauncher({ launch: ["x"] }), input())).toBeNull();
  });
});

describe("presets", () => {
  test("the repo ships herdr, process, rex and tmux, all valid", () => {
    expect(listPresets()).toEqual(["herdr", "process", "rex", "tmux"]);
    for (const preset of listPresets()) expect(resolveLauncher({ preset }).name).toBe(preset);
    expect(resolveLauncher({ preset: "process" })).toMatchObject({ name: "process", background: true, launch: ["{{agent_argv}}"] });
  });

  test("user fields replace preset fields one by one", () => {
    const spec = resolveLauncher({ preset: "herdr", close: ["hc", "kill", "-f", "{{handle}}"] });
    expect(spec.close).toEqual(["hc", "kill", "-f", "{{handle}}"]);
    expect(spec.status).toEqual(["hc", "get", "{{handle}}", "--json"]);
  });

  test("a new preset is just a JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-tasks-presets-"));
    writeFileSync(join(dir, "tmux.json"), JSON.stringify({ launch: ["tmux", "new-window", "-P"], close: ["tmux", "kill-window", "-t", "{{handle}}"] }));
    expect(resolveLauncher({ preset: "tmux" }, dir)).toMatchObject({ name: "tmux", launch: ["tmux", "new-window", "-P"] });
  });

  test("invalid launchers list every problem", () => {
    expect(() => resolveLauncher({ preset: "nope" })).toThrow('unknown launcher preset "nope" (available: herdr, process, rex, tmux)');
    let error: LauncherError | undefined;
    try {
      resolveLauncher({ lanch: ["x"], close: [], status_map: "tmux", handle: "address" });
    } catch (err) {
      error = err as LauncherError;
    }
    expect(error?.details).toEqual([
      "lanch: unknown field (allowed: preset, description, launch, then, background, handle, close, status, status_map, read, attach, space)",
      "launch: is required",
      "close: must be a non-empty array of strings (argv) or a shell command string",
      'handle: must be "json:.<path>" or "regex:<pattern>"',
      'status_map: must be "herdr" or an object from output to one of: working, idle, blocked, exited, gone',
    ]);
  });
});

describe("launch environment", () => {
  // A login shell whose profile adds /opt/login/bin, like Homebrew's.
  function fakeHome(): { home: string; shell: string } {
    const home = mkdtempSync(join(tmpdir(), "agent-tasks-launch-env-"));
    const shell = join(home, "login-sh");
    writeFileSync(shell, `#!/bin/sh\n[ "$1" = -lc ] && PATH="/opt/login/bin:$PATH" && export PATH && shift && exec /bin/sh -c "$@"\nexec /bin/sh "$@"\n`, { mode: 0o755 });
    return { home, shell };
  }

  test("a minimal PATH (an app such as Herdr's panel started agent-tasks) gets ~/.local/bin and the login shell's folders", () => {
    const { home, shell } = fakeHome();
    const path = launchEnv({ HOME: home, SHELL: shell, PATH: "/usr/bin:/bin" }).PATH!.split(":");
    expect(path).toEqual([join(home, ".local", "bin"), "/usr/bin", "/bin", "/opt/login/bin"]);
  });

  test("a PATH that has ~/.local/bin (a terminal) is left as it is", () => {
    const { home, shell } = fakeHome();
    const env = { HOME: home, SHELL: shell, PATH: `/usr/bin:${join(home, ".local", "bin")}` };
    expect(launchEnv(env)).toBe(env);
  });

  test("loginFirst (SSH) puts the login shell's folders first", () => {
    const { home, shell } = fakeHome();
    const path = launchEnv({ HOME: home, SHELL: shell, PATH: "/usr/bin:/bin" }, { loginFirst: true }).PATH!.split(":");
    expect(path).toEqual([join(home, ".local", "bin"), "/opt/login/bin", "/usr/bin", "/bin"]);
  });
});
